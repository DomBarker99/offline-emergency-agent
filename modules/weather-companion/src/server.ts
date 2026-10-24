import { retrieve } from './retrieval.ts';
import { ChatRequest, answerChat } from './chat.ts';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildContext, type Branch } from './scenario.ts';
import { ControlSchema } from './schema.ts';
import { simulateEvent, RequestSchema } from './event-pipeline.ts';

let seconds = 0;
let startedAt: number | null = null;
let branch: Branch = 'assisted-departure';
let runId = randomUUID();
const elapsed = () => Math.min(300, seconds + (startedAt === null ? 0 : (performance.now() - startedAt) / 1000));
const pause = () => { seconds = elapsed(); startedAt = null; };
const server = createServer(async (req, res) => {
  const reply = (status: number, data: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data, null, 2));
  };
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if(req.method==='GET' && url.pathname==='/api/pack'){
      const query=(url.searchParams.get('q')??'flood').slice(0,300);
      const result=await retrieve(query);
      return reply(200,{...result,items:result.items.map(({id,title,body,source,passageId})=>({id,title,body,source,passageId}))});
    }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      if (req.headers.origin && req.headers.origin !== 'http://'+req.headers.host) return reply(403,{error:'Origin not allowed'});
      if (!req.headers['content-type']?.startsWith('application/json')) return reply(415,{error:'JSON required'});
      let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>524288)return reply(413,{error:'Request too large'});}
      let input;try{input=ChatRequest.safeParse(JSON.parse(body));}catch{return reply(400,{error:'Invalid JSON'});}
      if(!input.success)return reply(400,{error:'Invalid chat request'});
      try{return reply(200,await answerChat(input.data));}catch(error){console.error('chat failed:',error instanceof Error?error.message:error);return reply(503,{error:input.data.mode==='local'?'Local assistance is unavailable. Start the local model server.':'Online assistance is unavailable. Check the server configuration or retry.'});}
    }
    if (req.method === 'GET' && ['/scene.js' , '/studio.js', '/vendor/gsap.min.js'].includes(url.pathname)) {
      const asset = await readFile(new URL('../public' + url.pathname, import.meta.url));
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(asset);
    }
    if (req.method === 'GET' && ['/', '/animation-studio', '/companion'].includes(url.pathname)) {
      const page = await readFile(new URL(url.pathname === '/companion' ? '../public/companion.html' : url.pathname === '/animation-studio' ? '../public/animation-studio.html' : '../public/index.html', import.meta.url));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(page);
    }
    if (req.method === 'GET' && url.pathname === '/v2/context') {
      const request = RequestSchema.safeParse({hazard:url.searchParams.get('hazard')??'flood', seconds:url.searchParams.has('seconds')?Number(url.searchParams.get('seconds')):elapsed()});
      if(!request.success)return reply(400,{error:'Invalid hazard or demo seconds'});
      return reply(200,await simulateEvent(request.data));
    }
    if (req.method === 'GET' && url.pathname === '/health') return reply(200, { status: 'ok', simulation: true });
    if (url.pathname === '/dev/clock' && req.method === 'GET') return reply(200, { seconds: elapsed(), running: startedAt !== null && elapsed() < 300, branch, runId });
    if (url.pathname === '/dev/clock' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 4096) return reply(413, { error: 'Body too large' }); }
      let parsed;
      try { parsed = ControlSchema.safeParse(JSON.parse(body)); } catch { return reply(400, { error: 'Invalid JSON' }); }
      if (!parsed.success) return reply(400, { error: parsed.error.issues });
      const command = parsed.data;
      pause();
      if (command.action === 'play') startedAt = performance.now();
      if (command.action === 'reset') { seconds = 0; runId = randomUUID(); }
      if (command.action === 'seek') { seconds = command.seconds!; runId = randomUUID(); }
      if (command.action === 'branch') { branch = command.branch!; runId = randomUUID(); }
      return reply(200, { seconds: elapsed(), running: startedAt !== null, branch, runId });
    }
    if (req.method !== 'GET') return reply(405, { error: 'Method not allowed' });
    const context = buildContext(elapsed(), branch);
    const packet = { runId, ...context };
    if (url.pathname === '/v1/context') return reply(200, packet);
    const products: Record<string, unknown> = {
      weather: context.weather, watershed: context.watershed, alerts: context.alerts,
      impacts: context.impacts, resources: context.resources, resident: context.residentContext,
      assessment: { stage: context.stage, branch: context.branch, aiHandoff: context.aiHandoff },
    };
    const product = url.pathname.replace('/v1/', '');
    if (url.pathname.startsWith('/v1/') && Object.hasOwn(products, product)) return reply(200, {
      schemaVersion: context.schemaVersion, simulation: true, runId, revision: context.revision,
      asOf: context.asOf, area: context.area, quality: context.quality, data: products[product],
    });
    reply(404, { error: 'Unknown endpoint', context: '/v1/context', developerControl: '/dev/clock' });
  } catch (error) { console.error(error); reply(500, { error: 'Scenario processing failed' }); }
});
const port = Number(process.env.PORT ?? 4317);
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  console.log(`Synthetic flood API: http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}/v1/context (paused)`);
});
