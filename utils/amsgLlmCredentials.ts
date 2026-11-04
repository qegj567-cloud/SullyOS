import { resolveDialogueApi } from './characterApi';
import { isAnthropicEndpoint, normalizeLlmBaseUrl, type LlmApiType } from './llmEndpoint';
/**
 * 主动消息 2.0 的「LLM 凭据引用」（credRefs）：本地这一侧的命名、取值与变更侦测。
 *
 * 过去每条排程任务的载荷里都冻结一份 apiUrl / apiKey / primaryModel。换一次 Key 就得
 * 把待触发的任务逐条 PUT 回去，漏一条到点就是 401；角色在 fire 里给自己排的任务客户端
 * 根本够不着，旧 Key 顺着自排链一直传下去。
 *
 * 现在凭据单独存一张表（worker 的 `llm_credentials`），任务只带一个名字（credId）。
 * 到点由 worker 按名字现读，所以**换 Key 只要覆盖那一行**，已排的任务——包括角色自排的
 * 那些——下一次触发用的就是新凭据，任务行一个字都不用改。
 *
 * 这份文件只做三件不联网的事：
 *   1. 起名（credId 的唯一出处，见下面三种用途）；
 *   2. 按当前配置算出每一行该是什么值；
 *   3. 记一份「上次传上去的是什么」的指纹底账，好让上传只在真的变了的时候发生。
 *
 * 联网那半截在 activeMsgClient（排程 / 即时对话前的确保上传）和 amsgStateSync
 * （改配置后的后台补传，退避 + 底账那一套跟 tool_config 共用同一个套路）。
 */

import type { APIConfig, ActiveMsg2CharacterConfig, CharacterProfile } from '../types';

/** 凭据行的值：三个字段全必填，服务端只查非空、不做格式校验。 */
export interface LlmCredentialValue {
  apiUrl: string;
  apiKey: string;
  primaryModel: string;
}

/** 一行凭据 = 名字 + 值。 */
export interface LlmCredentialRow {
  credId: string;
  value: LlmCredentialValue;
}

/**
 * worker 支持「凭据存表、任务带引用」这件事的能力位（GET /capabilities 的 features）。
 * 名字由上游 amsg-server 定义，这里只认它。
 */
export const LLM_CREDENTIALS_FEATURE = 'llm-credentials';

/**
 * 这台 worker 走不走 credRefs 这条路——**整个前端只在这里判一次**。
 *
 * 探不到 / 老 worker 一律 false，那一档原样走「凭据内联进任务」的老路。主动消息 2.0
 * 已经对所有人开放，旧 worker 是真实存在的运行时状态，不是开发期的兼容债。
 */
export const supportsLlmCredentials = (features: string[] | null | undefined): boolean =>
  Array.isArray(features) && features.includes(LLM_CREDENTIALS_FEATURE);

/**
 * 聊天补全的完整地址。任务行里存的是这个终点地址，不是用户填的 baseUrl。
 * 排程、即时对话、凭据行三处必须同一份算法，所以放在这里当唯一出处。
 */
export const normalizeChatApiUrl = (baseUrl: string, apiType?: LlmApiType): string => {
  const normalized = normalizeLlmBaseUrl(baseUrl, apiType);
  return isAnthropicEndpoint(normalized) ? normalized : `${normalized}/chat/completions`;
};

/**
 * 一个角色名下的凭据用途。配置变更时覆盖行，存量排程迁移时可调整 chat 引用。
 *
 *   chat     定时主动消息，使用角色默认对话 API；未设置则使用全局。
 *   instant  即时对话，使用当轮请求终值（OpenAI 兼容模式可包含 -thinking 后缀）。
 *            与 chat 分开，防止刷新配置时覆盖正在生成的这一轮请求。
 *   emotion  即时对话那一轮的情绪评估（副 API；没单独配就回落到全局聊天 API）
 *   memory   记忆宫殿的后台活儿（门牌整理这类）。用的是记忆宫殿副 API
 *            （memoryPalaceConfig.lightLLM），跟上面三份都不是同一个——它现在是全局
 *            一份配置，但照旧按角色存一行：删角色时跟着一起清，将来真做成分角色也不用动。
 */
export type LlmCredentialPurpose = 'chat' | 'instant' | 'emotion' | 'memory';

