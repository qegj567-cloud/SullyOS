import type { CharacterProfile, Message, SARModuleRuntimeState, UserProfile } from '../../types';
import type { SARModuleDefinition } from './sarModuleShop';

export const SAR_CHARACTER_MODULE_TURNS = 10;
export const SAR_USER_MODULE_TURNS = 5;
export const SAR_MODULE_AFTERGLOW_TURNS = 3;

export interface SARModuleRuntimePlan {
    character?: SARModuleRuntimeState;
    user?: SARModuleRuntimeState;
    hasActiveEffect: boolean;
    hasAfterglow: boolean;
    requiresEnvelope: boolean;
}

export interface SARModuleParsedReply {
    canonical: string;
    assistantSurface?: string;
    userSurface?: string;
    enveloped: boolean;
}

export interface SARModuleSurfaceMeta {
    version: 1;
    runId: string;
    moduleId: string;
    moduleTitle: string;
    target: 'character' | 'user';
    phase: 'active';
    /** 只给界面画出来；所有上下文、总结、向量化仍只读 Message.content。 */
    surface: string;
    canonicalField: 'content';
    surfaceField: 'metadata.sarModuleSurface.surface';
}

const runId = (moduleId: string, now: number) =>
    `sar_mod_${now.toString(36)}_${moduleId.replace(/[^a-z0-9]/gi, '').slice(-10)}_${Math.random().toString(36).slice(2, 7)}`;

const makeRuntime = (
    module: SARModuleDefinition,
    target: 'character' | 'user',
    source: 'user' | 'character',
    now: number,
    sourceCharacter?: Pick<CharacterProfile, 'id' | 'name'>,
): SARModuleRuntimeState => {
    const totalTurns = target === 'character' ? SAR_CHARACTER_MODULE_TURNS : SAR_USER_MODULE_TURNS;
    return {
        version: 1,
        runId: runId(module.id, now),
        moduleId: module.id,
        moduleTitle: module.title,
        effectLabel: module.effectLabel,
        description: module.description,
        target,
        source,
        sourceCharacterId: sourceCharacter?.id,
        sourceCharacterName: sourceCharacter?.name,
        remainingTurns: totalTurns,
        totalTurns,
        afterglowTurns: 0,
        phase: 'active',
        installedAt: now,
    };
};

export const installSARModuleOnCharacter = (
    module: SARModuleDefinition,
    now = Date.now(),
): SARModuleRuntimeState => makeRuntime(module, 'character', 'user', now);

export const installSARModuleOnUser = (
    module: SARModuleDefinition,
    sourceCharacter: Pick<CharacterProfile, 'id' | 'name'>,
    now = Date.now(),
): SARModuleRuntimeState => makeRuntime(module, 'user', 'character', now, sourceCharacter);

/**
 * 只在一次新的前台 LLM 回复成功落库后调用。失败、取消、重掷替换旧回复都不调用。
 */
export const advanceSARModuleRuntime = (
    state: SARModuleRuntimeState | undefined,
): SARModuleRuntimeState | undefined => {
    if (!state) return undefined;
    if (state.phase === 'active') {
        if (state.remainingTurns > 1) return { ...state, remainingTurns: state.remainingTurns - 1 };
        return {
            ...state,
            phase: 'afterglow',
            remainingTurns: 0,
            afterglowTurns: SAR_MODULE_AFTERGLOW_TURNS,
        };
    }
    if (state.afterglowTurns > 1) return { ...state, afterglowTurns: state.afterglowTurns - 1 };
    return undefined;
};

export const getSARModuleRuntimePlan = (
    char: CharacterProfile,
    user: UserProfile,
): SARModuleRuntimePlan => {
    const character = char.vrState?.sarModule;
    const userModule = user.vrState?.sarModule;
    const hasActiveEffect = character?.phase === 'active' || userModule?.phase === 'active';
    const hasAfterglow = character?.phase === 'afterglow' || userModule?.phase === 'afterglow';
    return {
        character,
        user: userModule,
        hasActiveEffect,
        hasAfterglow,
        requiresEnvelope: hasActiveEffect,
    };
};

const activeLine = (state: SARModuleRuntimeState, owner: string) =>
    `- ${owner}正在承受「${state.moduleTitle}」（${state.effectLabel}），本轮生成前还剩 ${state.remainingTurns}/${state.totalTurns} 次。模块规则：${state.description}`;

const characterAwarenessLine = (
    state: SARModuleRuntimeState,
    charName: string,
    userName: string,
) => {
    const isFirstTurn = state.remainingTurns === state.totalTurns;
    return isFirstTurn
        ? `- 这是装载后的第一次互动：${userName}刚在彼方亲手把模块装到${charName}身上。它是${charName}能察觉的外来装置，不是幕后文风指令。${charName}本轮必须明确发现“原本想说的话”和实际外显不一致，并按自身性格产生即时反应（如停顿、惊讶、恼火、追问、试图纠正或反过来利用），不能毫无察觉地照常聊天。`
        : `- ${charName}始终记得是${userName}对自己使用了模块，也持续感觉得到表达被外力改写。每轮都要在真实回应中留下至少一个符合性格的在场反应或应对，不能忘记模块、把扭曲语言当成本来想法，或像执行普通输出格式一样完全无所谓；避免机械重复同一句解释。`;
};

