import type { APIConfig, CompanionVideoApiConfig } from '../../types';
import { normalizeApiBaseUrl, normalizeApiCredential } from '../apiConfigNormalize';
import { getProxyWorkerUrl } from '../proxyWorker';

export type CompanionVideoProvider = NonNullable<CompanionVideoApiConfig['provider']>;
export const COMPANION_ARK_PLAN = {
  baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', model: 'doubao-seed-2.1-pro',
  keys: 'https://ark.volcengine.com/region:cn-beijing/subscription/agent-plan',
};
export function isCompanionArkPlan(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, '') === COMPANION_ARK_PLAN.baseUrl;
}
export function companionVideoDirectEndpoint(api: Pick<CompanionVideoApiConfig, 'baseUrl'>) {
  return `${api.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
}
export function companionVideoEndpoint(api: Pick<CompanionVideoApiConfig, 'baseUrl'>, origin = typeof window !== 'undefined' ? window.location.origin : '') {
  const direct = companionVideoDirectEndpoint(api);
  if (!isCompanionArkPlan(api.baseUrl) || !origin) return direct;
  const page = new URL(origin);
  if (['127.0.0.1', 'localhost', '[::1]'].includes(page.hostname)) {
    return `${page.origin}/api/companion/ark-plan/chat/completions`;
  }
  const proxy = new URL(getProxyWorkerUrl());
  if (proxy.protocol !== 'https:' || proxy.username || proxy.password || proxy.search || proxy.hash) {
    throw new Error('豆包套餐视频需要 HTTPS 应用主代理，请检查设置中的网络代理地址');
  }
  return `${proxy.href.replace(/\/+$/, '')}/api/companion/ark-plan/chat/completions`;
}
// Official contracts checked 2026-11-17. Defaults are editable, never model capability detection.
export const COMPANION_VIDEO_PROVIDERS = {
  doubao: {
    name: '豆包 · 火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seed-2-1-pro-260915',
    signup: 'https://console.volcengine.com/ark/', keys: 'https://ark.volcengine.com/region:cn-beijing/apikey',
    docs: 'https://console.volcengine.com/ark/region:cn-beijing/docs/video-understanding',
    note: '开通支持视频输入的 Seed 模型，填写 Model ID 或自己的推理接入点 ID。使用方舟模型 API Key，和豆包语音 Key 分开。录像直接发送；视频观察关闭深度思考。',
  },
  minimax: {
    name: 'MiniMax · 国内', baseUrl: 'https://api.minimax.cn/v1', model: 'MiniMax-M3.1-Flash',
    signup: 'https://platform.minimax.cn/', keys: 'https://platform.minimax.cn/console/keys',
    docs: 'https://platform.minimax.cn/docs/api-reference/text-chat-openai',
    note: '使用国内开放平台的模型 API Key，并确认账号已开通 M3.1 Flash 或 M3 视频输入。录像直接发送；M3.1 Flash 必须开启思考，这里使用 low 强度，不向它发送禁用思考参数。',
  },
  zhipu: {
    name: '智谱 GLM · 视频直传试用', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3-flash',
    signup: 'https://open.bigmodel.cn/', keys: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    docs: 'https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash',
    note: '使用模型标准 API Key，默认 GLM-5.3-Flash，支持视频理解。国内接口的本地 MP4 Base64 兼容性仍待实测；2026-11-21 检查时，官方接口未放行测试站的鉴权跨域预检。请先检查直连，再测试图形样片；失败不会自动转发或上传到临时存储。该默认模型不能关闭思考。',
  },
  custom: {
    name: '自定义兼容接口', baseUrl: '', model: '',
    signup: 'https://bailian.console.aliyun.com/', keys: 'https://help.aliyun.com/zh/model-studio/get-api-key',
    docs: 'https://help.aliyun.com/zh/model-studio/vision',
    note: '保留原有 MP4 Base64 video_url 接法，可填写百炼等兼容平台的地址。请自行确认视频输入能力、地域、Key 和模型 ID；仅识图或视频生成模型不适用。',
  },
} as const;

const miniMax = COMPANION_VIDEO_PROVIDERS.minimax;
export const DEFAULT_COMPANION_VIDEO: CompanionVideoApiConfig = {
  provider: 'minimax', baseUrl: miniMax.baseUrl, model: miniMax.model, apiKey: '',
};

export function domesticMiniMaxVideoKey(api: Pick<APIConfig, 'minimaxRegion' | 'minimaxApiKey'>) {
  return api.minimaxRegion === 'overseas' ? '' : normalizeApiCredential(api.minimaxApiKey);
}

export function isOfficialCompanionMiniMax(api?: CompanionVideoApiConfig) {
  return api?.provider === 'minimax' && normalizeApiBaseUrl(api.baseUrl) === miniMax.baseUrl;
}

/** Resolve for this request only. Persist the user's draft, never the inherited key. */
export function resolveCompanionVideoApi(config: CompanionVideoApiConfig | undefined, domesticKey: string) {
  const selected = config ?? DEFAULT_COMPANION_VIDEO;
  if (!isOfficialCompanionMiniMax(selected)) return selected;
  const apiKey = normalizeApiCredential(selected.apiKey) || domesticKey;
  return apiKey ? { ...selected, baseUrl: miniMax.baseUrl, apiKey } : undefined;
}

export function videoRequestParameters(api: CompanionVideoApiConfig): Record<string, unknown> {
  switch (api.provider) {
    case 'doubao': return { thinking: { type: 'disabled' }, max_completion_tokens: 1200 };
    case 'minimax': return { reasoning_effort: 'low', reasoning_split: true, max_completion_tokens: 4096 };
    // GLM-4.6V allows disabling thinking; users selecting a different model keep its defaults.
    case 'zhipu': return { max_tokens: 4096, ...(api.model.toLowerCase() === 'glm-4.6v' ? { thinking: { type: 'disabled' } } : {}) };
    default: return { temperature: 0, max_tokens: 1000 };
  }
}
