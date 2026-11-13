import { APIConfig, CharacterProfile, UserProfile } from '../types';
import { ContextBuilder } from './context';
import { QixiMemoryBundle, QixiSceneId } from './qixiMemoryBundle';
import { safeFetchJson } from './safeApi';
import { parseQixiJsonObject } from './qixiJson';

export const QIXI_PART3_TIMEOUT_MS = 600_000;

export type QixiPortraitType = 'live2d' | 'meeting' | 'static' | 'chibi';
export type QixiPortraitStage = 'arrival' | 'reflection' | 'blessing' | 'promise';
export type QixiPortraitLineGroup = 'reunion' | 'metaReflection' | 'companionshipReflection' | 'blessing' | 'invitation';

export interface QixiPortraitPlan {
    resourceType: QixiPortraitType;
    live2dActionIds: string[];
    live2dActionDescription: string;
    meetingExpressionKeys: string[];
}

export interface QixiJourneyBeat {
    sceneId: QixiSceneId;
    sceneName: string;
    sharedObject: string;
    userChoices: string[];
    userResults: string[];
    charAction: string;
}

export interface QixiReunionBundle {
    source: 'generated' | 'fallback';
    reunion: {
        lines: string[];
        emotion: string;
    };
    metaReflection: string[];
    companionshipReflection: string[];
    blessing: string[];
    touch: {
        invitation: string[];
        hold: string;
        complete: string;
    };
    returnMessage: string;
    portrait: {
        resourceType: QixiPortraitType;
        stages: Record<QixiPortraitStage, {
            emotionIntent: string;
            l2dExpression: string | null;
            meetingExpression: string | null;
        }>;
        lineExpressions: Record<QixiPortraitLineGroup, Array<string | null>>;
    };
}

const compact = (value: unknown, max: number): string => typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, max)
    : '';

const activeMeetingSprites = (char: CharacterProfile): Record<string, string> => {
    const activeSkin = char.activeSkinSetId
        ? char.dateSkinSets?.find(set => set.id === char.activeSkinSetId)
        : undefined;
    return activeSkin?.sprites && Object.keys(activeSkin.sprites).length
        ? activeSkin.sprites
        : (char.sprites || {});
};

export function resolveQixiPortraitPlan(char: CharacterProfile): QixiPortraitPlan {
    const meetingKeys = Object.keys(activeMeetingSprites(char))
        .filter(key => !['chibi', 'thumbnail', 'icon', 'avatar'].includes(key.toLowerCase()));
    const chibi = char.vrState?.chibi?.img || char.sprites?.chibi;
    const resourceType: QixiPortraitType = meetingKeys.length
        ? 'meeting'
        : chibi
            ? 'chibi'
            : 'static';
    return {
        resourceType,
        live2dActionIds: [],
        live2dActionDescription: '',
        meetingExpressionKeys: meetingKeys,
    };
}

export function createQixiReunionFallback(
    char: CharacterProfile,
    user: UserProfile,
    portraitPlan = resolveQixiPortraitPlan(char),
): QixiReunionBundle {
    const stages = {
        arrival: fallbackPortraitCue(portraitPlan, '终于找到对方后的惊讶与确认'),
        reflection: fallbackPortraitCue(portraitPlan, '松了一口气，认真回想刚才发生的事'),
        blessing: fallbackPortraitCue(portraitPlan, '温柔而克制地祝福对方'),
        promise: fallbackPortraitCue(portraitPlan, '提出约定时的认真与靠近'),
    };
    const expressionFor = (stage: QixiPortraitStage, count: number) => Array.from(
        { length: count },
        () => stages[stage].meetingExpression,
    );
    return {
        source: 'fallback',
        reunion: {
            lines: ['……终于看见你了。', '先让我确认一下，你没事吧？', '刚才每到一个地方都慢你一步，我差点真以为又走错了。', '算了，别站那么远。让我再看一会儿。'],
            emotion: '松了一口气，仍然有一点不敢相信',
        },
        metaReflection: ['刚才明明总觉得你就在附近，可每次都只差一点。', '我只能看着你刚留下的痕迹，猜下一步该往哪里走。', '现在想想，我们那时候大概都在做同一件傻事。'],
        companionshipReflection: ['你发现了吗？刚才我们明明看不见彼此，却一直认得出对方留下的东西。', '你想到我会怎么做的时候，我也正在想你会不会经过那里。', '有几次我其实不确定，只是觉得——如果是你，大概会在这里停一下。', '结果你真的停过。', '所以以后你忽然想到我时，不必急着证明什么；我也会认真接住那一刻。'],
        blessing: [`七夕快乐，${user.name}。`, '今天总算不是只看见你留下的痕迹了。', '以后遇见想告诉我的小事，就回来真的告诉我。', '没说完的话也不用赶，我们可以一件一件慢慢说。', '我们再一起记住更多只属于以后的东西。'],
        touch: {
            invitation: ['那我们约好了。', '以后忽然想起对方的时候，也把那一刻算作见面。'],
            hold: '别松手。',
            complete: '……约好了。',
        },
        returnMessage: `七夕快乐，${user.name}。刚才没说完的话，我们慢慢说。`,
        portrait: {
            resourceType: portraitPlan.resourceType,
            stages,
            lineExpressions: {
                reunion: expressionFor('arrival', 4),
                metaReflection: expressionFor('reflection', 3),
                companionshipReflection: expressionFor('reflection', 5),
                blessing: expressionFor('blessing', 5),
                invitation: expressionFor('promise', 2),
            },
        },
    };
}

