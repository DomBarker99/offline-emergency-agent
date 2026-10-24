import test from 'node:test';
import assert from 'node:assert/strict';
import {answerChat,ChatRequest} from '../src/chat.ts';
test('chat validates input, uses the shared agent, and routes offline to the local model',async()=>{
 assert.equal(ChatRequest.safeParse({text:'',mode:'local',context:null,history:[]}).success,false);
 const original=globalThis.fetch;let called='';let sent='';
 // The shared agent calls the model through the OpenAI client; answer like a Chat Completions server.
 globalThis.fetch=async(url,options)=>{called=String(url instanceof Request?url.url:url);const body=JSON.parse(String(options?.body??await (url as Request).text()));sent=JSON.stringify(body.messages);
  return new Response(JSON.stringify({id:'t',object:'chat.completion',created:0,model:'test',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'Test reply [C1].'}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{headers:{'Content-Type':'application/json'}});};
 try{
  const result=await answerChat({text:'Explain flood protection',mode:'local',context:null,history:[]});
  assert.match(called,/127.0.0.1:8080/);
  assert.match(sent,/calm emergency companion/);
  assert.match(sent,/handling facts only/);           // the shared agent's medical limit is in the prompt
  assert.equal(result.provider,'local');
  assert.equal(result.contextFreshness,'saved');
  assert.equal(result.answer,'Test reply.');           // citation tags are not shown
  assert.equal('sources' in result,false);
 } finally{globalThis.fetch=original;}
});
test('shipped disaster passages are retrieved without a model',async()=>{
 const {retrieve}=await import('../src/retrieval.ts');
 const pack=await retrieve('flood water evacuation','flood');
 assert.equal(pack.passageCount,2140);
 assert.ok(pack.items.some(item=>item.passageId));
 assert.ok(pack.items.every(item=>typeof item.body==='string'&&item.source?.url));
});
