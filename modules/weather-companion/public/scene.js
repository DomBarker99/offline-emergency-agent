/* Shared scene adapter: the main demo supplies flood context; other hazards
   are manually selected fixtures in the animation studio, not API forecasts. */
(() => {
  const host = document.getElementById('weather-window');
  if (!host) return;
  const frame = document.createElement('iframe');
  frame.src = '/animation-studio?embed=1';
  frame.title = 'Animated weather window';
  frame.style.cssText = 'display:block;width:100%;aspect-ratio:1412/1114;border:0;background:#faf9f6';
  host.replaceChildren(frame);
  let ready = false;
  let state = { type:'weather-scene', stage:1, running:false, hours:0 };
  let lastClockBucket = -1;
  const send = () => { if (ready) frame.contentWindow.postMessage(state, location.origin); };
  frame.addEventListener('load', () => { ready = true; send(); });
  window.weatherScene = {
    update(context) {
      const stage = context?.stage?.level;
      if (![1,2,3].includes(stage)) return;
      if (state.stage !== stage) { state = {...state, stage}; send(); }
    },
    setRunning(running) {
      if (state.running !== !!running) { state = {...state, running:!!running}; send(); }
    },
    setClock(hours) {
      if (!Number.isFinite(hours)) return;
      // The parent renders its clock every frame. Send only minute-level updates.
      const bucket = Math.floor(hours * 60);
      if (bucket === lastClockBucket) return;
      lastClockBucket = bucket;
      state = {...state, hours:Math.max(0, Math.min(12, hours))}; send();
    }
  };
})();
