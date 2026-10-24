"""
build_pack.py: turn the tagged passages into a static Cognee knowledge pack (ONLINE, build time).

WHERE THIS FITS
  Step 3 of the knowledge pipeline:  collect.py -> extract.py -> build_pack.py -> serve.py
  Input:  <corpus>/passages.jsonl
  Output: <pack-dir>/ (Cognee's databases: SQLite metadata, LanceDB vectors, Ladybug graph)
          <pack-dir>/passages.jsonl  a frozen copy of the passages the pack was built from
          <pack-dir>/build-info.json what was built, with which models, how long each step took
          <pack-dir>/conflicts.json  facts Cognee's conflict review marked as disputed (for a person to check)

WHAT HAPPENS
  1. add:      every passage becomes one Cognee document, tagged with its passage ID and metadata
               (publisher, URL, the date the page shows as 'effective_date').
  2. cognify:  Cognee splits documents into chunks, embeds them with the local embedding model, and asks
               the frontier build model to extract entities and relationships into a knowledge graph.
  3. improve(review_conflicts=True): Cognee compares facts that come from different documents, using
               their dates, and records disputed ones. We export them; we do not let them change answers.
  The pack is never updated afterwards: a new library means a new build into a new folder.

USAGE
  uv run --env-file ../.env python build_pack.py --pack ../data/pack/library-v1
  Options: --limit N (first N passages, for tests)  --sources fda,cdc  --no-conflicts  --batch 40
           --resume   continue an interrupted build in the same folder (Cognee skips finished documents)
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from pack_config import DATASET, EMBEDDING_MODEL, configure


def doc_text(p: dict) -> str:
    """The text Cognee indexes for one passage. Title and heading are included so a passage that only
    says 'Do not drive through it' is still found for 'flood'. The passage text itself is unchanged."""
    where = "California" if p["jurisdiction"] == "CA" else "United States"
    return f"{p['pageTitle']}\n{p['heading']}\n\n{p['text']}\n\n(Source: {p['publisher']}; applies to: {where})"


async def build(args) -> dict:
    import cognee  # imported here, after configure() has set the environment
    from cognee.tasks.ingestion.data_item import DataItem

    passages = [json.loads(l) for l in open(args.passages)]
    if args.sources:
        keep = set(args.sources.split(","))
        passages = [p for p in passages if p["sourceId"] in keep]
    if args.limit:
        passages = passages[: args.limit]
    info: dict = {"startedAt": datetime.now(timezone.utc).isoformat(), "passages": len(passages),
                  "buildModel": os.environ.get("LLM_MODEL"), "llmArgs": os.environ.get("LLM_ARGS"),
                  "embeddingModel": EMBEDDING_MODEL, "dataset": DATASET, "timings": {}}
    print(f"building pack from {len(passages)} passages -> {args.pack}", flush=True)

    # 1. add ------------------------------------------------------------------------------------
    t = time.time()
    items = []
    for p in passages:
        items.append(DataItem(
            data=doc_text(p), label=p["id"], literal_text=True,
            external_metadata={"passage_id": p["id"], "url": p["url"], "publisher": p["publisher"],
                               "source_id": p["sourceId"], "jurisdiction": p["jurisdiction"],
                               "effective_date": p.get("pageDate") or p["fetchedAt"][:10]},
            node_set=[f"source:{p['sourceId']}", f"jurisdiction:{p['jurisdiction']}"] + [f"hazard:{h}" for h in p["hazards"]],
        ))
    for i in range(0, len(items), 200):
        await cognee.add(items[i:i + 200], dataset_name=DATASET)
    info["timings"]["add_s"] = round(time.time() - t, 1)
    print(f"add done in {info['timings']['add_s']} s", flush=True)

    # 2. cognify ----------------------------------------------------------------------------------
    t = time.time()
    await cognee.cognify(datasets=[DATASET], data_per_batch=args.batch, summary_method="from_extraction")
    info["timings"]["cognify_s"] = round(time.time() - t, 1)
    print(f"cognify done in {info['timings']['cognify_s']} s", flush=True)

    # Map Cognee's document IDs back to our passage IDs (search results carry the document ID).
    datasets = await cognee.datasets.list_datasets()
    ds = next(d for d in datasets if d.name == DATASET)
    rows = await cognee.datasets.list_data(ds.id)
    id_map = {}
    for r in rows:
        meta = r.external_metadata or {}
        if isinstance(meta, str):
            meta = json.loads(meta)
        if meta.get("passage_id"):
            id_map[str(r.id)] = meta["passage_id"]
    (Path(args.pack) / "doc-to-passage.json").write_text(json.dumps(id_map, indent=1))
    info["documents"] = len(id_map)

    # 3. conflict review -------------------------------------------------------------------------
    if not args.no_conflicts:
        t = time.time()
        try:
            result = await cognee.improve(dataset=DATASET, review_conflicts=True)
            info["improve"] = str(result)[:4000]
        except Exception as e:  # conflict review is a bonus; a failure must not lose the pack
            info["improveError"] = repr(e)[:2000]
        info["timings"]["conflict_review_s"] = round(time.time() - t, 1)
        print(f"conflict review done in {info['timings']['conflict_review_s']} s", flush=True)

    # Freeze the passages this pack was built from, so serve.py returns exactly these texts.
    with open(Path(args.pack) / "passages.jsonl", "w") as f:
        for p in passages:
            f.write(json.dumps(p) + "\n")
    info["finishedAt"] = datetime.now(timezone.utc).isoformat()
    return info


def main() -> int:
    ap = argparse.ArgumentParser(description="Build the static Cognee knowledge pack.")
    ap.add_argument("--corpus", default=os.environ.get("CORPUS_DIR"))
    ap.add_argument("--pack", required=True, help="output folder for the pack (must be new or empty)")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--sources", default="")
    ap.add_argument("--batch", type=int, default=40, help="documents cognify processes concurrently")
    ap.add_argument("--no-conflicts", action="store_true")
    ap.add_argument("--resume", action="store_true", help="continue an interrupted build in an existing pack folder")
    args = ap.parse_args()
    if not args.corpus:
        sys.exit("Set CORPUS_DIR or pass --corpus.")
    pack = Path(args.pack).expanduser().resolve()
    if pack.exists() and any(pack.iterdir()) and not args.resume:
        sys.exit(f"{pack} is not empty. Packs are never updated in place: build into a new folder.")
    args.pack = str(pack)
    args.passages = str(Path(args.corpus).expanduser() / "passages.jsonl")
    configure(pack, mode="build")
    info = asyncio.run(build(args))
    if args.resume:
        info["resumed"] = True  # add() is a no-op for documents already stored; cognify skips finished ones
    (pack / "build-info.json").write_text(json.dumps(info, indent=2))
    print(json.dumps(info["timings"]), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