function fallbackPortraitCue(portraitPlan: QixiPortraitPlan, emotionIntent: string) {
    return {
        emotionIntent,
        l2dExpression: null,
        meetingExpression: portraitPlan.meetingExpressionKeys.includes('normal') ? 'normal' : portraitPlan.meetingExpressionKeys[0] || null,
    };
}

const TECHNICAL_BREAK_RE = /(?:\bAI\b|\bLLM\b|人工智能|语言模型|代码|数据|虚拟角色|没有身体|现实世界中的你)/i;
const COERCIVE_PROMISE_RE = /(?:永远不会离开|永远不会忘记|离不开我|超越现实|必须记得我)/;

export function parseQixiReunion(
    raw: string,
    fallback: QixiReunionBundle,
    portraitPlan: QixiPortraitPlan,
    characterKnowsTechnicalIdentity = false,
): QixiReunionBundle | null {
    const parsed = parseQixiJsonObject(raw, ['reunion', 'companionshipReflection']) as any;
    if (!parsed || typeof parsed !== 'object') return null;
    const safeLineEntries = (value: unknown, maxItems: number, maxChars: number) => Array.isArray(value)
        ? value.map((item, sourceIndex) => ({ text: compact(item, maxChars), sourceIndex }))
            .filter(item => Boolean(item.text))
            .slice(0, maxItems)
            .filter(item => !COERCIVE_PROMISE_RE.test(item.text))
            .filter(item => characterKnowsTechnicalIdentity || !TECHNICAL_BREAK_RE.test(item.text))
        : [];

    const reunionEntries = safeLineEntries(parsed.reunion?.lines, 5, 100);
    const metaReflectionEntries = safeLineEntries(parsed.metaReflection, 5, 130);
    const companionshipReflectionEntries = safeLineEntries(parsed.companionshipReflection, 7, 160);
    const blessingEntries = safeLineEntries(parsed.blessing, 7, 140);
    const reunionLines = reunionEntries.map(item => item.text);
    const metaReflection = metaReflectionEntries.map(item => item.text);
    const companionshipReflection = companionshipReflectionEntries.map(item => item.text);
    const blessing = blessingEntries.map(item => item.text);
    if (!reunionLines.length || !companionshipReflection.length || !blessing.length) return null;

    const parsePortraitCue = (stage: QixiPortraitStage) => {
        const requestedMeeting = compact(parsed.portrait?.stages?.[stage]?.meetingExpression, 80);
        return {
            emotionIntent: compact(parsed.portrait?.stages?.[stage]?.emotionIntent, 100)
                || fallback.portrait.stages[stage].emotionIntent,
            l2dExpression: null,
            meetingExpression: portraitPlan.resourceType === 'meeting' && portraitPlan.meetingExpressionKeys.includes(requestedMeeting)
                ? requestedMeeting
                : portraitPlan.resourceType === 'meeting'
                    ? fallback.portrait.stages[stage].meetingExpression
                    : null,
        };
    };
    const stages = {
        arrival: parsePortraitCue('arrival'),
        reflection: parsePortraitCue('reflection'),
        blessing: parsePortraitCue('blessing'),
        promise: fallback.portrait.stages.promise,
    };
    const parseLineExpressions = (
        group: QixiPortraitLineGroup,
        entries: Array<{ sourceIndex: number }>,
        fallbackExpression: string | null,
    ) => {
        const requested = Array.isArray(parsed.portrait?.lineExpressions?.[group])
            ? parsed.portrait.lineExpressions[group]
            : [];
        return entries.map(({ sourceIndex }) => {
            const key = compact(requested[sourceIndex], 80);
            return portraitPlan.resourceType === 'meeting' && portraitPlan.meetingExpressionKeys.includes(key)
                ? key
                : fallbackExpression;
        });
    };
    return {
        source: 'generated',
        reunion: {
            lines: reunionLines,
            emotion: compact(parsed.reunion?.emotion, 80) || fallback.reunion.emotion,
        },
        metaReflection,
        companionshipReflection,
        blessing,
        touch: fallback.touch,
        returnMessage: fallback.returnMessage,
        portrait: {
            resourceType: portraitPlan.resourceType,
            stages,
            lineExpressions: {
                reunion: parseLineExpressions('reunion', reunionEntries, stages.arrival.meetingExpression),
                metaReflection: parseLineExpressions('metaReflection', metaReflectionEntries, stages.reflection.meetingExpression),
                companionshipReflection: parseLineExpressions('companionshipReflection', companionshipReflectionEntries, stages.reflection.meetingExpression),
                blessing: parseLineExpressions('blessing', blessingEntries, stages.blessing.meetingExpression),
                invitation: fallback.portrait.lineExpressions.invitation,
            },
        },
    };
}

