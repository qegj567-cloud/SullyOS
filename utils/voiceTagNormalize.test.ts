import { describe, it, expect } from 'vitest';
import { normalizeVoiceTags, sanitizeIntoSegments, sanitizeForBubble } from './sanitize';
import { ChatParser } from './chatParser';
import { ChatPrompts } from './chatPrompts';
import { parseVoiceOutput } from './minimaxTts';
import { collectVoiceBatchSubtitle, isPoisonedVoiceSubtitle } from './voiceSubtitle';

// 语音标签自愈：模型把 <语音> 写歪的各种真实形态都要能修回规范，
// 否则 chunkText 原子块保护 / hasVoiceTag 配对全失效 → 掉格式。
describe('normalizeVoiceTags', () => {
  it('规范输入原样保留', () => {
    const s = '<语音 emotion="calm">你好</语音>';
    expect(normalizeVoiceTags(s)).toBe(s);
    expect(normalizeVoiceTags('没有语音标签的普通文本')).toBe('没有语音标签的普通文本');
  });

  it('未闭合开标签 → 末尾补闭合', () => {
    expect(normalizeVoiceTags('<语音 emotion="calm">うん、そのまま。'))
      .toBe('<语音 emotion="calm">うん、そのまま。</语音>');
  });

  it('未闭合繁体開标签 → 补繁体闭合', () => {
    expect(normalizeVoiceTags('<語音>大丈夫。')).toBe('<語音>大丈夫。</語音>');
  });

  it('孤儿闭合标签 → 删除', () => {
    expect(normalizeVoiceTags('前半句</语音>后半句')).toBe('前半句后半句');
  });

  it('嵌套多余开标签 → 删除，保持一对', () => {
    expect(normalizeVoiceTags('<语音>第一段<语音>第二段</语音>'))
      .toBe('<语音>第一段第二段</语音>');
  });

  it('全角尖括号 → 半角', () => {
    expect(normalizeVoiceTags('＜语音 emotion="sad"＞ごめん＜/语音＞'))
      .toBe('<语音 emotion="sad">ごめん</语音>');
  });

  it('闭合标签内空格 / 全角斜杠 → 规范', () => {
    expect(normalizeVoiceTags('<语音>hi</ 语音 >')).toBe('<语音>hi</语音>');
    expect(normalizeVoiceTags('<语音>hi<／语音>')).toBe('<语音>hi</语音>');
  });

  it('属性少空格 / 全角引号 / 全角等号 → 规范', () => {
    expect(normalizeVoiceTags('<语音emotion="happy">hi</语音>'))
      .toBe('<语音 emotion="happy">hi</语音>');
    expect(normalizeVoiceTags('<语音 emotion=“calm”>hi</语音>'))
      .toBe('<语音 emotion="calm">hi</语音>');
    expect(normalizeVoiceTags('<语音 emotion＝"calm">hi</语音>'))
      .toBe('<语音 emotion="calm">hi</语音>');
  });

  it('自闭合空标签 <语音/> → 删除，不吞后文', () => {
    expect(normalizeVoiceTags('<语音/>后面的正文')).toBe('后面的正文');
  });

  it('多对标签依次配对，互不干扰', () => {
    const s = '<语音>一</语音>中间<语音>二</语音>';
    expect(normalizeVoiceTags(s)).toBe(s);
  });

  // ─── <字幕> 标签（显式翻译格式）───
  it('规范的 语音+字幕 组合原样保留', () => {
    const s = '<语音 emotion="calm">Take a rest.</语音>\n<字幕>好好休息。</字幕>';
    expect(normalizeVoiceTags(s)).toBe(s);
  });

  it('未闭合语音 + 完整字幕 → 语音闭合插在字幕之前，不吞字幕', () => {
    expect(normalizeVoiceTags('<语音>Take a rest.\n<字幕>好好休息。</字幕>'))
      .toBe('<语音>Take a rest.</语音>\n<字幕>好好休息。</字幕>');
  });

  it('未闭合字幕 → 末尾补闭合；孤儿字幕闭合 → 删除', () => {
    expect(normalizeVoiceTags('<语音>hi</语音>\n<字幕>你好'))
      .toBe('<语音>hi</语音>\n<字幕>你好</字幕>');
    expect(normalizeVoiceTags('前面</字幕>后面')).toBe('前面后面');
  });

  it('全角字幕标签 → 规范化', () => {
    expect(normalizeVoiceTags('<语音>hi</语音>＜字幕＞你好＜/字幕＞'))
      .toBe('<语音>hi</语音><字幕>你好</字幕>');
  });

  it('字幕写进语音块里 → 挪到闭合标签后面', () => {
    expect(normalizeVoiceTags('<语音 emotion="happy">Hey, you there?<字幕>喂，你在吗？</字幕></语音>'))
      .toBe('<语音 emotion="happy">Hey, you there?</语音>\n<字幕>喂，你在吗？</字幕>');
    // 未闭合的语音块里夹着字幕：补闭合时就让到字幕前面
    expect(normalizeVoiceTags('<语音>Hey<字幕>喂</字幕>'))
      .toBe('<语音>Hey</语音><字幕>喂</字幕>');
  });

  it('字幕嵌在语音块里时，朗读文本只剩外语、字幕单独取出', () => {
    const parsed = parseVoiceOutput('<语音>Hey, you there?<字幕>喂，你在吗？</字幕></语音>');
    expect(parsed.speech).toBe('Hey, you there?');
    expect(parsed.rawSpeech).toBe('Hey, you there?');
    expect(parsed.subtitle).toBe('喂，你在吗？');
  });

  it('历史上下文里的旧坏格式按规范写法交给模型', () => {
    const char = { id: 'c1', name: '阿一' } as any;
    const { apiMessages } = ChatPrompts.buildMessageHistory([
      { id: 1, charId: 'c1', role: 'user', type: 'text', content: '在吗', timestamp: 1 },
      { id: 2, charId: 'c1', role: 'assistant', type: 'text', content: '<语音>Hey<字幕>喂</字幕></语音>', timestamp: 2 },
    ] as any, 20, char, { name: '小明' } as any, []);
    const reply = String(apiMessages.find(m => m.role === 'assistant')?.content);
    expect(reply).toContain('<语音>Hey</语音>\n<字幕>喂</字幕>');
  });
});

