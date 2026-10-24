/**
 * Speech to text, one recording per run: reads audio on stdin, prints the text as JSON on stdout, exits.
 * Started by transcribe.ts for every dictation; not meant to be run by hand.
 *
 *   stdin   raw audio: 32-bit float samples, little-endian, mono, 16,000 per second
 *   stdout  {"text": "..."}            on success
 *           {"error": "..."}           on failure (exit code 1)
 *
 * The model is Whisper base.en (English, about 77 MB) run by transformers.js on the CPU, the same
 * library that runs the search model (search.ts). Its files live in data/models/ (not in git). If they
 * are missing they are downloaded once (needs internet); after that this works fully offline.
 *
 * Why a separate process: Whisper needs about 0.9 GB while it works and doesn't give that memory back.
 * A process that exits after each recording returns all of it, which matters next to a 15 GB local model.
 * Starting it, loading the model and transcribing a short sentence takes about 0.7 s on the demo laptop.
 */
import { existsSync } from "node:fs";
import { env, pipeline } from "@huggingface/transformers";

export const SPEECH_MODEL = "onnx-community/whisper-base.en";
env.cacheDir = new URL("../data/models/", import.meta.url).pathname;

/** Reads all of stdin into one Float32Array. */
async function readAudio(): Promise<Float32Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const bytes = Buffer.concat(chunks);
  // Copy into a fresh, aligned buffer: Float32Array needs a byte offset that is a multiple of 4.
  const aligned = new Uint8Array(bytes.length - (bytes.length % 4));
  aligned.set(bytes.subarray(0, aligned.length));
  return new Float32Array(aligned.buffer);
}

try {
  const audio = await readAudio();
  if (audio.length < 1600) throw new Error("recording too short"); // under 0.1 s
  const cached = existsSync(new URL(`../data/models/${SPEECH_MODEL}/onnx/encoder_model_quantized.onnx`, import.meta.url));
  env.allowRemoteModels = !cached; // offline once the files are there
  // "q8" = the 8-bit files: a quarter of the size of full precision, same words in our tests.
  const asr = await pipeline("automatic-speech-recognition", SPEECH_MODEL, { dtype: "q8" });
  const result = await asr(audio);
  const text = (Array.isArray(result) ? result[0]?.text : result.text) ?? "";
  process.stdout.write(JSON.stringify({ text: text.trim() }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