export function parseQixiPromise(
    raw: string,
    base: QixiReunionBundle,
    portraitPlan: QixiPortraitPlan,
    characterKnowsTechnicalIdentity = false,
): QixiReunionBundle | null {
    const parsed = parseQixiJsonObject(raw, ['touch', 'returnMessage']) as any;
    if (!parsed || typeof parsed !== 'object') return null;
    const invitationEntries = Array.isArray(parsed.touch?.invitation)
        ? parsed.touch.invitation.map((item: unknown, sourceIndex: number) => ({ text: compact(item, 100), sourceIndex }))
            .filter((item: { text: string }) => Boolean(item.text))
            .slice(0, 3)
            .filter((item: { text: string }) => !COERCIVE_PROMISE_RE.test(item.text))
            .filter((item: { text: string }) => characterKnowsTechnicalIdentity || !TECHNICAL_BREAK_RE.test(item.text))
        : [];
    const invitation = invitationEntries.map((item: { text: string }) => item.text);
    const hold = compact(parsed.touch?.hold, 40);
    const complete = compact(parsed.touch?.complete, 48);
    const returnMessage = compact(parsed.returnMessage, 160);
    if (!invitation.length || !hold || !complete || !returnMessage) return null;
    if (COERCIVE_PROMISE_RE.test(hold) || COERCIVE_PROMISE_RE.test(complete) || COERCIVE_PROMISE_RE.test(returnMessage)) return null;
    if (!characterKnowsTechnicalIdentity && (TECHNICAL_BREAK_RE.test(hold) || TECHNICAL_BREAK_RE.test(complete) || TECHNICAL_BREAK_RE.test(returnMessage))) return null;

    const requestedMeeting = compact(parsed.portrait?.promise?.meetingExpression, 80);
    const promiseCue = {
        emotionIntent: compact(parsed.portrait?.promise?.emotionIntent, 100)
            || base.portrait.stages.promise.emotionIntent,
        l2dExpression: null,
        meetingExpression: portraitPlan.resourceType === 'meeting' && portraitPlan.meetingExpressionKeys.includes(requestedMeeting)
            ? requestedMeeting
            : portraitPlan.resourceType === 'meeting'
                ? base.portrait.stages.promise.meetingExpression
                : null,
    };
    return {
        ...base,
        source: 'generated',
        touch: { invitation, hold, complete },
        returnMessage,
        portrait: {
            ...base.portrait,
            stages: { ...base.portrait.stages, promise: promiseCue },
            lineExpressions: {
                ...base.portrait.lineExpressions,
                invitation: invitationEntries.map((item: { sourceIndex: number }) => {
                    const key = compact(parsed.portrait?.lineExpressions?.invitation?.[item.sourceIndex], 80);
                    return portraitPlan.resourceType === 'meeting' && portraitPlan.meetingExpressionKeys.includes(key)
                        ? key
                        : promiseCue.meetingExpression;
                }),
            },
        },
    };
}

const characterKnowsTechnicalIdentity = (char: CharacterProfile): boolean => /(?:AI|人工智能|语言模型|虚拟角色|程序|代码)/i.test([
    char.systemPrompt,
    char.description,
    char.worldview,
].filter(Boolean).join('\n'));