describe('自愈后整条管线联动', () => {
  it('sanitizeForBubble: 未闭合多段语音 → 修好后 chunkText 保护成单 chunk', () => {
    // 模型忘写闭合 + 内容多段：修复前保护正则配不上，语音块会被切碎
    const raw = '<语音 emotion="calm">第一段。\n\n第二段。';
    const cleaned = sanitizeForBubble(raw);
    const chunks = ChatParser.chunkText(cleaned);
    expect(chunks).toEqual(['<语音 emotion="calm">第一段。\n\n第二段。</语音>']);
  });

  it('sanitizeIntoSegments (worker): 未闭合语音 → 单 segment，banner 取内部文字', () => {
    const segs = sanitizeIntoSegments('<语音 emotion="sad">ごめんね。\n\n本当に。');
    expect(segs).toEqual([
      { raw: '<语音 emotion="sad">ごめんね。\n\n本当に。</语音>', sanitized: 'ごめんね。\n\n本当に。' },
    ]);
  });

  it('sanitizeIntoSegments: 简繁互换闭合 (<语音>…</語音>) 也整块保护', () => {
    const segs = sanitizeIntoSegments('<语音>hi\n\nthere</語音>');
    expect(segs).toHaveLength(1);
    expect(segs[0].sanitized).toBe('hi\n\nthere');
  });

  it('sanitizeIntoSegments: 语音+字幕组合整块单 segment, banner 用中文字幕', () => {
    const segs = sanitizeIntoSegments('闲聊一句\n<语音 emotion="calm">Take a rest, okay?</语音>\n<字幕>好好休息，好吗？</字幕>');
    expect(segs).toEqual([
      { raw: '闲聊一句', sanitized: '闲聊一句' },
      {
        raw: '<语音 emotion="calm">Take a rest, okay?</语音>\n<字幕>好好休息，好吗？</字幕>',
        sanitized: '好好休息，好吗？',
      },
    ]);
  });

  it('chunkText: 语音+字幕组合是一个原子 chunk, 不被换行拆开', () => {
    const chunks = ChatParser.chunkText('打字的话\n<语音>Sleep well.\n\nGood night.</语音>\n<字幕>睡个好觉。\n\n晚安。</字幕>\n又一句');
    expect(chunks).toEqual([
      '打字的话',
      '<语音>Sleep well.\n\nGood night.</语音>\n<字幕>睡个好觉。\n\n晚安。</字幕>',
      '又一句',
    ]);
  });
});

