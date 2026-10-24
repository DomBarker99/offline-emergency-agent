/**
 * One-time build step: copy the library's passages into data/library/ and embed them for search.
 *
 * Usage:  npm run embed                        (reads $CORPUS_DIR/passages.jsonl)
 *         npm run embed -- path/to/passages.jsonl
 * Needs internet the first time only, to download the embedding model (~130 MB into data/models/).
 * Takes about 1.5 minutes for ~2,000 passages. Rerun whenever passages.jsonl changes.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { embed, EMBEDDING_MODEL, embeddingText, LIBRARY_DIR, loadEmbedder, type Passage } from "./search.ts";

const source = process.argv[2] ?? (process.env.CORPUS_DIR && join(process.env.CORPUS_DIR, "passages.jsonl"));
if (!source) throw new Error("Pass a passages.jsonl path or set CORPUS_DIR in .env");

mkdirSync(LIBRARY_DIR, { recursive: true });
copyFileSync(source, new URL("passages.jsonl", LIBRARY_DIR));
const passages = readFileSync(source, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Passage);

const embedder = await loadEmbedder(true);
const started = performance.now();
const vectors: Float32Array[] = [];
for (let i = 0; i < passages.length; i += 32) {
  vectors.push(...(await embed(embedder, passages.slice(i, i + 32).map(embeddingText))));
  process.stdout.write(`\rembedded ${vectors.length}/${passages.length}`);
}

// One flat file of float32 numbers, passage after passage, in passages.jsonl order.
const flat = new Float32Array(vectors.length * vectors[0].length);
vectors.forEach((v, i) => flat.set(v, i * v.length));
writeFileSync(new URL("vectors.bin", LIBRARY_DIR), Buffer.from(flat.buffer));
writeFileSync(
  new URL("library.json", LIBRARY_DIR),
  JSON.stringify({ source, passages: passages.length, model: EMBEDDING_MODEL, builtAt: new Date().toISOString() }, null, 2),
);
console.log(`\ndone in ${Math.round((performance.now() - started) / 1000)} s -> ${LIBRARY_DIR.pathname}`);