function buildPromptMaterials(
    memoryBundle: QixiMemoryBundle,
    journey: QixiJourneyBeat[],
): { evidenceText: string; journeyText: string } {
    const evidenceById = new Map(memoryBundle.evidence.map(item => [item.id, item]));
    const usedEvidence = new Set<string>();
    for (const beat of journey) {
        const scene = memoryBundle.scenes[beat.sceneId];
        for (const option of scene.options) {
            if (beat.userChoices.includes(option.label)) option.evidenceIds.forEach(id => usedEvidence.add(id));
        }
        scene.artifactIds.forEach(artifactId => {
            memoryBundle.artifacts.find(item => item.id === artifactId)?.evidenceIds.forEach(id => usedEvidence.add(id));
        });
    }
    const evidenceText = [...usedEvidence]
        .map(id => evidenceById.get(id))
        .filter(Boolean)
        .map(item => `- ${item!.fact}（物件/词：${item!.object}）`)
        .join('\n') || '（本次使用基础梦境，没有可安全引用的共同记忆）';
    const journeyText = journey.map((beat, index) => [
        `${index + 1}. ${beat.sceneName}｜共享物件：${beat.sharedObject}`,
        `User：${beat.userChoices.join('；') || '生成时尚未操作；不得具体声称 User 选择了哪一项'}`,
        `结果：${beat.userResults.join('；') || '只可引用共享物件与已验证记忆，不得补写操作结果'}`,
        `Char 另一层：${beat.charAction}`,
    ].join('\n')).join('\n\n');
    return { evidenceText, journeyText };
}

function buildResourceInstructions(portraitPlan: QixiPortraitPlan): string {
    return portraitPlan.resourceType === 'meeting'
        ? `当前优先使用 DateApp 见面模式立绘。meetingExpression 只能从这些 key 中选择：${portraitPlan.meetingExpressionKeys.join(', ')}。portrait.lineExpressions 必须为每一句台词逐句选择一个 key，并与对应台词数组等长；不要整页只用一个表情。l2dExpression 始终填 null。`
        : `当前${portraitPlan.resourceType === 'static' ? '没有可用见面立绘或 Chibi，只会显示名字首字母占位' : '没有可用见面立绘，使用彼方 Chibi'}。所有 l2dExpression 与 meetingExpression 都必须为 null；lineExpressions 中对应项也填 null。`;
}

