/**
 * Connectivity: is there internet right now? The answer drives the app's online/offline switch.
 *
 *   server.ts starts one monitor ──► every few seconds: a tiny HEAD request to the online model's server
 *                                     any HTTP answer = internet; network error or timeout = no internet
 *   /api/status reports it ──► companion.html shows Live / Offline
 *   feed.ts delivers emergency updates only while it says "online"
 *   chat.ts sends questions to the local model while it says "offline"
 *
 * Why a probe and not just the browser's navigator.onLine: navigator.onLine only knows whether a network
 * interface is up. With Wi-Fi connected but the internet down (a dead router, a hotel login page) it still
 * says "online". The page uses navigator.onLine too, for an instant reaction when Wi-Fi is switched off.
 *
 * "Simulate offline" (the hidden presenter key) sets a flag here, so the whole app (feed, chat, page)
 * behaves exactly as if the internet were gone, without touching Wi-Fi.
 */

/** What the rest of the server reads. */
export interface ConnectivityState {
  internet: boolean; // the last probes reached the internet
  simulatedOffline: boolean; // the presenter pressed the hidden key
  online: boolean; // internet && !simulatedOffline: the one value everything else should use
  checkedAt: string | null; // when the last probe finished (ISO time)
}

export interface MonitorOptions {
  probeUrl?: string; // default: the online model's server
  intervalMs?: number; // time between probes
  timeoutMs?: number; // a probe slower than this counts as "no internet"
  failuresToGoOffline?: number; // consecutive failed probes before switching to offline (one slow probe on bad Wi-Fi shouldn't flip the screen)
  probe?: (url: string, timeoutMs: number) => Promise<boolean>; // replaceable for tests
}

/** One probe: any HTTP response (even 404) proves the internet is reachable. */
async function httpProbe(url: string, timeoutMs: number): Promise<boolean> {
  try {
    await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts probing right away and keeps going until stop() is called.
 * Starts out as "online" so a normal launch doesn't flash an offline banner before the first probe.
 */
export function createConnectivityMonitor(options: MonitorOptions = {}) {
  const probeUrl = options.probeUrl ?? "https://openrouter.ai/";
  const intervalMs = options.intervalMs ?? 3000;
  const timeoutMs = options.timeoutMs ?? 2500;
  const failuresToGoOffline = options.failuresToGoOffline ?? 2;
  const probe = options.probe ?? httpProbe;

  let internet = true;
  let failures = 0;
  let simulatedOffline = false;
  let checkedAt: string | null = null;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  /** Runs one probe and updates the state. Exposed so tests (and a fresh page) don't have to wait. */
  async function check(): Promise<ConnectivityState> {
    const ok = await probe(probeUrl, timeoutMs);
    failures = ok ? 0 : failures + 1;
    if (ok) internet = true;
    else if (failures >= failuresToGoOffline) internet = false;
    checkedAt = new Date().toISOString();
    return state();
  }

  function state(): ConnectivityState {
    return { internet, simulatedOffline, online: internet && !simulatedOffline, checkedAt };
  }

  // setTimeout after each probe (not setInterval), so a slow probe never overlaps the next one.
  async function loop() {
    await check();
    if (!stopped) timer = setTimeout(loop, intervalMs);
    timer?.unref(); // don't keep the process alive just for probing
  }
  void loop();

  return {
    state,
    check,
    setSimulatedOffline(value: boolean) {
      simulatedOffline = value;
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

export type ConnectivityMonitor = ReturnType<typeof createConnectivityMonitor>;
