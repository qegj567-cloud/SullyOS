// 即时对话（instant chat）客户端这一半的回归守卫。
//
// 钉的都是「坏了也不报错、只表现成体验变差」的那类行为：
//   1. POST 的形状——任务行型 / 任务身份 / fire_pack 带不带 chat 段。错一个字，
//      worker 到点要么拿主动消息模板去答聊天，要么整条硬失败，而用户只看到「一直在输入」。
//   2. 只有 202 才算发出去。别的状态一律「没发出去」，绝不静默退回本地生成。
//   3. 待收记录扛得住重启——它就是「正在输入…」那盏灯的唯一依据。
//   4. 补收对账：已经上过屏的那条不能再放一遍。
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_USER_ID = '3f2b1c8a-9d4e-4a1b-8c2d-000000000009';

// _encrypt 换成「原样返回明文」，测里才读得到两个信封里到底装了什么。
const { reiClient } = vi.hoisted(() => ({
  reiClient: {
    init: vi.fn().mockResolvedValue(undefined),
    _encrypt: vi.fn(async (plaintext: string) => ({
      iv: 'iv', authTag: 'tag', encryptedData: plaintext,
    })),
    putClientState: vi.fn(),
    getClientState: vi.fn(),
  },
}));
vi.mock('@rei-standard/amsg-client', () => ({ ReiClient: vi.fn(() => reiClient) }));
vi.mock('./keepAlive', () => ({
  KeepAlive: { init: vi.fn().mockResolvedValue(undefined), reregister: vi.fn().mockResolvedValue(undefined) },
}));

// 后台任务结果的分发口：真的那份会动态 import 记忆宫殿那一整套（IndexedDB），
// 这里只关心「补收有没有把它交出去、销账判断对不对」。
const { resultDispatch } = vi.hoisted(() => ({
  resultDispatch: { calls: [] as unknown[], contexts: [] as unknown[], settle: true },
}));
vi.mock('./amsgResults', () => ({
  dispatchAmsgResult: vi.fn(async (payload: unknown, context?: unknown) => {
    resultDispatch.calls.push(payload);
    resultDispatch.contexts.push(context);
    return resultDispatch.settle;
  }),
}));

const { storeState } = vi.hoisted(() => ({
  storeState: {
    config: {
      userId: '3f2b1c8a-9d4e-4a1b-8c2d-000000000009',
      workerUrl: 'https://amsg.example.workers.dev',
      serverToken: '',
      instantChatEnabled: true,
    } as Record<string, unknown>,
    /** 非空时 getGlobalConfig 直接 reject（模拟 IndexedDB 被别的标签页卡住那类异常）。 */
    configError: null as Error | null,
    inbox: [] as any[],
    saved: [] as any[],
    markedNotices: [] as Array<{ charId: string; ids: string[] }>,
  },
}));
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: {
    ensureUserId: async () => TEST_USER_ID,
    getGlobalConfig: async () => {
      if (storeState.configError) throw storeState.configError;
      return storeState.config;
    },
    saveGlobalConfig: vi.fn().mockResolvedValue(undefined),
    listInboxMessages: async () => storeState.inbox,
    saveInboxMessage: async (message: any) => { storeState.saved.push(message); },
    markExpiredNoticesNotified: async (charId: string, ids: string[]) => {
      storeState.markedNotices.push({ charId, ids });
    },
  },
}));

import { ActiveMsgClient } from './activeMsgClient';
import {
  AMSG_INSTANT_CHAT_PENDING_LS_KEY,
  AMSG_INSTANT_CHAT_STAGED_NOTICES_LS_KEY,
  AMSG_OUTBOX_ADOPTED_LS_KEY,
  clearInstantChatPending,
  discardInstantChatExpiredNotices,
  drainOutbox,
  failInstantChatPending,
  getInstantChatPending,
  getStagedInstantChatExpiredNotices,
  isInstantChatReady,
  INSTANT_CHAT_REPROBE_TIMEOUT_MS,
  resetInstantChatReprobeCooldown,
  resolveInstantChatReadiness,
  sendInstantChatTurn,
  stopInstantChat,
  setInstantChatPending,
  settleInstantChatApiLog,
  settleInstantChatExpiredNotices,
  stageInstantChatExpiredNotices,
} from './amsgInstantChat';
import { FIRE_PACK_VERSION, unpackStateValue } from './amsgFirePack';
import { AMSG_BUNDLE_VERSION } from './amsgBundleVersion';
import { ActiveMsgStore } from './activeMsgStore';
import type { AmsgSarModuleSnapshot } from './vrWorld/sarEnvelopeCore';
import { ChatPrompts } from './chatPrompts';
import { DB } from './db';

const CHAR = { id: 'char-instant-1', name: '小满', memories: [] } as any;
const USER = { name: '小明' } as any;
const API = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'gpt-test' };

const stubFirePackDeps = () => {
  vi.spyOn(DB, 'getRecentMessagesByCharId').mockResolvedValue([] as any);
  vi.spyOn(ChatPrompts, 'buildSystemPrompt').mockResolvedValue('SYS_PROMPT_MARKER');
  vi.spyOn(ChatPrompts, 'buildMessageHistory').mockReturnValue({ apiMessages: [] } as any);
  vi.spyOn(ChatPrompts, 'filterVisibleEmojis').mockReturnValue({ emojis: [], categories: [] } as any);
};

/** 装一个只认 /instant-chat 的假 fetch，返回它记下来的请求。 */
const mockInstantChatFetch = (status: number, body: unknown) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: { get: () => 'application/json' },
    } as any;
  }));
  return calls;
};