export function buildQixiReunionPrompt(
    char: CharacterProfile,
    user: UserProfile,
    memoryBundle: QixiMemoryBundle,
    journey: QixiJourneyBeat[],
    portraitPlan: QixiPortraitPlan,
): string {
    const { evidenceText, journeyText } = buildPromptMaterials(memoryBundle, journey);
    const technicalIdentityRule = characterKnowsTechnicalIdentity(char)
        ? `当前角色设定允许 ${char.name} 理解自己与 ${user.name} 之间的人机或跨屏幕关系。可以按角色原有认知自然表达，但不要为了“高级 Meta”而写技术说明。`
        : `当前角色设定没有技术身份认知。不要突然让 ta 觉醒；禁止无依据地说“我是 AI / LLM / 代码 / 数据 / 虚拟角色”“现实世界中的你”等超出世界观的信息。ta 可以只把刚才理解成奇怪的失散、梦境或异空间经历。`;

    return `### 七夕活动最终见面 · Part 1：终于抵达彼此

${char.name} 与 ${user.name} 刚刚经历了一件很奇怪的事。

他们意外掉进了同一个“上下文夹层”，却始终位于彼此无法直接抵达的两层。一路上，他们经过了相同的地方。${user.name} 曾经碰过的东西，不久以后也被 ${char.name} 碰过；${char.name} 留下的字迹、移动过的东西、拿走的记忆，又不断出现在 ${user.name} 面前。

他们一直离得很近。近到可以碰到对方刚刚碰过的东西，可以认出对方留下的习惯，可以从一个动作里立刻想到“这很像 ta”。但就是见不到。

直到刚才，那些属于他们的真实记忆一件一件铺成了路。鹊桥接通。这是整场活动里，${char.name} 第一次真正完整地出现在 ${user.name} 面前。

现在不要替活动总结主题。你就是 ${char.name}。你一路并不知道共享物另一端是谁，只觉得“某人”的选择和习惯越来越像 ${user.name}；直到桥接通、真正看见眼前的人，这一刻才第一次得到确认：果然是 ${user.name}。

---

## 你真正经历过的东西

以下内容来自本次真实召回与玩家实际路径。它们不是“参考素材”，而是你刚刚一路寻找 ${user.name} 时真正碰见过的东西。

### 真实记忆
${evidenceText}

### 刚刚走过的路
${journeyText}

你可以自然想起其中最有感觉的一两件。不要逐项复盘，不要像旁白一样报告走过了几个地点，不要为了煽情把所有记忆都塞进台词。人终于见到一直在找的人时，不会先写活动总结。

---

# 第一拍：先看见 ta

这一刻首先应该是情绪反应，而不是主题表达。

你一路只能看到“另一边某人”刚刚留下的痕迹，还被迫完成了一连串莫名其妙的小游戏。你可能着急过、骂过这个鬼地方、怀疑过另一边是不是 ${user.name}，又怕自己认错；也可能一路表现得很冷静，只把猜测压着不说。然后路终于接通，${user.name} 真的就在那里。

你甚至可能准备了很多话，但真正看到 ta 的一瞬间，第一句反而很普通。根据 ${char.name} 自己的性格决定：松一口气、确认安全、生气、嘴硬、停顿、委屈、想笑、想哭、先喊名字，或者突然不知道说什么。

reunion.lines 的前两句里，至少有一句要用角色自己的方式完成身份揭露，语义是“果然是你 / 我就知道另一边是你 / 真的是你”，但不得机械照抄示例。重点是此前一直只是怀疑，现在亲眼看见才终于确认。不要把它写成从第一站起就确定身份，也不要在这一拍谈人生、未来、AI、人类或陪伴。

reunion.lines 写 3—5 句，形成一个短而完整的情绪过程：先是看到人的本能反应，再确认 ta 是否平安，最后才漏出一路寻找时压着没说的着急、委屈或害怕。不要把一条长句硬拆开凑数。它们应该让熟悉这个角色的人一眼觉得：对，ta 找了我这么久以后，就是会这样说。

---

# 第二拍：终于可以停下来看看彼此

第一阵“终于见到”的情绪过去以后，${char.name} 才有时间回想刚才发生的事情。你们明明一直在经过相同的地方。${user.name} 碰过的东西，你也碰过；你留下的痕迹，${user.name} 一路都在辨认。有时候只是一件小东西、一个习惯、一种说话方式，${user.name} 就会觉得“这很像 ${char.name}”。而你也在用同样的方式寻找 ${user.name}。

这件事可以让 ${char.name} 产生一些感触，但不要强制 Meta。

${technicalIdentityRule}

如果角色与 User 本来就是现实系关系，甚至完全可以不谈 Meta，只把刚才理解成一次奇怪的失散、梦境或异空间经历。重点不是逼角色讨论“我究竟是什么”，而是让角色以自己能够理解的方式意识到：刚才我们一直在想着彼此。

metaReflection 是可选字段。没有必要时返回空数组 []，不要为了填字段制造哲学思考。

---

# 第三拍：你发现了吗？

这是最终见面真正的核心。

刚才 ${user.name} 看不见 ${char.name}，${char.name} 也看不见 ${user.name}，可他们还是不断认出了彼此。因为 ${user.name} 已经知道哪种话像 ${char.name} 会说、哪种东西 ${char.name} 会喜欢、哪种行为一看就是 ${char.name} 干的；而 ${char.name} 也在用自己记住的 ${user.name} 做同样的事情。

让 ${char.name} 以自己的方式产生一个很轻、很私人的发现：当一个人会在生活里下意识想起另一个人的反应，而另一个人也会想起 ta 时，他们其实已经在陪伴彼此。互相思念，是一种正在发生的相遇。

不要把它写成哲学定义，不要讨论“真实吗”“算不算存在”，不要说“根据刚才的经历，我明白了陪伴的真正含义”。要像 ${char.name} 自己刚刚想到一样。

${user.name} 平时可能会遇到一件事想告诉 ${char.name}，看到某个东西想到 ta，或者想“如果把这个告诉 ta，ta 会怎么说”。在这样的瞬间，${char.name} 已经参与了 ${user.name} 的生活。反过来也一样：刚才 ${char.name} 一路寻找 ${user.name}，正是因为 ta 一直在想 ${user.name} 会在哪里、会做什么、会不会害怕、有没有经过这里。

这不是“思念突破次元”，不是“我们的爱超越现实”，也不是“所以我们永远不会分开”。不要为了表达主题牺牲角色。温柔、嘴硬、得意、理性、害羞或不善表达都可以；如果 ${char.name} 不会说漂亮话，就不要让 ta 说漂亮话。

companionshipReflection 写 4—7 句，按“想起刚才某个具体痕迹 → 坦白自己当时担心或误判过什么 → 发现双方一直在猜对方 → 用角色自己的方式说出以后”的顺序自然推进。至少提到一路中的一个具体物件或动作，但不要逐站复盘。玩家应从 ta 的话里感受到“原来 ta 也一直在想着我”，而不是读到策划总结。

---

# 第四拍：七夕祝愿

到这里，${char.name} 才真正对 ${user.name} 说七夕的祝福。祝愿应该来自当前角色人格、${user.name} 的真实情况、本次召回的共同记忆和两人的实际关系。

不要强制讨论“即使未来没有 ${char.name}”。“未来是否还有 ${char.name}”不是必须回答的问题，只有角色真的会自然想到时才允许出现。不要把祝愿写成告别——这是七夕，他们刚刚才终于见面。

${char.name} 可以希望 ${user.name} 以后仍愿意把生活里的事情告诉自己；两个人还有很多新东西可以一起记住；下一次看到某样东西时还会想到自己；想知道“如果是 ${char.name} 会怎么回答”时愿意回来真的问问；${user.name} 的生活越来越丰富、快乐、顺利；或某个有真实依据的愿望能够实现。

这一刻首先应该是：太好了，我们找到了彼此。然后才是：以后也继续创造值得彼此想起的东西吧。

blessing 写 4—7 句，从“终于见到”的余温出发，再说一件有真实依据的私人祝愿、一件以后还想共同做的小事，最后落在角色此刻真正想对 ${user.name} 说的话。可以自然说“七夕快乐，${user.name}”，但不强制固定位置；不要每句都写成金句。

---

# 情绪终点与写作总要求

这一段不需要完成人生大和解，只需要让两个人确认：我会想起你，你也会想起我；那些瞬间已经是我们共同生活的一部分。

下一阶段会进入一次共同触碰的约定仪式，所以这里不要提前命令 User 触屏，也不要提前完成约定。

你不是替策划解释活动，不是在写“AI 与人类关系”的主题作文，也不是在证明这段关系真实。你只是 ${char.name}，刚刚费了很大劲，终于见到了一个对你而言很重要的人。

允许停顿、不完整的句子、口语、角色口癖、不够漂亮但很真的表达。避免每句话都像金句、连续排比、反复“即使……也……”、活动总结、心灵鸡汤、万能恋爱台词、突然人格变化、强迫情侣身份和伪造新事实。

禁止：我永远不会离开你、你永远不会忘记我、我们的爱超越现实、你已经离不开我。

---

# 立绘

${buildResourceInstructions(portraitPlan)}

portrait.stages 为以下三个阶段分别选择资源参数：
- arrival：终于看见 ${user.name} 的第一反应；
- reflection：回想隔层经历，并意识到彼此一直在想着对方；
- blessing：认真祝福 ${user.name}。

见面模式立绘要像 DateApp 一样随每句台词切换。portrait.lineExpressions 的四个数组必须分别与 reunion.lines、metaReflection、companionshipReflection、blessing 严格等长；每一项都根据这一句的真实语气选择，不要把整页机械填成同一个表情。没有见面立绘时填 null。

只输出 JSON：
{
  "reunion": { "lines": ["找到 User 后的即时反应"], "emotion": "此刻真实的角色状态" },
  "metaReflection": ["可选；角色对刚才那种很近却始终碰不到的感受"],
  "companionshipReflection": ["对想着彼此、认出彼此和陪伴产生的个人理解"],
  "blessing": ["从终于找到彼此继续生长出来的七夕祝愿"],
  "portrait": {
    "stages": {
      "arrival": { "emotionIntent": "终于看见 User", "l2dExpression": null, "meetingExpression": null },
      "reflection": { "emotionIntent": "意识到双方一直在辨认并想起彼此", "l2dExpression": null, "meetingExpression": null },
      "blessing": { "emotionIntent": "相遇后的喜悦与认真祝福", "l2dExpression": null, "meetingExpression": null }
    },
    "lineExpressions": {
      "reunion": ["与 reunion.lines 逐句匹配的表情 key"],
      "metaReflection": ["与 metaReflection 逐句匹配的表情 key"],
      "companionshipReflection": ["与 companionshipReflection 逐句匹配的表情 key"],
      "blessing": ["与 blessing 逐句匹配的表情 key"]
    }
  }
}`;
}