// 「外语语音没翻译」修复：字幕从同批次兄弟气泡直接收回来。
// 但只有模型真的守了字幕对齐格式才收（结构校验），否则返回 '' 走 LLM 翻译 ——
// 真实翻车报告：模型标签外写的是独立闲聊短句，转文字面板却把它们当翻译展示。
describe('collectVoiceBatchSubtitle', () => {
  const mk = (id: number, role: 'user' | 'assistant', content: string, type: 'text' | 'emoji' = 'text') =>
    ({ id, role, type, content }) as any;

  it('对齐的字幕（气泡数 == 语音段数）→ 按序拼接', () => {
    const msgs = [
      mk(1, 'user', '你在吗'),
      mk(2, 'assistant', '别怕，我在这里陪着你。'),
      mk(3, 'assistant', '闭上眼睛好好休息吧。'),
      mk(4, 'assistant', '<语音 emotion="calm">怖がらないで、俺がここにいる。\n\n目を閉じてゆっくり休んで。</语音>'),
    ];
    expect(collectVoiceBatchSubtitle(msgs, 4)).toBe('别怕，我在这里陪着你。\n闭上眼睛好好休息吧。');
  });

  it('翻车场景回归：闲聊短句 ≠ 字幕（气泡数对不上语音段数）→ 空串走 LLM', () => {
    // 模型没守字幕对齐：4 条独立中文短句 + 一整段英文独白
    const msgs = [
      mk(1, 'assistant', '？？'),
      mk(2, 'assistant', '宝宝你六点半就醒了'),
      mk(3, 'assistant', '等我一下'),
      mk(4, 'assistant', '刚睁眼嗓子还是哑的'),
      mk(5, 'assistant', "<语音>Morning, baby. I just opened my eyes and... you weren't next to me, so. That's already annoying. Anyway. Good morning. I love you. Come back to bed.</语音>"),
    ];
    expect(collectVoiceBatchSubtitle(msgs, 5)).toBe('');
  });

  it('段数碰巧一致但长度悬殊 → 空串走 LLM', () => {
    const msgs = [
      mk(1, 'assistant', '等我一下'),
      mk(2, 'assistant', "<语音>Morning, baby. I just opened my eyes and you weren't next to me. That's already annoying. I had this dream where you were feeding me cake and then took it away.</语音>"),
    ];
    expect(collectVoiceBatchSubtitle(msgs, 2)).toBe('');
  });

  it('批次边界：不越过 user 消息去收上一轮的文字', () => {
    const msgs = [
      mk(1, 'assistant', '上一轮说的完全不相干的话'),
      mk(2, 'user', '嗯'),
      mk(3, 'assistant', '这一轮的中文字幕在这里。'),
      mk(4, 'assistant', '<语音>ここが今回の字幕のはずだよ。</语音>'),
    ];
    expect(collectVoiceBatchSubtitle(msgs, 4)).toBe('这一轮的中文字幕在这里。');
  });

  it('同批次有第二条语音 → 归属含糊，返回空串走 LLM 兜底', () => {
    const msgs = [
      mk(1, 'assistant', '一条字幕'),
      mk(2, 'assistant', '<语音>ひとつめ</语音>'),
      mk(3, 'assistant', '<语音>ふたつめ</语音>'),
    ];
    expect(collectVoiceBatchSubtitle(msgs, 3)).toBe('');
  });

  it('双语气泡只取 %%BILINGUAL%% 前的半边', () => {
    const msgs = [
      mk(1, 'assistant', '今天的中文字幕。\n%%BILINGUAL%%\ntranslated half'),
      mk(2, 'assistant', '<语音>今日の字幕だよ。</语音>'),
    ];
    expect(collectVoiceBatchSubtitle(msgs, 2)).toBe('今天的中文字幕。');
  });

  it('emoji 气泡跳过；纯语音回合返回空串', () => {
    const msgs = [
      mk(1, 'assistant', 'https://emoji.example/a.png', 'emoji'),
      mk(2, 'assistant', '<语音>voice only</语音>'),
    ];
    expect(collectVoiceBatchSubtitle(msgs, 2)).toBe('');
  });

  it('消息不存在 → 空串', () => {
    expect(collectVoiceBatchSubtitle([], 99)).toBe('');
  });
});

// 存量毒数据自检：旧版本（无对齐校验）把闲聊短句当翻译持久化了，回灌时要认出来清掉
describe('isPoisonedVoiceSubtitle', () => {
  const mk = (id: number, role: 'user' | 'assistant', content: string, type: 'text' | 'emoji' = 'text') =>
    ({ id, role, type, content }) as any;
  const misfireBatch = [
    mk(1, 'assistant', '？？'),
    mk(2, 'assistant', '宝宝你六点半就醒了'),
    mk(3, 'assistant', '等我一下'),
    mk(4, 'assistant', '刚睁眼嗓子还是哑的'),
    mk(5, 'assistant', "<语音>Morning, baby. I just opened my eyes and... you weren't next to me. Anyway. Good morning. I love you. Come back to bed.</语音>"),
  ];

  it('存的值 == 旧逻辑产物 且 新校验不认 → 毒数据', () => {
    const legacy = '？？\n宝宝你六点半就醒了\n等我一下\n刚睁眼嗓子还是哑的';
    expect(isPoisonedVoiceSubtitle(misfireBatch, 5, legacy)).toBe(true);
  });

  it('LLM 翻译出来的正经译文（≠ 旧逻辑产物）→ 不动', () => {
    expect(isPoisonedVoiceSubtitle(misfireBatch, 5, '早安宝贝，我刚睁眼你就不在身边。总之早安，我爱你，回床上来。')).toBe(false);
  });

  it('对齐字幕的存量数据（新校验也认可）→ 不动', () => {
    const alignedBatch = [
      mk(1, 'assistant', '别怕，我在这里陪着你。'),
      mk(2, 'assistant', '闭上眼睛好好休息吧。'),
      mk(3, 'assistant', '<语音>怖がらないで、俺がここにいる。\n\n目を閉じてゆっくり休んで。</语音>'),
    ];
    expect(isPoisonedVoiceSubtitle(alignedBatch, 3, '别怕，我在这里陪着你。\n闭上眼睛好好休息吧。')).toBe(false);
  });

  it('空翻译 → 不动', () => {
    expect(isPoisonedVoiceSubtitle(misfireBatch, 5, '')).toBe(false);
  });
});
