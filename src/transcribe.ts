/**
 * Dictation: turns a recording into text, offline. Used by the app's POST /api/transcribe.
 *
 *   companion.html records the microphone ──► POST /api/transcribe (raw 16 kHz float samples)
 *       └─► transcribe(samples) starts transcribe-worker.ts as a short-lived process
 *             └─► Whisper base.en ──► {"text": "..."} ──► back to the page, into the message box
 *
 * Usage:  const text = await transcribe(samples)   // samples: Float32Array, mono, 16,000 per second
 *
 * Under Electron, process.execPath is the Electron program, not Node. ELECTRON_RUN_AS_NODE=1 makes it
 * behave like plain Node for the child, so the same code works in the app, in tests and from a terminal.
 */
import { spawn } from "node:child_process";

export const SAMPLE_RATE = 16_000;
export const MAX_SECONDS = 30; // Whisper reads 30-second windows; the page stops recording at this length

const WORKER = new URL("./transcribe-worker.ts", import.meta.url).pathname;

/**
 * @returns the words heard (may be empty for silence)
 * @throws if the recording is longer than MAX_SECONDS, or the worker fails (model missing while offline, ...)
 */
export function transcribe(samples: Float32Array, timeoutMs = 60_000): Promise<string> {
  if (samples.length > SAMPLE_RATE * MAX_SECONDS) {
    return Promise.reject(new Error(`recording longer than ${MAX_SECONDS} s`));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs, // kills a stuck worker
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", () => {
      try {
        const result = JSON.parse(out) as { text?: string; error?: string };
        if (typeof result.text === "string") resolve(result.text);
        else reject(new Error(result.error ?? "transcription failed"));
      } catch {
        reject(new Error(`transcription failed: ${err.trim().split("\n").at(-1) ?? "no output"}`));
      }
    });
    // Send the samples as raw bytes, then close stdin so the worker knows the recording is complete.
    child.stdin.end(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  });
}