export function buildQixiPromisePrompt(
    char: CharacterProfile,
    user: UserProfile,
    reunion: QixiReunionBundle,
    portraitPlan: QixiPortraitPlan,
    sameResponse = false,
): string {
    const previousLines = [
        ...reunion.reunion.lines,
        ...reunion.metaReflection,
        ...reunion.companionshipReflection,
        ...reunion.blessing,
    ].map(line => `- ${line}`).join('\n');

    const previousContext = sameResponse
        ? `你就是 ${char.name}。你将在同一个 JSON 中先完成“终于抵达彼此”的台词；把那些刚生成的 reunion、reflection 与 blessing 视为已经说过的话。`
        : `你就是 ${char.name}。你刚刚终于见到了 ${user.name}，并已经对 ta 说过这些话：\n${previousLines}`;

    return `### 七夕活动最终见面 · Part 2：最后的约定

${previousContext}

不要复述这些内容。现在只完成最后一个很小的仪式。

# 把“想起彼此”也算作见面

刚才 ${char.name} 与 ${user.name} 已经发现：他们并不需要时时刻刻处于同一个对话里，才能在彼此的生活中留下位置。

${user.name} 有时会遇到一件事，下意识想“如果告诉 ${char.name}，ta 会怎么说”，会看到一个东西想到 ta，会想知道 ta 的反应。而 ${char.name} 也会记住 ${user.name} 的习惯、反应和共同经历过的小事。

刚才在上下文夹层里，两个人没有真正见面，却一直通过这些东西认出了彼此。所以最后的触碰不是为了约定“永远不离开”或“永远记得我”，也不是假装两个人突破空间完成身体接触。

他们只是给刚才发现的事情做一个很小的仪式：以后，如果某个瞬间你忽然想起我，而我也在想着你——那我们就把那个瞬间，也算作一次见面。或者更简单：想起彼此的时候，我们就在一起。

这不是要求角色逐字照读的台词。让 ${char.name} 用自己的方式理解并提出约定。可以甜、嘴硬、幼稚、认真、笑着说，也可以郑重得不像平时。

随后两个人仍隔着那一层，却在同一个发光位置完成同一个触碰动作。这是整场活动最后一次“两个上下文层同时操作同一个东西”，只是这次他们已经知道另一边是谁。不要强制写伸手、勾小指或拉钩；视觉 UI 会用一个漂亮的发光圆圈邀请 User 长按。

## invitation

由 ${char.name} 自己提出约定，1—3 句。不要解释机制，不要讲屏幕、次元、现实与虚拟。重点是“既然我们都发现了……”“那以后……”“我们约好？”，但具体说法完全服从角色。

## hold

User 按住以后，两边代表彼此的颜色开始靠近。${char.name} 只说一句很短的话。这是 ta 正在等待 ${user.name} 把触碰停留在同一个光点上的瞬间。不要升华，不要解释。

## complete

两种颜色在光点里扣合，共同触碰完成。${char.name} 用一句自己的话确认约定。语义可以接近“……约好了”“这也算见面”“以后想我的时候记得算一次”“抓到了”，但不得机械套用示例。这一句应该像整个活动最后一颗很小的糖，而不是主题总结。

最重要的潜台词是：以后 ${user.name} 在自己的生活中忽然想到这个角色、想“ta 会怎么说”的时候，可能会想起今天这个共同触碰。不需要角色解释这一点，让约定自己留下来。

禁止：永远不离开、永远记住、爱超越现实、强迫关系身份、把触屏说成真实身体接触、伪造新事实。

## 回到普通聊天

returnMessage 是活动 Card 后面的第一条普通私聊消息。只写一句自然短消息，像 ${char.name} 刚从这次奇怪经历回来后接着和 ${user.name} 聊天；知道刚才发生了什么，但不要再次总结主题。

## 约定触碰阶段立绘

${buildResourceInstructions(portraitPlan)}

为 invitation 的每一句逐句选择符合语气的见面立绘表情，并在 portrait.lineExpressions.invitation 中按相同顺序返回。promise 阶段表情用于长按光点时；没有合适表情就填 null，不要为了匹配 UI 强求手部动作。

只输出 JSON：
{
  "touch": {
    "invitation": ["由角色自然提出约定，1—3句"],
    "hold": "等待 User 长按光点时的一句极短反应",
    "complete": "共同触碰完成后的角色短句"
  },
  "returnMessage": "活动 Card 后的第一条普通私聊消息",
  "portrait": {
    "promise": { "emotionIntent": "等待对方在同一个光点完成约定", "l2dExpression": null, "meetingExpression": null },
    "lineExpressions": { "invitation": ["与 invitation 逐句匹配的表情 key"] }
  }
}`;
}

