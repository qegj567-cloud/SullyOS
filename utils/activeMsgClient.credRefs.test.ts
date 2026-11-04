// utils/activeMsgClient.credRefs.test.ts
//
// 回归守卫（任务怎么带凭据）：
//   1. 达标的 worker 上，任务只带引用、一个内联凭据字段都不写——上游对「引用与内联同传」
//      是直接 400，写多一个字段就是整条排程发不出去。
//   2. 不达标的 worker 上原样走内联老路，且一个凭据请求都不发。主动消息 2.0 对所有人开放，
//      旧 worker 是真实存在的运行时状态，这条回落不能退化。
//   3. 云端说「引用的凭据不存在」时当场补传再重试一次（换过 master key / 点过清空云端数据
//      之后，本地那本指纹底账是脏的，不自愈的话用户会一直排不成任务）。
//   4. 即时对话：情绪评估的副 API 凭据改走引用之后，任务 metadata 里只剩提示词模板。
//   5. 即时对话绝不单挂 emotion 引用——上游 scheduleTask 见到任何 credRefs 就不再复制内联
//      三件套，只挂 emotion 的话，角色在这一轮里自排的任务会继承一份没有聊天凭据的空壳。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { reiClient } = vi.hoisted(() => ({
  reiClient: {
    init: vi.fn(),
    putClientState: vi.fn(),
    getCapabilities: vi.fn(),
    putLlmCredentials: vi.fn(),
    deleteLlmCredentials: vi.fn(),
    _encrypt: vi.fn(),
  },
}));
vi.mock('@rei-standard/amsg-client', () => ({ ReiClient: vi.fn(() => reiClient) }));
vi.mock('./keepAlive', () => ({
  KeepAlive: { init: vi.fn().mockResolvedValue(undefined), reregister: vi.fn().mockResolvedValue(undefined) },
}));

const TEST_USER_ID = '3f2b1c8a-9d4e-4a1b-8c2d-000000000042';
/** 能力位在测里现改：达标 / 不达标两条路都要跑到。 */
const globalConfig: Record<string, unknown> = {
  userId: TEST_USER_ID,
  workerUrl: 'https://amsg.example.workers.dev',
  serverToken: '',
  llmCredentialsSupported: true,
};
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: {
    ensureUserId: async () => TEST_USER_ID,
    getGlobalConfig: async () => ({ ...globalConfig }),
    saveGlobalConfig: vi.fn().mockResolvedValue(undefined),
  },
}));

import { ActiveMsgClient, requireAnthropicWorker } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { requestStartupUpdateCheck, STARTUP_UPDATE_CHECK_STORAGE_KEY } from './amsgAutoUpdateTrigger';
import { AMSG_BUNDLE_VERSION } from './amsgBundleVersion';
import { forgetAllCredIds } from './amsgLlmCredentials';
import { clearInstantChatPending } from './amsgInstantChat';
import { ChatPrompts } from './chatPrompts';
import { DB } from './db';

const CHAR_ID = 'char-credrefs';
const CHAR = {
  id: CHAR_ID,
  name: '小满',
  memories: [],
  activeMsg2Config: { enabled: true, tasks: [] },
} as any;
const API = { baseUrl: 'https://api.example.dev/v1', apiKey: 'sk-global', model: 'gpt-global' } as any;

/** 这一轮 POST 出去的那份任务载荷（加密前）。 */
const capturedPayloads: any[] = [];
/** 每次 POST 的返回，按顺序取；用完了就一直回最后一个。 */
let scheduleResponses: Array<{ status: number; body: unknown }> = [];
let postedPaths: string[] = [];
/** 每次 POST 的明文外壳（即时对话那条的外壳是明文 JSON，里面才是信封）。 */
let postedBodies: any[] = [];

const respond = () => {
  const next = scheduleResponses.length > 1 ? scheduleResponses.shift()! : scheduleResponses[0];
  return {
    status: next.status,
    text: async () => JSON.stringify(next.body),
    headers: new Headers({ 'content-type': 'application/json' }),
  };
};

