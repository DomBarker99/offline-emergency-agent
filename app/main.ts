/**
 * Desktop app (Electron): the companion screen in a window, answered by the shared agent.
 *
 *   Electron main process (this file)
 *     ├─ loads .env (the settings below)
 *     ├─ starts the companion server in this process: modules/weather-companion/src/server.ts on 127.0.0.1:4317
 *     │     /companion   the screen          /api/feed     the emergency (live while there is internet)
 *     │     /api/chat ──► chat.ts ──► ask() in src/agent.ts (library search, cards, profile, medical limit)
 *     │     /api/transcribe ──► Whisper on this laptop (src/transcribe.ts)
 *     └─ opens a window on http://127.0.0.1:4317/companion
 *
 * Usage:  npm run app   (or double-click the launcher)
 * Settings, read from .env at startup (a value set in the shell wins over .env):
 *   AGENT_PROVIDER  openrouter | local      model used while online (offline always uses the local model)
 *   AGENT_SCENARIO  flood | fire | earthquake | outage | heat     the active emergency the app opens on
 *   AGENT_LOCAL_MODEL  gemma4-26b-a4b (default) | granite4.2-8b   the model the local server runs
 *   AGENT_DEVTOOLS=1                        open Chromium DevTools next to the window
 * Presenter key: Ctrl+Shift+O in the window switches "simulate offline" on and off (handled by the page).
 */
import { createConnection } from "node:net";
import { app, BrowserWindow, dialog, session, shell } from "electron";

const root = new URL("../", import.meta.url);
try {
  process.loadEnvFile(new URL(".env", root));
} catch {
  // No .env: the defaults below apply (local model, flood).
}

const PORT = 4317;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const settings = {
  provider: process.env.AGENT_PROVIDER ?? "local",
  scenario: process.env.AGENT_SCENARIO ?? "flood",
};
const allowed: Record<keyof typeof settings, string[]> = {
  provider: ["local", "openrouter"],
  scenario: ["flood", "fire", "earthquake", "outage", "heat"],
};

/** True when something already listens on the port (e.g. `npm run weather:demo` in a terminal). */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
  });
}

/** Waits until the companion server answers /health (it loads the library first). */
async function waitForServer(): Promise<void> {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`${ORIGIN}/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("The companion server did not start.");
}

function fail(message: string): void {
  dialog.showErrorBox("Offline Emergency Agent", message);
  app.quit();
}

app.whenReady().then(async () => {
  for (const key of Object.keys(settings) as (keyof typeof settings)[]) {
    if (!allowed[key].includes(settings[key])) {
      return fail(`AGENT_${key.toUpperCase()} must be one of: ${allowed[key].join(", ")} (got "${settings[key]}"). Check .env.`);
    }
  }
  if (await portInUse(PORT)) {
    return fail(`Port ${PORT} is already in use, probably by the companion started from a terminal. Stop it and open the app again.`);
  }

  // Microphone for dictation: allowed for our own page only, and only audio. Electron would otherwise
  // grant every permission request. (macOS still asks the person once, the first time.)
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const ours = details.requestingUrl.startsWith(ORIGIN);
    const audioOnly = permission === "media" && "mediaTypes" in details && (details.mediaTypes ?? []).every((t) => t === "audio");
    callback(ours && audioOnly);
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => permission === "media" && requestingOrigin === ORIGIN);

  // Start the companion server inside this process. The path is built at runtime on purpose, so the
  // TypeScript check of the app doesn't also type-check the companion module.
  process.env.PORT = String(PORT);
  process.env.AGENT_PROVIDER = settings.provider;
  process.env.AGENT_SCENARIO = settings.scenario;
  await import(new URL("../modules/weather-companion/src/server.ts", import.meta.url).href);
  await waitForServer();

  const win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 720,
    minHeight: 600,
    title: "Offline Emergency Agent",
    backgroundColor: "#f6f5f0",
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false },
  });
  // Links (the official source pages, the support contact's phone number) open outside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${ORIGIN}/companion`)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  win.loadURL(`${ORIGIN}/companion`);
  if (process.env.AGENT_DEVTOOLS === "1") win.webContents.openDevTools({ mode: "detach" });
});

// Closing the window quits the app, which also stops the companion server.
app.on("window-all-closed", () => app.quit());