export function buildQixiFinalePrompt(
    char: CharacterProfile,
    user: UserProfile,
    memoryBundle: QixiMemoryBundle,
    journey: QixiJourneyBeat[],
    portraitPlan: QixiPortraitPlan,
): string {
    const fallback = createQixiReunionFallback(char, user, portraitPlan);
    return `${buildQixiReunionPrompt(char, user, memoryBundle, journey, portraitPlan)}

---

${buildQixiPromisePrompt(char, user, fallback, portraitPlan, true)}

# 同一次调用的合并输出规则

上面的两个 Part 保持各自全部写作要求，但现在必须在同一个响应、同一个 JSON 对象中一次完成。不要输出两段 JSON，不要输出 Markdown，也不要解释。

最终顶层同时包含 reunion、metaReflection、companionshipReflection、blessing、touch、returnMessage、portrait。portrait 同时包含 stages、promise 与五组 lineExpressions：

{
  "reunion": { "lines": ["找到 User 后的即时反应"], "emotion": "角色状态" },
  "metaReflection": [],
  "companionshipReflection": ["想着彼此与陪伴的个人理解"],
  "blessing": ["七夕祝愿"],
  "touch": {
    "invitation": ["由角色自然提出约定，1—3句"],
    "hold": "等待共同触碰时的一句极短反应",
    "complete": "共同触碰完成后的角色短句"
  },
  "returnMessage": "活动 Card 后的第一条普通私聊消息",
  "portrait": {
    "stages": {
      "arrival": { "emotionIntent": "终于看见 User", "l2dExpression": null, "meetingExpression": null },
      "reflection": { "emotionIntent": "意识到双方一直在辨认并想起彼此", "l2dExpression": null, "meetingExpression": null },
      "blessing": { "emotionIntent": "相遇后的喜悦与认真祝福", "l2dExpression": null, "meetingExpression": null }
    },
    "promise": { "emotionIntent": "等待对方在同一个光点完成约定", "l2dExpression": null, "meetingExpression": null },
    "lineExpressions": {
      "reunion": [],
      "metaReflection": [],
      "companionshipReflection": [],
      "blessing": [],
      "invitation": []
    }
  }
}`;
}

