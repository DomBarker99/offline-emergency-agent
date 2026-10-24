(() => {
  const $ = s => document.querySelector(s);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let hazard = 'flood', stage = 1, playing = true, loops;
  let renderedHazard = null;
  const copy = {
    flood: [['A quiet stretch.', 'A soft sky and a little rain.'], ['Rain is building.', 'Closer clouds, steadier rainfall, and water beginning to rise.'], ['Flooding is occurring.', 'The water reaches the foreground. The scene stays calm; the status stays clear.']],
    fire: [['A clear afternoon.', 'A familiar view with clear air.'], ['Fire risk is elevated.', 'A warmer, drier landscape. No flames before a fire is confirmed.'], ['A wildfire is active.', 'The simulated fire spreads down the hillside, then holds. Replay restarts the sequence.']],
    earthquake: [['A still moment.', 'A quiet home on steady ground.'], ['Time to prepare.', 'A readiness state—not a prediction that an earthquake is approaching.'], ['Shaking has been detected.', 'The ground shakes and a small crack opens in the path. Replay to view it again.']],
    outage: [['The lights are on.', 'Warm little windows and a softly lit street.'], ['An outage is possible.', 'The evening view remains lit. The text carries the early warning.'], ['The power is out.', 'The streetlamp and house windows go dark. The scene remains visible.']],
    heat: [['A comfortable day.', 'Soft sunlight and a quiet garden.'], ['The heat is building.', 'A stronger sun and a subtle upward shimmer.'], ['Extreme heat is occurring.', 'A warm, still afternoon with a clearer heat shimmer.']]
  };
  // Stable variation keeps replay deterministic without synchronized sheets of rain.
  const drops = Array.from({length:36}, (_,i) => ({
    x: 20 + (i * 97) % 660,
    phase: ((i * 0.61803398875) % 1),
    length: 9 + (i % 4) * 2,
    opacity: .32 + (i % 5) * .09,
    speed: .88 + (i % 7) * .04
  }));
  $('#rain').innerHTML = drops.map((d,i)=>`<path class="drop" d="M${d.x} 0l-1.6 ${d.length}" stroke-width="${1 + (i % 3) * .25}" opacity="${d.opacity}" transform="translate(${-45*d.phase} ${400*d.phase})"/>`).join('');
  function draw() {
    gsap.globalTimeline.resume();
    loops?.revert();
    loops=null;
    gsap.killTweensOf('*');
    const changedHazard = renderedHazard !== hazard;
    renderedHazard = hazard;
    const animate = playing && !reduce.matches && !document.hidden;
    const duration = animate && !changedHazard ? .65 : 0;
    const set = (target,values) => { const nodes = document.querySelectorAll(target); if(nodes.length) gsap.to(nodes,{...values,duration,overwrite:true}); };
    // An inactive hazard must disappear immediately, not ghost behind the next label.
    const visible = (target,opacity) => opacity === 0 ? gsap.set(target,{opacity:0}) : set(target,{opacity});
    const night = hazard === 'outage';
    const hot = hazard === 'heat' || hazard === 'fire';
    set('#weather-tint',{attr:{fill:night?'#203a59':hot?'#e6a856':'#64839a'},opacity:night?[.28,.32,.6][stage-1]:stage===1?0:hot?[0,.04,.06][stage-1]:hazard==='flood'?[0,.12,.24][stage-1]:0});
    visible('#rain',hazard==='flood'?[.14,.55,.85][stage-1]:0);
    if(hazard!=='flood'||stage===1) gsap.set('#flood-water',{y:402});
    else set('#flood-water',{y:stage===2?365:308});
    visible('#smoke',hazard==='fire'&&stage===3?1:0);
    visible('#flames',hazard==='fire'&&stage===3?1:0);
    gsap.set('#fire-foreground-art',{opacity:hazard==='fire'&&stage===3?1:0});
    visible('#heat-lines',hazard==='heat'?[0,.35,.65][stage-1]:0);
    visible('#outage-lights',night&&stage===3?1:0);
    visible('#ground-crack',hazard==='earthquake'&&stage===3?1:0);
    gsap.set('#quake-art',{x:0,y:0});
    $('#headline').textContent=copy[hazard][stage-1][0];
    $('#description').textContent=copy[hazard][stage-1][1];
    $('#stage-label').textContent=`Stage ${stage} · ${['Steady','Prepare','Event'][stage-1]}`;
    $('.dot').style.background=['#7eaa92','#c9aa6b','#bd876b'][stage-1];
    $('#scene-title').textContent=`${hazard}: ${copy[hazard][stage-1][0]}`;
    document.querySelectorAll('[data-stage]').forEach(b=>b.setAttribute('aria-pressed',Number(b.dataset.stage)===stage));
    document.querySelectorAll('[data-hazard]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.hazard===hazard));
    $('#play').textContent=reduce.matches?'Reduced motion':playing?'Pause motion':'Play motion';
    $('#play').disabled=reduce.matches;
    $('#play').setAttribute('aria-pressed',playing&&!reduce.matches);
    // Final pose is also the reduced-motion view: no information relies on motion.
    document.querySelectorAll('.fire-advance').forEach((front,i)=>gsap.set(front,{y:12+Math.pow(i/10,1.5)*155}));
    gsap.set('#burn-scar',{attr:{d:'M941 520Q1160 532 1412 580L1412 745Q1190 649 941 539Z'}});
    gsap.set('#burn-edge',{attr:{d:'M941 539Q1190 649 1412 745'}});
    if (!animate) return;
    loops = gsap.context(()=>{
      if(hazard==='flood') {
        document.querySelectorAll('.drop').forEach((drop,i)=>{
          const d = drops[i];
          const duration = [2.8,2.2,1.8][stage-1] * d.speed;
          const fall = gsap.timeline({repeat:-1});
          fall.fromTo(drop,{x:0,y:-24},{x:-45,y:402,duration,ease:'none'},0)
            .fromTo(drop,{opacity:0},{opacity:d.opacity,duration:duration*.12,ease:'sine.inOut'},0)
            .to(drop,{opacity:0,duration:duration*.18,ease:'sine.inOut'},duration*.82);
          // Seed every loop at a different point; wrap only after fading out.
          fall.progress(d.phase);
        });
        gsap.to('#ripples',{x:20,duration:3,repeat:-1,yoyo:true,ease:'sine.inOut'});
      }
      if(hazard==='fire'&&stage===3){
        const spread = gsap.timeline();
        spread.fromTo('#burn-scar',{attr:{d:'M941 520Q1160 532 1412 580L1412 580Q1190 536 941 520Z'}},
          {attr:{d:'M941 520Q1160 532 1412 580L1412 745Q1190 649 941 539Z'},duration:9,ease:'sine.inOut'},3);
        spread.fromTo('#burn-edge',{attr:{d:'M941 520Q1190 536 1412 580'}},
          {attr:{d:'M941 539Q1190 649 1412 745'},duration:9,ease:'sine.inOut'},3);
        document.querySelectorAll('.fire-advance').forEach((front,i)=>{
          spread.fromTo(front,{y:0},{y:12+Math.pow(i/10,1.5)*155,duration:9,ease:'sine.inOut'},3);
          spread.fromTo(front,{scaleY:.35},{scaleY:1,transformOrigin:'50% 100%',duration:2.6,ease:'sine.out'},i*.09);
        });
        document.querySelectorAll('.puff').forEach((puff,i)=>{
          gsap.fromTo(puff,{x:-5,y:6},{x:12,y:-17,duration:4.5+i*.8,repeat:-1,yoyo:true,ease:'sine.inOut'});
        });
        document.querySelectorAll('.flame').forEach((flame,i)=> {
          gsap.set(flame,{transformOrigin:'50% 100%'});
          const flicker=gsap.timeline({repeat:-1});
          flicker.to(flame,{scaleY:.82,skewX:-3,duration:.6+(i%3)*.1,ease:'sine.inOut'})
            .to(flame,{scaleY:1.06,skewX:3,duration:.75+(i%4)*.09,ease:'sine.inOut'})
            .to(flame,{scaleY:.94,skewX:-1,duration:.65,ease:'sine.inOut'});
          flicker.progress((i*.618)%1);
        });
      }
      if(hazard==='heat'&&stage>1) gsap.to('.heat-line',{y:-7,duration:2.1,stagger:.3,repeat:-1,yoyo:true,ease:'sine.inOut'});
      if(hazard==='earthquake'&&stage===3) {
        // Only the artwork inside the fixed frame moves. A finite, damped burst
        // avoids suggesting that shaking continues after the fixture event.
        gsap.fromTo('#crack-reveal',{attr:{height:0}},{attr:{height:175},delay:.35,duration:.95,ease:'power1.inOut'});
        const shake = gsap.timeline({delay:.15});
        [[9,1,.10],[-12,-2,.10],[14,2,.09],[-14,0,.10],
         [12,-1,.11],[-11,2,.12],[9,0,.13],[-7,-1,.14],
         [5,1,.16],[-3,0,.18],[1,0,.20],[0,0,.25]]
          .forEach(([x,y,duration]) => shake.to('#quake-art',{x,y,duration,ease:'sine.inOut'}));
      }
    });
  }
  let requestedHazard=hazard, requestedSeconds=0, requestVersion=0, pendingController, receivedContext=false;
  let lastFeedTick=performance.now();
  const embedded=new URLSearchParams(location.search).has('embed');
  async function loadContext() {
    const version=++requestVersion;
    pendingController?.abort();const controller=new AbortController();pendingController=controller;
    const timeout=setTimeout(()=>controller.abort(),5000);
    const url='/v2/context?hazard='+encodeURIComponent(requestedHazard)+'&seconds='+requestedSeconds;
    $('#feed-status').textContent='Reading simulated feeds…';
    try {
      const response=await fetch(url,{signal:controller.signal,cache:'no-store'});
      if(!response.ok)throw Error('Feed request failed');
      const packet=await response.json();
      if(version!==requestVersion)return;
      if(packet.schemaVersion!=='2.0.0'||packet.hazard!==requestedHazard||![1,2,3].includes(packet.stage?.level)||!packet.scene?.available)throw Error('Assessment unavailable');
      const changed=!receivedContext||hazard!==packet.hazard||stage!==packet.stage.level;
      receivedContext=true;hazard=packet.hazard;stage=packet.stage.level;
      $('.window').style.visibility='visible';
      if(changed)draw();
      $('#feed-status').textContent='Simulation · '+packet.records.length+' evidence records · '+packet.asOf+' · '+packet.quality.validity;
      $('#feed-json').href=url;
      $('#feed-packet').textContent=JSON.stringify(packet,null,2);
      window.dispatchEvent(new CustomEvent('weather:context',{detail:packet}));
    } catch(error) {
      if(version!==requestVersion)return;
      receivedContext=false;
      $('.window').style.visibility='hidden';
      $('#headline').textContent='Conditions unavailable';
      $('#description').textContent='The context feed could not be validated. Retry by selecting a scenario.';
      $('#stage-label').textContent='No current assessment';
      $('#feed-status').textContent='Feed unavailable — previous readings must not be treated as current.';
      $('#feed-packet').textContent='';
    } finally {clearTimeout(timeout);if(version===requestVersion)pendingController=null;}
  }
  document.querySelectorAll('[data-hazard]').forEach(b=>b.onclick=()=>{requestedHazard=b.dataset.hazard;lastFeedTick=performance.now();loadContext()});
  document.querySelectorAll('[data-stage]').forEach(b=>b.onclick=()=>{requestedSeconds=({1:0,2:100,3:200})[Number(b.dataset.stage)];lastFeedTick=performance.now();loadContext()});
  function setPlayback(value) {
    if(value&&!playing&&!loops){playing=true;draw();}
    lastFeedTick=performance.now();
    playing = value;
    if(playing && !reduce.matches && !document.hidden) gsap.globalTimeline.resume();
    else gsap.globalTimeline.pause();
    $('#play').textContent=reduce.matches?'Reduced motion':playing?'Pause motion':'Play motion';
    $('#play').setAttribute('aria-pressed',playing&&!reduce.matches);
  }
  $('#play').onclick=()=>setPlayback(!playing);
  $('#replay').onclick=()=>{playing=true;requestedSeconds=({1:0,2:100,3:200})[stage];lastFeedTick=performance.now();if(receivedContext)draw();loadContext()};
  let externalReplay=null;
  const external=new URLSearchParams(location.search).get('embed')==='external';
  if(embedded) {
    addEventListener('message',event=>{
      if(!external||event.origin!==location.origin||event.source!==parent||event.data?.type!=='weather-context')return;
      const {packet:p,running,hours,replay}=event.data;
      if(p?.schemaVersion!=='2.0.0'||!['flood','fire','earthquake','outage','heat'].includes(p.hazard)||![1,2,3].includes(p.stage?.level)||!p.scene?.available||typeof running!=='boolean'||!Number.isFinite(hours))return;
      const changed=!receivedContext||hazard!==p.hazard||stage!==p.stage.level||replay!==externalReplay;
      receivedContext=true;hazard=p.hazard;stage=p.stage.level;externalReplay=replay;
      $('.window').style.visibility='visible';
      if(changed){playing=running;draw();}
      setPlayback(running);
      gsap.set('#clock-tint',{opacity:Math.max(0,.32*(1-Math.min(1,hours/7)))});
    });
  }
  if(embedded&&!external) {
    playing=false;
    addEventListener('message', event => {
      if(event.origin!==location.origin || event.source!==parent || event.data?.type!=='weather-scene') return;
      const data=event.data;
      if(![1,2,3].includes(data.stage)||typeof data.running!=='boolean'||!Number.isFinite(data.hours)) return;
      const changed=stage!==data.stage || hazard!=='flood';
      requestedHazard='flood';requestedSeconds=Math.max(0,Math.min(300,data.hours*25));
      hazard='flood';stage=data.stage;
      // Draw once on stage change, not every clock tick.
      if(changed) {playing=data.running;draw();}
      if(data.running && !playing) {playing=true;draw();}
      setPlayback(data.running);
      const darkness=Math.max(0,.48*(1-Math.min(1,data.hours/7)));
      gsap.set('#clock-tint',{opacity:darkness});
    });
  }
  reduce.addEventListener('change',draw);
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden) gsap.globalTimeline.pause();
    else if(playing&&!reduce.matches) gsap.globalTimeline.resume();
  });
  draw();
  $('.window').style.visibility='hidden';
  if(!external)loadContext();
  setInterval(()=>{
    const now=performance.now(),delta=(now-lastFeedTick)/1000;lastFeedTick=now;
    if(!embedded&&playing&&!document.hidden&&receivedContext)requestedSeconds=Math.min(300,requestedSeconds+delta);
    if(!external&&!document.hidden&&!pendingController)loadContext();
  },2000);
})();
