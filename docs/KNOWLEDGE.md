# Knowledge: the library, the pack and the cards

How the agent knows things. Read this after [ARCHITECTURE.md](ARCHITECTURE.md).

## The big picture

The agent answers only from **official guidance collected ahead of time**. It never answers from what the language model happens to remember. Building that knowledge needs the internet and a strong model. Using it doesn't need either.

```
ONLINE: build once (needs internet)                               OFFLINE: every question
───────────────────────────────────────────                       ──────────────────────────────────────────
official websites (Ready.gov, CDC, NWS, FDA, Cal OES, ...)
   │ knowledge/collect.py        capture pages as published
   ▼
corpus/raw/<source>/<page>/      page.pdf (to look at), page.md (text), meta.json (dates, checks)
   │ knowledge/extract.py        split into passages, tag topics
   ▼
corpus/passages.jsonl            ~2,000 passages in the publishers' own words
   │ knowledge/build_pack.py     Cognee: embeddings (local model) + knowledge graph (build model)
   ▼
data/pack/<version>/             static pack: database files, never edited  ──►  knowledge/serve.py
   │ knowledge/draft_cards.py    pick verbatim sentences for each danger           (search only, no LLM,
   ▼                                                                                 127.0.0.1:8788)
data/cards/library-cards.json    action cards, reviewed by a person                        │
                                                                                            ▼
                                                     question → safety router → CogneeStore (src/core/knowledge-cognee.ts)
                                                              → cards + passages → local model → cited answer
```

## Three kinds of knowledge

| Kind | Where | Trusted because | Used how |
| --- | --- | --- | --- |
| **Library passages** | `corpus/passages.jsonl`, searched through the pack | Only allowlisted official publishers (`knowledge/sources.json`), copied word for word | Retrieved per question. The model cites them as `[L1]`, `[L2]`... |
| **Action cards** | `data/cards/library-cards.json` | Sentences selected from passages, checked verbatim by a script, then reviewed by a person (`"reviewed": true`) | Pinned by the safety router when a danger is detected. Cited as `[C1]`... |
| **Household profile** | `data/demo/profile.json` | The user's own records | Included in every prompt |

The knowledge graph Cognee builds is **not** a fourth source of facts. The build model writes its entity descriptions, so nobody has checked them. The graph only helps search find the right passages. The model is always given the original passage text.

## Why Cognee, and how it's configured

[Cognee](https://github.com/topoteretes/cognee) turns documents into a knowledge graph plus vector indexes, stored in embedded files (SQLite, LanceDB, a Ladybug/Kuzu graph). No database server is needed. Its Python SDK also has a conflict review step and records which chunk supports each graph link.

All Cognee settings are in one file, `knowledge/pack_config.py`:

- **Static pack.** Self-improvement, feedback learning, session memory and "improve after remember" are off. The app never writes to the pack.
- **Local embeddings.** `BAAI/bge-small-en-v1.5` through fastembed (about 67 MB, CPU). It is used both to build the pack and to search it, so search works offline. The model downloads once into the Hugging Face cache.
- **Build model.** Any OpenAI-compatible endpoint, set by `BUILD_LLM_BASE_URL`, `BUILD_LLM_API_KEY`, `BUILD_LLM_MODEL` and `BUILD_LLM_REASONING_EFFORT` in `.env`. The model must support structured (JSON schema) output. It is used only at build time.
- **Serving has no LLM.** `serve.py` configures an unreachable LLM on purpose, so any code path that tried to call one would fail instead of reaching the internet.
- **Telemetry and multi-user access control are off.**

## How search works (`knowledge/serve.py`)

Every search runs three methods over the pack and merges their rankings with Reciprocal Rank Fusion. A passage that ranks high on several lists wins.

1. **Meaning (vector):** the question is embedded and compared with every passage.
2. **Words (lexical):** BM25-style keyword ranking.
3. **Graph:** the question is matched against the graph's entity names, for example "dog" matches "pets" and "pet carrier". Passages that mention those entities are added.

A short follow-up such as "What about the dog?" is searched together with the previous question (`retrievalQuery()` in `src/core/agent.ts`).

## Running it

```sh
# one-time: Python tooling (uv) and the locally installed Google Chrome are required
cd knowledge && uv sync && cd ..

# 1. collect, 2. extract (CORPUS_DIR in .env points at the corpus folder)
cd knowledge
uv run --env-file ../.env python collect.py            # --only cdc,nws  --force  --report-only
uv run --env-file ../.env python extract.py
# 3. build a NEW pack folder (packs are never updated in place)
uv run --env-file ../.env python build_pack.py --pack ../data/pack/library-v1
# 4. draft action cards for review
uv run --env-file ../.env python draft_cards.py --out ../data/cards/library-cards.json
cd ..

# use it
npm run knowledge                                  # search service on 127.0.0.1:8788 (KNOWLEDGE_PACK=...)
KNOWLEDGE_BACKEND=cognee npm run chat -- --provider openrouter
KNOWLEDGE_BACKEND=cognee npm run serve

# measure it
npm run bench -- --part retrieval --passages data/pack/library-v1/passages.jsonl
npm run bench -- --part agent --provider openrouter --backends demo,cognee
```

## Reviewing cards

Each card in `data/cards/library-cards.json` lists its `quotes`: every sentence, with the passage ID and URL it came from. To review one:

1. Read each quote on the original page.
2. Check that the card puts the protective action first and leaves nothing important out.
3. Set `"reviewed": true`. Delete quotes you don't want. Never add your own words.

## Evaluation questions

`data/eval/questions.json` holds the benchmark questions. Each has its known good source pages (`gold`), and some have phrases a good answer usually contains (`expectAny`). There are three types: answerable, follow-up (with an earlier turn) and out-of-scope (the agent must say it doesn't know). Add a question whenever you find a failure.
