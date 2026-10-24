/**
 * Desktop app (Electron), main process: opens the window and answers its questions with ask().
 *
 * The agent runs right here in the main process (same code as the terminal chat, src/agent.ts).
 * The window (index.html + renderer.js) can't call it directly; it asks through the small bridge in
 * preload.cjs, and ipcMain.handle("ask") below does the work.
 *
 * Usage:  npm run app
 * Configuration comes from .env (pick one block there; a value set in the shell wins over .env):
 *   AGENT_PROVIDER=local|openrouter   where the model runs, fixed for this run (default local)
 *   LOCAL_BASE_URL / OPENROUTER_BASE_URL   optional: route model calls elsewhere (e.g. mitmproxy)
 *   AGENT_DEVTOOLS=1                  open Chromium DevTools next to the window
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

const root = new URL("../", import.meta.url);
try {
  process.loadEnvFile(new URL(".env", root));
} catch {
  // No .env: fine for the local model; OpenRouter will report the missing key when used.
}

// Imported after .env is loaded, because agent.ts reads the provider settings when it loads.
const { ask, PROVIDERS, stripCitations } = await import("../src/agent.ts");
type ProviderName = keyof typeof PROVIDERS;
type Turn = { role: "user" | "assistant"; text: string };

const provider = (process.env.AGENT_PROVIDER ?? "local") as ProviderName;

ipcMain.handle("info", () => ({
  provider,
  model: PROVIDERS[provider].model,
  endpoint: PROVIDERS[provider].baseURL,
}));
// The window gets only the answer text, without citation tags. Sources, dangers, flags and timing stay
// here and in the log (logs/turns-<date>.jsonl); nothing about them is shown in the chat.
ipcMain.handle("ask", async (_event, req: { question: string; history: Turn[] }) => {
  const turn = await ask(req.question, req.history, provider);
  return { answer: stripCitations(turn.answer) };
});

app.whenReady().then(() => {
  if (!(provider in PROVIDERS)) {
    dialog.showErrorBox("Configuration error", `AGENT_PROVIDER must be "local" or "openrouter" (got "${provider}"). Check .env.`);
    app.quit();
    return;
  }
  const win = new BrowserWindow({
    width: 900,
    height: 760,
    title: "Offline Emergency Agent",
    webPreferences: { preload: new URL("preload.cjs", import.meta.url).pathname, contextIsolation: true, sandbox: true },
  });
  // Source links open in the normal browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.loadFile(new URL("index.html", import.meta.url).pathname);
  if (process.env.AGENT_DEVTOOLS === "1") win.webContents.openDevTools({ mode: "detach" });
});

// Closing the window quits the app (also on macOS), so the launcher can clean up after it.
app.on("window-all-closed", () => app.quit());