beforeEach(() => {
  capturedPayloads.length = 0;
  postedPaths = [];
  postedBodies = [];
  scheduleResponses = [{ status: 200, body: { success: true, data: { uuid: 'remote-uuid', status: 'pending' } } }];
  globalConfig.llmCredentialsSupported = true;
  delete globalConfig.anthropicMessagesSupported;
  delete globalConfig.anthropicMessagesWorkerUrl;
  delete globalConfig.initializedAt;
  localStorage.removeItem(STARTUP_UPDATE_CHECK_STORAGE_KEY);
  forgetAllCredIds();
  reiClient.init.mockReset().mockResolvedValue(undefined);
  reiClient.putClientState.mockReset().mockResolvedValue({ success: true });
  reiClient.putLlmCredentials.mockReset().mockResolvedValue({ success: true, data: { upserted: 1 } });
  reiClient.deleteLlmCredentials.mockReset().mockResolvedValue({ success: true, data: { deleted: 3 } });
  reiClient.getCapabilities.mockReset().mockResolvedValue({ serverVersion: '2.6.0-next.17', features: [] });
  reiClient._encrypt.mockReset().mockImplementation(async (json: string) => {
    capturedPayloads.push(JSON.parse(json));
    return { iv: 'iv', authTag: 'tag', encryptedData: 'enc' };
  });
  vi.spyOn(DB, 'getRecentMessagesByCharId').mockResolvedValue([] as any);
  vi.spyOn(DB, 'getEmojis').mockResolvedValue([] as any);
  vi.spyOn(DB, 'getEmojiCategories').mockResolvedValue([] as any);
  vi.spyOn(ChatPrompts, 'buildSystemPrompt').mockResolvedValue('SYS');
  vi.spyOn(ChatPrompts, 'buildMessageHistory').mockReturnValue({ apiMessages: [] } as any);
  vi.spyOn(ChatPrompts, 'filterVisibleEmojis').mockReturnValue({ emojis: [], categories: [] } as any);
  vi.spyOn(ActiveMsgClient, 'registerPushSubscription').mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    postedPaths.push(String(url));
    try { postedBodies.push(JSON.parse(String(init?.body ?? 'null'))); } catch { postedBodies.push(null); }
    return respond();
  }));
  clearInstantChatPending(CHAR_ID);
});

