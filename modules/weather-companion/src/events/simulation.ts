import {METRICS,RequestSchema,type Hazard,type EvidenceRecord,type SourceAdapter,type Assessor} from './schema.ts';
import {buildEventContext} from './processor.ts';
import {buildContext} from '../scenario.ts';
const HOUR=3600000, ORIGIN=Date.parse('2026-01-15T08:00:00Z');
const time=(n:number)=>new Date(n).toISOString();
const round=(n:number)=>Math.round(n*100)/100;
const domains:Record<Hazard,Array<keyof typeof METRICS>>={
  flood:['rainfall','riverLevel','windGust','temperature','humidity'],
  fire:['temperature','humidity','windGust','pm25','fireArea','fireDistance'],
  earthquake:['magnitude','shakingIntensity'],
  outage:['customersWithoutPower','temperature'],
  heat:['temperature','humidity','heatIndex','windGust'],
};
const forecastable=new Set(['rainfall','windGust','temperature','humidity','heatIndex','pm25']);
function sample(metric:keyof typeof METRICS,hour:number,hazard:Hazard):number|null {
  const phase=hour<4?0:hour<8?1:2;
  const values:Record<keyof typeof METRICS,Array<number|null>>={
    rainfall:[.2,8,22],riverLevel:[1.2,2.2,3.8],windGust:[12,26,42],
    temperature:hazard==='heat'?[24,34,41]:hazard==='fire'?[25,31,34]:[18,20,23],
    humidity:hazard==='fire'?[45,24,15]:[50,55,60],pm25:[8,28,110],
    fireArea:[0,0,320],fireDistance:[null,null,6],
    magnitude:[null,null,5.8],shakingIntensity:[null,null,6],
    customersWithoutPower:[0,0,72],heatIndex:[25,38,47],
  };
  // A detected earthquake is a bounded event, never a predicted series.
  if((metric==='magnitude'||metric==='shakingIntensity')&&hour!==8)return null;
  return values[metric][phase];
}
export function createSimulationAdapter(hazard:Hazard):SourceAdapter {
  const source={id:`sim:${hazard}`,name:`Synthetic ${hazard} feed`,provenance:'simulated' as const,updateIntervalSeconds:2};
  return {source,async read({asOf,areaId}){
    const end=Date.parse(asOf),hour=Math.floor((end-ORIGIN)/HOUR);
    const records:EvidenceRecord[]=[];
    const legacy=hazard==='flood'?buildContext(Math.max(0,Math.min(300,hour*25))):null;
    for(const metric of domains[hazard])for(let offset=-12;offset<12;offset++){
      const kind=offset<0?'observation':'forecast';
      if(kind==='forecast'&&!forecastable.has(metric))continue;
      // Observation ending at the current boundary represents this scenario hour.
      let value=sample(metric,hour+offset+1,hazard);
      if(legacy){
        const row=offset<0?legacy.weather.history[offset+12]:legacy.weather.forecast.hourly[offset];
        const field=({rainfall:'precipitation',windGust:'windGust',temperature:'temperature',humidity:'humidity'} as const)[metric as 'rainfall'|'windGust'|'temperature'|'humidity'];
        if(field)value=row[field].value;
        if(metric==='riverLevel')value=buildContext(Math.max(0,Math.min(300,(hour+offset+1)*25))).watershed.riverStage.value;
      }
      records.push({id:`${source.id}:${hour}:${metric}:${offset}`,sourceId:source.id,areaId,kind,metric,
        value:value===null?null:round(value*(!legacy&&kind==='forecast'&&metric==='rainfall'?.85:1)),unit:METRICS[metric].unit,
        validFrom:time(end+offset*HOUR),validTo:time(end+(offset+1)*HOUR),issuedAt:kind==='forecast'?asOf:time(end+(offset+1)*HOUR),retrievedAt:asOf,
        provenance:'simulated',quality:{validity:value===null?'unavailable':'passed',geographicFit:'local',uncertainty:'not-calibrated'}});
    }
    return {source,records};
  }};
}
const summaries:Record<Hazard,string[]>={
 flood:['Steady conditions','Begin preparing for flooding','Flooding is occurring'],
 fire:['No active fire in this fixture','Fire conditions are worsening','A wildfire is active'],
 earthquake:['No shaking detected in this fixture','General earthquake readiness; no earthquake is predicted','An earthquake has been detected'],
 outage:['Power is available','Prepare for a possible outage','A power outage is confirmed'],
 heat:['Comfortable conditions','Heat is building','Extreme heat is occurring'],
};
export function createSimulationAssessor(seconds:number):Assessor {
 return {async assess({hazard,asOf,records}){
   const level=seconds<100?1:seconds<200?2:3;
   const evidence=records.filter(r=>r.kind==='observation'&&r.value!==null&&r.validTo===asOf);
   // Keep seismic evidence from the detected event even after shaking stops.
   const quake=records.filter(r=>r.metric==='magnitude'&&r.value!==null&&r.kind==='observation');
   return {level,name:['steady','prepare','event'][level-1] as 'steady'|'prepare'|'event',summary:summaries[hazard][level-1],
     basis:'scripted-fixture',evidenceIds:[...new Set([...evidence,...quake].map(r=>r.id))]};
 }};
}
export async function simulateEvent(request:unknown){
 const {hazard,seconds}=RequestSchema.parse(request);const hour=Math.floor(seconds/25);
 return buildEventContext({hazard,asOf:time(ORIGIN+hour*HOUR),areaId:'demo-california-area',adapters:[createSimulationAdapter(hazard)],assessor:createSimulationAssessor(seconds)});
}
