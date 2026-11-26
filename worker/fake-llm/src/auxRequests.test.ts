import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AUX_KINDS, detectAuxKind, type AuxKind } from './auxRequests';
import { planResponse, type ReplyPlan } from './scenarios';
import { parseEmotionEvalOutput } from '../../../utils/emotionApply';
import { safeParseJsonArray } from '../../../utils/memoryPalace/jsonUtils';
import { parsePlateLlmReply, PLATE_USER_TURN } from '../../../utils/memoryPalace/roomPlateCore';
import { validatePersonaScriptResponse } from '../../../utils/personaSimLog';
import { validateDreamResponse } from '../../../utils/dreamScript';
import { readDedicatedFriendFeedResponse } from '../../../utils/friendFeedOutput';
import { extractJson } from '../../../utils/safeApi';

const repo = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

// 每个标记都得真的出现在它注明的那份提示词代码里；提示词改了开头，这里先挂，
// 不然辅助请求会悄悄被当成主回复，吃到副作用场景的正文。
const MARKERS: Array<[AuxKind, string, string]> = [
    ['emotion', 'utils/activeMsgClient.ts', '你是一个角色情绪分析系统。请分析角色「'],
    ['memory-extract', 'utils/memoryPalace/extraction.ts', '以你的第一人称视角（"我"）提取值得记住的记忆'],
    ['memory-compress', 'utils/memoryPalace/eventBoxCompression.ts', '下面这些记忆都属于一件事：「'],
    ['memory-compress', 'utils/memoryPalace/eventBoxCompression.ts', '下面这段第一人称回忆写得太长了'],
    ['memory-digest', 'utils/memoryPalace/digestion.ts', '请开始审视。'],
    ['memory-digest', 'utils/memoryPalace/digestion.ts', '你现在正在独处，安静地回想最近的事情。'],
    ['personality', 'utils/memoryPalace/digestion.ts', '请判断。'],
    ['personality', 'utils/memoryPalace/digestion.ts', '你是一个性格分析专家。'],
    ['plates', 'utils/memoryPalace/roomPlateCore.ts', '安静地整理自己的"底色认知"'],
    ['schedule', 'utils/scheduleGenerator.ts', '## Task: 生成角色的今日日程 + 意识流独白'],
    ['schedule', 'utils/scheduleGenerator.ts', '## Task: 生成角色的今日思绪 + 意识流独白'],
    ['schedule-narrative', 'utils/scheduleGenerator.ts', '请根据以上信息，写一段**进化后的内心独白**'],
    ['persona-sim', 'apps/PersonaSim.tsx', '### [导演任务：手机人生演出 Screenlife]'],
    ['dream', 'apps/DreamTheater.tsx', '### [导演任务：梦境演出 Dream Theater]'],
    ['vision', 'utils/visionApi.ts', '请准确、具体地描述图片中实际可见的内容'],
    ['friend-feed', 'utils/friendFeedEmotion.ts', '这条动态的评论区已刷新。本轮仅一次请求'],
    ['format-fix', 'utils/chatTurnGeneration.ts', '你是私聊气泡的格式校对员'],
    ['thinking-translate', 'utils/thinkingTranslation.ts', '你是翻译器。用户提供 segments 数组'],
    ['translate', 'apps/Chat.tsx', '把以下内容翻译成中文。只输出翻译结果，不要任何解释。'],
];

it.each(MARKERS)('%s 的标记还在 %s 里', (_kind, file, marker) => {
    expect(repo(file)).toContain(marker);
});

it('哔哔刷新那条标记拼在模板串里，分两段核对', () => {
    const src = repo('utils/friendFeedEmotion.ts');
    expect(src).toContain('## 参与哔哔（${source === \'refresh\' ? \'用户主动刷新');
});

it('每类辅助请求都登记了至少一个标记', () => {
    expect(new Set(MARKERS.map(m => m[0]))).toEqual(new Set(Object.keys(AUX_KINDS)));
});

