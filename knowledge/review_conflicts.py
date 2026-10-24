"""
review_conflicts.py: find places where official sources disagree (ONLINE, build time, after build_pack.py).

WHERE THIS FITS
  Part of building a pack:  build_pack.py -> review_conflicts.py -> CONFLICTS.md (for people to review)
  It uses Cognee's conflict review (improve(review_conflicts=True) under the hood) with the build model.

WHAT IT DOES
  1. Picks the entities worth reviewing: graph entities mentioned by passages from TWO OR MORE different
     publishers (that's where official sources can disagree). Reviewing every entity would take many
     hours of sequential model calls, so the most widely shared entities go first, within a time budget.
  2. Cognee's review reads each entity's facts with the chunks that support them and their dates
     (effective_date = the date the page shows), and records disputed attributes as FactConflict nodes.
  3. Exports every conflict to <pack>/conflicts.json and a readable report <corpus>/CONFLICTS.md, with
     the passages and URLs on each side, for a PERSON to decide. The agent never uses this output to
     answer; when sources disagree it is told to say so (see src/core/prompt.ts).

USAGE
  uv run --env-file ../.env python review_conflicts.py --pack ../data/pack/library-v1 --max-minutes 90
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from pack_config import DATASET, configure


async def select_entities(max_entities: int, max_mentions: int = 0) -> tuple[list[str], dict]:
    """Entities mentioned by passages from 2+ publishers, most widely shared first.
    max_mentions > 0 skips very broad entities ("water", "emergency"): each of those drags hundreds of
    facts into one review call, which can take tens of minutes at high reasoning effort."""
    from cognee.infrastructure.databases.graph import get_graph_engine
    graph = await get_graph_engine()
    nodes, edges = await graph.get_graph_data()
    props = {str(n): p for n, p in nodes}
    doc_source = {}
    for nid, p in props.items():
        if p.get("type") == "TextDocument":
            meta = p.get("external_metadata") or {}
            meta = json.loads(meta) if isinstance(meta, str) else meta
            if meta.get("source_id"):
                doc_source[nid] = meta["source_id"]
    chunk_source = {str(s): doc_source[str(t)] for s, t, r, *_ in edges if r == "is_part_of" and str(t) in doc_source}
    sources_of: dict[str, set] = defaultdict(set)
    mentions: dict[str, int] = defaultdict(int)
    for s, t, r, *_ in edges:
        s, t = str(s), str(t)
        if r == "contains" and s in chunk_source and props.get(t, {}).get("type") == "Entity":
            sources_of[t].add(chunk_source[s])
            mentions[t] += 1
    shared = [e for e, srcs in sources_of.items() if len(srcs) >= 2 and (not max_mentions or mentions[e] <= max_mentions)]
    shared.sort(key=lambda e: (-len(sources_of[e]), -mentions[e], e))
    stats = {"entities": sum(1 for p in props.values() if p.get("type") == "Entity"),
             "entitiesWith2PlusSources": len(shared)}
    return shared[:max_entities], stats


async def export_conflicts(pack: Path, corpus: Path | None) -> list[dict]:
    """Every FactConflict in the graph, with the passages behind each side."""
    from cognee.infrastructure.databases.graph import get_graph_engine
    graph = await get_graph_engine()
    nodes, edges = await graph.get_graph_data()
    props = {str(n): p for n, p in nodes}
    passages = {json.loads(l)["id"]: json.loads(l) for l in open(pack / "passages.jsonl")}
    def passage_of(node_id: str) -> dict | None:
        """A source ID is a document chunk; its metadata names our passage."""
        meta = props.get(str(node_id), {}).get("external_metadata") or {}
        meta = json.loads(meta) if isinstance(meta, str) else meta
        p = passages.get(meta.get("passage_id", ""))
        if not p:
            return None
        return {"passage": p["id"], "publisher": p["publisher"], "url": p["url"], "pageDate": p.get("pageDate"),
                "heading": p["heading"]}

    out = []
    for nid, p in props.items():
        if p.get("type") != "FactConflict":
            continue
        about = props.get(str(p.get("about_id")), {})
        values = [props.get(str(v), {}).get("name") or str(v) for v in (p.get("values") or [])]
        sources = [passage_of(s) or {"node": str(s)} for s in (p.get("sources") or [])]
        out.append({"id": nid, "about": about.get("name"), "attribute": p.get("attribute"), "kind": p.get("kind"),
                    "status": p.get("status"), "text": p.get("text"), "values": values, "sources": sources})
    (pack / "conflicts.json").write_text(json.dumps(out, indent=2, default=str))
    if corpus:
        lines = ["# Conflicts between sources", "",
                 f"Generated {datetime.now(timezone.utc).replace(microsecond=0).isoformat()} by `knowledge/review_conflicts.py` "
                 f"from pack `{pack.name}`. Cognee's conflict review (build model) compared facts about the same thing "
                 "coming from different documents, using each page's date. These are for a person to check; the agent "
                 "does not use them to answer.", "",
                 f"{len(out)} conflicts recorded.", ""]
        for c in sorted(out, key=lambda c: (c["status"] != "unresolved", str(c["about"]))):
            lines += [f"## {c['about']}: {c['attribute']} ({c['status']}, {c['kind']})", "", str(c["text"] or ""), ""]
            lines.append("Entities involved: " + ", ".join(str(v) for v in c.get("values") or []))
            lines.append("")
            for src in c.get("sources") or []:
                if "passage" in src:
                    lines.append(f"- {src['publisher']}, page dated {src.get('pageDate') or 'n/a'}: {src['heading']} ({src['url']}), passage `{src['passage']}`")
                else:
                    lines.append(f"- graph node {src['node']}")
            lines.append("")
        (corpus / "CONFLICTS.md").write_text("\n".join(lines) + "\n")
    return out


async def run(args) -> dict:
    import cognee  # noqa: F401  (initializes Cognee with the environment set by configure())
    from cognee.memify_pipelines.review_conflicts import review_conflicts_pipeline
    from cognee.modules.users.methods import get_default_user

    entity_ids, stats = await select_entities(args.max_entities, args.max_mentions)
    print(f"{stats['entities']} entities; {stats['entitiesWith2PlusSources']} shared by 2+ publishers; reviewing up to {len(entity_ids)}", flush=True)
    user = await get_default_user()
    deadline = time.time() + args.max_minutes * 60
    reviewed = 0
    for i in range(0, len(entity_ids), args.shard):
        if time.time() > deadline:
            print("time budget reached", flush=True)
            break
        shard = entity_ids[i:i + args.shard]
        t = time.time()
        try:
            await review_conflicts_pipeline(DATASET, user, entity_ids=shard)
        except Exception as e:
            print(f"shard {i // args.shard} failed: {e!r}"[:400], flush=True)
            continue
        reviewed += len(shard)
        print(f"reviewed {reviewed}/{len(entity_ids)} entities ({time.time() - t:.0f} s for this shard)", flush=True)
    conflicts = await export_conflicts(Path(args.pack), Path(args.corpus) if args.corpus else None)
    return {**stats, "reviewedEntities": reviewed, "conflicts": len(conflicts),
            "unresolved": sum(1 for c in conflicts if c["status"] == "unresolved")}


def main() -> int:
    ap = argparse.ArgumentParser(description="Review conflicts between sources in a built pack.")
    ap.add_argument("--pack", required=True)
    ap.add_argument("--corpus", default=os.environ.get("CORPUS_DIR"))
    ap.add_argument("--max-entities", type=int, default=1500)
    ap.add_argument("--max-minutes", type=float, default=90)
    ap.add_argument("--shard", type=int, default=100)
    ap.add_argument("--max-mentions", type=int, default=0, help="skip entities mentioned by more passages than this")
    ap.add_argument("--export-only", action="store_true", help="only export conflicts already recorded")
    args = ap.parse_args()
    pack = Path(args.pack).expanduser().resolve()
    args.pack = str(pack)
    configure(pack, mode="build")
    t = time.time()
    if args.export_only:
        import cognee  # noqa: F401
        conflicts = asyncio.run(export_conflicts(pack, Path(args.corpus) if args.corpus else None))
        print(f"exported {len(conflicts)} conflicts")
        return 0
    result = asyncio.run(run(args))
    result["minutes"] = round((time.time() - t) / 60, 1)
    info_path = pack / "build-info.json"
    info = json.loads(info_path.read_text()) if info_path.exists() else {}
    info["conflictReview"] = result
    info_path.write_text(json.dumps(info, indent=2))
    print(json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
