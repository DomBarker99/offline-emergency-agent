# Knowledge: the library and the cards

How the agent knows things. Read this after [ARCHITECTURE.md](ARCHITECTURE.md).

## The big picture

The agent answers only from **official guidance collected ahead of time**, never from what the language model happens to remember. Building the library needs the internet. Using it doesn't.

```
ONLINE: build (Python tools in knowledge/, only when sources change)       OFFLINE: every question (TypeScript)
official websites (Ready.gov, CDC, NWS, FDA, Cal OES, ...)
   │ collect.py        capture pages as published  → corpus/raw/<source>/<page>/
   │ extract.py        split into passages, tag topics → corpus/passages.jsonl
   │ build_pack.py     Cognee: knowledge graph (build model) ─┐
   │ review_conflicts.py  where sources disagree → CONFLICTS.md ┘ (for people, not used to answer)
   │ draft_cards.py    verbatim action cards → data/cards/library-cards.json (reviewed by a person)
   ▼
 npm run embed      passages → data/library/ (passages + vectors)  ──►  src/search.ts → src/agent.ts
```

## Two kinds of knowledge

| Kind | Where | Trusted because | Used how |
| --- | --- | --- | --- |
| **Library passages** | `data/library/passages.jsonl` | Only allowlisted official publishers (`knowledge/sources.json`), copied word for word | The 5 closest passages per question, cited as `[L1]`…`[L5]` |
| **Action cards** | `data/cards/library-cards.json` | Sentences selected from passages, checked word for word by a script, then reviewed by a person (`"reviewed": true`) | Forced in by the danger rules, cited as `[C1]`… |

The household profile (`data/demo/profile.json`) is added to every prompt.

## Search (`src/search.ts`)

Each passage (page title + heading + text) is turned into 384 numbers that capture its meaning, using BAAI/bge-small-en-v1.5 through transformers.js on the CPU. A question is turned into numbers the same way, and the passages with the highest cosine similarity win. About 4 ms per question for 2,140 passages.

On the 44 evaluation questions with known sources, the right source was in the top 5 every time and ranked first 82% of the time. The earlier design, a separate Cognee search service, scored 100% and 84%. Cognee's graph and keyword modes and their combination scored lower, so search is meaning-only.

## Where Cognee fits

[Cognee](https://github.com/topoteretes/cognee) builds a knowledge graph from the library at build time (`knowledge/build_pack.py`, settings in `knowledge/pack_config.py`): a frontier model extracts entities and relationships from every passage, with local embeddings. The graph feeds **conflict review** (`knowledge/review_conflicts.py`), which lists claims that differ between sources (`corpus/CONFLICTS.md`) for a person to settle. The graph is not used to answer questions.

## Commands

```sh
# Python tools (need uv; Google Chrome for collecting). From knowledge/:
uv sync
uv run --env-file ../.env python collect.py            # --only cdc,nws  --force  --report-only
uv run --env-file ../.env python extract.py
uv run --env-file ../.env python build_pack.py --pack ../data/pack/<new-folder>
uv run --env-file ../.env python review_conflicts.py --pack ../data/pack/<folder> --max-minutes 60 --max-mentions 40 --shard 10
uv run --env-file ../.env python draft_cards.py --out ../data/cards/<new-file>.json   # don't overwrite reviewed cards

# Then, from the repo root:
npm run embed            # reads $CORPUS_DIR/passages.jsonl, writes data/library/
npm run bench -- --retrieval-only
```

## Reviewing cards

Each card in `data/cards/library-cards.json` lists its `quotes`: every sentence, with the passage ID and URL it came from. To review one:

1. Read each quote on the original page.
2. Check the card puts the protective action first and leaves nothing important out.
3. Set `"reviewed": true`. Delete quotes you don't want. Never add your own words.

## Evaluation questions

`data/eval/questions.json`: each question has its known good source pages (`gold`), and some have phrases a good answer usually contains (`expectAny`). There are three types: answerable, follow-up (with an earlier turn) and out-of-scope (the agent must say it doesn't know). Add a question whenever you find a failure.
