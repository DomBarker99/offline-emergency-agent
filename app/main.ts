/**
 * Desktop app (Electron): the weather companion in a window, answered by the shared agent.
 *
 *   Electron main process (this file)
 *     ├─ loads .env (the settings below)
 *     ├─ starts the companion server in this process: modules/weather-companion/src/server.ts on 127.0.0.1:4317
 *     │     /companion      the page            /v2/context   simulated weather
 *     │     /api/chat  ──►  chat.ts ──► ask() in src/agent.ts (library search, cards, profile, medical limit)
 *     │     /api/pack       browse the saved guidance
 *     └─ opens a window on http://127.0.0.1:4317/companion?view=…&scenario=…&provider=…
 *
 * Usage:  npm run app   (or double-click the launcher)
 * Settings, read from .env at startup (a value set in the shell wins over .env):
 *   AGENT_PROVIDER  local | openrouter      model used while online (offline always uses local)
 *   AGENT_VIEW      production | demo       demo adds the scenario, playback and "Simulate offline" controls
 *   AGENT_SCENARIO  flood | fire | earthquake | outage | heat
 *   AGENT_DEVTOOLS=1                        open Chromium DevTools next to the window
 */
import { createConnection } from "node:net";
import { app, BrowserWindow, dialog, shell } from "electron";

const root = new URL("../", import.meta.url);
try {
  process.loadEnvFile(new URL(".env", root));
} catch {
  // No .env: the defaults below apply (local model, production view, flood).
}

const PORT = 4317;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const settings = {
  provider: process.env.AGENT_PROVIDER ?? "local",
  view: process.env.AGENT_VIEW ?? "production",
  scenario: process.env.AGENT_SCENARIO ?? "flood",
};
const allowed: Record<keyof typeof settings, string[]> = {
  provider: ["local", "openrouter"],
  view: ["production", "demo"],
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
  for (let i = 0; i < 100; i++) {
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
    return fail(`Port ${PORT} is already in use, probably by the weather companion started from a terminal. Stop it and open the app again.`);
  }
  // Start the companion server inside this process. The path is built at runtime on purpose, so the
  // TypeScript check of the app doesn't also type-check the companion module.
  process.env.PORT = String(PORT);
  await import(new URL("../modules/weather-companion/src/server.ts", import.meta.url).href);
  await waitForServer();

  const win = new BrowserWindow({
    width: 1320,
    height: 880,
    title: "Offline Emergency Agent",
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  // Source links and the companion's other pages open in the normal browser; the window stays on the companion.
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
  const query = new URLSearchParams(settings).toString();
  win.loadURL(`${ORIGIN}/companion?${query}`);
  if (process.env.AGENT_DEVTOOLS === "1") win.webContents.openDevTools({ mode: "detach" });
});

// Closing the window quits the app, which also stops the companion server.
app.on("window-all-closed", () => app.quit());