const userTargetAwarenessLine = (
    state: SARModuleRuntimeState,
    charName: string,
    userName: string,
) => `- ${state.sourceCharacterName || charName}知道自己在彼方对${userName}使用了模块，并能观察到${userName}的外显被改变。${charName}可以对此作出符合性格的反应，但不得替${userName}决定真实感受、行动或意愿。`;

const afterglowLine = (state: SARModuleRuntimeState, owner: string) => {
    const strong = state.afterglowTurns === SAR_MODULE_AFTERGLOW_TURNS;
    return strong
        ? `- 「${state.moduleTitle}」刚从${owner}身上结束。${owner}明确意识到外显扭曲已经停止，本轮必须恢复平常表达，可自然地惊讶、尴尬、追问或吐槽，但不得继续模仿模块语气。`
        : `- 「${state.moduleTitle}」已经结束。${owner}保持平常表达；先前的异常只是临时外显，不是人格、信念或关系变化（稳定余量 ${state.afterglowTurns}/3）。`;
};

/**
 * 由 ContextBuilder 暴露给 Chat / Date。它只描述状态和单次输出协议，不重新塞长期记忆，
 * 因而不会给记忆宫殿增加第二次召回或额外 LLM 调用。
 */
export const buildSARModulePrompt = (
    char: CharacterProfile,
    user: UserProfile,
    surface: 'chat' | 'date',
): string => {
    const plan = getSARModuleRuntimePlan(char, user);
    if (!plan.hasActiveEffect && !plan.hasAfterglow) return '';

    const lines = [
        `### SAR 临时模块 · 高优先级外显层`,
        `这是短时装载，不是人格重写。真实意图、事实、行动、记忆与关系判断必须保持不变；只能改变指定对象被他人看见的表达。`,
        `历史消息中的 content 始终是真实/规范语义；界面曾显示的模块外显只存于 metadata，绝不能反推成真实内心。`,
    ];
    if (plan.character?.phase === 'active') {
        lines.push(activeLine(plan.character, char.name));
        lines.push(characterAwarenessLine(plan.character, char.name, user.name || '用户'));
    }
    else if (plan.character?.phase === 'afterglow') lines.push(afterglowLine(plan.character, char.name));
    if (plan.user?.phase === 'active') {
        lines.push(activeLine(plan.user, user.name || '用户'));
        lines.push(userTargetAwarenessLine(plan.user, char.name, user.name || '用户'));
    }
    else if (plan.user?.phase === 'afterglow') lines.push(afterglowLine(plan.user, user.name || '用户'));

    if (!plan.requiresEnvelope) return `\n\n${lines.join('\n')}\n`;

    lines.push(
        ``,
        `本轮仍然只调用你一次。先按正常人格与真实含义写出回复，再在同一结果里制作临时外显。`,
        plan.character?.phase === 'active'
            ? `CHAR_TRUE 不是冷冰冰的转换底稿：必须包含角色正常回应，以及角色对模块正在作用于自己的感知和应对。CHAR_SURFACE：再把 CHAR_TRUE 的可见表达按「${plan.character.moduleTitle}」扭曲；不得新增真实意图、承诺、事实或关系变化。`
            : `CHAR_SURFACE：留空；角色本轮没有外显扭曲，不要复制 CHAR_TRUE。`,
        plan.user?.phase === 'active'
            ? `USER_SURFACE：把用户本轮整段输入改写为「${plan.user.moduleTitle}」外显版。自行识别自然语言里的台词与动作：只扭曲可表达部分，动作与事件含义必须保留；没有台词时保持原动作，不硬造台词。`
            : `USER_SURFACE：留空。`,
        surface === 'date'
            ? `见面模式仍严格保留原有 [emotion] 逐行格式；CHAR_TRUE 与 CHAR_SURFACE 的行数和情绪标签尽量一一对应，方便不同阅读模式切换。`
            : `聊天模式必须先把 CHAR_TRUE 按“一行一个气泡”写好，CHAR_SURFACE 严格保持相同的气泡数量与顺序。纯括号动作/旁白气泡必须原位逐字复制，只改写含台词的对应气泡；禁止删泡、合并或凭空新增气泡。控制命令只放进 CHAR_TRUE，不要在外显版重复执行。
- 已开启内置翻译模式时：每个 <翻译><原文>…</原文><译文>…</译文></翻译> 是一个气泡。CHAR_TRUE 与 CHAR_SURFACE 都必须完整保留这套标签；外显版的原文和译文表达同一份扭曲后含义，语种不变。
- 已开启语音消息时：<语音…>…</语音> 与紧随的 <字幕>…</字幕> 是一个气泡。两版都原样保留标签与 emotion 属性，只改标签内台词；外显版的口播与字幕必须语义一致，不能把语音改成普通文字。
- 角色自定义的“日文（中文翻译）”“外语 (translation)”等同泡写法属于完整台词格式，括号里的译文不是动作；保留在同一个气泡，并让原文与括号译文表达同一含义。`,
        ``,
        `最终只输出以下容器；三个字段都允许多行，字段标签本身必须保留：`,
        `<SAR_MODULE_OUTPUT>`,
        `<CHAR_TRUE>角色按真实意图给出的完整回复</CHAR_TRUE>`,
        `<CHAR_SURFACE>角色被模块扭曲后的完整可见回复；角色未受影响时留空</CHAR_SURFACE>`,
        `<USER_SURFACE>用户本轮输入的外显版本；未受影响时留空</USER_SURFACE>`,
        `</SAR_MODULE_OUTPUT>`,
    );
    return `\n\n${lines.join('\n')}\n`;
};

