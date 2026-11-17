import type { APIConfig, CharacterProfile, CompanionSttConfig, CompanionVideoApiConfig, VisionApiConfig } from '../../types';
import { dialogueMaxTokens, resolveDialogueApi } from '../characterApi';
import { safeFetchJson, extractContent } from '../safeApi';
import { blobDataUrl } from './capture';
import { companionVideoEndpoint, videoRequestParameters } from './videoProviders';
import { companionTestImage, companionTestVideo } from './testMedia';
import { CompanionVoice } from './voice';
import { startCompanionListening, type ListeningCallbacks } from './listening';
import { startDoubaoListening } from './doubaoListening';

export interface CompanionTestResult { summary: string; detail?: string }
export type CompanionTestRun = (signal: AbortSignal, progress: (message: string) => void) => Promise<CompanionTestResult>;
type Endpoint = Pick<APIConfig, 'baseUrl' | 'apiKey' | 'model'>;

async function probe(api: Endpoint, body: object, signal: AbortSignal, char?: CharacterProfile, endpoint?: string) {
  const url = new URL(api.baseUrl.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请填写有效的 HTTP(S) API 地址');
  if (!api.model.trim()) throw new Error('请填写模型 ID');
  const response = await safeFetchJson(endpoint ?? `${api.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
    body: JSON.stringify({ model: api.model, ...body }),
  }, 0, 60_000, { appId: 'companion', appName: '同行', charId: char?.id, charName: char?.name, purpose: '测试连接' });
  signal.throwIfAborted();
  const text = extractContent(response).trim();
  if (!text) throw new Error('接口已响应，但没有返回正文；请检查模型、输出额度或思考参数');
  return text;
}

// Fixed diagnostic prompts intentionally do not load character context, memories or chat history.
export async function testCompanionDialogue(api: APIConfig, char: CharacterProfile | undefined, signal: AbortSignal) {
  const selected = resolveDialogueApi(api, char);
  const detail = await probe(selected, { stream: selected.stream ?? true, max_tokens: dialogueMaxTokens(selected),
    messages: [{ role: 'user', content: '这是接口连通测试，请只回复一句简短的中文问候。' }] }, signal, char);
  return { summary: '已收到对话模型回复', detail };
}

export async function testCompanionImage(api: APIConfig | VisionApiConfig, signal: AbortSignal, char?: CharacterProfile, dialogue = false) {
  const detail = await probe(api, { stream: dialogue ? (api as APIConfig).stream ?? true : false,
    max_tokens: dialogue ? dialogueMaxTokens(api as APIConfig) : 1200, messages: [{ role: 'user', content: [
    { type: 'text', text: '请简短描述图片中的形状和颜色。' },
    { type: 'image_url', image_url: { url: companionTestImage() } },
  ] }] }, signal, char);
  return { summary: '已收到图片描述，请核对是否为白底红色圆形', detail };
}

export async function testCompanionVideo(api: CompanionVideoApiConfig, signal: AbortSignal, progress: (text: string) => void, char?: CharacterProfile) {
  progress('正在生成 2 秒图形样片，不使用摄像头');
  const clip = await companionTestVideo(signal), url = await blobDataUrl(clip.blob, signal);
  signal.throwIfAborted(); progress('样片已生成，正在请求视频模型');
  const detail = await probe(api, { stream: false, ...videoRequestParameters(api), messages: [{ role: 'user', content: [
    { type: 'video_url', video_url: { url, ...(['doubao', 'minimax'].includes(api.provider ?? '') ? { fps: 1 } : {}) } },
    { type: 'text', text: '请按先后顺序，简短描述这段视频中形状和颜色的变化。' },
  ] }] }, signal, char, companionVideoEndpoint(api));
  return { summary: '已收到视频描述，请核对是否为红色圆形 → 蓝色方形', detail };
}

export async function testCompanionVoice(api: APIConfig, char: CharacterProfile, signal: AbortSignal, progress: (text: string) => void) {
  signal.throwIfAborted();
  const voice = new CompanionVoice(); voice.prime();
  const close = () => voice.close(); signal.addEventListener('abort', close, { once: true });
  let audible = false;
  progress('正在合成测试短句，请留意声音');
  try {
    await voice.play('这是同行的语音测试，我能陪你一起逛街。', char, api, signal, () => {}, () => {
      audible = true; progress('正在播放当前角色的音色');
    });
    signal.throwIfAborted();
    if (!audible) throw new Error('接口已结束，但未检测到音频播放，请检查音色、额度和浏览器音频权限');
    return { summary: '已合成并完成播放', detail: '若仍听不到声音，请检查设备音量和输出设备。' };
  } finally { signal.removeEventListener('abort', close); close(); }
}

export function testCompanionStt(config: CompanionSttConfig, signal: AbortSignal, progress: (text: string) => void): Promise<CompanionTestResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let stop: (() => void) | undefined, settled = false;
    const finish = (error?: unknown, text?: string) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', cancel); stop?.();
      if (error) reject(error); else resolve({ summary: '已收到最终识别文字', detail: text });
    };
    const cancel = () => finish(signal.reason ?? new DOMException('已取消', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('30 秒内未得到确认文字；请检查麦克风输入、权限或识别服务，再试一次')), 30_000);
    signal.addEventListener('abort', cancel, { once: true });
    progress('请允许麦克风，说一句话后稍作停顿；最长 30 秒');
    const callbacks: ListeningCallbacks = {
      speech: () => {}, partial: text => { if (!settled && text) progress(`临时识别：${text}`); },
      final: text => { if (text.trim()) finish(undefined, text.trim()); },
      error: message => finish(new Error(message)),
      state: text => { if (!settled) progress(`${text}；请说一句话后稍作停顿`); },
    };
    try { stop = config.provider === 'doubao' ? startDoubaoListening(config, callbacks) : startCompanionListening(callbacks); if (settled) stop(); }
    catch (error) { finish(error); }
  });
}

/** Provider errors can echo credentials. Redact before rendering, copying or keeping results in UI state. */
export function redactCompanionTestText(text: string, config: unknown) {
  const secrets: string[] = [];
  const scan = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && /key|token|secret|password/i.test(key) && item.trim()) secrets.push(item, encodeURIComponent(item));
      else if (item && typeof item === 'object') scan(item);
    }
  };
  scan(config);
  for (const secret of secrets.sort((a, b) => b.length - a.length)) text = text.split(secret).join('[已隐藏凭据]');
  return text.replace(/https?:\/\/[^\s<>"']+/g, '[接口地址]').slice(0, 1600);
}