export const ALL_CREDENTIAL_PURPOSES: readonly LlmCredentialPurpose[] = ['chat', 'instant', 'emotion', 'memory'];

/** 角色名下某个用途的 credId。上游只当它是不透明字符串（1–128 字符、不含控制字符）。 */
export const charCredId = (charId: string, purpose: LlmCredentialPurpose): string =>
  `char:${charId}/${purpose}`;

/** 这个角色名下全部可能的 credId（删角色时按它清云端那几行）。 */
export const charCredIds = (charId: string): string[] =>
  ALL_CREDENTIAL_PURPOSES.map((purpose) => charCredId(charId, purpose));

/** 把 credId 拆回「哪个角色、什么用途」；不认识的形状返回 null。 */
export const parseCharCredId = (
  credId: string,
): { charId: string; purpose: LlmCredentialPurpose } | null => {
  const m = /^char:(.+)\/(chat|instant|emotion|memory)$/.exec(credId || '');
  return m ? { charId: m[1], purpose: m[2] as LlmCredentialPurpose } : null;
};

/** 三件套齐了才是一行能用的凭据（缺一样 worker 到点也发不出请求）。 */
export const isUsableCredentialValue = (
  value: Partial<LlmCredentialValue> | null | undefined,
): value is LlmCredentialValue =>
  !!value && !!value.apiUrl && !!value.apiKey && !!value.primaryModel;

/** 用户填的 { baseUrl, apiKey, model } → 凭据行的值。缺字段时返回 null，由调用方决定怎么办。 */
export const toCredentialValue = (
  api: { baseUrl?: string; apiKey?: string; model?: string; apiType?: LlmApiType } | null | undefined,
): LlmCredentialValue | null => {
  if (!api?.baseUrl || !api.model) return null;
  const value = {
    apiUrl: normalizeChatApiUrl(api.baseUrl, api.apiType),
    apiKey: api.apiKey || '',
    primaryModel: api.model,
  };
  return isUsableCredentialValue(value) ? value : null;
};

/** 定时主动消息跟随角色默认对话 API，未设置时跟随全局；旧主动消息副 API 字段不参与取值。 */
export const buildCharChatCredRow = (
  char: Pick<CharacterProfile, 'id' | 'dialogueApi'>,
  _config: ActiveMsg2CharacterConfig | undefined,
  apiConfig: Pick<APIConfig, 'baseUrl' | 'apiKey' | 'model'>,
): LlmCredentialRow | null => {
  const value = toCredentialValue(resolveDialogueApi(apiConfig, char));
  return value ? { credId: charCredId(char.id, 'chat'), value } : null;
};

/**
 * 即时对话那一行的值：调用方给的就是本地生成这一轮真正会发出去的那份
 * （baseUrl / apiKey 取 effectiveApi，model 取请求体终值——原生 Claude 保留真实模型 ID）。
 */
export const buildCharInstantCredRow = (
  charId: string,
  api: { baseUrl?: string; apiKey?: string; model?: string },
): LlmCredentialRow | null => {
  const value = toCredentialValue(api);
  return value ? { credId: charCredId(charId, 'instant'), value } : null;
};

/**
 * 情绪评估那一行的值：角色单独配了情绪 API 就用它，否则回落到全局聊天 API
 * ——回落口径与本地评估那条路（useChatAI 的 emotionApi）一致。
 */
export const buildCharEmotionCredRow = (
  charId: string,
  emotionApi: { baseUrl?: string; apiKey?: string; model?: string } | null | undefined,
  apiConfig: Pick<APIConfig, 'baseUrl' | 'apiKey' | 'model'>,
): LlmCredentialRow | null => {
  const source = emotionApi?.baseUrl ? emotionApi : apiConfig;
  const value = toCredentialValue(source);
  return value ? { credId: charCredId(charId, 'emotion'), value } : null;
};

/**
 * 记忆宫殿后台活儿那一行的值：记忆宫殿副 API（memoryPalaceConfig.lightLLM）。
 *
 * **不回落到全局聊天 API**——本地那条路也不回落（记忆宫殿 App 的手动按钮在副 API 没配时
 * 直接报错），拿主 API 悄悄跑一遍后台整理会把用户的主 API 额度花在他没同意的地方。
 * 没配就返回 null，调用方据此不走云端、留在本地按原来的规矩处理。
 */
