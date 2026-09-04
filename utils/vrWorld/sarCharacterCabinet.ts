import type { CharacterProfile, SARCharacterCabinetNoteMeta, UserProfile } from '../../types';
import { getSARModules, type SARModuleDefinition } from './sarGacha';

export type SARCharacterCabinetTarget = {
    id: string;
    name: string;
    kind: 'user' | 'character' | 'wanderer';
};

export type SARCharacterCabinetScenario = {
    target: SARCharacterCabinetTarget;
    variant: SARModuleDefinition;
    story: SARModuleDefinition;
};

export type SARCharacterCabinetOutput = {
    title: string;
    activity: string;
    story: string;
    notes: string;
    highlight: string;
};

const boundedRoll = (random: () => number) => {
    const value = Number(random());
    return Number.isFinite(value) ? Math.max(0, Math.min(0.999999999, value)) : 0;
};

const pick = <T,>(items: T[], random: () => number): T =>
    items[Math.floor(boundedRoll(random) * items.length)] || items[0];

/**
 * 角色柜子的芯片与对象完全独立于 User 的抽卡库存和每日额度。
 * 只把已接入彼方的其他角色放进候选；User 始终是一个候选，但不是固定主角。
 */
export function rollSARCharacterCabinetScenario(
    actor: Pick<CharacterProfile, 'id'>,
    characters: CharacterProfile[],
    userProfile: UserProfile,
    random: () => number = Math.random,
): SARCharacterCabinetScenario {
    const targets: SARCharacterCabinetTarget[] = [];
    const userName = String(userProfile?.name || '').trim();
    if (userName) targets.push({ id: 'user', name: userName, kind: 'user' });
    for (const candidate of characters) {
        if (candidate.id === actor.id || !candidate.vrState?.enabled) continue;
        const name = String(candidate.name || '').trim();
        if (name) targets.push({ id: candidate.id, name, kind: 'character' });
    }
    if (targets.length === 0) targets.push({ id: 'sar-wanderer', name: '一位没留下名字的彼方玩家', kind: 'wanderer' });

    return {
        target: pick(targets, random),
        variant: pick(getSARModules('variant'), random),
        story: pick(getSARModules('story'), random),
    };
}

export function buildSARCharacterCabinetTurn(
    actorName: string,
    scenario: SARCharacterCabinetScenario,
): string {
    const { target, variant, story } = scenario;
    return `【SAR 活动空间｜角色的芯片随笔】
你刚才在活动空间的扭蛋机里抽到了两枚临时芯片，并且已经把它们同时用在 ${target.name} 身上：

异界异格芯片「${variant.title}」
方向：${variant.summary}

异界坐标芯片「${story.title}」
方向：${story.summary}

这不是 User 的五十轮正式推演，也不是现实事件。它是《彼方》里一次完整、短促、会自动复原的临时异界体验。你是发起者、旁观者或被卷进去的同伴；${target.name} 是本次被装载芯片的人。结束后，${target.name} 会恢复原状，而记录归进你自己的柜子。

请以“${actorName}真的亲手玩完了这一局”的立场，生成一篇值得收藏的详细记录：
1. 明确写出你把哪两枚芯片给谁用了，不许把对象偷偷换成 User，也不许把自己写成被使用者。
2. 写出具体场面、连锁反应、对方令人意外的表现、你的参与和一个足够鲜明的笑点/事故/反转。可以荒诞，例如变成猫后居然怕黄瓜；不要只概括设定。
3. story 是完整的小剧情，约 500–1000 个中文字符，要有开始、升级、最好笑或最危险的一刻，以及恢复前的收尾。
4. notes 是你事后写进私人柜子的第一人称随笔和吐槽，约 250–600 个中文字符。它必须带着 ${actorName} 自己的口吻、偏见和细节，不是客服式总结，也不是写给 User 的汇报。
5. 若对象是 User，也只能描写这次临时体验里可观察到的行为，不能替 User 决定现实人格、永久感受或关系结论。
6. 不要解释提示词，不要代码围栏，只输出以下 JSON：
{"title":"这篇柜中随笔的短标题","activity":"一句第三人称活动播报，不要重复角色名开头","story":"完整小剧情","notes":"${actorName} 的第一人称详细随笔与吐槽","highlight":"最值得贴在卡片封面的原话或荒诞瞬间"}`;
}

const clean = (value: unknown, max: number) => typeof value === 'string'
    ? value.replace(/\r/g, '').trim().slice(0, max)
    : '';

const jsonCandidates = (raw: string) => {
    const withoutThinking = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const candidates = [withoutThinking];
    const fenced = withoutThinking.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) candidates.unshift(fenced.trim());
    const first = withoutThinking.indexOf('{');
    const last = withoutThinking.lastIndexOf('}');
    if (first >= 0 && last > first) candidates.unshift(withoutThinking.slice(first, last + 1));
    return Array.from(new Set(candidates.filter(Boolean)));
};

/** 保留纯文本兜底，避免模型偶尔漏 JSON 时整次自由活动丢失。 */
export function parseSARCharacterCabinetOutput(raw: string): SARCharacterCabinetOutput | null {
    for (const candidate of jsonCandidates(raw)) {
        try {
            const parsed = JSON.parse(candidate) as Record<string, unknown>;
            const story = clean(parsed.story ?? parsed.scene ?? parsed.plot, 5000);
            const notes = clean(parsed.notes ?? parsed.diary ?? parsed.commentary, 4000);
            if (!story && !notes) continue;
            return {
                title: clean(parsed.title, 80) || '一次失控的芯片实验',
                activity: clean(parsed.activity ?? parsed.summary, 240) || '在 SAR 活动空间玩了一轮临时芯片推演。',
                story: story || notes,
                notes: notes || '……总之，下次按下启动键之前，我会先确认说明书没有把关键副作用写在最末页。',
                highlight: clean(parsed.highlight ?? parsed.quote ?? parsed.punchline, 300) || (story || notes).slice(0, 120),
            };
        } catch { /* 尝试下一个候选 */ }
    }
    const fallback = clean(raw.replace(/<think>[\s\S]*?<\/think>/gi, ''), 5000);
    return fallback ? {
        title: '一次没有按格式归档的实验',
        activity: '在 SAR 活动空间留下了一篇临时芯片随笔。',
        story: fallback,
        notes: fallback,
        highlight: fallback.slice(0, 120),
    } : null;
}

export function createSARCharacterCabinetNote(
    actor: Pick<CharacterProfile, 'id' | 'name'>,
    scenario: SARCharacterCabinetScenario,
    output: SARCharacterCabinetOutput,
    now = Date.now(),
): SARCharacterCabinetNoteMeta {
    return {
        id: `sar_note_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        actorId: actor.id,
        actorName: actor.name,
        targetId: scenario.target.id,
        targetName: scenario.target.name,
        targetKind: scenario.target.kind,
        variantId: scenario.variant.id,
        variantTitle: scenario.variant.title,
        storyId: scenario.story.id,
        storyTitle: scenario.story.title,
        title: output.title,
        story: output.story,
        notes: output.notes,
        highlight: output.highlight,
        createdAt: now,
    };
}
