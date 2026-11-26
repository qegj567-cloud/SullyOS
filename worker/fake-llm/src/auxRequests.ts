// 认出「这不是主回复，是某类辅助请求」，给它一个格式合法、不改动用户数据的默认回复。
//
// 为什么要有这层：一轮私聊除了主回复，还会顺带发情绪评估、记忆提取、门牌整理等请求，
// 它们没有单独配 API 时也会打到假模型。要是把「副作用卡片」那种正文吐给情绪评估，
// 整条链会以假模型自己造成的方式坏掉，测出来的东西就不可信。
//
// 标记全部抄自真实提示词代码（出处写在每条后面）。顺序有讲究：情绪评估的提示词里整段包着
// 主回复的系统提示词，所以先认辅助请求；都不像就当主回复。默认回复尽量是空操作
// （空数组、changed:false），因为格式对但内容是假的回复会覆盖真实的记忆数据。
// 改了这些提示词的开头，auxRequests.test.ts 会挂。

type Message = { role?: string; content?: unknown };

interface AuxDef {
    describe: string;
    /** text = 所有消息拼起来的文字；lastUser = 最后一条 user 消息。 */
    match: (text: string, lastUser: string) => boolean;
    reply: (text: string, lastUser: string) => string;
}

const has = (...markers: string[]) => (text: string) => markers.some(m => text.includes(m));

