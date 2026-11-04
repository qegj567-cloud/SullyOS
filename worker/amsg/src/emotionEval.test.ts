// worker/amsg/src/emotionEval.test.ts
//
// 占位符还原：前端把评估提示词里两段大文本（角色的 system prompt、完整对话历史）
// 留成占位符发上来，worker 用本次请求已有的消息填回原位。填错一个字，评估看到的
// 就不是角色真正看到的那份上下文，判出来的情绪对不上它刚说的话——而这种偏差在
// 界面上完全看不出来，只会表现为「情绪越来越不准」。
import { afterEach, describe, it, expect, vi } from 'vitest';

import {
  resolveEmotionEvalApi,
  restoreEvalPrompt,
  runAmsgEmotionEval,
  takeEmotionEvalSpec,
} from './emotionEval';

const TEMPLATE = [
  '## 角色此刻看到的完整上下文',
  '__EMOTION_EVAL_SYSTEM_PROMPT__',
  '## 完整对话历史',
  '__EMOTION_EVAL_HISTORY__',
].join('\n');

it('keeps main friend-feed reply tasks out of the cloud emotion ride-along', async () => {
  const fetcher = vi.fn(async (_url: unknown, init: any) => {
    const body = JSON.parse(init.body);
    const prompt = JSON.stringify(body.messages);
    expect(prompt).toContain('人设仍然保留');
    expect(prompt).toContain('实时世界仍然保留');
    expect(prompt).not.toContain('main-only-request');
    expect(prompt).toContain('用户提到好友圈');
    return new Response(JSON.stringify({choices: [{message: {content: '{"changed":false}'}}]}));
  });
  vi.stubGlobal('fetch', fetcher);
  try {
    const result = await runAmsgEmotionEval({prompt: TEMPLATE},
      {baseUrl: 'https://test.invalid/v1', apiKey: '', model: 'eval'},
      [{role: 'system', content: '人设仍然保留'},
       {role: 'system', content: '【顺便回好友圈】main-only-request'},
       {role: 'user', content: '用户提到好友圈'},
       {role: 'system', content: '实时世界仍然保留'}], '小白');
    expect(result.raw).toBe('{"changed":false}');
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {vi.unstubAllGlobals();}
});

describe('restoreEvalPrompt', () => {
  it('system prompt 进第一个槽，其余消息按 [角色]: 正文 拼进第二个槽', () => {
    const out = restoreEvalPrompt(TEMPLATE, [
      { role: 'system', content: '你是 Nyah。' },
      { role: 'user', content: '在吗' },
      { role: 'assistant', content: '在的。' },
    ], 'Nyah');

    expect(out).not.toContain('__EMOTION_EVAL_SYSTEM_PROMPT__');
    expect(out).not.toContain('__EMOTION_EVAL_HISTORY__');
    expect(out).toContain('你是 Nyah。');
    expect(out).toContain('[用户]: 在吗');
    expect(out).toContain('[Nyah]: 在的。');
  });

  // String.replace 的第二个参数里，`$&`（整个匹配）、`$1`、`$'` 都是替换模式。
  // 用户设定里出现这些字符完全正常（写代码、写价格、写颜文字），naive 的
  // `.replace(槽位, 文本)` 会把它们当指令展开——system prompt 里凭空多出一串
  // 「__EMOTION_EVAL_SYSTEM_PROMPT__」，用户的原话反而丢了。函数式 replacer 才不会。
  it('设定里带 $& / $1 这类字符时逐字还原，不被当成替换模式展开', () => {
    const nastySystem = '规则：价格写成 $1，强调用 $& 包起来，别写 $`。';
    const out = restoreEvalPrompt(TEMPLATE, [
      { role: 'system', content: nastySystem },
      { role: 'user', content: '懂了 $&' },
    ], 'Nyah');

    expect(out).toContain(nastySystem);
    expect(out).toContain('[用户]: 懂了 $&');
    // naive 实现下 $& 会被展开成占位符本身，这两条就是那种走样的样子
    expect(out).not.toContain('__EMOTION_EVAL_SYSTEM_PROMPT__');
    expect(out).not.toContain('__EMOTION_EVAL_HISTORY__');
  });

  it('带图片的结构化消息拍平成「文字 [图片]」（跟本地那份逐字同款）', () => {
    const out = restoreEvalPrompt(TEMPLATE, [
      { role: 'system', content: '你是 Nyah。' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '看这个' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ], 'Nyah');

    expect(out).toContain('[用户]: 看这个 [图片]');
    // 图片的 base64 一个字节都不该进评估请求（白烧 token，还可能撑爆请求体）
    expect(out).not.toContain('base64');
  });

  // 即时对话的时效块（现在几点、外面在下雨）是追加在末尾的 system 消息。
  // 它必须进历史，评估才知道角色刚才是对着什么时间说的那句话。
  it('末尾追加的 system 块进历史，标成 [系统]', () => {
    const out = restoreEvalPrompt(TEMPLATE, [
      { role: 'system', content: '你是 Nyah。' },
      { role: 'user', content: '在吗' },
      { role: 'system', content: '【此刻的系统信息·仅你可见】\n现在是 2026年8月1日 早晨 08:00。' },
    ], 'Nyah');

    expect(out).toContain('[系统]: 【此刻的系统信息·仅你可见】');
    expect(out).toContain('现在是 2026年8月1日 早晨 08:00。');
  });

  it('第一条不是 system 时全都算历史（不硬吃掉一条当设定）', () => {
    const out = restoreEvalPrompt(TEMPLATE, [
      { role: 'user', content: '在吗' },
    ], 'Nyah');

    expect(out).toContain('[用户]: 在吗');
    // 设定槽位填空串：没有就是没有，不能拿第一条用户消息顶上去
    expect(out).toContain('## 角色此刻看到的完整上下文\n\n## 完整对话历史');
  });
});

// 失败原因这句话最终要走 push 出门（评估失败信号带给客户端），里头绝不能有 apiKey。
// 个别中转会把整个请求（含 Authorization 头）回显在错误页里，所以打码必须先于截断：
// 先截的话，切口正好落在 key 中间时整串里查不到完整 key，半截凭据就原样带出去了。
describe('评估失败原因的脱敏', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('错误正文里的 apiKey 被截断切中也不许漏出半截（先打码后截断）', async () => {
    const apiKey = 'sk-secondary-0123456789abcdef0123456789abcdef';
    // 110 个填充字符 + key：120 字符的切口正好穿过 key 的前半截。
    const body = 'x'.repeat(110) + apiKey + ' tail';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => body,
    })));

    const outcome = await runAmsgEmotionEval(
      { prompt: TEMPLATE },
      { baseUrl: 'https://eval.example.com/v1', apiKey, model: 'eval-mini' },
      [{ role: 'user', content: '在吗' }],
      'Nyah',
    );

    expect(outcome.raw).toBeNull();
    expect(outcome.error).toContain('副 API HTTP 401');
    expect(outcome.error).toContain('***');
    expect(outcome.error, 'key 的前缀一个字节都不许出门').not.toContain(apiKey.slice(0, 10));
  });
});

