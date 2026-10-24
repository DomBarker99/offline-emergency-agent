import {readFile} from 'node:fs/promises';
export async function retrieve(query:string,hazard?:string){
 const cards=JSON.parse(await readFile(new URL('../../../data/cards/library-cards.json',import.meta.url),'utf8'));
 let passages:any[]=[];
 try{passages=(await readFile(new URL('../../../data/library/passages.jsonl',import.meta.url),'utf8')).trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const terms=[...new Set(query.toLowerCase().match(/[a-z]{3,}/g)??[])];
 const score=(text:string)=>terms.reduce((n,t)=>n+(text.toLowerCase().includes(t)?1:0),0);
 const scenario=hazard==='outage'?'power-outage':hazard==='heat'?'extreme-heat':hazard;
 const selected=cards.map((c:any)=>({...c,score:score(c.title+' '+c.body)+(c.scenarios.includes(scenario)?3:0)})).filter((c:any)=>c.score>0).sort((a:any,b:any)=>b.score-a.score).slice(0,5);
 const excerpts=passages.map((p:any)=>({...p,score:score((p.heading??'')+' '+p.text)})).filter(p=>p.score>0).sort((a,b)=>b.score-a.score).slice(0,5).map((p,i)=>({id:'L'+(i+1),title:p.heading??p.pageTitle,body:p.text,source:{name:p.publisher,url:p.url,updated:p.pageDate},passageId:p.id}));
 return {items:[...selected,...excerpts],method:'local-keyword',passageCount:passages.length};
}