export const AUX_KINDS = {
    emotion: {
        describe: '情绪评估（本地、即时对话、定时消息之后都会跑）',
        // utils/activeMsgClient.ts buildEmotionEvalPrompt
        match: has('你是一个角色情绪分析系统。请分析角色「'),
        // utils/emotionApply.ts parseEmotionEvalOutput：changed:false 表示情绪不变
        reply: () => JSON.stringify({ changed: false, innerState: '假模型：情绪没有变化。' }),
    },
    'memory-extract': {
        describe: '记忆宫殿：记忆提取',
        // utils/memoryPalace/extraction.ts
        match: has('以你的第一人称视角（"我"）提取值得记住的记忆'),
        reply: () => '[]',
    },
    'memory-compress': {
        describe: '记忆宫殿：事件盒压缩与二次压缩',
        // utils/memoryPalace/eventBoxCompression.ts：{} 解析不出字段就保留原记忆、下次重试
        match: has('下面这些记忆都属于一件事：「', '下面这段第一人称回忆写得太长了'),
        reply: text => text.includes('下面这段第一人称回忆写得太长了') ? '' : '{}',
    },
    'memory-digest': {
        describe: '记忆宫殿：认知消化',
        // utils/memoryPalace/digestion.ts
        match: (text, lastUser) => lastUser.trim() === '请开始审视。' && text.includes('你现在正在独处，安静地回想最近的事情。'),
        reply: () => '[]',
    },
    personality: {
        describe: '记忆宫殿：人格审视',
        // utils/memoryPalace/digestion.ts
        match: (text, lastUser) => lastUser.trim() === '请判断。' && text.includes('你是一个性格分析专家。'),
        reply: () => JSON.stringify({ style: 'emotional', ruminationTendency: 0.3, reasoning: '假模型默认值' }),
    },
    plates: {
        describe: '记忆宫殿：门牌整理（本地与云端 plate-consolidate）',
        // utils/memoryPalace/roomPlateCore.ts PLATE_USER_TURN：没提到的房间一律跳过
        match: (text, lastUser) => lastUser.trim() === '请开始整理。' && text.includes('安静地整理自己的"底色认知"'),
        reply: () => '[]',
    },
    schedule: {
        describe: '日程生成（本地或云端代跑）',
        // utils/scheduleGenerator.ts 两种风格的 Task 标题
        match: has('## Task: 生成角色的今日日程 + 意识流独白', '## Task: 生成角色的今日思绪 + 意识流独白'),
        reply: () => JSON.stringify({
            slots: [{ startTime: '08:00', activity: '假模型日程', description: '测试用的一格日程', emoji: '💭', homePosition: { kind: 'away' } }],
            flowNarrative: { morning: '假模型的上午独白。', afternoon: '假模型的下午独白。', evening: '假模型的晚上独白。' },
        }),
    },
    'schedule-narrative': {
        describe: '日程：聊天后进化内心独白',
        // utils/scheduleGenerator.ts
        match: has('请根据以上信息，写一段**进化后的内心独白**'),
        reply: () => '假模型的内心独白：聊了一会儿，心情还不错。',
    },
    'persona-sim': {
        describe: '查手机 · 人格模拟（本地或云端代跑）',
        // apps/PersonaSim.tsx；最后一拍必须是 end
        match: has('### [导演任务：手机人生演出 Screenlife]'),
        reply: () => JSON.stringify({ title: '假模型演出', summary: '测试用的一小段', beats: [{ kind: 'thought', monologue: '这是假模型的演出。' }, { kind: 'end' }] }),
    },
    dream: {
        describe: '潜意识剧场 · 梦境（本地或云端代跑）',
        // apps/DreamTheater.tsx；强制原型时照抄，只有 deepsleep 可以没有碎片
        match: has('### [导演任务：梦境演出 Dream Theater]'),
        reply: text => JSON.stringify({
            archetype: text.match(/archetype 字段必须为 "(\w+)"/)?.[1] ?? 'starry',
            title: '假模型的梦', afterglow: '醒来什么也不记得。',
            fragments: [{ kind: 'line', text: '这是假模型的梦。', emphasis: 'normal' }, { kind: 'silence', pace: 1 }],
        }),
    },
    vision: {
        describe: '独立识图',
        // utils/visionApi.ts
        match: has('请准确、具体地描述图片中实际可见的内容'),
        reply: () => '假模型看到了一张测试图片。',
    },
    'friend-feed': {
        describe: '哔哔（好友圈）单独刷新 / 评论区刷新',
        // utils/friendFeedEmotion.ts；friendFeedAction:null 表示这轮不动作
        match: has('## 参与哔哔（用户主动刷新', '这条动态的评论区已刷新。本轮仅一次请求'),
        reply: () => JSON.stringify({ friendFeedAction: null }),
    },
    'format-fix': {
        describe: '本轮格式修复',
        // utils/chatTurnGeneration.ts
        match: has('你是私聊气泡的格式校对员'),
        reply: () => JSON.stringify({ edits: [] }),
    },
    'thinking-translate': {
        describe: '心象翻译',
        // utils/thinkingTranslation.ts：每个 segment id 回一条；系统提示词里有个 id:0 的示例，只看用户那条
        match: has('你是翻译器。用户提供 segments 数组'),
        reply: (_text, lastUser) => {
            const ids = [...lastUser.matchAll(/"id"\s*:\s*(\d+)/g)].map(m => Number(m[1]));
            return JSON.stringify({ translations: [...new Set(ids)].map(id => ({ id, text: `假模型译文 ${id}` })) });
        },
    },
    translate: {
        describe: '语音字幕翻译',
        // apps/Chat.tsx
        match: has('把以下内容翻译成中文。只输出翻译结果，不要任何解释。', 'Translate the following text to '),
        reply: () => '假模型译文。',
    },
} satisfies Record<string, AuxDef>;

export type AuxKind = keyof typeof AUX_KINDS;

function text(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(p => (p && typeof p === 'object' && typeof (p as any).text === 'string') ? (p as any).text : '').join('');
    return '';
}

export function detectAuxKind(requestText: string, messages: Message[]): AuxKind | null {
    let lastUser = '';
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') { lastUser = text(messages[i].content); break; }
    }
    for (const [kind, def] of Object.entries(AUX_KINDS) as [AuxKind, AuxDef][]) {
        if (def.match(requestText, lastUser)) return kind;
    }
    return null;
}