afterEach(() => {
  clearInstantChatPending(CHAR_ID);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('原生接口只提交给已确认支持且地址一致的 Worker，OpenAI 不受新门槛影响', async () => {
  await expect(requireAnthropicWorker(['https://api.test/v1/chat/completions'])).resolves.toBeUndefined();
  await expect(requireAnthropicWorker(['https://api.anthropic.com/v1/messages'])).rejects.toThrow('尚未就绪');
  globalConfig.anthropicMessagesSupported=true;
  globalConfig.anthropicMessagesWorkerUrl='https://other-worker.test';
  await expect(requireAnthropicWorker(['https://api.anthropic.com/v1/messages'])).rejects.toThrow('尚未就绪');
  globalConfig.anthropicMessagesWorkerUrl=globalConfig.workerUrl;
  await expect(requireAnthropicWorker(['https://api.anthropic.com/v1/messages'])).resolves.toBeUndefined();
});

it('旧 Worker 的存量内联任务不会被更新成它不支持的原生凭据', async () => {
  const update=vi.spyOn(ActiveMsgClient,'updatePendingTasksRemote');
  await expect(ActiveMsgClient.refreshCharPendingAiTaskCredentials({char:CHAR,config:{enabled:true,tasks:[]},apiConfig:{...API,baseUrl:'https://api.anthropic.com',apiType:'anthropic'},tasks:[{taskUuid:'legacy',mode:'auto'} as any],remoteTasks:[{uuid:'legacy'}]})).rejects.toThrow('尚未就绪');
  expect(update).not.toHaveBeenCalled();expect(reiClient.putLlmCredentials).not.toHaveBeenCalled();
});

it('新版冷启动自动更新 Worker 后复查原生能力，无需用户重连', async () => {
  globalConfig.initializedAt=1;
  vi.spyOn(ActiveMsgStore,'saveGlobalConfig').mockImplementation(async patch => Object.assign(globalConfig,patch) as any);
  const connect=vi.spyOn(ActiveMsgClient,'connect');
  let upgraded=false;
  const network=vi.fn(async (url: string) => {
    if (String(url).endsWith('/self-update')) {
      upgraded=true;
      return Response.json({success:true,data:{message:'updated'}});
    }
    expect(String(url)).toContain('/config-check');
    return Response.json({success:true,data:{workerVersion:upgraded?AMSG_BUNDLE_VERSION:'old',instantTick:true,anthropicMessages:upgraded}});
  });
  vi.stubGlobal('fetch',network);
  expect(await requestStartupUpdateCheck(Date.now(),'native-update-test')).toBe('updated');
  expect(globalConfig.anthropicMessagesSupported).toBe(true);
  expect(network).toHaveBeenCalledTimes(3);
  await expect(requireAnthropicWorker(['https://api.anthropic.com/v1/messages'])).resolves.toBeUndefined();
  expect(network).toHaveBeenCalledTimes(3);
  expect(connect).not.toHaveBeenCalled();
});

it('自动部署晚于启动探测时，首次原生请求自动纠正旧的不支持结果', async () => {
  globalConfig.anthropicMessagesSupported=false;
  globalConfig.anthropicMessagesWorkerUrl=globalConfig.workerUrl;
  vi.spyOn(ActiveMsgStore,'saveGlobalConfig').mockImplementation(async patch => Object.assign(globalConfig,patch) as any);
  const network=vi.fn(async()=>Response.json({success:true,data:{workerVersion:AMSG_BUNDLE_VERSION,instantTick:true,anthropicMessages:true}}));
  vi.stubGlobal('fetch',network);
  await expect(requireAnthropicWorker(['https://api.anthropic.com/v1/messages'])).resolves.toBeUndefined();
  await expect(requireAnthropicWorker(['https://api.anthropic.com/v1/messages'])).resolves.toBeUndefined();
  expect(network).toHaveBeenCalledTimes(1);
});

/** 排程 POST 出去的那份任务载荷（云端状态那份没有 messageType，据此认出来）。 */
const scheduledTask = () => capturedPayloads.filter((p) => p && 'messageType' in p).at(-1);
/** 传上去的凭据行（扁平化所有批次）。 */
const putRows = () => reiClient.putLlmCredentials.mock.calls.flatMap(([rows]: any[]) => rows);

const schedule = (config: any = { enabled: true, tasks: [] }, char = CHAR) => ActiveMsgClient.scheduleCharacterTask({
  char,
  config,
  task: { mode: 'auto', firstSendTime: new Date(Date.now() + 3600_000).toISOString(), recurrenceType: 'none' },
  userProfile: { name: '小明' } as any,
  groups: [],
  realtimeConfig: {} as any,
  apiConfig: API,
});

describe('排程任务的凭据', () => {
  it('达标的 worker：任务只带 credRefs，内联三件套一个字段都不写', async () => {
    await schedule();

    const task = scheduledTask();
    expect(task.credRefs).toEqual({ chat: `char:${CHAR_ID}/chat` });
    expect(task, '引用与内联同传上游直接 400').not.toHaveProperty('apiUrl');
    expect(task).not.toHaveProperty('apiKey');
    expect(task).not.toHaveProperty('primaryModel');
  });

  it('凭据行在建任务之前就登记好（上游建任务前会挨个查引用）', async () => {
    await schedule();

    expect(putRows()).toEqual([{
      credId: `char:${CHAR_ID}/chat`,
      owner: { type: 'character', id: CHAR_ID }, ownerGeneration: 0,
      value: {
        apiUrl: 'https://api.example.dev/v1/chat/completions',
        apiKey: 'sk-global',
        primaryModel: 'gpt-global',
      },
    }]);
    expect(reiClient.putLlmCredentials.mock.invocationCallOrder[0])
      .toBeLessThan((globalThis.fetch as any).mock.invocationCallOrder.at(-1));
  });

  it.each([true, false])('角色默认 API 进入实际排程载荷（凭据表支持=%s）', async supported => {
    globalConfig.llmCredentialsSupported = supported;
    const dialogueApi = { baseUrl: 'https://role.example/v1', apiKey: 'role-key', model: 'role-model' };
    await schedule(undefined, { ...CHAR, dialogueApi });
    const expected = { apiUrl: dialogueApi.baseUrl + '/chat/completions', apiKey: dialogueApi.apiKey, primaryModel: dialogueApi.model };
    if (supported) {
      expect(putRows()[0].value).toEqual(expected);
      expect(scheduledTask()).not.toHaveProperty('apiKey');
    } else {
      expect(scheduledTask()).toMatchObject(expected);
    }
  });

  it('旧角色的单独 API 不再参与排程', async () => {
    await schedule({
      enabled: true,
      tasks: [],
      useSecondaryApi: true,
      secondaryApi: { baseUrl: 'https://alt.example.dev/v1', apiKey: 'sk-alt', model: 'gpt-alt' },
    });

    expect(putRows()[0].value).toEqual({
      apiUrl: 'https://api.example.dev/v1/chat/completions', apiKey: 'sk-global', primaryModel: 'gpt-global',
    });
  });

  it('值没变 → 第二次排程一个凭据请求都不发', async () => {
    await schedule();
    reiClient.putLlmCredentials.mockClear();
    await schedule();
    expect(reiClient.putLlmCredentials).not.toHaveBeenCalled();
  });

  it('不达标的 worker：原样内联，不带 credRefs，也不发凭据请求', async () => {
    globalConfig.llmCredentialsSupported = false;

    await schedule();

    const task = scheduledTask();
    expect(task.apiUrl).toBe('https://api.example.dev/v1/chat/completions');
    expect(task.apiKey).toBe('sk-global');
    expect(task.primaryModel).toBe('gpt-global');
    expect(task).not.toHaveProperty('credRefs');
    expect(reiClient.putLlmCredentials).not.toHaveBeenCalled();
  });

  it('固定消息（不走 LLM）永远不带凭据引用', async () => {
    await ActiveMsgClient.scheduleCharacterTask({
      char: CHAR,
      config: { enabled: true, tasks: [] } as any,
      task: {
        mode: 'fixed',
        firstSendTime: new Date(Date.now() + 3600_000).toISOString(),
        recurrenceType: 'none',
        userMessage: '晚安',
      },
      userProfile: { name: '小明' } as any,
      groups: [],
      realtimeConfig: {} as any,
      apiConfig: API,
    });

    expect(scheduledTask()).not.toHaveProperty('credRefs');
    expect(reiClient.putLlmCredentials).not.toHaveBeenCalled();
  });

  it('云端说这行凭据不存在 → 强传一次再重排一次，用户看不到失败', async () => {
    // 先排一次让本地底账记上「传过了」，再把云端那行「弄丢」。
    await schedule();
    reiClient.putLlmCredentials.mockClear();
    postedPaths = [];
    scheduleResponses = [
      { status: 409, body: { success: false, error: { code: 'CREDENTIAL_NOT_FOUND', message: '凭据不存在' } } },
      { status: 200, body: { success: true, data: { uuid: 'retried-uuid', status: 'pending' } } },
    ];

    const result = await schedule();

    expect(result.uuid).toBe('retried-uuid');
    // 底账说「没变过」，所以这一次必须是绕过指纹的强传，否则重排还是同一个 409。
    expect(putRows()).toHaveLength(1);
    expect(postedPaths.filter((p) => p.includes('schedule-message'))).toHaveLength(2);
  });

  it('补传之后还是不认 → 抛错交给用户，不无限重试', async () => {
    scheduleResponses = [
      { status: 409, body: { success: false, error: { code: 'CREDENTIAL_NOT_FOUND', message: '凭据不存在' } } },
    ];

    await expect(schedule()).rejects.toThrow('凭据不存在');
    expect(postedPaths.filter((p) => p.includes('schedule-message'))).toHaveLength(2);
  });
});

describe('即时对话的凭据与情绪评估', () => {
  const EVAL_SPEC = {
    prompt: '模板 __EMOTION_EVAL_SYSTEM_PROMPT__ __EMOTION_EVAL_HISTORY__',
    api: { baseUrl: 'https://eval.example.dev/v1', apiKey: 'sk-eval', model: 'eval-mini' },
  };

  const send = (extra: Record<string, unknown> = {}) => {
    scheduleResponses = [{ status: 202, body: { status: 'accepted', uuid: 'instant-uuid' } }];
    return ActiveMsgClient.sendInstantChat({
      char: CHAR,
      chatMessages: [{ role: 'user', content: '在吗' }],
      api: { baseUrl: 'https://api.example.dev/v1', apiKey: 'sk-global', model: 'claude-sonnet-4-thinking' },
      userProfile: { name: '小明' } as any,
      groups: [],
      realtimeConfig: {} as any,
      ...extra,
    } as any);
  };

  it('达标的 worker：聊天与情绪两个引用一起带，评估配置里只剩提示词模板', async () => {
    await send({ emotionEval: EVAL_SPEC });

    const task = scheduledTask();
    expect(task.credRefs).toEqual({
      chat: `char:${CHAR_ID}/instant`,
      emotion: `char:${CHAR_ID}/emotion`,
    });
    expect(task).not.toHaveProperty('apiKey');
    expect(task.metadata.amsgEmotionEval, '副 API 的 apiKey 不该再进任务 metadata')
      .toEqual({ prompt: EVAL_SPEC.prompt });
  });

  it('即时对话那行存的是当轮终值（-thinking 后缀不能被抹平）', async () => {
    await send({ emotionEval: EVAL_SPEC });

    const instantRow = putRows().find((row: any) => row.credId === `char:${CHAR_ID}/instant`);
    expect(instantRow.value.primaryModel).toBe('claude-sonnet-4-thinking');
    const emotionRow = putRows().find((row: any) => row.credId === `char:${CHAR_ID}/emotion`);
    expect(emotionRow.value).toEqual({
      apiUrl: 'https://eval.example.dev/v1/chat/completions', apiKey: 'sk-eval', primaryModel: 'eval-mini',
    });
  });

  it('秘密请求编号随加密评估配置保留，凭据引用仍不携带副 API key', async () => {
    await send({emotionEval: {...EVAL_SPEC, homeSecretRequestId: 'secret-request'}});
    expect(scheduledTask().metadata.amsgEmotionEval).toEqual({
      prompt: EVAL_SPEC.prompt, homeSecretRequestId: 'secret-request',
    });
  });

  it('这一轮不评估 → 只带聊天那个引用（绝不出现单挂 emotion 的空壳）', async () => {
    await send();

    expect(scheduledTask().credRefs).toEqual({ chat: `char:${CHAR_ID}/instant` });
    expect(putRows().map((row: any) => row.credId)).toEqual([`char:${CHAR_ID}/instant`]);
  });

  it('不达标的 worker：内联三件套 + 评估配置照旧带凭据', async () => {
    globalConfig.llmCredentialsSupported = false;

    await send({ emotionEval: EVAL_SPEC });

    const task = scheduledTask();
    expect(task).not.toHaveProperty('credRefs');
    expect(task.apiKey).toBe('sk-global');
    expect(task.metadata.amsgEmotionEval).toEqual(EVAL_SPEC);
    expect(reiClient.putLlmCredentials).not.toHaveBeenCalled();
  });

  // 回归守卫：本地底账只记得「这个入口传过什么」。云端那行被别的入口（iOS 上 Safari
  // 和主屏 App 各存各的）或别的 Worker 改成别的模型之后，底账还说「没变」，于是一轮
  // 都不传，本地怎么切 API 云端都还用那份旧的。凭据必须每一轮都随请求交给 worker。
  it('值没变的第二轮照样把这一轮的凭据随请求带上（不看底账）', async () => {
    await send();
    postedBodies = [];
    capturedPayloads.length = 0;
    reiClient.putLlmCredentials.mockClear();

    await send();

    expect(reiClient.putLlmCredentials, '底账说没变，单独登记那一步照旧省掉').not.toHaveBeenCalled();
    const outer = postedBodies.find((b) => b && 'taskPayload' in b);
    expect(outer.credPayload).toEqual({ iv: 'iv', authTag: 'tag', encryptedData: 'enc' });
    const credBody = capturedPayloads.find((p) => p && 'credentials' in p);
    expect(credBody.credentials).toEqual([{
      credId: `char:${CHAR_ID}/instant`,
      owner: { type: 'character', id: CHAR_ID }, ownerGeneration: 0,
      value: {
        apiUrl: 'https://api.example.dev/v1/chat/completions',
        apiKey: 'sk-global',
        primaryModel: 'claude-sonnet-4-thinking',
      },
    }]);
  });

  it('不达标的 worker（内联凭据）不带 credPayload', async () => {
    globalConfig.llmCredentialsSupported = false;
    await send();
    const outer = postedBodies.find((b) => b && 'taskPayload' in b);
    expect(outer).not.toHaveProperty('credPayload');
  });

  it('包装层回「引用的凭据不存在」→ 补传后重发一次', async () => {
    await send();
    reiClient.putLlmCredentials.mockClear();
    postedPaths = [];
    scheduleResponses = [
      {
        status: 409,
        body: {
          success: false,
          error: {
            code: 'INSTANT_CHAT_TASK_FAILED',
            upstream: { success: false, error: { code: 'CREDENTIAL_NOT_FOUND', message: '凭据不存在' } },
          },
        },
      },
      { status: 202, body: { status: 'accepted', uuid: 'instant-retried' } },
    ];

    const result = await ActiveMsgClient.sendInstantChat({
      char: CHAR,
      chatMessages: [{ role: 'user', content: '在吗' }],
      api: { baseUrl: 'https://api.example.dev/v1', apiKey: 'sk-global', model: 'claude-sonnet-4-thinking' },
      userProfile: { name: '小明' } as any,
      groups: [],
      realtimeConfig: {} as any,
    } as any);

    expect(result.uuid).toBe('instant-retried');
    expect(reiClient.putLlmCredentials).toHaveBeenCalledTimes(1);
    expect(postedPaths.filter((p) => p.includes('instant-chat'))).toHaveLength(2);
  });
});

describe('能力探测', () => {
  it('features 有 llm-credentials → 存 true；没有 → 存 false', async () => {
    reiClient.getCapabilities.mockResolvedValue({ serverVersion: '2.6.0-next.17', features: ['llm-credentials'] });
    await expect(ActiveMsgClient.probeLlmCredentialsSupport()).resolves.toBe(true);

    reiClient.getCapabilities.mockResolvedValue({ serverVersion: '2.6.0-next.16', features: ['client-state'] });
    await expect(ActiveMsgClient.probeLlmCredentialsSupport()).resolves.toBe(false);
  });

  it('老 worker 没有这个端点（null）/ 探测抛错 → 一律 false', async () => {
    reiClient.getCapabilities.mockResolvedValue(null);
    await expect(ActiveMsgClient.probeLlmCredentialsSupport()).resolves.toBe(false);

    reiClient.getCapabilities.mockRejectedValue(new Error('offline'));
    await expect(ActiveMsgClient.probeLlmCredentialsSupport()).resolves.toBe(false);
  });
});

describe('删凭据行', () => {
  it('删角色时按名字删那三行，并把本地底账一起划掉', async () => {
    await schedule();
    await ActiveMsgClient.deleteLlmCredentials({ credIds: [`char:${CHAR_ID}/chat`] });

    expect(reiClient.deleteLlmCredentials).toHaveBeenCalledWith({ credIds: [`char:${CHAR_ID}/chat`] });
    // 底账划掉了 → 下次排程会重新传一遍（不然那行永远补不回来）。
    reiClient.putLlmCredentials.mockClear();
    await schedule();
    expect(reiClient.putLlmCredentials).toHaveBeenCalledTimes(1);
  });
});
