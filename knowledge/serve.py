"""
serve.py: read-only search service over a built knowledge pack (OFFLINE, every question).

WHERE THIS FITS
  Step 4 of the knowledge pipeline:  collect.py -> extract.py -> build_pack.py -> serve.py
  The TypeScript chat agent calls this service (src/core/knowledge-cognee.ts) to find passages.
  It binds to 127.0.0.1 only, configures Cognee WITHOUT any LLM (see pack_config.py), and never writes
  to the pack. Unplug the network and it works the same.

WHAT A SEARCH DOES (mode "hybrid", the default)
  Three ways of finding passages, all using Cognee's local indexes, then merged:
    1. meaning  ("vector"):  the question is embedded with the local model and compared with every chunk.
    2. words    ("lexical"): classic keyword ranking (BM25-style) over the same chunks.
    3. graph    ("graph"):   the question is matched against the knowledge graph's entities (e.g. "dog"
                             -> "pets", "pet carrier"); passages that mention the best entities are added.
  The three ranked lists are merged with Reciprocal Rank Fusion (a passage high on several lists wins).
  What comes back is always the ORIGINAL passage text from passages.jsonl, never graph descriptions an
  LLM wrote at build time. The graph only helps find passages; it is not a source of facts.

HTTP API
  GET  /health                      -> pack info
  POST /search {"query": str, "limit": 6, "mode": "hybrid"|"vector"|"lexical"|"graph"}
       -> {"hits": [{"id", "score", "methods", "text", "heading", "pageTitle", "publisher", "url",
                     "pageDate", "fetchedAt", "hazards", "needs", "phases", "jurisdiction", "tier"}],
           "timingsMs": {...}}
  GET  /passage/{id}               -> one passage

USAGE
  uv run python serve.py --pack ../data/pack/library-v1 [--port 8788]
"""
from __future__ import annotations

import argparse
import json
import time
from collections import defaultdict
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from pack_config import DATASET, configure

RRF_K = 60  # standard Reciprocal Rank Fusion constant: score = sum over lists of 1 / (RRF_K + rank)


class SearchRequest(BaseModel):
    query: str
    limit: int = 6
    mode: str = "hybrid"


class PackIndex:
    """Everything loaded once at startup: passages, and maps from Cognee's IDs to our passage IDs."""

    def __init__(self, pack: Path):
        self.pack = pack
        self.passages: dict[str, dict] = {}
        self.chunk_to_passage: dict[str, str] = {}
        self.text_to_passage: dict[str, str] = {}
        self.entity_to_chunks: dict[str, set[str]] = defaultdict(set)
        self.info: dict = {}

    async def load(self) -> None:
        from cognee.infrastructure.databases.graph import get_graph_engine

        for line in open(self.pack / "passages.jsonl"):
            p = json.loads(line)
            self.passages[p["id"]] = p
        self.info = json.loads((self.pack / "build-info.json").read_text()) if (self.pack / "build-info.json").exists() else {}

        graph = await get_graph_engine()
        nodes, edges = await graph.get_graph_data()
        props = {str(n): p for n, p in nodes}
        # TextDocument nodes carry our passage_id in their external_metadata.
        doc_to_passage = {}
        for nid, p in props.items():
            if p.get("type") == "TextDocument":
                meta = p.get("external_metadata") or {}
                if isinstance(meta, str):
                    try:
                        meta = json.loads(meta)
                    except json.JSONDecodeError:
                        meta = {}
                if meta.get("passage_id"):
                    doc_to_passage[nid] = meta["passage_id"]
        for src, dst, rel, *_ in edges:
            src, dst = str(src), str(dst)
            if rel == "is_part_of" and dst in doc_to_passage:          # chunk -> document
                self.chunk_to_passage[src] = doc_to_passage[dst]
        for src, dst, rel, *_ in edges:
            src, dst = str(src), str(dst)
            if rel == "contains" and src in self.chunk_to_passage and props.get(dst, {}).get("type") == "Entity":
                self.entity_to_chunks[dst].add(src)                      # chunk mentions entity
        for cid, pid in self.chunk_to_passage.items():
            t = props.get(cid, {}).get("text")
            if t:
                self.text_to_passage[t.strip()[:200]] = pid
        self.info.update({"graphNodes": len(nodes), "graphEdges": len(edges), "chunksMapped": len(self.chunk_to_passage),
                          "entitiesLinked": len(self.entity_to_chunks), "passagesLoaded": len(self.passages)})

    def passage_for_result(self, r) -> str | None:
        d = r if isinstance(r, dict) else (r.model_dump() if hasattr(r, "model_dump") else {})
        rid = str(d.get("id") or "")
        if rid in self.chunk_to_passage:
            return self.chunk_to_passage[rid]
        t = (d.get("text") or d.get("payload", {}).get("text") or "").strip()[:200]
        return self.text_to_passage.get(t)


