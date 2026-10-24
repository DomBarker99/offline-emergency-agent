/**
 * Desktop app (Electron), main process: opens the window and answers its questions with ask().
 *
 * The agent runs right here in the main process (same code as the terminal chat, src/agent.ts).
 * The window (index.html + renderer.js) can't call it directly; it asks through the small bridge in
 * preload.cjs, and ipcMain.handle("ask") below does the work.
 *
 * Usage:  npm run app
 * Modes, read from .env at startup (a value set in the shell wins over .env):
 *   AGENT_PROVIDER=local|openrouter   which model the window starts with (default local)
 *   AGENT_DEVTOOLS=1                  open Chromium DevTools next to the window
 *   LOCAL_BASE_URL / OPENROUTER_BASE_URL  route model calls elsewhere (e.g. through mitmproxy)
 */
import { app, BrowserWindow, ipcMain, shell } from "electron";

const root = new URL("../", import.meta.url);
try {
  process.loadEnvFile(new URL(".env", root));
} catch {
  // No .env: fine for the local model; OpenRouter will report the missing key when used.
}

// Imported after .env is loaded, because agent.ts reads the provider settings when it loads.
const { ask, PROVIDERS } = await import("../src/agent.ts");
type ProviderName = keyof typeof PROVIDERS;

const startProvider: ProviderName = process.env.AGENT_PROVIDER === "openrouter" ? "openrouter" : "local";

ipcMain.handle("info", () => ({
  provider: startProvider,
  endpoints: { local: PROVIDERS.local.baseURL, openrouter: PROVIDERS.openrouter.baseURL },
  devtools: process.env.AGENT_DEVTOOLS === "1",
}));
ipcMain.handle("ask", (_event, req: { question: string; history: { role: "user" | "assistant"; text: string }[]; provider: ProviderName }) =>
  ask(req.question, req.history, req.provider),
);

app.whenReady().then(() => {
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