export const buildCharMemoryCredRow = (
  charId: string,
  lightLLM: { baseUrl?: string; apiKey?: string; model?: string } | null | undefined,
): LlmCredentialRow | null => {
  if (!lightLLM?.baseUrl || !lightLLM.apiKey) return null;
  const value = toCredentialValue(lightLLM);
  return value ? { credId: charCredId(charId, 'memory'), value } : null;
};

// ─── 「传过没有、变了没有」的指纹底账 ───
//
// 凭据本体绝不落 localStorage（那等于把 apiKey 又抄一份到别的地方）。这里只记一个
// 指纹：值没变就不重传，省掉每次排程 / 每条消息一次多余的 PUT。指纹只用来比对相等，
// 不做任何安全用途，所以一个普通的字符串散列就够。

export const AMSG2_CRED_FINGERPRINT_LS_KEY = 'amsg2_llm_cred_fingerprints';

/** FNV-1a 32 位 + 长度后缀。够区分「换了 Key / 换了模型」，不用于任何安全判定。 */
export const fingerprintCredentialValue = (value: LlmCredentialValue): string => {
  const text = `${value.apiUrl}\0${value.apiKey}\0${value.primaryModel}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(36)}.${text.length.toString(36)}`;
};

type FingerprintLedger = Record<string, string>;

export const readCredFingerprints = (): FingerprintLedger => {
  try {
    const parsed = JSON.parse(localStorage.getItem(AMSG2_CRED_FINGERPRINT_LS_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: FingerprintLedger = {};
    for (const [credId, fp] of Object.entries(parsed)) {
      if (typeof fp === 'string') out[credId] = fp;
    }
    return out;
  } catch {
    // 读不出来就当「一行都没传过」：多传一次是幂等的，比漏传安全。
    return {};
  }
};

const writeCredFingerprints = (ledger: FingerprintLedger) => {
  // 存储满 / 隐私模式写不进去就算了：底账只是省请求的，写不进去顶多每次都重传。
  try {
    if (Object.keys(ledger).length === 0) localStorage.removeItem(AMSG2_CRED_FINGERPRINT_LS_KEY);
    else localStorage.setItem(AMSG2_CRED_FINGERPRINT_LS_KEY, JSON.stringify(ledger));
  } catch { /* 见上 */ }
};

/** 这几行里，云端那份跟现在算出来的不一样（或者压根没传过）的那些。 */
export const pickChangedCredRows = (
  rows: LlmCredentialRow[],
  ledger: FingerprintLedger = readCredFingerprints(),
): LlmCredentialRow[] =>
  rows.filter((row) => ledger[row.credId] !== fingerprintCredentialValue(row.value));

/** 记下「这几行已经传上去了」。 */
export const rememberCredRows = (rows: LlmCredentialRow[]): void => {
  if (rows.length === 0) return;
  const ledger = readCredFingerprints();
  for (const row of rows) ledger[row.credId] = fingerprintCredentialValue(row.value);
  writeCredFingerprints(ledger);
};

/** 把这几行从底账里划掉（云端删了 / 传出去的那份作废了，下次必须重传）。 */
export const forgetCredIds = (credIds: string[]): void => {
  if (credIds.length === 0) return;
  const ledger = readCredFingerprints();
  let changed = false;
  for (const credId of credIds) {
    if (credId in ledger) { delete ledger[credId]; changed = true; }
  }
  if (changed) writeCredFingerprints(ledger);
};

/** 整本底账清掉（清空云端数据之后云端一行都不剩，本地这份账也就作废了）。 */
export const forgetAllCredIds = (): void => writeCredFingerprints({});

/** 底账里现在记着哪些 credId（后台补传按它决定要重算哪几行）。 */
export const knownCredIds = (): string[] => Object.keys(readCredFingerprints());

/** 上游单批 PUT 的上限，超了要自己切片。 */
export const CRED_PUT_BATCH_MAX = 100;

export const chunkCredRows = (rows: LlmCredentialRow[], size = CRED_PUT_BATCH_MAX): LlmCredentialRow[][] => {
  const out: LlmCredentialRow[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
};