describe('认请求类型', () => {
    const plan = (system: string, user: string, model = 'fake/side-effects') =>
        planResponse({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });

    it('情绪评估的提示词里整段包着主回复的系统提示词，仍然认成情绪评估，不吃副作用场景', () => {
        const prompt = '你是一个角色情绪分析系统。请分析角色「小明」\n### 聊天 App 行为规范 (Chat App Rules)\n【本次任务】';
        const { requestKind, plan: p } = planResponse({ model: 'fake/side-effects', messages: [{ role: 'user', content: prompt }] });
        expect(requestKind).toBe('emotion');
        expect((p as ReplyPlan).content).not.toContain('[[');
    });

    it('门牌整理只在最后一条 user 恰好是「请开始整理。」时才算', () => {
        const system = '你现在在独处，安静地整理自己的"底色认知"';
        expect(plan(system, PLATE_USER_TURN).requestKind).toBe('plates');
        expect(plan(system, '请开始整理。顺便聊聊').requestKind).toBe('main');
    });

    it('普通私聊落到 main，场景照常生效', () => {
        const r = plan('### 聊天 App 行为规范 (Chat App Rules)', '在吗');
        expect(r.requestKind).toBe('main');
        expect((r.plan as ReplyPlan).content).toContain('[[ACTION:POKE]]');
    });

    it('@kind 只打到那类辅助请求，主回复回到 basic', () => {
        const emotion = '你是一个角色情绪分析系统。请分析角色「小明」';
        expect(plan('', emotion, 'fake/error-500@emotion').plan).toMatchObject({ type: 'http-error', status: 500 });
        const main = plan('', '在吗', 'fake/error-500@emotion');
        expect(main.requestKind).toBe('main');
        expect(main.plan.type).toBe('reply');
    });

    it('聊天里写 #fake:场景 能临时换场景；定时任务只认【本次任务】之后那段', () => {
        expect(plan('', '#fake:error-401 测一下', 'fake/basic').plan).toMatchObject({ status: 401 });
        const fire = '挂着的排程：提示词「#fake:error-500」\n【本次任务】\n可选灵感补充：#fake:error-429';
        expect(plan('', fire, 'fake/basic').plan).toMatchObject({ status: 429 });
        expect(plan('', '挂着的排程：提示词「#fake:error-500」\n【本次任务】\n随便说点', 'fake/basic').plan.type).toBe('reply');
    });
});

describe('默认回复过得了 App 的真实解析器', () => {
    const reply = (kind: AuxKind, lastUser = '') => AUX_KINDS[kind].reply('', lastUser);
    const completion = (content: string) => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });

    it('情绪评估：解析成功且不改情绪', () => {
        expect(parseEmotionEvalOutput(reply('emotion'))).toMatchObject({ changed: false });
    });
    it('记忆提取 / 消化 / 门牌：空数组，什么都不写', () => {
        expect(safeParseJsonArray(reply('memory-extract'))).toEqual([]);
        expect(safeParseJsonArray(reply('memory-digest'))).toEqual([]);
        expect(parsePlateLlmReply(reply('plates'))).toEqual([]);
    });
    it('人格审视、日程：JSON 能抽出来', () => {
        expect(extractJson(reply('personality'))).toMatchObject({ style: 'emotional' });
        expect(extractJson(reply('schedule')).slots).toHaveLength(1);
    });
    it('人格模拟、梦境：通过各自的校验', () => {
        expect(validatePersonaScriptResponse(completion(reply('persona-sim'))).beats.at(-1)).toEqual({ kind: 'end' });
        expect(validateDreamResponse(completion(reply('dream'))).fragments.length).toBeGreaterThan(0);
        expect(JSON.parse(AUX_KINDS.dream.reply('archetype 字段必须为 "ocean"')).archetype).toBe('ocean');
    });
    it('哔哔刷新：解析成「这轮不动作」', () => {
        expect(readDedicatedFriendFeedResponse(completion(reply('friend-feed')))).toBeNull();
    });
    it('心象翻译：每个 segment id 各回一条', () => {
        const out = JSON.parse(reply('thinking-translate', JSON.stringify({ segments: [{ id: 0, source: 'a' }, { id: 1, source: 'b' }] })));
        expect(out.translations.map((t: any) => t.id)).toEqual([0, 1]);
    });
});

it('detectAuxKind 对空请求不误判', () => {
    expect(detectAuxKind('', [])).toBeNull();
});