// 评估配置的两种长相：存量任务把副 API 凭据整份塞在 metadata 里；新任务只带提示词模板，
// 凭据在 llm_credentials 表里、任务只带 credRefs.emotion 这个名字。两种都得认。
describe('副 API 凭据的来路（内联 / 凭据表）', () => {
  const SPEC_INLINE = {
    prompt: 'T',
    api: { baseUrl: 'https://inline.example.dev/v1', apiKey: 'sk-inline', model: 'inline-mini' },
  };

  it('存量任务里内联的那份优先（不去劳动凭据表）', async () => {
    const resolve = vi.fn();
    await expect(resolveEmotionEvalApi(SPEC_INLINE, { emotion: 'char:c1/emotion' }, resolve))
      .resolves.toEqual(SPEC_INLINE.api);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('只带引用 → 按名字现读，apiUrl 摘回 baseUrl 口径（评估请求自己会补 /chat/completions）', async () => {
    const resolve = vi.fn(async () => ({
      apiUrl: 'https://tabled.example.dev/v1/chat/completions',
      apiKey: 'sk-tabled',
      primaryModel: 'tabled-mini',
    }));

    await expect(resolveEmotionEvalApi({ prompt: 'T' }, { emotion: 'char:c1/emotion' }, resolve))
      .resolves.toEqual({
        baseUrl: 'https://tabled.example.dev/v1', apiKey: 'sk-tabled', model: 'tabled-mini',
      });
    expect(resolve).toHaveBeenCalledWith('char:c1/emotion');
  });

  it('云端那行没了 / 老部署根本没有这个方法 → null，这一轮不评估（主回复照发）', async () => {
    await expect(resolveEmotionEvalApi({ prompt: 'T' }, { emotion: 'char:c1/emotion' }, async () => null))
      .resolves.toBeNull();
    await expect(resolveEmotionEvalApi({ prompt: 'T' }, { emotion: 'char:c1/emotion' }, undefined))
      .resolves.toBeNull();
    await expect(resolveEmotionEvalApi({ prompt: 'T' }, null, async () => null)).resolves.toBeNull();
  });

  it('读凭据抛错也只是不评估，绝不把这一轮的正文连累掉', async () => {
    await expect(resolveEmotionEvalApi({ prompt: 'T' }, { emotion: 'char:c1/emotion' }, async () => {
      throw new Error('D1 挂了');
    })).resolves.toBeNull();
  });
});

// 两道防线一道都不能少：任务 metadata 走的是加密信封，放凭据安全；推送出了这台 worker
// 就归推送服务管了，所以捕获点就地删、组 push 前再删一次。
describe('takeEmotionEvalSpec 认新旧两种形状', () => {
  it('只带提示词模板（新任务）→ 认，并就地把键删掉', () => {
    const metadata: Record<string, unknown> = { charId: 'c1', amsgEmotionEval: { prompt: 'T' } };
    expect(takeEmotionEvalSpec(metadata)).toEqual({ prompt: 'T' });
    expect(metadata).not.toHaveProperty('amsgEmotionEval');
  });

  it('带整份内联凭据（存量任务）→ 照旧认，键同样就地删掉', () => {
    const spec = { prompt: 'T', api: { baseUrl: 'https://x.dev', apiKey: 'sk-x', model: 'm' } };
    const metadata: Record<string, unknown> = { amsgEmotionEval: spec };
    expect(takeEmotionEvalSpec(metadata)).toEqual(spec);
    expect(metadata).not.toHaveProperty('amsgEmotionEval');
  });

  it('带了 api 却配不齐 → 判不可用，键照删（那份里同样有 apiKey）', () => {
    const metadata: Record<string, unknown> = {
      amsgEmotionEval: { prompt: 'T', api: { baseUrl: '', apiKey: 'sk-x', model: '' } },
    };
    expect(takeEmotionEvalSpec(metadata)).toBeNull();
    expect(metadata).not.toHaveProperty('amsgEmotionEval');
  });

  it('没有提示词模板 → 不可用（评估无从谈起）', () => {
    expect(takeEmotionEvalSpec({ amsgEmotionEval: { prompt: '' } })).toBeNull();
  });
});
