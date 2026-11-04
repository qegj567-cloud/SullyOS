import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildFcmMessage, createHybridPushTransport, fcmTokenFromEndpoint } from './nativeFcm';
import {
  buildThirdPartyPushEndpoint,
  normalizeThirdPartyPushConfig,
  parseThirdPartyPushEndpoint,
  THIRD_PARTY_PUSH_PROVIDERS,
} from '../../../utils/amsgThirdPartyPush';

describe('AMSG2 native FCM & third-party push transport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('普通 Web Push endpoint 原样委托旧发送器（兼容 UnifiedPush / ntfy 的 RFC8291 端点）', async () => {
    const sendNotification = vi.fn().mockResolvedValue('web-ok');
    const transport = createHybridPushTransport({}, { sendNotification });
    const subscription = { endpoint: 'https://ntfy.sh/up123456/push', keys: { p256dh: 'a', auth: 'b' } };
    await expect(transport.sendNotification(subscription, '{"message":"hi"}')).resolves.toBe('web-ok');
    expect(sendNotification).toHaveBeenCalledWith(subscription, '{"message":"hi"}');
  });

  it('只有 fcm: endpoint 才识别为原生 token', () => {
    expect(fcmTokenFromEndpoint('fcm:abc:123')).toBe('abc:123');
    expect(fcmTokenFromEndpoint('https://push.example/sub')).toBeNull();
    expect(fcmTokenFromEndpoint('fcm:   ')).toBeNull();
  });

  it('正文只放 notification 一份，data 保留 AMSG2 路由字段', () => {
    const request = buildFcmMessage('token', JSON.stringify({
      messageId: 'm1', message: '你好', contactName: 'Sully',
      metadata: { charId: 'char-1', activeMsg2: true },
    }));
    expect(request.message.notification).toEqual({ title: 'Sully', body: '你好' });
    expect(request.message.data.amsgHasBody).toBe('1');
    const portable = JSON.parse(request.message.data.amsgPayload);
    expect(portable.message).toBeUndefined();
    expect(portable.metadata.charId).toBe('char-1');
  });

  it('第三方推送列表包含 WxPusher（推荐）、Bark、MeoW，且不向新用户展示 ntfy', () => {
    expect(THIRD_PARTY_PUSH_PROVIDERS.map(p => p.id)).toEqual(['wxpusher', 'bark', 'meow']);
    expect(THIRD_PARTY_PUSH_PROVIDERS[0].label).toContain('WxPusher（推荐）');
  });

  it('支持直接粘贴 Bark / MeoW 完整链接或 WxPusher SPT 构造并解析 endpoint', () => {
    const wxEndpoint = buildThirdPartyPushEndpoint({
      provider: 'wxpusher',
      token: 'https://wxpusher.zjiecode.com/api/send/message/SPT_abc12345',
    });
    expect(wxEndpoint).toBe('wxpusher:SPT_abc12345');
    expect(parseThirdPartyPushEndpoint(wxEndpoint)).toEqual({
      provider: 'wxpusher',
      token: 'SPT_abc12345',
      serverOrigin: 'https://wxpusher.zjiecode.com',
    });

    const barkNormalized = normalizeThirdPartyPushConfig({
      provider: 'bark',
      token: 'https://api.day.app/MyBarkKey123/测试内容',
    });
    expect(barkNormalized).toEqual({
      provider: 'bark',
      token: 'MyBarkKey123',
      serverOrigin: 'https://api.day.app',
    });
    const barkEndpoint = buildThirdPartyPushEndpoint({
      provider: 'bark',
      token: 'https://bark.selfhost.example/CustomKey99/',
    });
    expect(barkEndpoint).toBe('bark:https://bark.selfhost.example/CustomKey99');
    expect(parseThirdPartyPushEndpoint(barkEndpoint)).toEqual({
      provider: 'bark',
      token: 'CustomKey99',
      serverOrigin: 'https://bark.selfhost.example',
    });

    const meowEndpoint = buildThirdPartyPushEndpoint({
      provider: 'meow',
      token: 'harmony_user',
    });
    expect(meowEndpoint).toBe('meow:https://api.chuckfang.com/harmony_user');
    expect(parseThirdPartyPushEndpoint(meowEndpoint)).toEqual({
      provider: 'meow',
      token: 'harmony_user',
      serverOrigin: 'https://api.chuckfang.com',
    });
  });

  it('wxpusher: 端点通过极简推送 API 发送通知，并带上角色点击跳转链接', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 1000, msg: '处理成功', success: true }), { status: 200 }),
    );
    const webPush = { sendNotification: vi.fn() };
    const transport = createHybridPushTransport({}, webPush);

    const res = await transport.sendNotification(
      { endpoint: 'wxpusher:SPT_test123456', clickUrl: 'https://sullyos.example.com/' },
      JSON.stringify({
        contactName: 'Sully',
        message: '早安，今天降温记得加衣服',
        metadata: { charId: 'char-sully' },
      }),
    );

    expect(res).toEqual({ ok: true, provider: 'wxpusher' });
    expect(webPush.sendNotification).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://wxpusher.zjiecode.com/api/send/message/simple-push');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      spt: 'SPT_test123456',
      summary: 'Sully：早安，今天降温记得加衣服',
      content: 'Sully\n\n早安，今天降温记得加衣服',
      contentType: 1,
      url: 'https://sullyos.example.com/?openApp=chat&activeMsgCharId=char-sully',
    });
  });

  it('bark: 端点通过 Bark push API 发送通知，并在有公开 http(s) 头像时附带 icon', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 200, message: 'success' }), { status: 200 }),
    );
    const webPush = { sendNotification: vi.fn() };
    const transport = createHybridPushTransport({}, webPush);

    await transport.sendNotification(
      { endpoint: 'bark:https://api.day.app/DeviceKey888', clickUrl: 'https://sullyos.example.com' },
      JSON.stringify({
        contactName: 'Sully',
        message: '看到我头像了吗？',
        avatarUrl: 'https://cdn.example.com/sully.png',
        metadata: { charId: 'char-sully' },
      }),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.day.app/push');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      device_key: 'DeviceKey888',
      title: 'Sully',
      body: '看到我头像了吗？',
      group: 'amsg-char-sully',
      icon: 'https://cdn.example.com/sully.png',
      url: 'https://sullyos.example.com/?openApp=chat&activeMsgCharId=char-sully',
    });
  });

  it('meow: 端点通过 MeoW API 发送通知', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 200, message: 'ok' }), { status: 200 }),
    );
    const webPush = { sendNotification: vi.fn() };
    const transport = createHybridPushTransport({}, webPush);

    await transport.sendNotification(
      { endpoint: 'meow:https://api.chuckfang.com/harmony_nick' },
      JSON.stringify({
        contactName: 'Sully',
        message: '鸿蒙备用通知测试',
      }),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.chuckfang.com/harmony_nick');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      title: 'Sully',
      msg: '鸿蒙备用通知测试',
    });
  });

  it('静默推送信封（show: never 或 reasoning/tool-request）不触发第三方 App 弹窗', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const webPush = { sendNotification: vi.fn() };
    const transport = createHybridPushTransport({}, webPush);

    const res = await transport.sendNotification(
      { endpoint: 'wxpusher:SPT_test123456' },
      JSON.stringify({
        messageKind: 'reasoning',
        notification: { show: 'never' },
      }),
    );

    expect(res).toEqual({ skipped: true, reason: 'silent-payload' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});


