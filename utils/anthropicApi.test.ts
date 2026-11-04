import {afterEach,describe,expect,it,vi} from 'vitest';
import {anthropicContinuation,fetchLlm,fromAnthropicMessage,installAnthropicFetch,toAnthropicRequest} from './anthropicApi';
import {normalizeLlmBaseUrl} from './llmEndpoint';
import {normalizeApiConfig} from './apiConfigNormalize';
import {configFromPreset} from './apiPresetSwitch';
import {resolveDialogueApi} from './characterApi';
import {buildCharChatCredRow,buildCharInstantCredRow} from './amsgLlmCredentials';
import {safeFetchJson} from './safeApi';
import {extractApiTokenUsage} from './apiCallLog';
import {callLlm as sdkCallLlm,extractAssistantMessage} from '@rei-standard/amsg-shared';

const native='https://api.anthropic.com/v1/messages';
const message=(content:any[]=[{type:'text',text:'你好'}])=>({type:'message',id:'msg-test',model:'claude-test',role:'assistant',content,stop_reason:'end_turn',usage:{input_tokens:5,output_tokens:7,cache_read_input_tokens:1000,cache_creation_input_tokens:200}});
const sse=(events:any[],close=true)=>new Response(new ReadableStream<Uint8Array>({start(controller){const encoded=new TextEncoder().encode(events.map(event=>`event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(''));for(let i=0;i<encoded.length;i+=7)controller.enqueue(encoded.slice(i,i+7));if(close)controller.close();}}),{headers:{'content-type':'text/event-stream'}});
const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;vi.restoreAllMocks();});

describe('Anthropic native transport',()=>{
 it('normalizes roots, version prefixes, full endpoints and switches atomically between providers',()=>{
  for(const baseUrl of ['https://api.anthropic.com','https://api.anthropic.com/v1/','https://api.anthropic.com/v1/messages','https://api.anthropic.com/v1/chat/completions'])expect(normalizeLlmBaseUrl(baseUrl,'anthropic')).toBe(native);
  expect(normalizeLlmBaseUrl(native,'openai')).toBe('https://api.anthropic.com/v1');
  const api=normalizeApiConfig({baseUrl:'https://api.anthropic.com',apiKey:'key',model:'claude-test',apiType:'anthropic'});
  const preset=configFromPreset({id:'a',name:'a',config:api});expect(preset).toMatchObject({baseUrl:native,apiType:'anthropic'});
  const resolved=resolveDialogueApi(api,{dialogueApi:{baseUrl:'https://open.test/v1',apiKey:'other',model:'other'}});
  expect(resolved.apiType).toBe('openai');expect(resolved.apiKey).toBe('other');
  const expected={apiUrl:native,apiKey:'key',primaryModel:'claude-test'};
  expect(buildCharChatCredRow({id:'c'},undefined,api)?.value).toEqual(expected);
  expect(buildCharInstantCredRow('c',api)?.value).toEqual(expected);
 });
 it('preserves stable system/history and late reminders, images, parallel tools and cache boundaries without mutation',()=>{
  const body={model:'claude-test',temperature:1.7,messages:[{role:'system',content:'角色与世界书'},{role:'user',content:[{type:'text',text:'看看'},{type:'image_url',image_url:{url:'data:image/png;base64,AA=='}}]},{role:'assistant',content:null,tool_calls:[{id:'tool1',type:'function',function:{name:'lookup',arguments:'{"q":"hello"}'}}]},{role:'tool',tool_call_id:'tool1',content:'结果'},{role:'system',content:'现在：每轮不同'}],tools:[{type:'function',function:{name:'lookup',parameters:{type:'object',properties:{q:{type:'string'}}}}}],tool_choice:'auto'};
  const copy=structuredClone(body),out=toAnthropicRequest(body);
  expect(body).toEqual(copy);expect(out.temperature).toBe(1);expect(out.max_tokens).toBe(8000);
  expect(out.system[0]).toEqual({type:'text',text:'角色与世界书'});expect(out.system.at(-1).cache_control).toEqual({type:'ephemeral'});
  expect(out.messages[0].content[1]).toMatchObject({type:'image',source:{type:'base64',media_type:'image/png',data:'AA=='}});
  expect(out.messages[1].content[0]).toMatchObject({type:'tool_use',id:'tool1',input:{q:'hello'}});
  expect(out.messages[2].content[0]).toMatchObject({type:'tool_result',tool_use_id:'tool1',cache_control:{type:'ephemeral'}});
  expect(out.messages[2].content[1].text).toContain('现在：每轮不同');expect(out.messages[2].content[1]).not.toHaveProperty('cache_control');
  expect(out.tools[0].input_schema).toEqual(body.tools[0].function.parameters);
 });
 it('makes exactly one native browser request, translates usage and preserves the caller signal',async()=>{
  const network=vi.fn(async()=>Response.json(message())); const abort=new AbortController();
  const result=await fetchLlm(native+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer secret'},body:JSON.stringify({model:'claude-test',messages:[{role:'user',content:'你好'}]}),signal:abort.signal},network,true);
  expect(network).toHaveBeenCalledTimes(1);const [url,options]=network.mock.calls[0] as any;
  expect(url).toBe(native);expect(options.headers.get('x-api-key')).toBe('secret');expect(options.headers.has('authorization')).toBe(false);
  expect(options.headers.get('anthropic-version')).toBe('2023-06-01');expect(options.headers.get('anthropic-dangerous-direct-browser-access')).toBe('true');expect(options.signal).toBe(abort.signal);
  const completion=await result.json();expect(completion.choices[0].message.content).toBe('你好');
  expect(extractApiTokenUsage(completion)).toEqual({prompt:1205,completion:7,total:1212,cached:1000,cacheWrite:200});
 });
 it('leaves OpenAI and unrelated /messages requests untouched and normalizes native models authentication',async()=>{
  const network=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>Response.json({data:[]}));const options={method:'POST',body:JSON.stringify({channel:'chat',text:'hello'})};
  await fetchLlm('https://other.test/messages',options,network,true);expect(network).toHaveBeenLastCalledWith('https://other.test/messages',options);
  await fetchLlm('https://open.test/v1/chat/completions',options,network,true);expect(network).toHaveBeenLastCalledWith('https://open.test/v1/chat/completions',options);
  await fetchLlm(native+'/models',{headers:{Authorization:'Bearer key'}},network,true);expect(network.mock.calls.at(-1)![0]).toBe('https://api.anthropic.com/v1/models');
 });
 it('streams split UTF-8 text, thinking and tool JSON, with cumulative usage and signed continuation',async()=>{
  const events=[{type:'message_start',message:{id:'m',model:'claude-test',usage:{input_tokens:5,cache_read_input_tokens:1000}}},{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'',signature:''}},{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'想一想'}},{type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'signed'}},{type:'content_block_start',index:1,content_block:{type:'text',text:''}},{type:'content_block_delta',index:1,delta:{type:'text_delta',text:'中文🙂'}},{type:'content_block_start',index:2,content_block:{type:'tool_use',id:'t1',name:'lookup',input:{}}},{type:'content_block_delta',index:2,delta:{type:'input_json_delta',partial_json:'{"q":'}},{type:'content_block_delta',index:2,delta:{type:'input_json_delta',partial_json:'"城市"}'}},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:20}},{type:'message_stop'}];
  globalThis.fetch=vi.fn(async()=>sse(events,false));const onDelta=vi.fn(),onReasoningDelta=vi.fn();
  const result=await safeFetchJson(native+'/chat/completions',{method:'POST',body:JSON.stringify({model:'claude-test',messages:[{role:'user',content:'你好'}],stream:true})},2,0,undefined,{onDelta,onReasoningDelta});
  expect(onDelta).toHaveBeenCalledWith('中文🙂','中文🙂');expect(result.choices[0].finish_reason).toBe('tool_calls');
  expect(result.choices[0].message.tool_calls[0].function.arguments).toBe('{"q":"城市"}');
  expect(result.choices[0].message.anthropic_thinking[0].signature).toBe('signed');expect(result.usage.prompt_tokens).toBe(1005);expect(result.usage.completion_tokens).toBe(20);
  const continuation={role:'assistant',content:'UI placeholder',tool_calls:result.choices[0].message.tool_calls,...anthropicContinuation(result.choices[0].message)};
  const next=toAnthropicRequest({model:'claude-test',messages:[{role:'user',content:'x'},continuation,{role:'tool',tool_call_id:'t1',content:'结果'}]});
  expect(next.messages[1].content).toEqual([{type:'thinking',thinking:'想一想',signature:'signed'},{type:'text',text:'中文🙂'},{type:'tool_use',id:'t1',name:'lookup',input:{q:'城市'}}]);
 });
 it.each(['error','truncated'])('fails %s streams without a second paid request',async mode=>{
  const events=[{type:'message_start',message:{id:'m',model:'claude-test',usage:{input_tokens:1}}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'半句话'}},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},...(mode==='error'?[{type:'error',error:{type:'overloaded_error',message:'overloaded'}}]:[])];
  const network=vi.fn(async()=>sse(events));globalThis.fetch=network;
  await expect(safeFetchJson(native,{method:'POST',body:JSON.stringify({model:'c',messages:[{role:'user',content:'x'}],stream:true})},3)).rejects.toThrow(mode==='error'?'overloaded':'message_stop');expect(network).toHaveBeenCalledTimes(1);
 });
 it('uses the real amsg SDK across native tool rounds and keeps browser-only headers out of Worker requests',async()=>{
  const first=message([{type:'thinking',thinking:'思考',signature:'signed'},{type:'tool_use',id:'t1',name:'lookup',input:{q:'城市'}}]);first.stop_reason='tool_use';
  const network=vi.fn(async()=>Response.json(network.mock.calls.length===1?first:message()));globalThis.fetch=network;installAnthropicFetch(false);
  const payload={apiUrl:native,apiKey:'secret',primaryModel:'claude-test',messages:[{role:'user',content:'你好'}],tools:[{type:'function',function:{name:'lookup',parameters:{type:'object',properties:{}}}}]};
  const result=await sdkCallLlm(payload,{requireContent:false});
  const second=await sdkCallLlm({...payload,messages:[...payload.messages,extractAssistantMessage(result.response),{role:'tool',tool_call_id:'t1',content:'结果'}]},{requireContent:false});
  expect(second.content).toBe('你好');expect(network).toHaveBeenCalledTimes(2);
  const [,init]=network.mock.calls[1] as any;expect(init.headers.has('anthropic-dangerous-direct-browser-access')).toBe(false);
  const body=JSON.parse(init.body);expect(body.messages[1].content[0]).toEqual({type:'thinking',thinking:'思考',signature:'signed'});expect(body.messages[2].content[0].tool_use_id).toBe('t1');
 });
 it('keeps HTTP errors and cancellation visible, with no provider downgrade',async()=>{
  const network=vi.fn(async()=>Response.json({type:'error',error:{type:'authentication_error',message:'bad key'}},{status:401}));globalThis.fetch=network;
  await expect(safeFetchJson(native,{method:'POST',body:JSON.stringify({model:'c',messages:[{role:'user',content:'x'}]})})).rejects.toThrow('bad key');expect(network).toHaveBeenCalledTimes(1);
  const abort=new DOMException('cancelled','AbortError');globalThis.fetch=vi.fn(async()=>{throw abort;});await expect(fetchLlm(native,{method:'POST',body:JSON.stringify({model:'c',messages:[{role:'user',content:'x'}]})})).rejects.toBe(abort);
 });
 it('preserves Request options and cancels an in-progress native stream upstream',async()=>{
  const cancel=vi.fn();
  const network=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({type:'message_start',message:{id:'m',model:'c',usage:{}}})+'\n\n'));},cancel}),{headers:{'content-type':'text/event-stream'}}));
  const request=new Request(native,{method:'POST',headers:{Authorization:'Bearer key','content-type':'application/json'},credentials:'omit',redirect:'error',body:JSON.stringify({model:'c',messages:[{role:'user',content:'x'}],stream:true})});
  const response=await fetchLlm(request,undefined,network,true),reader=response.body!.getReader();
  await reader.read();await reader.cancel('user stopped');
  expect(cancel).toHaveBeenCalledWith('user stopped');
  expect(network.mock.calls[0][1]).toMatchObject({credentials:'omit',redirect:'error'});
 });
 it('roundtrips non-stream tool calls and respects native thinking model IDs and unsupported sampling',()=>{
  const original=message([{type:'text',text:'查一下'},{type:'tool_use',id:'x',name:'lookup',input:{q:'城市'}}]);original.stop_reason='tool_use';
  const out=fromAnthropicMessage(original);expect(out.choices[0].message.tool_calls[0].function.arguments).toBe('{"q":"城市"}');
  expect(toAnthropicRequest({model:'claude-opus-4-7',temperature:.8,top_p:.9,messages:[{role:'user',content:'x'}]})).not.toHaveProperty('temperature');
  expect(toAnthropicRequest({model:'custom-thinking',thinking:{type:'enabled',budget_tokens:2048},temperature:.8,messages:[{role:'user',content:'x'}]})).toMatchObject({model:'custom-thinking',thinking:{type:'enabled',budget_tokens:2048}});
 });
 it('uses adaptive thinking on current Claude models while preserving legacy manual budgets',()=>{
  const body={thinking:{type:'enabled',budget_tokens:2048},reasoning_effort:'medium',temperature:.8,messages:[{role:'user',content:'x'}],response_format:{type:'json_schema',json_schema:{schema:{type:'object'}}}};
  for(const model of ['claude-opus-4-6','claude-opus-4-7','claude-opus-4-8','claude-sonnet-4-6','claude-sonnet-5']){
   const result=toAnthropicRequest({...body,model});expect(result.thinking).toEqual({type:'adaptive'});expect(result.output_config).toMatchObject({effort:'medium',format:{type:'json_schema'}});expect(result).not.toHaveProperty('temperature');
  }
  expect(toAnthropicRequest({...body,model:'claude-sonnet-4-5'}).thinking).toEqual(body.thinking);
 });
});
