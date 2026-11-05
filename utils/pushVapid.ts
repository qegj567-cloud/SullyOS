/**
 * Shared VAPID credentials store.
 *
 * The 主动消息 2.0 one-click deploy reuses the key pair stored here (and
 * writes the generated pair back), so redeploying keeps browser push
 * subscriptions valid.
 *
 * Private key is intentionally persisted too: the user has to paste it
 * into their Cloudflare Worker env, and re-displaying it later is much
 * easier than regenerating + re-deploying. localStorage already holds
 * API keys / client tokens, one more secret of comparable sensitivity
 * does not change the threat model.
 *
 * Default values are empty by design — there is no hardcoded fallback.
 * The user generates their own VAPID key pair via the 推送凭据 (VAPID)
 * settings modal (or lets the one-click deploy create one), then mirrors
 * it into the Worker env when deploying by hand.
 */

const PUSH_VAPID_KEY = 'push_vapid_v1';

export interface PushVapid {
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidEmail?: string;
  updatedAt?: number;
}

const EMPTY: PushVapid = {
  vapidPublicKey: '',
  vapidPrivateKey: '',
};

export function loadPushVapid(): PushVapid {
  if (typeof localStorage === 'undefined') return { ...EMPTY };
  try {
    const raw = localStorage.getItem(PUSH_VAPID_KEY);
    if (raw) return { ...EMPTY, ...(JSON.parse(raw) as Partial<PushVapid>) };
  } catch { /* ignore */ }
  return { ...EMPTY };
}

export function savePushVapid(v: PushVapid): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const next: PushVapid = {
      vapidPublicKey: v.vapidPublicKey.trim(),
      vapidPrivateKey: v.vapidPrivateKey.trim(),
      vapidEmail: v.vapidEmail?.trim() || undefined,
      updatedAt: Date.now(),
    };
    localStorage.setItem(PUSH_VAPID_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
}

export function clearPushVapid(): void {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.removeItem(PUSH_VAPID_KEY); } catch { /* ignore */ }
}

export function isPushVapidReady(v?: PushVapid): boolean {
  const x = v ?? loadPushVapid();
  // VAPID public keys are 65 raw bytes → 87 base64url chars. >60 is a loose
  // sanity check that catches "empty", "BAKnuY" partial paste, etc.
  return x.vapidPublicKey.length > 60;
}