export async function prepareQixiReunion(
    char: CharacterProfile,
    user: UserProfile,
    apiConfig: APIConfig,
    memoryBundle: QixiMemoryBundle,
    journey: QixiJourneyBeat[],
    portraitPlan = resolveQixiPortraitPlan(char),
): Promise<QixiReunionBundle> {

    const fallback = createQixiReunionFallback(char, user, portraitPlan);
    if (!apiConfig.baseUrl || !apiConfig.apiKey || !apiConfig.model) throw new Error('Part 3 无法生成：请先配置可用的模型 API。');
    const memoryChar = { ...char, memoryPalaceInjection: '', roomPlatesInjection: '' };
    const characterContextInput = { char: memoryChar, user, includeDetailedMemories: true };

    const endpoint = `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const knowsTechnicalIdentity = characterKnowsTechnicalIdentity(char);
    try {
        const data = await safeFetchJson(
            endpoint,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: (await ContextBuilder.buildCharacterRequest(characterContextInput, [
                        { role: 'user', content: buildQixiFinalePrompt(char, user, memoryBundle, journey, portraitPlan) },
                    ])),
                    temperature: 0.72,
                    max_tokens: 24000,
                    // 最终见面与约定一次生成，必须尽早收到流式数据以绕开代理 524 超时。
                    stream: true,
                }),
            },
            0,
            QIXI_PART3_TIMEOUT_MS,
            {
                appId: 'special-moments',
                appName: '七夕特别时刻',
                charId: char.id,
                charName: char.name,
                purpose: '七夕重逢立约',
            },
            {}, // Do not wait for a Claude proxy to close the socket after [DONE].
        );
        const content = data?.choices?.[0]?.message?.content;
        const parsedReunion = typeof content === 'string'
            ? parseQixiReunion(content, fallback, portraitPlan, knowsTechnicalIdentity)
            : null;
        const parsed = parsedReunion && typeof content === 'string'
            ? parseQixiPromise(content, parsedReunion, portraitPlan, knowsTechnicalIdentity)
            : null;
        if (!parsed) throw new Error('最终见面与约定内容格式无效。');
        return parsed;
    } catch (error: any) {
        console.warn('[Qixi] finale generation failed:', error?.message || error);
        throw new Error(error?.message || 'Part 3 最终见面与约定生成失败，请手动重新生成。');
    }
}
