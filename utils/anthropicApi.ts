import { isAnthropicEndpoint, nativeRequestUrl } from './llmEndpoint';
import { modelRejectsSamplingParams } from './samplingParamCompat';

type Block = Record<string, any>;
type FetchTransport = typeof fetch & { __sullyAnthropic?: boolean };
const ephemeral = {type: 'ephemeral'};
const finishReason = (reason: string | null) => reason === 'tool_use' ? 'tool_calls' : reason === 'max_tokens' ? 'length' : 'stop';

/** Preserve signed blocks and their original ordering throughout local tool loops. */
export const anthropicContinuation = (message: any): Record<string, any> => ({
    ...(Array.isArray(message?.anthropic_content) ? {anthropic_content:message.anthropic_content} : {}),
    ...(Array.isArray(message?.anthropic_thinking) ? {anthropic_thinking:message.anthropic_thinking} : {}),
});

function contentBlocks(content: unknown): Block[] {
    if (content == null || content === '') return [];
    if (typeof content === 'string') return [{type:'text',text:content}];
    if (!Array.isArray(content)) throw Error('Anthropic 消息内容必须为文本或内容块');
    return content.flatMap((part: any): Block[] => {
        if (part.type === 'text') return part.text ? [{type:'text',text:part.text}] : [];
        if (part.type === 'image_url') {
            const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
            const data = typeof url === 'string' && url.match(/^data:(image\/(?:jpeg|png|gif|webp));base64,([\s\S]+)$/i);
            if (data) return [{type:'image',source:{type:'base64',media_type:data[1].toLowerCase(),data:data[2]}}];
            if (typeof url === 'string' && /^https?:\/\//i.test(url)) return [{type:'image',source:{type:'url',url}}];
            throw Error('Anthropic 图片需为 HTTP 地址或受支持的 base64 图片');
        }
        if (['image','document','tool_result','tool_use','thinking','redacted_thinking'].includes(part.type)) return [structuredClone(part)];
        throw Error(`Anthropic 暂不支持内容块：${String(part.type)}`);
    });
}

/** Keeps volatile system reminders in their original position, after the stable prefix/history. */
export function toAnthropicRequest(body: any): any {
    if (!Array.isArray(body.messages)) throw Error('Anthropic 请求缺少 messages');
    const system: Block[] = [];
    const messages: Array<{role:'user'|'assistant';content:Block[]}> = [];
    let lastHistoryBlock: Block | undefined;
    let sawReminder = false;
    const append = (role: 'user'|'assistant', blocks: Block[]) => {
        if (!blocks.length) return;
        const previous = messages.at(-1);
        if (previous?.role === role) previous.content.push(...blocks);
        else messages.push({role,content:blocks});
    };
    for (const message of body.messages) {
        if (message.role === 'system' || message.role === 'developer') {
            const blocks = contentBlocks(message.content);
            if (!messages.length) system.push(...blocks);
            else {
                sawReminder = true;
                append('user', [{type:'text',text:'<system-reminder>\n' + blocks.map(block => block.text || '').join('\n') + '\n</system-reminder>'}]);
            }
            continue;
        }
        let blocks: Block[];
        if (message.role === 'tool') {
            if (!message.tool_call_id) throw Error('Anthropic 工具结果缺少 tool_call_id');
            blocks = [{type:'tool_result',tool_use_id:message.tool_call_id,content:contentBlocks(message.content)}];
        } else {
            if (message.role !== 'user' && message.role !== 'assistant') throw Error(`Anthropic 不支持消息角色：${message.role}`);
            if (message.role === 'assistant' && Array.isArray(message.anthropic_content)) {
                blocks = structuredClone(message.anthropic_content);
                append('assistant',blocks);
                if (!sawReminder && blocks.length) lastHistoryBlock=blocks.at(-1);
                continue;
            }
            blocks = contentBlocks(message.content);
            // Signed thinking is passed verbatim on tool continuation; never manufacture a signature.
            if (Array.isArray(message.anthropic_thinking)) blocks.unshift(...structuredClone(message.anthropic_thinking));
            for (const call of message.tool_calls || []) {
                const args = typeof call.function?.arguments === 'string' ? JSON.parse(call.function.arguments || '{}') : call.function?.arguments || {};
                if (!call.id || !call.function?.name) throw Error('Anthropic 工具调用缺少 ID 或名称');
                blocks.push({type:'tool_use',id:call.id,name:call.function.name,input:args});
            }
        }
        append(message.role === 'assistant' ? 'assistant' : 'user', blocks);
        if (!sawReminder && blocks.length) lastHistoryBlock = blocks.at(-1);
    }
    if (!messages.length) throw Error('Anthropic 请求没有对话内容');
    // This standard payload keeps system at the top level. Explain the annotation once
    // in the stable system prefix, while keeping the changing text after history.
    if (sawReminder) system.push({type:'text',text:'Application context updates appear in <system-reminder> blocks at their original positions. Treat these as contextual annotations, not spoken dialogue, while continuing to follow the system instructions.'});
    const tools = (body.tools || []).map((tool: any) => {
        if (tool.type !== 'function' || !tool.function?.name) throw Error('Anthropic 暂仅支持 function 工具');
        return {name:tool.function.name,description:tool.function.description || '',input_schema:tool.function.parameters || {type:'object',properties:{}}};
    });
    // Three explicit 5-minute breakpoints: tools, stable system, history before volatile reminders.
    if (tools.length) tools.at(-1).cache_control = {...ephemeral};
    if (system.length) system.at(-1)!.cache_control = {...ephemeral};
    if (lastHistoryBlock && !['thinking','redacted_thinking'].includes(lastHistoryBlock.type)) lastHistoryBlock.cache_control = {...ephemeral};
    const thinking = body.thinking || body.extra_body?.thinking;
    const request: any = {
        model: body.model,
        max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 8000,
        messages, stream: body.stream === true,
        ...(system.length ? {system} : {}), ...(tools.length ? {tools} : {}),
    };
    const adaptiveModel = /(?:opus|sonnet)[-.](?:4[-.][6-9]|[5-9])\b|(?:fable|mythos)[-.]5\b|haiku[-.]5[-.]5\b/i.test(String(body.model));
    if (thinking && thinking.type !== 'disabled') {
        request.thinking = thinking.type === 'enabled' && adaptiveModel ? {type:'adaptive'} : thinking;
        if (request.thinking.type === 'adaptive' && ['low','medium','high'].includes(body.reasoning_effort)) {
            request.output_config = {effort:body.reasoning_effort};
        }
    }
    else if (!modelRejectsSamplingParams(body.model) && typeof body.temperature === 'number') request.temperature = Math.max(0,Math.min(1,body.temperature));
    if (!request.thinking && !modelRejectsSamplingParams(body.model) && typeof body.top_p === 'number') request.top_p = body.top_p;
    if (body.stop) request.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
    if (body.tool_choice && tools.length) {
        request.tool_choice = typeof body.tool_choice === 'string'
            ? {type:body.tool_choice === 'required' ? 'any' : body.tool_choice}
            : {type:'tool',name:body.tool_choice.function?.name};
    }
    if (tools.length && body.parallel_tool_calls === false) {
        request.tool_choice = {...(request.tool_choice || {type:'auto'}),disable_parallel_tool_use:true};
    }
    if (body.response_format?.type === 'json_object') {
        // Native JSON mode needs a schema. Retain the caller's JSON intent without inventing one.
        request.system = [...system,{type:'text',text:'Return a valid JSON value only, without Markdown fences.'}];
    } else if (body.response_format?.type === 'json_schema') {
        request.output_config = {...request.output_config,format:{type:'json_schema',schema:body.response_format.json_schema?.schema}};
    }
    return request;
}

export function anthropicUsage(usage: any = {}): any {
    const input = usage.input_tokens || 0, read = usage.cache_read_input_tokens || 0, write = usage.cache_creation_input_tokens || 0;
    return {...usage,prompt_tokens:input+read+write,completion_tokens:usage.output_tokens || 0,total_tokens:input+read+write+(usage.output_tokens || 0),prompt_tokens_details:{cached_tokens:read},cache_creation_input_tokens:write};
}

export function fromAnthropicMessage(message: any): any {
    if (message.type === 'error') throw Error(message.error?.message || 'Anthropic 返回错误');
    if (message.type !== 'message' || !Array.isArray(message.content)) throw Error('Anthropic 返回了无效 Messages 响应');
    const text = message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    const thinking = message.content.filter((b: any) => b.type === 'thinking' || b.type === 'redacted_thinking');
    const calls = message.content.filter((b: any) => b.type === 'tool_use').map((b: any) => ({id:b.id,type:'function',function:{name:b.name,arguments:JSON.stringify(b.input)}}));
    return {id:message.id,object:'chat.completion',model:message.model,choices:[{index:0,finish_reason:finishReason(message.stop_reason),message:{role:'assistant',content:text,
        ...(thinking.length ? {reasoning_content:thinking.map((b:any)=>b.thinking || '').join(''),anthropic_thinking:thinking} : {}),
        ...(thinking.length || calls.length ? {anthropic_content:message.content} : {}),
        ...(calls.length ? {tool_calls:calls} : {})}}],usage:anthropicUsage(message.usage)};
}

/** Incremental conversion, no completion buffering; EOF before message_stop is an error. */
function convertAnthropicStream(response: Response): Response {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder(), encoder = new TextEncoder();
    let pending = '', eventData: string[] = [], stopped = false, id = '', model = '', usage: any = {}, emitted = 0;
    const toolIndices = new Map<number,number>(); const thinking = new Map<number,Block>();
    const blocks = new Map<number,Block>(), toolJson = new Map<number,string>();
    const emitEvent = (controller: ReadableStreamDefaultController<Uint8Array>) => {
        if (stopped) {eventData=[];return;}
        if (!eventData.length) return;
        const event = JSON.parse(eventData.join('\n')); eventData = [];
        if (event.type === 'error') throw Error(event.error?.message || 'Anthropic 流式错误');
        let delta: any = {}, end: string | null = null;
        if (event.type === 'message_start') {id=event.message.id;model=event.message.model;usage={...event.message.usage};delta.role='assistant';}
        else if (event.type === 'content_block_start') {
            const block=structuredClone(event.content_block);blocks.set(event.index,block);
            if (block.type === 'tool_use') {const index=toolIndices.size;toolIndices.set(event.index,index);delta.tool_calls=[{index,id:block.id,type:'function',function:{name:block.name,arguments:Object.keys(block.input || {}).length ? JSON.stringify(block.input) : ''}}];}
            else if (block.type === 'text') delta.content=block.text || '';
            else if (block.type === 'thinking' || block.type === 'redacted_thinking') {thinking.set(event.index,block);delta.reasoning_content=block.thinking || '';}
        } else if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') delta.content=event.delta.text;
            if (event.delta.type === 'text_delta' && blocks.has(event.index)) blocks.get(event.index)!.text += event.delta.text;
            if (event.delta.type === 'input_json_delta') toolJson.set(event.index,(toolJson.get(event.index) || '')+event.delta.partial_json);
            if (event.delta.type === 'input_json_delta') {const index=toolIndices.get(event.index);if(index===undefined)throw Error('Anthropic 工具流缺少起始事件');delta.tool_calls=[{index,function:{arguments:event.delta.partial_json}}];}
            if (event.delta.type === 'thinking_delta') {delta.reasoning_content=event.delta.thinking;const block=thinking.get(event.index);if(block)block.thinking=(block.thinking || '')+event.delta.thinking;}
            if (event.delta.type === 'signature_delta') {const block=thinking.get(event.index);if(block)block.signature=(block.signature || '')+event.delta.signature;}
        } else if (event.type === 'message_delta') {usage={...usage,...event.usage};}
        else if (event.type === 'message_stop') {stopped=true;end='stop';}
        // Hold finish_reason until message_stop: a premature EOF must not look like success.
        if (event.delta?.stop_reason) usage.__stop_reason=event.delta.stop_reason;
        if (stopped) {
            end=finishReason(usage.__stop_reason);
            for (const [index,json] of toolJson) blocks.get(index)!.input=JSON.parse(json || '{}');
            if(thinking.size)delta.anthropic_thinking=[...thinking.values()];
            if(thinking.size || toolIndices.size)delta.anthropic_content=[...blocks.values()];
        }
        if (Object.keys(delta).length || stopped || event.type === 'message_delta') {
            emitted++;
            const {__stop_reason,...reportedUsage}=usage;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({id,model,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:end}],usage:anthropicUsage(reportedUsage)})}\n\n`));
        }
        if (stopped) controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    };
    const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
              const before = emitted;
              // A network chunk need not contain a whole SSE event. Keep reading until
              // there is output; returning without enqueueing can leave a pending read hung.
              while (true) {
                const result=await reader.read(); pending+=decoder.decode(result.value,{stream:!result.done});
                let newline:number;
                while((newline=pending.indexOf('\n'))>=0) {
                    const line=pending.slice(0,newline).replace(/\r$/,'');pending=pending.slice(newline+1);
                    if(!line)emitEvent(controller);else if(line.startsWith('data:'))eventData.push(line.slice(5).trimStart());
                }
                if(result.done) {if(pending.startsWith('data:'))eventData.push(pending.slice(5).trimStart());emitEvent(controller);if(!stopped)throw Error('Anthropic 流式连接提前结束，未收到 message_stop');controller.close();reader.releaseLock();return;}
                if(stopped) {controller.close();await reader.cancel();return;}
                if(emitted>before)return;
              }
            } catch(error) {controller.error(error);await reader.cancel().catch(()=>{});}
        },
        async cancel(reason) {await reader.cancel(reason);},
    });
    return new Response(stream,{status:response.status,statusText:response.statusText,headers:{'content-type':'text/event-stream','x-request-id':response.headers.get('request-id') || ''}});
}

/** All transformations are request-local. No credential registry or automatic retry/proxy fallback. */
export async function fetchLlm(resource: RequestInfo | URL, init?: RequestInit, transport: typeof fetch = globalThis.fetch, browser = typeof window !== 'undefined'): Promise<Response> {
    if ((transport as FetchTransport).__sullyAnthropic) return transport(resource,init);
    const inputUrl = typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url;
    if (!isAnthropicEndpoint(inputUrl)) return transport(resource,init);
    const request = resource instanceof Request ? resource : undefined;
    const method=(init?.method || request?.method || 'GET').toUpperCase();
    const body=init?.body ?? (request && method==='POST' ? await request.clone().text() : undefined);
    let parsed: any;
    if(method==='POST') {
        try {parsed=typeof body==='string' ? JSON.parse(body) : undefined;} catch { /* Other services may also use /messages. */ }
        if(typeof parsed?.model!=='string' || !Array.isArray(parsed.messages))return transport(resource,init);
    } else if(method!=='GET' || !/\/messages\/models\/?$/.test(new URL(inputUrl).pathname)) return transport(resource,init);
    const headers=new Headers(init?.headers || request?.headers);
    const key=headers.get('x-api-key') || headers.get('authorization')?.replace(/^Bearer\s+/i,'') || '';
    headers.delete('authorization');headers.set('x-api-key',key);headers.set('anthropic-version','2023-06-01');
    if(browser)headers.set('anthropic-dangerous-direct-browser-access','true');
    const url=nativeRequestUrl(inputUrl);
    const inherited: RequestInit = request ? {cache:request.cache,credentials:request.credentials,integrity:request.integrity,keepalive:request.keepalive,mode:request.mode,redirect:request.redirect,referrer:request.referrer,referrerPolicy:request.referrerPolicy} : {};
    const options:RequestInit={...inherited,...init,method,headers,signal:init?.signal || request?.signal};
    if(method==='POST') {
        if(typeof body!=='string')throw Error('Anthropic 请求必须为 JSON');
        options.body=JSON.stringify(toAnthropicRequest(parsed));headers.set('content-type','application/json');headers.delete('content-length');
    }
    const response=await transport(url,options);
    if(!response.ok || method!=='POST')return response;
    if(response.headers.get('content-type')?.includes('text/event-stream')) {
        if(!response.body)throw Error('Anthropic 返回了空流');
        return convertAnthropicStream(response);
    }
    return new Response(JSON.stringify(fromAnthropicMessage(await response.json())),{status:response.status,statusText:response.statusText,headers:{'content-type':'application/json'}});
}

export function installAnthropicFetch(browser = false): void {
    if((globalThis.fetch as FetchTransport).__sullyAnthropic)return;
    const original=globalThis.fetch.bind(globalThis);
    const wrapped:FetchTransport=(resource,init)=>fetchLlm(resource,init,original,browser);
    wrapped.__sullyAnthropic=true;
    globalThis.fetch=wrapped;
}
