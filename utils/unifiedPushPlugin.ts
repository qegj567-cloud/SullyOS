import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

export interface UnifiedPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  distributor: string;
  temporary: boolean;
  vapidPublicKey: string;
}

export interface UnifiedPushStatus {
  bridgeVersion?: number;
  registrationRevision?: string;
  acknowledgedRegistration?: string;
  native: boolean;
  distributors: string[];
  distributor: string | null;
  subscription: UnifiedPushSubscription | null;
  lastError: string | null;
  permission: 'granted' | 'denied' | 'prompt';
}

export interface UnifiedPushStoredMessage {
  id: string;
  payload: string;
  receivedAt: number;
}

interface UnifiedPushNativePlugin {
  getStatus(): Promise<Omit<UnifiedPushStatus, 'permission'>>;
  register(options: { vapidPublicKey: string }): Promise<{ pending: boolean }>;
  unregister(): Promise<void>;
  drainPendingPushes(): Promise<{ messages: UnifiedPushStoredMessage[]; launchPayload?: string }>;
  peekPendingPushes(): Promise<{ messages: UnifiedPushStoredMessage[]; launchPayload?: string }>;
  acknowledgePush(options: { id: string }): Promise<void>;
  acknowledgeRegistration(options: { revision: string }): Promise<void>;
  addListener(
    eventName: 'pushReceived' | 'notificationTapped' | 'registrationChanged' | 'foreground',
    listener: (event: any) => void,
  ): Promise<PluginListenerHandle>;
}

const NativeUnifiedPush = registerPlugin<UnifiedPushNativePlugin>('AmsgUnifiedPush');

export const isUnifiedPushPlatform = (): boolean =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

const readPermission = async (): Promise<UnifiedPushStatus['permission']> => {
  const result = await LocalNotifications.checkPermissions();
  if (result.display === 'granted') return 'granted';
  if (result.display === 'denied') return 'denied';
  return 'prompt';
};

export const getUnifiedPushStatus = async (): Promise<UnifiedPushStatus> => {
  if (!isUnifiedPushPlatform()) {
    return {
      native: false,
      distributors: [],
      distributor: null,
      subscription: null,
      lastError: null,
      permission: 'denied',
    };
  }

  const [status, permission] = await Promise.all([
    NativeUnifiedPush.getStatus(),
    readPermission(),
  ]);
  return { ...status, permission };
};

const requireNotificationPermission = async (): Promise<void> => {
  const current = await LocalNotifications.checkPermissions();
  const result = current.display === 'prompt'
    ? await LocalNotifications.requestPermissions()
    : current;
  if (result.display !== 'granted') {
    throw new Error('通知权限未授予，UnifiedPush 收到消息后无法显示系统通知。');
  }
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 获取一条标准 Web Push 订阅，可直接交给 AMSG Worker。 */
export const ensureUnifiedPushSubscription = async (
  vapidPublicKey: string,
): Promise<{ endpoint: string; keys: { p256dh: string; auth: string } }> => {
  if (!isUnifiedPushPlatform()) throw new Error('UnifiedPush 仅用于 Android 原生 App。');
  await requireNotificationPermission();

  const before = await NativeUnifiedPush.getStatus();
  if (!before.distributor && before.distributors.length === 0) {
    throw new Error('没有检测到 UnifiedPush 服务。请先安装并打开 ntfy 的无 Firebase 版本，允许它后台运行后再试。');
  }

  await NativeUnifiedPush.register({ vapidPublicKey });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const status = await NativeUnifiedPush.getStatus();
    const subscription = status.subscription;
    if (
      subscription?.endpoint
      && subscription.keys?.p256dh
      && subscription.keys?.auth
      && subscription.vapidPublicKey === vapidPublicKey
    ) {
      return { endpoint: subscription.endpoint, keys: subscription.keys };
    }
    if (status.lastError) throw new Error(`UnifiedPush 注册失败：${status.lastError}`);
    await delay(250);
  }

  throw new Error('UnifiedPush 注册超时。请确认 ntfy 已打开并允许它在后台运行。');
};

export const readUnifiedPushSubscription = async () =>
  (await getUnifiedPushStatus()).subscription;

export const drainUnifiedPushMessages = () => NativeUnifiedPush.drainPendingPushes();
export const peekUnifiedPushMessages = () => NativeUnifiedPush.peekPendingPushes();
export const acknowledgeUnifiedPushMessage = (id: string) => NativeUnifiedPush.acknowledgePush({ id });
export const readUnifiedPushTransportStatus = () => NativeUnifiedPush.getStatus();
export const acknowledgeUnifiedPushRegistration = (revision: string) => NativeUnifiedPush.acknowledgeRegistration({ revision });

export const addUnifiedPushListener = (
  eventName: 'pushReceived' | 'notificationTapped' | 'registrationChanged' | 'foreground',
  listener: (event: any) => void,
) => NativeUnifiedPush.addListener(eventName, listener);