async def vector_hits(index: PackIndex, query: str, k: int) -> list[str]:
    from cognee.infrastructure.databases.vector import get_vector_engine_async
    res = await (await get_vector_engine_async()).search("DocumentChunk_text", query_text=query, limit=k)
    out = []
    for r in res:
        pid = index.chunk_to_passage.get(str(r.id))
        if pid and pid not in out:
            out.append(pid)
    return out


async def lexical_hits(index: PackIndex, query: str, k: int) -> list[str]:
    import cognee
    from cognee.modules.search.types import SearchType
    res = await cognee.search(query, query_type=SearchType.CHUNKS_LEXICAL, top_k=k, datasets=[DATASET])
    out = []
    for r in res:
        pid = index.passage_for_result(r)
        if pid and pid not in out:
            out.append(pid)
    return out


async def graph_hits(index: PackIndex, query: str, k: int, entities: int = 8) -> list[str]:
    """Entities whose names are closest in meaning to the question, then the passages mentioning them.
    Passages mentioning several of those entities (weighted by entity closeness) rank first."""
    from cognee.infrastructure.databases.vector import get_vector_engine_async
    res = await (await get_vector_engine_async()).search("Entity_name", query_text=query, limit=entities)
    score: dict[str, float] = defaultdict(float)
    for rank, r in enumerate(res):
        for cid in index.entity_to_chunks.get(str(r.id), ()):
            pid = index.chunk_to_passage.get(cid)
            if pid:
                score[pid] += 1.0 / (1 + rank)
    return [pid for pid, _ in sorted(score.items(), key=lambda x: -x[1])[:k]]


def create_app(index: PackIndex) -> FastAPI:
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def lifespan(_app):
        # Load inside the server's own event loop: Cognee caches database connections per loop.
        await index.load()
        await vector_hits(index, "warm up", 1)  # loads the embedding model now, not on the first question
        print(json.dumps({k: v for k, v in index.info.items()
                          if k in ("passagesLoaded", "chunksMapped", "entitiesLinked", "graphNodes")}), flush=True)
        yield

    app = FastAPI(title="Offline emergency agent: knowledge pack search", docs_url=None, redoc_url=None, lifespan=lifespan)

    @app.get("/health")
    async def health():
        return {"ok": True, "pack": index.pack.name, **{k: v for k, v in index.info.items() if k != "improve"}}

    @app.get("/passage/{pid:path}")
    async def passage(pid: str):
        if pid not in index.passages:
            raise HTTPException(404, "unknown passage")
        return index.passages[pid]

    @app.post("/search")
    async def search(req: SearchRequest):
        if not req.query.strip():
            raise HTTPException(400, "empty query")
        k = max(req.limit * 4, 20)  # each method looks wider than the final answer
        timings, lists = {}, {}
        methods = {"vector": vector_hits, "lexical": lexical_hits, "graph": graph_hits}
        wanted = list(methods) if req.mode == "hybrid" else [req.mode]
        for name in wanted:
            if name not in methods:
                raise HTTPException(400, f"unknown mode {req.mode}")
            t = time.perf_counter()
            lists[name] = await methods[name](index, req.query, k)
            timings[name] = round((time.perf_counter() - t) * 1000, 1)
        fused: dict[str, float] = defaultdict(float)
        found_by: dict[str, list[str]] = defaultdict(list)
        for name, ranked in lists.items():
            for rank, pid in enumerate(ranked):
                fused[pid] += 1.0 / (RRF_K + rank + 1)
                found_by[pid].append(name)
        top = sorted(fused.items(), key=lambda x: -x[1])[: req.limit]
        hits = []
        for pid, s in top:
            p = index.passages.get(pid)
            if not p:
                continue
            hits.append({"id": pid, "score": round(s, 5), "methods": found_by[pid],
                         **{f: p.get(f) for f in ("text", "heading", "pageTitle", "publisher", "url", "pageDate",
                                                  "fetchedAt", "hazards", "needs", "phases", "jurisdiction", "tier", "sourceId")}})
        return {"hits": hits, "timingsMs": timings}

    return app


def main() -> int:
    ap = argparse.ArgumentParser(description="Read-only search service over a knowledge pack.")
    ap.add_argument("--pack", required=True)
    ap.add_argument("--port", type=int, default=8788)
    args = ap.parse_args()
    pack = Path(args.pack).expanduser().resolve()
    configure(pack, mode="serve")  # before importing cognee: no LLM, local embeddings only
    index = PackIndex(pack)
    uvicorn.run(create_app(index), host="127.0.0.1", port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
