import test from 'node:test';
import assert from 'node:assert/strict';
import {answerChat,ChatRequest} from '../src/chat.ts';
test('chat validates input and routes offline exclusively to local model',async()=>{
 assert.equal(ChatRequest.safeParse({text:'',mode:'local',context:null,history:[]}).success,false);
 const original=globalThis.fetch;let called='';
 globalThis.fetch=async(url,options)=>{called=String(url);const body=JSON.parse(String(options?.body));assert.match(body.messages[0].content,/saved and may be stale/);return new Response(JSON.stringify({choices:[{message:{content:'Test reply [C1]'}}]}));};
 try{const result=await answerChat({text:'Explain',mode:'local',context:null,history:[]});assert.match(called,/127.0.0.1:8080/);assert.equal(result.provider,'local');assert.equal(result.contextFreshness,'saved');assert.ok(result.sources.length);}
 finally{globalThis.fetch=original;}
});
