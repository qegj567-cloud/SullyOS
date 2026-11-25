import { APIConfig } from '../types';
import { normalizeApiCredential } from './apiConfigNormalize';
import { resolveGlobalMainApi } from './apiSlots';

export const normalizeApiKey = (raw: string): string =>
  normalizeApiCredential(raw).replace(/^Bearer\s+/i, '').trim();

export const isOfficialMiniMaxDomain = (baseUrl?: string | null): boolean => {
  const raw = (baseUrl || '').trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return /(^|\.)(minimaxi\.com|minimax\.io|minimax\.cn|minimax\.chat)$/i.test(parsed.hostname);
  } catch {
    return /(minimaxi\.com|minimax\.io|minimax\.cn|minimax\.chat)/i.test(raw);
  }
};

export const resolveMiniMaxApiKey = (apiConfig: APIConfig): string => {
  const dedicated = normalizeApiKey(apiConfig.minimaxApiKey || '');
  if (dedicated) return dedicated;
  const resolvedMain = resolveGlobalMainApi(apiConfig);
  const mainUrl = (resolvedMain.baseUrl || '').trim();
  // 若主对话明确填了其它第三方服务商地址（如 OpenRouter / DeepSeek），绝不把主 Key 发给 MiniMax。
  if (mainUrl && !isOfficialMiniMaxDomain(mainUrl)) return '';
  return normalizeApiKey(resolvedMain.apiKey || '');
};