beforeEach(() => {
  localStorage.removeItem(AMSG_INSTANT_CHAT_PENDING_LS_KEY);
  localStorage.removeItem(AMSG_INSTANT_CHAT_STAGED_NOTICES_LS_KEY);
  localStorage.removeItem(AMSG_OUTBOX_ADOPTED_LS_KEY);
  storeState.inbox = [];
  storeState.saved = [];
  storeState.markedNotices = [];
  storeState.configError = null;
  storeState.config = {
    userId: TEST_USER_ID,
    workerUrl: 'https://amsg.example.workers.dev',
    serverToken: '',
    instantChatEnabled: true,
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /instant-chat 的形状', () => {
  /** 跑一轮，返回解析好的请求体（两个信封已经是明文）。 */
  const postOnce = async (chatMessages: Array<{ role: string; content: unknown }>, supersedesUuid?: string) => {
    stubFirePackDeps();
    const calls = mockInstantChatFetch(202, { status: 'accepted', uuid: 'uuid-1' });
    const result = await ActiveMsgClient.sendInstantChat({
      char: CHAR, chatMessages, api: API, maxTokens: 8000,
      userProfile: USER, groups: [], realtimeConfig: {} as any,
      ...(supersedesUuid ? { supersedesUuid } : {}),
    });
    // 按地址挑，不按顺序挑：握手时会顺带打一次 /config-check 刷能力位
    // （见 activeMsgClient 的 initializeClient），认 calls[0] 会挑到那一条。
    const call = calls.find((c) => String(c.url).includes('/instant-chat'))!;
    const body = JSON.parse(String(call.init.body));
    return {
      result,
      call,
      state: JSON.parse(body.statePayload.encryptedData),
      task: JSON.parse(body.taskPayload.encryptedData),
      supersedes: body.supersedesUuid,
    };
  };

  it('外壳是明文 JSON：两个信封已经加密好，别再给外壳挂加密头', async () => {
    const { call } = await postOnce([{ role: 'user', content: '在吗' }]);
    expect(call.url).toContain('/instant-chat');
    const headers = new Headers(call.init.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('X-User-Id')).toBe(TEST_USER_ID);
    // 挂了的话包装层会把整个外壳当成一整份密文，statePayload / taskPayload 就解不出来。
    expect(headers.get('X-Payload-Encrypted')).toBeNull();
    expect(headers.get('X-Encryption-Version')).toBeNull();
  });

  it('任务行型是 auto + none，身份标着 instant', async () => {
    const { task } = await postOnce([{ role: 'user', content: '在吗' }]);
    // 'instant' 在上游是「当场跑完」的行型，走不到 fire hooks，chat 段就白传了。
    expect(task.messageType).toBe('auto');
    expect(task.recurrenceType).toBe('none');
    // 标着 instant-chat 而不是 chat：面板对账靠这个标签把「用户正等着的这一轮」
    // 跟定时任务的行分开，不然它会被当成排程补进任务清单。
    expect(task.messageSubtype).toBe('instant-chat');
    expect(task.metadata.amsgMode).toBe('instant');
    expect(task.metadata.amsgInstantChat).toBe(true);
    expect(task.metadata.charId).toBe(CHAR.id);
    expect(typeof task.metadata.amsgClientTaskId).toBe('string');
    // 防穿帮闸问的是「到点还该不该主动开口」——带上它会把用户正等着的回复吞掉。
    expect(task.metadata.amsgExpirePolicy).toBeUndefined();
  });

  it('immediate: true 且不带 firstSendTime（落库即到期，慢机吃提前量的 400 无从发生）', async () => {
    const { task } = await postOnce([{ role: 'user', content: '在吗' }]);
    expect(task.immediate).toBe(true);
    expect(task.firstSendTime).toBeUndefined();
  });

  it('顶替 uuid 只在加密信封里（上游同一事务原子取消），外壳明文不带', async () => {
    const { task, supersedes } = await postOnce([{ role: 'user', content: '在吗' }], 'uuid-prev');
    expect(task.supersedesUuid).toBe('uuid-prev');
    expect(supersedes).toBeUndefined();
  });

  it('没有可顶替的上一条时不带这个键', async () => {
    const { task } = await postOnce([{ role: 'user', content: '在吗' }]);
    expect(task.supersedesUuid).toBeUndefined();
  });

  // 情绪评估要跟这一轮一起上云（worker 跑完随最后一条推送把结果送回来）。它里头有
  // 用户副 API 的 apiKey，落点必须是加密的 taskPayload —— 掉进外壳明文或 statePayload
  // 都等于把凭据摊在网络上。
  it('情绪评估配置进的是加密的任务信封，明文外壳里一个字节都没有', async () => {
    stubFirePackDeps();
    const calls = mockInstantChatFetch(202, { status: 'accepted', uuid: 'uuid-1' });
    const emotionEval = {
      prompt: '你是一个角色情绪分析系统。__EMOTION_EVAL_SYSTEM_PROMPT__\n__EMOTION_EVAL_HISTORY__',
      api: { baseUrl: 'https://eval.example.com/v1', apiKey: 'sk-secondary-KEYLEAK', model: 'eval-mini' },
    };
    await ActiveMsgClient.sendInstantChat({
      char: CHAR, chatMessages: [{ role: 'user', content: '在吗' }], api: API,
      userProfile: USER, groups: [], realtimeConfig: {} as any,
      emotionEval,
    });

    const rawBody = String(calls[0].init.body);
    const body = JSON.parse(rawBody);
    const task = JSON.parse(body.taskPayload.encryptedData);
    expect(task.metadata.amsgEmotionEval).toEqual(emotionEval);
    // 外壳（除去两个信封本身）不许出现副 API 的 key
    const shell = { ...body, statePayload: undefined, taskPayload: undefined };
    expect(JSON.stringify(shell)).not.toContain('sk-secondary-KEYLEAK');
    // 云端状态那份也不该有：它跟任务信封是两码事，评估配置只跟着这一轮的任务走
    expect(body.statePayload.encryptedData).not.toContain('sk-secondary-KEYLEAK');
  });

  it('没配情绪评估就不带这个键（不是塞个空对象上去）', async () => {
    const { task } = await postOnce([{ role: 'user', content: '在吗' }]);
    expect(task.metadata.amsgEmotionEval).toBeUndefined();
  });

  // SAR 模块生效 / 恢复期那一轮：worker 靠 amsgSar 拆信封并原样挂回末条推送，落库侧
  // 靠它写事件、推进回合。键名是三方约定，改一个字 worker 就当普通回合处理——信封整段上屏。
  it('SAR 快照原样进任务 metadata.amsgSar（经 sendInstantChatTurn 一路带上去）', async () => {
    stubFirePackDeps();
    const calls = mockInstantChatFetch(202, { status: 'accepted', uuid: 'uuid-sar' });
    const sarModule: AmsgSarModuleSnapshot = {
      v: 1,
      character: { runId: 'run-c', moduleId: 'm1', moduleTitle: '模块', target: 'character', phase: 'active' },
      events: [{
        version: 1, runId: 'run-c', moduleId: 'm1', moduleTitle: '模块', target: 'character',
        source: 'user', phase: 'active', moment: 'installed',
      }],
      userMessageId: 42,
      userSurfaceTargetIds: [],
      reroll: false,
    };
    const result = await sendInstantChatTurn({
      char: CHAR, chatMessages: [{ role: 'user', content: '在吗' }], api: API,
      userProfile: USER, groups: [], realtimeConfig: {} as any,
      sarModule,
    });
    expect(result.ok).toBe(true);
    const call = calls.find((c) => String(c.url).includes('/instant-chat'))!;
    const task = JSON.parse(JSON.parse(String(call.init.body)).taskPayload.encryptedData);
    expect(task.metadata.amsgSar).toEqual(sarModule);
  });

  it('没有 SAR 模块的普通回合不带 amsgSar', async () => {
    const { task } = await postOnce([{ role: 'user', content: '在吗' }]);
    expect(task.metadata).not.toHaveProperty('amsgSar');
  });

  it('凭据带的是调用方给的那份（本地生成会用的同一份）', async () => {
    const { task } = await postOnce([{ role: 'user', content: '在吗' }]);
    expect(task.apiUrl).toBe('https://api.example.com/v1/chat/completions');
    expect(task.apiKey).toBe('sk-test');
    expect(task.primaryModel).toBe('gpt-test');
    expect(task.maxTokens).toBe(8000);
    expect(task.messages).toHaveLength(1);
  });

  it('云端状态是 v7 的 fire_pack，chat.messages 就是本地那串 fullMessages', async () => {
    const fullMessages = [
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: '今天怎么样' },
    ];
    const { state } = await postOnce(fullMessages);
    const firePackEntry = state.entries.find((e: any) => e.key === 'fire_pack');
    expect(firePackEntry).toBeTruthy();
    const pack = JSON.parse(await unpackStateValue(firePackEntry.value));
    expect(pack.v).toBe(FIRE_PACK_VERSION);
    expect(pack.chat.messages).toEqual(fullMessages);
    expect(typeof pack.chat.builtAt).toBe('number');
    // 排程那条路传的那几样一个都不能少（worker 到点全都要读）。
    const keys = state.entries.map((e: any) => e.key);
    expect(keys).toContain('tool_pack');
    expect(keys).toContain('tool_config');
  });

  // ── 轻量包：模板只有定时任务那条路才渲染 ──
  // 角色 2.0 关着（云端 fire 不注入排程工具）且没有任务时，每次发送重建一整份系统
  // 提示词 + 近史转写纯属白付——主线程二次构建 + 上行几十 KB 都发生在拿到 202 之前。
  it('角色 2.0 关着且无任务 → 模板用占位标记，系统提示词一次都不构建', async () => {
    const { state } = await postOnce([{ role: 'user', content: '在吗' }]);
    const entry = state.entries.find((e: any) => e.key === 'fire_pack');
    const pack = JSON.parse(await unpackStateValue(entry.value));
    expect(pack.template).toContain('AMSG2_INSTANT_STUB_TEMPLATE');
    expect(pack.selfScheduleEnabled).toBe(false);
    // chat 段照常带全——即时 fire 吃的是它，不是模板
    expect(pack.chat.messages).toHaveLength(1);
    expect(ChatPrompts.buildSystemPrompt).not.toHaveBeenCalled();
  });

  it('角色 2.0 开着 → 照旧带真模板（云端 fire 可能当场排出会消费它的任务）', async () => {
    stubFirePackDeps();
    const calls = mockInstantChatFetch(202, { status: 'accepted', uuid: 'uuid-real-template' });
    const charOn = { ...CHAR, activeMsg2Config: { enabled: true, tasks: [] } } as any;
    await ActiveMsgClient.sendInstantChat({
      char: charOn, chatMessages: [{ role: 'user', content: '在吗' }], api: API,
      userProfile: USER, groups: [], realtimeConfig: {} as any,
    });
    const body = JSON.parse(String(calls[0].init.body));
    const state = JSON.parse(body.statePayload.encryptedData);
    const entry = state.entries.find((e: any) => e.key === 'fire_pack');
    const pack = JSON.parse(await unpackStateValue(entry.value));
    expect(pack.template).toContain('SYS_PROMPT_MARKER');
    expect(pack.template).not.toContain('AMSG2_INSTANT_STUB_TEMPLATE');
    expect(pack.selfScheduleEnabled).toBe(true);
  });

  // ── 图片：云端这条路必须跟本地跑出来的一模一样 ──
  //
  // 拍平图片曾经是这里的做法，代价是模型看不到用户刚发的那张图，只能对着
  // 「[User sent an image]」硬答——而且答得挺像回事，用户根本看不出是这条路缺了东西。
  // 现在原样带上云，只在体积真的过不去时才从最老的开始丢，且当前这轮永不降级。

  /** 造一张「大图」：分段形状是真的，base64 内容用重复字符凑体积。 */
  const imageMessage = (role: string, kb: number, text = '[User sent an image]') => ({
    role,
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(kb * 1024)}` } },
    ],
  });

  const chatOf = async (state: any) => {
    const entry = state.entries.find((e: any) => e.key === 'fire_pack');
    return JSON.parse(await unpackStateValue(entry.value)).chat;
  };

  it('带图片那条原样上云（结构化分段一个字都不动）', async () => {
    const structured = [
      { role: 'user', content: [
        { type: 'text', text: '[User sent an image]' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ] },
    ];
    const { state } = await postOnce(structured);
    const chat = await chatOf(state);
    // 回归守卫：拍平的话这里会变成字符串 '[User sent an image]'，图片就此消失
    expect(chat.messages).toEqual(structured);
    expect(JSON.stringify(chat.messages)).toContain('base64');
  });

  it('体积超标 → 从最老的消息开始丢图片本体，文字段留下', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 三张 1 MB 的图，预算 2 MiB：最老的那张必然要丢
    const { state } = await postOnce([
      imageMessage('user', 1024, '第一张'),
      imageMessage('assistant', 1024, '第二张'),
      { role: 'user', content: '最后这句没有图' },
    ]);
    const chat = await chatOf(state);
    expect(chat.messages[0].content).toBe('第一张');          // 丢成文字段
    expect(typeof chat.messages[0].content).toBe('string');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('最新那条用户消息的图片永远不丢（这一轮要聊的就是它）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { state } = await postOnce([
      imageMessage('user', 1024, '很久以前那张'),
      imageMessage('assistant', 1024, '角色发的那张'),
      imageMessage('user', 512, '刚发出去的这张'),
    ]);
    const chat = await chatOf(state);
    const newest = chat.messages[2];
    // 回归守卫：从头往后丢的循环要是没跳过它，用户刚发的图就没了，而回复照样有
    expect(Array.isArray(newest.content)).toBe(true);
    expect(newest.content[1].image_url.url).toContain('base64');
    // 老的两条让位
    expect(typeof chat.messages[0].content).toBe('string');
    warn.mockRestore();
  });

  it('只剩最新那条还是超预算 → 抛错，不悄悄把当前这轮截断', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(postOnce([imageMessage('user', 4096, '一张巨图')]))
      .rejects.toThrow(/图片太大/);
    warn.mockRestore();
  });

  // ── 超预算的报错要说真话 ──
  // 拍平循环只压得动图片；纯文本本身就超限（长角色卡 + 世界书 + 近史）时它一条也压
  // 不掉。以前这条路也报「图片太大…删掉图片再发」——用户没有图可删，照着做永远修不好。
  it('纯文本就超预算 → 报「上下文太大」，一个字不提图片', async () => {
    const err = await postOnce([
      { role: 'system', content: 'A'.repeat(3 * 1024 * 1024) },
      { role: 'user', content: '在吗' },
    ]).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('上下文太大');
    // 回归守卫：旧文案叫用户删图，纯文本轮里没有图可删
    expect(err.message).not.toContain('图片');
  });

  it('小图 + 巨文本（删图也救不回来）→ 同样报上下文太大，不指错路让用户删图', async () => {
    const err = await postOnce([
      { role: 'system', content: 'A'.repeat(3 * 1024 * 1024) },
      imageMessage('user', 16, '顺手带的小图'),
    ]).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('上下文太大');
    expect(err.message).not.toContain('图片');
  });

});

describe('只有 202 才算发出去', () => {
  const send = async (status: number, body: unknown) => {
    stubFirePackDeps();
    mockInstantChatFetch(status, body);
    return sendInstantChatTurn({
      char: CHAR, chatMessages: [{ role: 'user', content: '在吗' }], api: API,
      userProfile: USER, groups: [], realtimeConfig: {} as any,
    });
  };

  it('202 → 记一笔待收记录', async () => {
    const result = await send(202, { status: 'accepted', uuid: 'uuid-ok' });
    expect(result.ok).toBe(true);
    expect(getInstantChatPending(CHAR.id)?.uuid).toBe('uuid-ok');
  });

  it('200 但没有 uuid → 算没发出去（别把「可能发了」当成发了）', async () => {
    const result = await send(200, { success: true });
    expect(result.ok).toBe(false);
    expect(getInstantChatPending(CHAR.id)).toBeNull();
  });

  it('401 → 明确告诉用户密钥对不上，不留待收记录', async () => {
    const result = await send(401, { success: false, error: { code: 'INVALID_CLIENT_TOKEN' } });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('共享密钥');
    expect(getInstantChatPending(CHAR.id)).toBeNull();
  });

  it('上游那一步挂了 → 原因带出来，仍然算没发出去', async () => {
    const result = await send(500, {
      success: false,
      error: {
        code: 'INSTANT_CHAT_STATE_FAILED', message: '云端状态没传上去，这条没发出去',
        step: 'client-state', upstream: { error: { message: 'D1 timeout' } },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('INSTANT_CHAT_STATE_FAILED');
    expect(result.error).toContain('D1 timeout');
    expect(getInstantChatPending(CHAR.id)).toBeNull();
  });

  // firstSendTime 是设备的钟加提前量算的，上游按自己的钟校验「必须在未来」——
  // 慢网大包上传或设备时钟偏慢都会把提前量吃光。这种失败要指条路（重试 / 查自动
  // 对时），不能掉进一句没人看得懂的 HTTP 400。
  it('上游打回「时间必须在未来」→ 文案指向网络慢 / 时钟偏慢', async () => {
    const result = await send(400, {
      success: false,
      error: {
        code: 'INSTANT_CHAT_TASK_FAILED', message: '任务没建起来，这条没发出去',
        step: 'schedule-message',
        upstream: {
          success: false,
          error: {
            code: 'INVALID_TIMESTAMP', message: '时间必须在未来',
            details: { field: 'firstSendTime', reason: 'must be in the future' },
          },
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('时钟');
    expect(getInstantChatPending(CHAR.id)).toBeNull();
  });
});

// 「API 调用记录」的记录点挂在全局 fetch 拦截器上，只认 /chat/completions——上云这一轮
// 本地只发一个 POST 给自己的 Worker，那条拦不到。不专门记的话，开了即时对话之后聊天
// 在记录里整个消失，看着像调用凭空没了。
describe('上云的这一轮也进「API 调用记录」', () => {
  /** 收走写库的那几笔（apiCallLog 走动态 import('./db')，按 DB 单例打桩拦得到）。 */
  const captureLog = () => {
    const logged: any[] = [];
    vi.spyOn(DB, 'appendApiCallLog').mockImplementation(async (entry: any) => { logged.push(entry); });
    return logged;
  };

  const sendOnce = async (status: number, body: unknown) => {
    stubFirePackDeps();
    mockInstantChatFetch(status, body);
    const logged = captureLog();
    await sendInstantChatTurn({
      char: CHAR, chatMessages: [{ role: 'user', content: '在吗' }], api: API,
      userProfile: USER, groups: [], realtimeConfig: {} as any,
    });
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    return logged[0];
  };

  it('202 → 落一笔标着云端的「生成中」记录', async () => {
    const entry = await sendOnce(202, { status: 'accepted', uuid: 'uuid-log' });
    expect(entry).toMatchObject({
      id: 'cloud-uuid-log',
      route: 'cloud-instant-chat',
      pending: true,
      ok: true,
      baseUrl: API.baseUrl,
      model: API.model,
      appName: '消息',
      charId: CHAR.id,
      charName: CHAR.name,
      // 跟本地生成那条路同一个词，两条路在列表里对得起来。
      purpose: '聊天回复',
    });
    // 输入构成照算：这一轮到底交上去多大的东西，本地就这一份线索。
    expect(entry.promptBreakdown?.length).toBeGreaterThan(0);
  });

  it('连 202 都没拿到 → 记一笔当场就是终态的失败，不留「生成中」挂着', async () => {
    const entry = await sendOnce(500, { success: false, error: { code: 'X', message: '云端挂了' } });
    expect(entry).toMatchObject({ route: 'cloud-instant-chat', pending: false, ok: false });
    expect(entry.promptBreakdown?.length).toBeGreaterThan(0);
  });

  it('还没等到回复就又发一条 → 上一笔收成「已顶替」，不会一直转圈到被裁掉', async () => {
    stubFirePackDeps();
    mockInstantChatFetch(202, { status: 'accepted', uuid: 'uuid-second' });
    setInstantChatPending(CHAR.id, 'uuid-first', 1_000);
    const logged = captureLog();
    await sendInstantChatTurn({
      char: CHAR, chatMessages: [{ role: 'user', content: '还在吗' }], api: API,
      userProfile: USER, groups: [], realtimeConfig: {} as any,
    });
    await vi.waitFor(() => expect(logged).toHaveLength(2));
    // 顶掉的那一轮不算失败：云端把两句合成一次回，只是它不再单独等回复了。
    expect(logged.find((e) => e.id === 'cloud-uuid-first')).toMatchObject({
      pending: false, superseded: true, ok: true,
    });
    expect(logged.find((e) => e.id === 'cloud-uuid-second')?.pending).toBe(true);
  });

  it('回复回来 → 同一条记录补上用量，时间戳一个字不动（列表顺序不许跟着回复先后跳）', async () => {
    const logged = captureLog();
    settleInstantChatApiLog('uuid-log', { amsgUsage: { promptTokens: 1200, completionTokens: 80 } });
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    expect(logged[0]).toMatchObject({
      id: 'cloud-uuid-log', pending: false, ok: true,
      promptTokens: 1200, completionTokens: 80,
      // 云端只报入和出，总数本地自己加——列表顶上的合计读的就是它。
      totalTokens: 1280,
    });
    expect(logged[0].timestamp).toBeUndefined();
    expect(logged[0].tokensPartial).toBeUndefined();
  });

  it('这一轮调过工具 → 用量标成只算末轮（云端只报得回最后一次调用的数）', async () => {
    const logged = captureLog();
    settleInstantChatApiLog('uuid-log', {
      amsgUsage: { promptTokens: 1200, completionTokens: 80 },
      amsgToolTrace: [{ name: 'web_search', count: 1 }],
    });
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    expect(logged[0].tokensPartial).toBe(true);
  });

  it('云端没回用量 → 只销「生成中」，不往记录里填 0 冒充真数', async () => {
    const logged = captureLog();
    settleInstantChatApiLog('uuid-log', {});
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    expect(logged[0].pending).toBe(false);
    expect(logged[0].promptTokens).toBeUndefined();
    expect(logged[0].totalTokens).toBeUndefined();
  });

  it('云端点名说这一轮没成 → 那笔跟着收尾成失败，不会一直写着「生成中」', async () => {
    setInstantChatPending(CHAR.id, 'uuid-dead', 1_000);
    vi.spyOn(DB, 'saveMessage').mockResolvedValue(undefined as any);
    const logged = captureLog();
    await failInstantChatPending(CHAR.id, 'uuid-dead', '云端生成失败');
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    expect(logged[0]).toMatchObject({ id: 'cloud-uuid-dead', pending: false, ok: false });
  });
});

describe('待收记录（「正在输入…」那盏灯的唯一依据）', () => {
  it('落在 localStorage 里，重启后还在', () => {
    setInstantChatPending('char-a', 'uuid-a', 1_000);
    // 模块状态每次都从存储读，等价于重开一次应用。
    expect(getInstantChatPending('char-a')).toEqual({ charId: 'char-a', uuid: 'uuid-a', acceptedAt: 1_000, charName: '' });
    expect(localStorage.getItem(AMSG_INSTANT_CHAT_PENDING_LS_KEY)).toContain('uuid-a');
  });

  it('同角色只留最新一条（顶替之后旧 uuid 没人认领了）', () => {
    setInstantChatPending('char-a', 'uuid-1', 1_000);
    setInstantChatPending('char-a', 'uuid-2', 2_000);
    expect(getInstantChatPending('char-a')?.uuid).toBe('uuid-2');
  });

  it('销账是幂等的', () => {
    setInstantChatPending('char-a', 'uuid-a', 1_000);
    expect(clearInstantChatPending('char-a')).toBe(true);
    expect(clearInstantChatPending('char-a')).toBe(false);
    expect(getInstantChatPending('char-a')).toBeNull();
  });

  it('存储里躺着坏数据时当没有，不能把整条路带崩', () => {
    localStorage.setItem(AMSG_INSTANT_CHAT_PENDING_LS_KEY, '{ 这不是 JSON');
    expect(getInstantChatPending('char-a')).toBeNull();
  });
});

// 这一轮以「没等到回复」收尾时，「情绪更新中」那盏灯也得跟着灭。
//
// 情绪评估的结果是搭最后一条回复的推送回来的（metadata.amsgEmotionDone）。可这一轮
// 要是**一条推送都没有**——模型空输出/纯拒答被 worker 判成 skip-push，或者整条 fire
// 硬失败——那个信号永远不会到，灯只能等 660 秒的安全网熄，期间还会弹一句「worker 可能
// 是旧版」的误导提示。云端已经点名说这一轮没成，就是最确定的熄灯时机。
describe('零推送收尾时也要熄灭情绪徽章', () => {
  // node 环境没有 window，给个最小 stub（这一组只关心派了哪些事件）。
  beforeAll(() => {
    (globalThis as any).window ??= { dispatchEvent: () => true };
  });

  /** 记下这一段派了哪些事件（spy 而不是手工换函数：restore 交给 vitest，漏还原不了）。 */
  const captureEvents = () => {
    const seen: Array<{ type: string; detail: any }> = [];
    const spy = vi.spyOn(window, 'dispatchEvent').mockImplementation((event: any) => {
      seen.push({ type: event?.type, detail: event?.detail });
      return true;
    });
    return { seen, restore: () => spy.mockRestore() };
  };

  it('销账成功 → 发一次 instant-emotion-done（徽章的熄灭信号）', async () => {
    setInstantChatPending('char-emo', 'uuid-emo', 1_000);
    const { seen, restore } = captureEvents();
    try {
      await failInstantChatPending('char-emo', 'uuid-emo', '云端生成失败');
    } finally {
      restore();
    }
    const done = seen.filter((e) => e.type === 'instant-emotion-done');
    expect(done).toHaveLength(1);
    expect(done[0].detail).toEqual({ charId: 'char-emo' });
  });

  // 结论迟到、用户已经又发了一条时，销的是新那一轮的账才叫出事——灯也一样：
  // 新那一轮的评估还在云端跑着，这时候熄灯等于骗人。
  it('结论对不上当前这一轮 → 一个事件都不发（新那一轮的灯不许碰）', async () => {
    setInstantChatPending('char-emo', 'uuid-new', 2_000);
    const { seen, restore } = captureEvents();
    try {
      await failInstantChatPending('char-emo', 'uuid-old', '迟到的结论');
    } finally {
      restore();
    }
    expect(seen.some((e) => e.type === 'instant-emotion-done')).toBe(false);
    expect(getInstantChatPending('char-emo')?.uuid).toBe('uuid-new');
  });
});

describe('开关', () => {
  it('设置页开了 + 地址填着 → 走云端', async () => {
    expect(await isInstantChatReady()).toBe(true);
    expect(await resolveInstantChatReadiness()).toEqual({ ready: true });
  });

  it('开关没开 → 不走（每条消息都读这一份，别处不做第二道门）', async () => {
    storeState.config = { ...storeState.config, instantChatEnabled: false };
    expect(await isInstantChatReady()).toBe(false);
    expect(await resolveInstantChatReadiness()).toEqual({ ready: false, reason: 'disabled' });
  });

  it('地址空着 → 不走', async () => {
    storeState.config = { ...storeState.config, workerUrl: '  ' };
    expect(await isInstantChatReady()).toBe(false);
    expect(await resolveInstantChatReadiness()).toEqual({ ready: false, reason: 'no-worker-url' });
  });

  // ─── Worker 跑不动这条路（instantChatSupported）───
  //
  // 跑不动的 Worker 上即时对话是**发一条挂一条**：老 bundle 被 waitUntil 砍在 30 秒，
  // 新 bundle 少了起跳器直接 503。用户开着开关也得让位给本地生成，否则他对着
  // 「正在输入…」等一条永远不来的回复，而设置页写着「已开启」。

  // 存量是粘的（只有探测成功才翻得回来），所以让位之前一定要先现探一次——下面四条钉的
  // 就是这次现探的四种去向。

  /** 存量说跑不动 + 摆好「这次现探会问到什么」。 */
  const stageOutdatedWithProbe = (outcome: 'supported' | 'unsupported' | 'unknown') => {
    storeState.config = { ...storeState.config, instantChatEnabled: true, instantChatSupported: false };
    // 冷却是模块级状态，会串到别的用例上去。
    resetInstantChatReprobeCooldown();
    return vi.spyOn(ActiveMsgClient, 'probeInstantChatSupportDetailed').mockResolvedValue({
      outcome,
      supported: outcome === 'supported' ? true : outcome === 'unsupported' ? false : undefined,
    });
  };

  it('现探确认跑不动 → 用户开着也不走云端（reason worker-outdated）', async () => {
    stageOutdatedWithProbe('unsupported');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* 静音，只数次数 */ });
    const readiness = await resolveInstantChatReadiness();
    expect(readiness).toEqual({ ready: false, reason: 'worker-outdated' });
    // 「用户没开」和「开了但用不了」是两回事：混成 disabled 的话，设置页那句提示、
    // 观察窗那条 trace 都没了着落。
    expect(readiness.reason).not.toBe('disabled');
    // 静默让位正是「静默分流」那个坑，必须留声。
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // ★ 这条是「一次抖动 ≠ 长期降级」的守卫。
  // 从前存量一旦是 false 就直接判死，而写下这个 false 的可能只是一次网络抖动——用户不
  // 碰巧打开设置页就一直卡在本地生成（线上真实故障：Worker 全绿，用户连着几小时全走本地，
  // 而他的本地直连根本不通）。现在发消息路上会现探一次，好了立刻回到云端。
  it('存量说跑不动、现探却发现已经好了 → 这一轮就回到云端（不必等用户去开设置页）', async () => {
    stageOutdatedWithProbe('supported');
    expect(await resolveInstantChatReadiness()).toEqual({ ready: true });
  });

  // 够不着云端时不能指人去「更新 Worker」：他多半点不动，而且问题也不在那儿。
  it('现探够不着云端 → 单独一档 worker-unreachable，不叫人去更新 Worker', async () => {
    stageOutdatedWithProbe('unknown');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* 静音，只数次数 */ });
    const readiness = await resolveInstantChatReadiness();
    expect(readiness).toEqual({ ready: false, reason: 'worker-unreachable' });
    expect(readiness.reason).not.toBe('worker-outdated');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // 现探是加在发消息路上的，连发几条消息不能变成一串 /config-check。
  it('冷却期内不重复现探（连发三条只探一次）', async () => {
    const probe = stageOutdatedWithProbe('unsupported');
    vi.spyOn(console, 'warn').mockImplementation(() => { /* 静音 */ });
    await resolveInstantChatReadiness();
    await resolveInstantChatReadiness();
    await resolveInstantChatReadiness();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('没探过（undefined）→ 放行：不知道 ≠ 知道它不行', async () => {
    storeState.config = { ...storeState.config, instantChatEnabled: true, instantChatSupported: undefined };
    expect(await resolveInstantChatReadiness()).toEqual({ ready: true });
  });

  it('探到能跑 → 照常上云', async () => {
    storeState.config = { ...storeState.config, instantChatEnabled: true, instantChatSupported: true };
    expect(await resolveInstantChatReadiness()).toEqual({ ready: true });
  });

  // ─── 那台 Worker 是不是当前 bundle（workerBundleCurrent）───
  //
  // 不参与放行，只给「这一轮要用新协议」的回合做额外否决（SAR 信封：旧 bundle 会把它切碎上屏）。
  // 三态都要钉：没探过当成「旧」的话，刚装好、还没握手的人一开 SAR 就被踢回本地。
  it('存量版本等于当前 bundle → workerBundleCurrent: true', async () => {
    storeState.config = { ...storeState.config, instantChatSupported: true, workerBundleVersion: AMSG_BUNDLE_VERSION };
    expect(await resolveInstantChatReadiness()).toEqual({ ready: true, workerBundleCurrent: true });
  });

  it('存量版本不等（含老 bundle 不报版本记下的 null）→ workerBundleCurrent: false，但照常 ready', async () => {
    storeState.config = { ...storeState.config, instantChatSupported: true, workerBundleVersion: '2000-01-01' };
    expect(await resolveInstantChatReadiness()).toEqual({ ready: true, workerBundleCurrent: false });
    storeState.config = { ...storeState.config, workerBundleVersion: null };
    expect(await resolveInstantChatReadiness()).toEqual({ ready: true, workerBundleCurrent: false });
  });

  it('从没探过版本（undefined）→ 不给结论，调用方放行', async () => {
    storeState.config = { ...storeState.config, instantChatSupported: true, workerBundleVersion: undefined };
    const readiness = await resolveInstantChatReadiness();
    expect(readiness.ready).toBe(true);
    expect(readiness).not.toHaveProperty('workerBundleCurrent');
  });

  // ─── ensureBundleVersion：需要信封的回合，版本没探过就当场问一次 ───
  //
  // 老用户刚更新 App、握手探测还没回来就发了一条 SAR 消息：存量是空的。直接放行等于赌那台
  // Worker 认得信封，赌输了信封整段切碎上屏。
  describe('ensureBundleVersion（版本存量为空时现探）', () => {
    const stageUnprobed = (state: 'current' | 'outdated' | 'unknown') => {
      storeState.config = { ...storeState.config, instantChatSupported: true, workerBundleVersion: undefined };
      resetInstantChatReprobeCooldown();
      return vi.spyOn(ActiveMsgClient, 'probeWorkerVersion').mockResolvedValue({
        state, deployed: state === 'current' ? AMSG_BUNDLE_VERSION : null, expected: AMSG_BUNDLE_VERSION, autoUpdate: null,
      });
    };

    it('没探过 + 需要信封 → 带超时现探一次，探到当前版本就放行', async () => {
      const probe = stageUnprobed('current');
      expect(await resolveInstantChatReadiness(undefined, { ensureBundleVersion: true }))
        .toEqual({ ready: true, workerBundleCurrent: true });
      expect(probe).toHaveBeenCalledTimes(1);
      // 发消息路上的现探必须带超时，别把用户按在发送键上干等。
      expect(probe).toHaveBeenCalledWith({ timeoutMs: INSTANT_CHAT_REPROBE_TIMEOUT_MS });
    });

    it('没探过 + 不需要信封（普通 / 恢复期回合）→ 不探，照旧不给结论', async () => {
      const probe = stageUnprobed('current');
      const readiness = await resolveInstantChatReadiness();
      expect(readiness).toEqual({ ready: true });
      expect(probe).not.toHaveBeenCalled();
    });

    it('现探到旧版 → workerBundleCurrent: false（调用方否决 outdated）', async () => {
      stageUnprobed('outdated');
      expect(await resolveInstantChatReadiness(undefined, { ensureBundleVersion: true }))
        .toEqual({ ready: true, workerBundleCurrent: false });
    });

    it('现探没问到 → 不给结论（调用方否决 unverified，而不是放行）', async () => {
      stageUnprobed('unknown');
      const readiness = await resolveInstantChatReadiness(undefined, { ensureBundleVersion: true });
      expect(readiness.ready).toBe(true);
      expect(readiness).not.toHaveProperty('workerBundleCurrent');
    });

    it('存量已有结论 → 不现探', async () => {
      const probe = stageUnprobed('current');
      storeState.config = { ...storeState.config, workerBundleVersion: '2000-01-01' };
      expect(await resolveInstantChatReadiness(undefined, { ensureBundleVersion: true }))
        .toEqual({ ready: true, workerBundleCurrent: false });
      expect(probe).not.toHaveBeenCalled();
    });

    it('没问到之后冷却期内不重复探（连发三条 SAR 消息只探一次）', async () => {
      const probe = stageUnprobed('unknown');
      for (let i = 0; i < 3; i += 1) {
        await resolveInstantChatReadiness(undefined, { ensureBundleVersion: true });
      }
      expect(probe).toHaveBeenCalledTimes(1);
    });
  });

  it('现探翻回 ready 时，用的是现探刚记下的版本（不拿探测前那份旧存量）', async () => {
    storeState.config = {
      ...storeState.config, instantChatSupported: false, workerBundleVersion: '2000-01-01',
    };
    resetInstantChatReprobeCooldown();
    vi.spyOn(ActiveMsgClient, 'probeInstantChatSupportDetailed').mockImplementation(async () => {
      // 真的那份会在问到答案时顺手存版本，这里照做。
      storeState.config = { ...storeState.config, instantChatSupported: true, workerBundleVersion: AMSG_BUNDLE_VERSION };
      return { outcome: 'supported', supported: true };
    });
    vi.spyOn(console, 'info').mockImplementation(() => { /* 静音 */ });
    expect(await resolveInstantChatReadiness()).toEqual({ ready: true, workerBundleCurrent: true });
  });

  // 用户自己没开的时候，「Worker 行不行」根本不该被问——那一档的原因是 disabled，
  // 报成 worker-outdated 会让设置页对着一个没开的开关喊「去更新 Worker」。
  it('用户自己没开时，先报 disabled，不越到 worker-outdated', async () => {
    storeState.config = { ...storeState.config, instantChatEnabled: false, instantChatSupported: false };
    expect(await resolveInstantChatReadiness()).toEqual({ ready: false, reason: 'disabled' });
  });

  // 能力位是「上一台 Worker」留下的存量。地址都空着还报「Worker 太旧」的话，
  // 设置页会把人指去点一个根本没连上的东西。
  it('地址空着时报 no-worker-url，不越到 worker-outdated', async () => {
    storeState.config = { ...storeState.config, workerUrl: '  ', instantChatSupported: false };
    expect(await resolveInstantChatReadiness()).toEqual({ ready: false, reason: 'no-worker-url' });
  });

  // 读配置失败被当成「没开」的话，这一轮会悄悄退回本地直连生成：用户按完发送随手锁屏，
  // 本地 fetch 被系统掐掉，回来时既没有回复也没有报错，设置页还写着「已开启」，观察窗里
  // 查无此事。所以它必须是单独一档、而且落地一条 warn。
  it('配置根本读不出来 ≠ 没开：单独一档 config-unreadable，而且不许静默', async () => {
    storeState.configError = new Error('IndexedDB blocked by another tab');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* 静音，只数次数 */ });
    const readiness = await resolveInstantChatReadiness();
    expect(readiness).toEqual({ ready: false, reason: 'config-unreadable' });
    expect(readiness.reason).not.toBe('disabled');
    expect(warn).toHaveBeenCalledTimes(1);
    // 只关心「走不走得通」的老调用点（设置页互斥门）行为不变：依旧是 false，不抛。
    expect(await isInstantChatReady()).toBe(false);
  });

  // ─── 角色级开关（undefined = 跟随全局默认开，只认显式 false）───

  it('角色自己关了 → 不走云端，reason char-disabled', async () => {
    const char = { activeMsg2Config: { enabled: true, instantChatEnabled: false } } as any;
    expect(await resolveInstantChatReadiness(char)).toEqual({ ready: false, reason: 'char-disabled' });
  });

  it('字段没设 / 显式 true → 照常上云（undefined 就是开，没有兼容舞步）', async () => {
    expect(await resolveInstantChatReadiness({ activeMsg2Config: { enabled: true } } as any))
      .toEqual({ ready: true });
    expect(await resolveInstantChatReadiness({ activeMsg2Config: { enabled: true, instantChatEnabled: true } } as any))
      .toEqual({ ready: true });
    // 连 activeMsg2Config 都没有的角色也一样是开。
    expect(await resolveInstantChatReadiness({} as any)).toEqual({ ready: true });
  });

  it('与排程开关互相独立：enabled=false 不影响即时对话', async () => {
    // 只即时不排程：排程关着、即时字段没设 → 照常上云。
    expect(await resolveInstantChatReadiness({ activeMsg2Config: { enabled: false } } as any))
      .toEqual({ ready: true });
  });

  it('char-disabled 是用户的主动选择，不 warn（跟「全局没开」同一待遇）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* 静音，只数次数 */ });
    await resolveInstantChatReadiness({ activeMsg2Config: { enabled: true, instantChatEnabled: false } } as any);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('随这一轮上云的作废回执', () => {
  const NOTICE_CHAR = 'char-notice';

  it('202 之后只记账，不销账（受理 ≠ 角色读到过）', () => {
    stageInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-1', ['n1', 'n2']);
    expect(getStagedInstantChatExpiredNotices(NOTICE_CHAR)).toEqual({
      charId: NOTICE_CHAR, uuid: 'uuid-1', ids: ['n1', 'n2'],
    });
    expect(storeState.markedNotices).toEqual([]);
  });

  it('回复真的落库了才销账，而且只销一次', async () => {
    stageInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-1', ['n1', 'n2']);
    expect(await settleInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-1')).toEqual(['n1', 'n2']);
    expect(storeState.markedNotices).toEqual([{ charId: NOTICE_CHAR, ids: ['n1', 'n2'] }]);
    // 台账已经取走：同一轮的补收 / 重复冲刷再调一次不会二次销账。
    expect(await settleInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-1')).toEqual([]);
    expect(storeState.markedNotices).toHaveLength(1);
  });

  it('销账认 uuid：上一轮迟到的结论碰不到新那一轮的回执', async () => {
    stageInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-new', ['n1']);
    expect(await settleInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-old')).toEqual([]);
    expect(storeState.markedNotices).toEqual([]);
    expect(getStagedInstantChatExpiredNotices(NOTICE_CHAR)?.uuid).toBe('uuid-new');
  });

  it('连发时新那一轮顶掉旧记录（旧的还没销账，会跟着新一轮一起重注）', () => {
    stageInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-1', ['n1']);
    stageInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-2', ['n1', 'n2']);
    expect(getStagedInstantChatExpiredNotices(NOTICE_CHAR)).toEqual({
      charId: NOTICE_CHAR, uuid: 'uuid-2', ids: ['n1', 'n2'],
    });
  });

  it('台账扛得住重启（云端那一轮本来就可能横跨一次刷新）', () => {
    stageInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-1', ['n1']);
    expect(JSON.parse(localStorage.getItem(AMSG_INSTANT_CHAT_STAGED_NOTICES_LS_KEY) || '{}'))
      .toEqual({ [NOTICE_CHAR]: { charId: NOTICE_CHAR, uuid: 'uuid-1', ids: ['n1'] } });
  });

  // 这一条是整个改动的由头：云端整轮失败（空输出被判 skip-push / fire 重试打光）时，
  // 回执要是已经销过账，角色永远不知道那条任务被作废过 —— 聊天里许下的承诺凭空消失。
  it('这一轮判定失败 → 回执退回未告知，绝不销账', async () => {
    setInstantChatPending(NOTICE_CHAR, 'uuid-1', 1_000);
    stageInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-1', ['n1']);
    vi.spyOn(DB, 'saveMessage').mockResolvedValue(undefined as any);
    await failInstantChatPending(NOTICE_CHAR, 'uuid-1', '云端生成失败');
    expect(storeState.markedNotices).toEqual([]);
    expect(getStagedInstantChatExpiredNotices(NOTICE_CHAR)).toBeNull();
  });

  it('失败结论对不上当前这一轮 → 新那一轮的回执一根都别动', async () => {
    setInstantChatPending(NOTICE_CHAR, 'uuid-new', 2_000);
    stageInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-new', ['n1']);
    vi.spyOn(DB, 'saveMessage').mockResolvedValue(undefined as any);
    await failInstantChatPending(NOTICE_CHAR, 'uuid-old', '迟到的结论');
    expect(getStagedInstantChatExpiredNotices(NOTICE_CHAR)?.ids).toEqual(['n1']);
    expect(discardInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-new')).toEqual(['n1']);
    expect(storeState.markedNotices).toEqual([]);
  });
});

describe('推送丢了的补收（服务端账本）', () => {
  const outboxPush = (messageId: string, overrides: Record<string, any> = {}) => ({
    messageKind: 'content',
    messageType: 'instant',
    source: 'scheduled',
    message: '我在呢',
    contactName: '小满',
    messageId,
    sessionId: 'sess-1',
    messageIndex: 1,
    totalMessages: 1,
    timestamp: new Date(1_700_000_000_000).toISOString(),
    taskId: 7,
    taskUuid: 'uuid-round-1',
    occurrenceMs: 1_700_000_000_000,
    metadata: { charId: CHAR.id, charName: '小满', amsgInstantChat: true },
    ...overrides,
  });

  const entry = (messageId: string, push: Record<string, any>, createdAt = Date.now()) => ({
    id: 1, messageId, taskUuid: 'uuid-round-1', sessionId: 'sess-1',
    messageIndex: 1, totalMessages: 1, createdAt, deliveredAt: null, push,
  });

  const stubOutbox = (entries: any[]) => {
    vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockResolvedValue(entries as any);
  };

  // 有旧接管标记时也走同一条补收和去重链。
  beforeEach(() => {
    localStorage.setItem(AMSG_OUTBOX_ADOPTED_LS_KEY, JSON.stringify({ at: Date.now() }));
  });

  it('账本上的那条写进收件箱，字段跟 SW 收真推送时写的一份对得上', async () => {
    const messageId = 'msg_task_7@1700000000000_hook_0';
    stubOutbox([entry(messageId, outboxPush(messageId))]);
    const { written, ackNow } = await drainOutbox();
    expect(written).toBe(1);
    expect(ackNow).toEqual([]);           // 落库之前不许销账
    const saved = storeState.saved[0];
    expect(saved.charId).toBe(CHAR.id);
    expect(saved.body).toBe('我在呢');
    expect(saved.messageType).toBe('instant');
    expect(saved.taskId).toBe(7);
    expect(saved.metadata.sessionId).toBe('sess-1');
    expect(saved.sentAt).toBe(1_700_000_000_000);
  });

  // Service Worker 直送和账本补收写的是同一批消息、同一个主键，补收落库就是整条覆盖。
  // 要是连「到达时间」也覆盖成现在，这条在收件箱里躺了多久就永远查不出来了（一律显示
  // 刚到），而「送达时用户在不在场」正是拿它判的——判错的后果是：明明用户离开时就到了、
  // 系统通知早已完整念过一遍的消息，回来还要一条条重演打字。
  it('SW 已经送到、还没被消费的那条，补收只换内容不改它到达的时刻', async () => {
    const messageId = 'msg_task_7@1700000000000_hook_0';
    const swReceivedAt = Date.now() - 30_000;   // SW 半分钟前就把它存进收件箱了
    storeState.inbox = [{ messageId, receivedAt: swReceivedAt }] as any;
    stubOutbox([entry(messageId, outboxPush(messageId))]);

    await drainOutbox();

    expect(storeState.saved[0].receivedAt, '第一次落到这台设备的时刻不该被抹掉').toBe(swReceivedAt);
  });

  it('本地压根没有过的那条，到达时刻才记成现在', async () => {
    const messageId = 'msg_task_7@1700000000000_hook_1';
    const before = Date.now();
    storeState.inbox = [];
    stubOutbox([entry(messageId, outboxPush(messageId))]);

    await drainOutbox();

    expect(storeState.saved[0].receivedAt).toBeGreaterThanOrEqual(before);
  });

  it.each([47, 49, 21 * 24])('%i 小时前仍在云端的消息也写入收件箱，不能提前销账', async (hours) => {
    const messageId = `msg-retained-${hours}`;
    stubOutbox([entry(messageId, outboxPush(messageId), Date.now() - hours * 3_600_000)]);
    const { written, ackNow, staleDropped } = await drainOutbox();
    expect(written).toBe(1);
    expect(storeState.saved.map((m: any) => m.messageId)).toEqual([messageId]);
    expect(ackNow).toEqual([]);
    expect(staleDropped).toBe(0);
  });

  it('完整历史里已有同 ID 的消息，只补销账，不重复上屏', async () => {
    const messageId = 'msg-already-persisted';
    stubOutbox([entry(messageId, outboxPush(messageId), Date.now() - 49 * 3_600_000)]);
    await DB.saveMessage({ charId: CHAR.id, role: 'assistant', type: 'text', content: '已收下',
      metadata: { activeMsg2: { messageId } } } as any);
    const { written, ackNow, staleDropped } = await drainOutbox();
    expect(written).toBe(0);
    expect(ackNow).toEqual([messageId]);
    expect(staleDropped).toBe(0);
  });

  it('本地历史核对失败时保留云端账目，不把未知当作未收到', async () => {
    stubOutbox([entry('msg-history-unreadable', outboxPush('msg-history-unreadable'))]);
    vi.spyOn(DB, 'findPersistedActiveMessageIds').mockRejectedValueOnce(new Error('database unavailable'));
    const ack = vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);
    await expect(drainOutbox()).rejects.toThrow('database unavailable');
    expect(storeState.saved).toHaveLength(0);
    expect(ack).not.toHaveBeenCalled();
  });

  // 补收回来已经没有意义的那几类：思维链要挂在正文上、工具请求那头的云端早就收工了、
  // 隔了一阵子的报错弹出来只会让人摸不着头脑。但账还是要销，不然每趟都把它们捞回来。
  it.each(['reasoning', 'tool_request', 'error'])('%s 类不进聊天流，当场销账', async (kind) => {
    const messageId = `msg-${kind}`;
    stubOutbox([entry(messageId, outboxPush(messageId, { messageKind: kind }))]);
    const { written, ackNow } = await drainOutbox();
    expect(written).toBe(0);
    expect(storeState.saved).toHaveLength(0);
    expect(ackNow).toEqual([messageId]);
  });

  // 后台任务（门牌整理这类）跑完送回来的结果**只走这条路**：不弹通知的结果上游只落
  // 账本、不发推送，所以补收是它唯一的入口。跟 reasoning/error 那批一起当场销账丢掉的
  // 话，云端跑完的东西会一声不响地全部蒸发——面板全绿、日志干净、就是东西没了。
  describe('后台任务的结果（messageKind: result）', () => {
    beforeEach(() => {
      resultDispatch.calls = [];
      resultDispatch.contexts = [];
      resultDispatch.settle = true;
    });

    it('交给分发口，不写进聊天流', async () => {
      const messageId = 'msg-result';
      const push = outboxPush(messageId, {
        messageKind: 'result',
        resultKind: 'plate-consolidate',
        message: undefined,
        items: [{ room: 'user_room', text: '小明搬去合租了' }],
      });
      stubOutbox([entry(messageId, push)]);
      const { written, ackNow } = await drainOutbox();

      expect(written).toBe(0);
      expect(storeState.saved).toHaveLength(0);
      expect(resultDispatch.calls).toEqual([push]);
      expect(ackNow).toEqual([messageId]);
    });

    it('消化失败就不销账，下次上线再拉回来', async () => {
      resultDispatch.settle = false;
      const messageId = 'msg-result-retry';
      stubOutbox([entry(messageId, outboxPush(messageId, {
        messageKind: 'result', resultKind: 'plate-consolidate',
      }))]);
      const { ackNow } = await drainOutbox();
      expect(ackNow).toEqual([]);
    });

    // 结果的有效期归认领方判断，所以必须原样传递服务端记账时间。
    it('结果处理器收到原始记账时间，自己判断有效期', async () => {
      const messageId = 'msg-result-old';
      const tooOld = Date.now() - (48 * 60 * 60 * 1000) - 1;
      stubOutbox([entry(messageId, outboxPush(messageId, {
        messageKind: 'result', resultKind: 'plate-consolidate',
      }), tooOld)]);
      await drainOutbox();
      expect(resultDispatch.calls).toHaveLength(1);
      expect(resultDispatch.contexts[0], '不交时间的话它连「这份躺了多久」都问不出来')
        .toEqual({ createdAt: tooOld });
    });
  });

  it('情绪结果显式标成 emotion_update（冲刷管线靠它分流，认不出会当正文气泡渲染）', async () => {
    const messageId = 'msg-emotion';
    stubOutbox([entry(messageId, outboxPush(messageId, {
      messageKind: 'emotion_update',
      messageType: undefined,
      message: '',
      metadata: { charId: CHAR.id, emotionRaw: '{"joy":1}' },
    }))]);
    const { written } = await drainOutbox();
    expect(written).toBe(1);
    expect(storeState.saved[0].messageType).toBe('emotion_update');
    expect(storeState.saved[0].metadata.emotionRaw).toBe('{"joy":1}');
  });

  it('推送载荷少了 charId → 没有落点，丢掉并销账而不是造一条无主消息', async () => {
    stubOutbox([entry('msg-orphan', { messageKind: 'content', message: '孤儿' })]);
    const { written, ackNow } = await drainOutbox();
    expect(written).toBe(0);
    expect(storeState.saved).toHaveLength(0);
    expect(ackNow).toEqual(['msg-orphan']);
  });

  // 销账即失忆：账一销，这条就再也拉不回来了。写不进收件箱时必须留着账。
  it('写收件箱失败 → 不销账，下次拉回来再试', async () => {
    const messageId = 'msg_task_7@1700000000000_hook_0';
    stubOutbox([entry(messageId, outboxPush(messageId))]);
    const { ActiveMsgStore } = await import('./activeMsgStore');
    vi.spyOn(ActiveMsgStore, 'saveInboxMessage').mockRejectedValueOnce(new Error('quota'));
    const { written, ackNow } = await drainOutbox();
    expect(written).toBe(0);
    expect(ackNow).toEqual([]);
  });

  it('账本读失败照常抛（「没读到」≠「读到了、确实没有」，调用方才好分开收场）', async () => {
    vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockRejectedValue(new Error('offline'));
    await expect(drainOutbox()).rejects.toThrow('offline');
  });

  // 契约测试：push→inbox 的字段映射有两份手工同步的副本（SW 的 saveContentToInbox 与
  // 这里的补收路径），销账检查只读 metadata.messageIndex/totalMessages、缺失当末段——
  // 任一副本漏抄这两个字段，多段回复的首段就会被当成末段销账，后续段永久丢失且无报错。
  // 这里钉住补收侧必须把顶层段号抄进 metadata（与 sw-keep-alive.ts 的映射同一条规则；
  // 那份是 SW 代码没法直接 import，改动 SW 映射时这条测试就是要一起过的清单）。
  it('顶层 messageIndex/totalMessages 必须抄进 metadata（销账检查只认 metadata 里的）', async () => {
    const messageId = 'msg_task_7@1700000000000_hook_0';
    stubOutbox([entry(messageId, {
      messageKind: 'content',
      message: '第一段',
      messageId,
      sessionId: 'sess_task_7@1700000000000',
      taskUuid: 'uuid-round-1',
      messageIndex: 1,
      totalMessages: 3,
      metadata: { charId: CHAR.id },
    })]);
    await drainOutbox();
    const inbox = storeState.saved[0];
    expect(inbox).toBeTruthy();
    expect(inbox.metadata.messageIndex).toBe(1);
    expect(inbox.metadata.totalMessages).toBe(3);
    expect(inbox.metadata.sessionId).toBe('sess_task_7@1700000000000');
  });
});

// 首次接管与之后补收一致：按实际落库情况去重，不能整批销掉存量。
describe('第一次接上服务端账本', () => {
  const entry = (messageId: string, taskUuid: string) => ({
    id: 1,
    messageId,
    taskUuid,
    sessionId: 'sess-x',
    messageIndex: 1,
    totalMessages: 1,
    createdAt: Date.now(),
    deliveredAt: null,
    push: {
      messageKind: 'content',
      message: '这是账本上的存量',
      messageId,
      taskUuid,
      metadata: { charId: CHAR.id, charName: '小满' },
    },
  });

  const stubOutboxOnce = (entries: any[]) =>
    vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockResolvedValue(entries as any);

  it('未收到的存量照常进收件箱，落库前不销账', async () => {
    stubOutboxOnce([entry('m1', 'uuid-1'), entry('m2', 'uuid-2')]);
    const ack = vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);
    const { written, ackNow } = await drainOutbox();
    expect(written).toBe(2);
    expect(storeState.saved.map((m: any) => m.messageId)).toEqual(['m1', 'm2']);
    expect(ack).not.toHaveBeenCalled();
    expect(ackNow).toEqual([]);
  });

  it('正在等回复和没有待收记录的消息都能补收', async () => {
    setInstantChatPending(CHAR.id, 'uuid-awaited');
    stubOutboxOnce([entry('m-old', 'uuid-old'), entry('m-awaited', 'uuid-awaited')]);
    const ack = vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);
    const { written } = await drainOutbox();
    expect(written).toBe(2);
    expect(storeState.saved.map((m: any) => m.messageId)).toEqual(['m-old', 'm-awaited']);
    expect(ack).not.toHaveBeenCalled();
  });

  it('后台任务结果成功处理后才销账，正文另等落库', async () => {
    resultDispatch.calls = [];
    resultDispatch.settle = true;
    const resultEntry = {
      ...entry('m-result', 'uuid-job'),
      push: { messageKind: 'result', resultKind: 'plate-consolidate', messageId: 'm-result' },
    };
    stubOutboxOnce([entry('m-old', 'uuid-old'), resultEntry]);
    const ack = vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);
    const { written, ackNow } = await drainOutbox();
    expect(ack).not.toHaveBeenCalled();
    expect(written).toBe(1);
    expect(resultDispatch.calls).toHaveLength(1);
    expect(ackNow).toEqual(['m-result']);
  });

  it('收件箱写失败不销账，下次仍能补回同一条', async () => {
    stubOutboxOnce([entry('m-retry', 'uuid-retry')]);
    const ack = vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);
    vi.spyOn(ActiveMsgStore, 'saveInboxMessage').mockRejectedValueOnce(new Error('quota'));
    const first = await drainOutbox();
    expect(first.written).toBe(0);
    expect(first.ackNow).toEqual([]);
    expect(ack).not.toHaveBeenCalled();
    expect((await drainOutbox()).written).toBe(1);
  });

  it('首次补收之后，新条目也照常接收', async () => {
    const list = stubOutboxOnce([entry('m-backlog', 'uuid-old')]);
    await drainOutbox();
    list.mockResolvedValue([entry('m-new', 'uuid-new')] as any);
    expect((await drainOutbox()).written).toBe(1);
    expect(storeState.saved.map((m: any) => m.messageId)).toEqual(['m-backlog', 'm-new']);
  });

  it('手动补收与自动补收遵循同一条落库前不 ACK 的规则', async () => {
    stubOutboxOnce([entry('m-missed', 'uuid-missed')]);
    const ack = vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);
    const { written, ackNow } = await drainOutbox({ treatBacklogAsMissed: true });
    expect(written).toBe(1);
    expect(storeState.saved.map((m: any) => m.messageId)).toEqual(['m-missed']);
    expect(ackNow).toEqual([]);
    expect(ack).not.toHaveBeenCalled();
  });
});

// ─── 两处探 /config-check 的地方都顺手记下那台 Worker 的 bundle 版本 ───
//
// SAR 信封回合要不要上云只看这份存量；只在一处记的话，另一条路（握手 / 设置页）探完
// 存量还是旧的，用户更新完 Worker 也照样被踢回本地。
describe('探测顺手记下 bundle 版本（workerBundleVersion）', () => {
  const configCheck = (status: number, data: Record<string, unknown> | null) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status,
      ok: status >= 200 && status < 300,
      json: async () => (data ? { success: true, data } : { success: false }),
      text: async () => JSON.stringify(data ? { success: true, data } : { success: false }),
      headers: { get: () => 'application/json' },
    } as any)));
  };
  const versionWrites = () => (ActiveMsgStore.saveGlobalConfig as any).mock.calls
    .map((call: any[]) => call[0])
    .filter((update: Record<string, unknown>) => 'workerBundleVersion' in update);

  beforeEach(() => { (ActiveMsgStore.saveGlobalConfig as any).mockClear(); });

  it('probeInstantChatSupportDetailed：问到答案就记版本', async () => {
    configCheck(200, { instantTick: true, workerVersion: '2099-01-01' });
    await ActiveMsgClient.probeInstantChatSupportDetailed();
    expect(versionWrites()).toContainEqual({ workerBundleVersion: '2099-01-01' });
  });

  it('probeWorkerVersion：老 bundle 不报版本 → 记 null（问到了，确实旧）', async () => {
    configCheck(200, { instantTick: true });
    await ActiveMsgClient.probeWorkerVersion();
    expect(versionWrites()).toContainEqual({ workerBundleVersion: null });
  });

  it('没问到答案（5xx）→ 一个字都不写，存量保持原样', async () => {
    configCheck(503, null);
    await ActiveMsgClient.probeWorkerVersion();
    await ActiveMsgClient.probeInstantChatSupportDetailed();
    expect(versionWrites()).toEqual([]);
  });
});

it('POST受理前停止也立即屏蔽这一轮，拿到202后不重新点亮待收状态', async () => {
  const { isReplyStopped } = await import('./chatReplyCancellation');
  const controller = new AbortController();
  let accept!: (value: any) => void;
  let requestedUuid = '';
  const send = vi.spyOn(ActiveMsgClient, 'sendInstantChat').mockImplementation(params => {
    requestedUuid = params.uuid!;
    return new Promise(resolve => { accept = resolve; });
  });
  const cancel = vi.spyOn(ActiveMsgClient, 'cancelTask').mockResolvedValue({ uuid: '', alreadyGone: true });
  const write = vi.spyOn(ActiveMsgClient, 'writeClientStateValue').mockResolvedValue(undefined);
  const pending = sendInstantChatTurn({
    char: CHAR, chatMessages: [{ role: 'user', content: '在吗' }], api: API,
    userProfile: USER, groups: [], realtimeConfig: {} as any, signal: controller.signal,
  });
  controller.abort();
  expect(isReplyStopped(requestedUuid)).toBe(true);
  accept({ uuid: requestedUuid });
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(getInstantChatPending(CHAR.id)).toBeNull();
  expect(cancel).toHaveBeenCalledWith(requestedUuid);
  send.mockRestore(); cancel.mockRestore(); write.mockRestore();
});

it('停止待收轮立即解除占位；云端取消失败也只保留已显示正文', async () => {
  const { publishReplyDisplay, isReplyStopped } = await import('./chatReplyCancellation');
  const charId = 'stop-received-round';
  const uuid = 'stop-received-uuid';
  const base = { charId, role: 'assistant', type: 'text', metadata: { activeMsg2: { taskUuid: uuid } } } as const;
  const shown = await DB.saveMessage({ ...base, content: '已经显示' } as any);
  await DB.saveMessage({ ...base, content: '还没上屏' } as any);
  publishReplyDisplay(charId, [shown], []);
  setInstantChatPending(charId, uuid, Date.now(), '角色');
  const cancel = vi.spyOn(ActiveMsgClient, 'cancelTask').mockRejectedValue(new Error('offline'));
  const write = vi.spyOn(ActiveMsgClient, 'writeClientStateValue').mockResolvedValue(undefined);
  try {
    const stopping = stopInstantChat(charId);
    expect(getInstantChatPending(charId)).toBeNull();
    expect(isReplyStopped(uuid)).toBe(true);
    await expect(stopping).rejects.toThrow('offline');
    expect((await DB.getMessagesByCharId(charId)).map(message => message.content)).toEqual(['已经显示']);
    expect(write).toHaveBeenCalledWith(`amsg:char:${charId}`, `chat_stop:${uuid}`, JSON.stringify({ text: '已经显示' }));
  } finally { cancel.mockRestore(); write.mockRestore(); }
});
