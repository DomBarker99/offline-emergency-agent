import {test} from 'node:test';
import assert from 'node:assert/strict';
import {simulateEvent,buildEventContext,createSimulationAdapter,createSimulationAssessor,RecordSchema} from '../src/event-pipeline.ts';

test('all five hazards provide deterministic, linked context at boundaries',async()=>{
 for(const hazard of ['flood','fire','earthquake','outage','heat'] as const)for(const seconds of [0,99,100,199,200,225,300]){
  const c=await simulateEvent({hazard,seconds});assert.equal(c.stage.level,seconds<100?1:seconds<200?2:3);
  assert.equal(c.mode,'simulation');assert.equal(c.failures.length,0);
  assert.deepEqual(c,await simulateEvent({hazard,seconds}));
  const ids=new Set(c.records.map(r=>r.id));assert.equal(ids.size,c.records.length);
  assert.ok(c.stage.evidenceIds.every(id=>ids.has(id)));
  for(const windows of [c.history,c.forecast.windows])for(const w of windows)for(const m of w.metrics){assert.ok(m.coveredHours<=w.hours);assert.ok(m.evidenceIds.every(id=>ids.has(id)));}
  if(hazard==='earthquake')assert.equal(c.records.filter(r=>r.kind==='forecast').length,0);
 }
});
test('source failures become unknown, never steady or zero',async()=>{
 const adapter=createSimulationAdapter('heat');adapter.read=async()=>{throw Error('Offline')};
 const c=await buildEventContext({hazard:'heat',asOf:'2026-01-15T08:00:00.000Z',areaId:'a',adapters:[adapter],assessor:createSimulationAssessor(0)});
 assert.equal(c.stage.level,null);assert.equal(c.mode,'unavailable');assert.equal(c.failures.length,1);
});
test('live adapter uses same interface and cannot inherit scripted severity',async()=>{
 const synthetic=createSimulationAdapter('heat');
 const live={source:{...synthetic.source,id:'provider:heat',provenance:'live' as const},async read(request:any){
  const batch:any=await synthetic.read(request);return {source:this.source,records:batch.records.map((r:any)=>({...r,sourceId:this.source.id,provenance:'live'}))};
 }};
 const input={hazard:'heat' as const,asOf:'2026-01-15T16:00:00.000Z',areaId:'a',adapters:[live]};
 const c=await buildEventContext(input);assert.equal(c.mode,'live');assert.equal(c.stage.level,null);
 await assert.rejects(()=>buildEventContext({...input,assessor:createSimulationAssessor(200)}),/forbidden/);
});
test('malformed units and overlapping intervals are rejected',async()=>{
 const source=createSimulationAdapter('flood');const request={hazard:'flood' as const,asOf:'2026-01-15T08:00:00.000Z',areaId:'a'};
 const batch:any=await source.read(request);assert.equal(RecordSchema.safeParse({...batch.records[0],unit:'inches'}).success,false);
 source.read=async()=>({...batch,records:[...batch.records,batch.records[0]]});
 const c=await buildEventContext({...request,adapters:[source]});assert.equal(c.failures.length,1);
});
test('rainfall aggregation and null seismic readings are not fabricated',async()=>{
 const c=await simulateEvent({hazard:'flood',seconds:0});assert.equal(c.history.at(-1)!.metrics.find(m=>m.metric==='rainfall')!.value,2.4);
 const quake=await simulateEvent({hazard:'earthquake',seconds:100});assert.ok(quake.latest.every(m=>m.value===null));
 assert.equal(quake.stage.name,'prepare');assert.match(quake.stage.summary,/no earthquake is predicted/);
});

test('v2 flood readings stay consistent with legacy dashboard',async()=>{
 const {buildContext}=await import('../src/scenario.ts');
 for(const seconds of [0,100,200,300]){
  const legacy=buildContext(seconds),packet=await simulateEvent({hazard:'flood',seconds});
  assert.equal(packet.latest.find(m=>m.metric==='rainfall')!.value,legacy.weather.current.precipitation.value);
  assert.equal(packet.latest.find(m=>m.metric==='riverLevel')!.value,legacy.watershed.riverStage.value);
  assert.equal(packet.forecast.windows[3].metrics.find(m=>m.metric==='rainfall')!.value,legacy.weather.forecast.upcomingWindows[3].precipitation.value);
 }
});
