/**
 * Library search: find the official passages that best match a question. Runs inside the app, offline.
 *
 * How it works: every passage was turned once into a list of 384 numbers that captures its meaning
 * (an "embedding", made by `npm run embed`, saved in data/library/vectors.bin). At question time the
 * question is embedded with the same small model, and the passages whose numbers are closest win.
 * "Closest" = cosine similarity: the vectors are normalized, so it's a plain dot product.
 *
 * The model is BAAI/bge-small-en-v1.5 (about 130 MB), run by transformers.js on the CPU. Its files are
 * cached in data/models/ on first download; after that no internet is needed.
 */
import { readFileSync } from "node:fs";
import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

export const EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";
export const LIBRARY_DIR = new URL("../data/library/", import.meta.url);
env.cacheDir = new URL("../data/models/", import.meta.url).pathname;

/** One passage of official guidance (a line of passages.jsonl, written by knowledge/extract.py). */
export interface Passage {
  id: string; // stable ID, e.g. "ready-gov:floods:3"
  publisher: string;
  url: string;
  pageTitle: string;
  heading: string; // headings above the text on the page, e.g. "Floods > During a Flood"
  pageDate: string | null; // "last updated" date shown on the page, if any
  text: string; // the publisher's exact words
}

/** The text that gets embedded for a passage: title and heading add context the text alone lacks. */
export function embeddingText(p: Passage): string {
  return `${p.pageTitle}\n${p.heading}\n\n${p.text}`;
}

/** Loads the embedding model. `allowDownload` is only true for `npm run embed`; the app stays offline. */
export async function loadEmbedder(allowDownload = false): Promise<FeatureExtractionPipeline> {
  env.allowRemoteModels = allowDownload;
  return pipeline("feature-extraction", EMBEDDING_MODEL, { dtype: "fp32" });
}

/** Embeds texts into normalized vectors (CLS pooling, as recommended for BGE models). */
export async function embed(embedder: FeatureExtractionPipeline, texts: string[]): Promise<Float32Array[]> {
  const out = await embedder(texts, { pooling: "cls", normalize: true });
  const data = out.data as Float32Array;
  const dim = out.dims[1];
  return texts.map((_, i) => data.slice(i * dim, (i + 1) * dim));
}

/**
 * Loads data/library (passages + vectors) and returns a search function.
 * @throws if the library hasn't been built yet (run `npm run embed`)
 */
export async function loadLibrary() {
  const passages = readFileSync(new URL("passages.jsonl", LIBRARY_DIR), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Passage);
  const raw = readFileSync(new URL("vectors.bin", LIBRARY_DIR));
  const all = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const dim = all.length / passages.length;
  if (!Number.isInteger(dim)) throw new Error("vectors.bin doesn't match passages.jsonl; run npm run embed");
  const embedder = await loadEmbedder();

  /** The `limit` passages closest in meaning to `query`, best first. */
  async function search(query: string, limit: number): Promise<Passage[]> {
    const [q] = await embed(embedder, [query]);
    const scores = passages.map((_, i) => {
      let s = 0;
      for (let k = 0; k < dim; k++) s += all[i * dim + k] * q[k];
      return s;
    });
    return [...scores.keys()]
      .sort((a, b) => scores[b] - scores[a])
      .slice(0, limit)
      .map((i) => passages[i]);
  }

  return { passages, search };
}
