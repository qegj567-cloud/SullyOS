/** 一轮即时对话的不可变输入，单独存放以保留 client_state 的大值分块能力。 */
export const INSTANT_INPUT_NAMESPACE = 'amsg:instant-input';
// 单条可达数百 KB，保留太久会撑满免费版 D1 的 500 MB；7 天与已结束任务行的保留期一致。
export const INSTANT_INPUT_TTL_DAYS = 7;

export interface InstantInputRef { namespace: typeof INSTANT_INPUT_NAMESPACE; key: string }
export interface InstantInputEnvelope { v: 1; charId: string; packedFirePack: string }

export const parseInstantInputRef = (value: unknown): InstantInputRef | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const ref = value as Record<string, unknown>;
  return ref.namespace === INSTANT_INPUT_NAMESPACE && typeof ref.key === 'string'
    && /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(ref.key)
    ? { namespace: INSTANT_INPUT_NAMESPACE, key: ref.key } : null;
};

export const parseInstantInputEnvelope = (value: string): InstantInputEnvelope | null => {
  try {
    const input = JSON.parse(value);
    return input?.v === 1 && typeof input.charId === 'string' && input.charId
      && typeof input.packedFirePack === 'string' && input.packedFirePack
      ? input as InstantInputEnvelope : null;
  } catch { return null; }
};