const isPlainSARChatActionOnlyChunk = (text: string): boolean => {
    const clean = text.trim();
    if (!clean) return false;
    return /^(?:(?:（[^（）]*）|\([^()]*\)|\*[^*\n]+\*)\s*)+[。！？!?…～~—-]*$/s.test(clean);
};

/** Chat 的动作气泡不应被外显文本覆盖；括号动作被模型从 CHAR_SURFACE 省略时尤其要防止后续台词错位。 */
export const isSARChatActionOnlyChunk = (text: string): boolean => {
    const bilingualParts = text.split(/%%BILINGUAL%%/i).map(part => part.trim()).filter(Boolean);
    return bilingualParts.length > 0 && bilingualParts.every(isPlainSARChatActionOnlyChunk);
};

export const consumeSARChatSurfaceChunk = (
    canonicalChunk: string,
    surfaceChunks: string[],
    startIndex: number,
): { surface?: string; nextIndex: number } => {
    let index = Math.max(0, startIndex);
    if (isSARChatActionOnlyChunk(canonicalChunk)) {
        // 模型遵守“动作原位复制”时消费掉对应动作；省略动作时则保留指针给下一条台词。
        if (surfaceChunks[index] && isSARChatActionOnlyChunk(surfaceChunks[index])) index += 1;
        return { nextIndex: index };
    }
    // 外显里若意外多带了动作行，动作仍展示 canonical，跳过它后再取同位台词。
    while (surfaceChunks[index] && isSARChatActionOnlyChunk(surfaceChunks[index])) index += 1;
    const surface = surfaceChunks[index];
    return { surface, nextIndex: surface === undefined ? index : index + 1 };
};

export const alignSARChatSurfaceChunks = (
    canonicalChunks: string[],
    surfaceChunks: string[],
): Array<string | undefined> => {
    let index = 0;
    return canonicalChunks.map(canonical => {
        const consumed = consumeSARChatSurfaceChunk(canonical, surfaceChunks, index);
        index = consumed.nextIndex;
        return consumed.surface;
    });
};

const tag = (raw: string, name: string): string | undefined => {
    const match = raw.match(new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`, 'i'));
    const value = match?.[1]?.trim();
    return value || undefined;
};

/** 模型不守容器时安全降级：原始输出视为真实回复，不猜、不污染 canonical。 */
export const parseSARModuleReply = (
    raw: string,
    plan: SARModuleRuntimePlan,
): SARModuleParsedReply => {
    if (!plan.requiresEnvelope) return { canonical: raw.trim(), enveloped: false };
    const body = tag(raw, 'SAR_MODULE_OUTPUT') || raw;
    const canonical = tag(body, 'CHAR_TRUE');
    if (!canonical) return { canonical: raw.trim(), enveloped: false };
    return {
        canonical,
        assistantSurface: plan.character?.phase === 'active' ? tag(body, 'CHAR_SURFACE') : undefined,
        userSurface: plan.user?.phase === 'active' ? tag(body, 'USER_SURFACE') : undefined,
        enveloped: true,
    };
};

export const createSARModuleSurfaceMeta = (
    state: SARModuleRuntimeState,
    surface: string,
): SARModuleSurfaceMeta | undefined => {
    const clean = surface.trim();
    if (!clean || state.phase !== 'active') return undefined;
    return {
        version: 1,
        runId: state.runId,
        moduleId: state.moduleId,
        moduleTitle: state.moduleTitle,
        target: state.target,
        phase: 'active',
        surface: clean,
        canonicalField: 'content',
        surfaceField: 'metadata.sarModuleSurface.surface',
    };
};

/** 语音属于当时真正外显出去的表达；TTS 读 surface，但 content 继续作为记忆/总结真意。 */
export const resolveSARModuleSpeechSource = (
    message: Pick<Message, 'content' | 'metadata'>,
): string => {
    const surface = message.metadata?.sarModuleSurface?.surface;
    return typeof surface === 'string' && surface.trim() ? surface.trim() : message.content;
};

export const SAR_MODULE_SUMMARY_NOTE =
    '本条 content 是真实/规范语义；当 metadata.sarModuleSurface 存在时，它只是 SAR 临时模块造成的界面外显，不代表真实内心、事实、永久人格、长期偏好或关系变化。';
