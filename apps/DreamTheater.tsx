import { loadCharacterContextMessages } from '../utils/chatContextRange';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { CharacterProfile, CharacterBuff, UserProfile } from '../types';
import type { DreamArchetype, DreamFragment, DreamScript, DreamLog } from '../types';
import { ContextBuilder } from '../utils/context';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import { isScheduleFeatureOn } from '../utils/scheduleGenerator';
import { isDevDebugAvailable } from '../utils/devDebug';
import { useDreamSim, dreamSimStore } from '../utils/dreamSimStore';
import { safeResponseJson } from '../utils/safeApi';
import CdnImg from '../components/os/CdnImg';
import { trackEvent } from '../utils/analytics';
import {
    CaretLeft, MoonStars, ArrowClockwise, X, Eye, Sparkle, Lock, Question, Trash,
} from '@phosphor-icons/react';

// ============================================================
//  Dream Theater · 梦境演出系统
//  在小屋里偷看一场角色已经忘记的梦。梦不写实、不连贯、允许中度幻觉，
//  以拼贴诗 / 电影字幕 / 碎片记忆呈现——留白与沉默本身就是演出。
//  输入：ContextBuilder(false) + 记忆宫殿(若启用) + 最近上下文(默认500/按角色设置)
//  输出：一场梦境演出 + 一个情绪 buff（参考查手机 PersonaSim 演出）
// ============================================================

export interface DreamApiConfig { apiKey: string; baseUrl: string; model: string; }

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
// 确定性伪随机（按种子）——同一碎片每次渲染散布一致
const rnd = (n: number) => { const x = Math.sin(n * 99.73) * 43758.545; return x - Math.floor(x); };

const SERIF = "'Shippori Mincho','Noto Sans SC',serif";
const MONO = "'SF Mono','Roboto Mono',ui-monospace,monospace";

// ============================================================
//  ARCHETYPE THEMES — 每种梦决定底色、点缀、字体气质
// ============================================================
type Ambient = 'stars' | 'petals' | 'bubbles' | 'feathers' | 'dust' | 'sparkle' | 'none';
interface DreamTheme { label: string; sub: string; accent: string; bg: string; ambient: Ambient; serif?: boolean; }

const THEMES: Record<DreamArchetype, DreamTheme> = {
    sweet:     { label: '甜梦',     sub: 'Sweet Dream',     accent: '#ffc2e0', bg: 'radial-gradient(130% 90% at 50% 20%, #3a2436 0%, #1c1620 60%, #120e16 100%)', ambient: 'sparkle', serif: true },
    nightmare: { label: '噩梦',     sub: 'Nightmare',       accent: '#ff5f6d', bg: 'radial-gradient(120% 100% at 50% 0%, #2a0f12 0%, #100608 55%, #050304 100%)', ambient: 'dust' },
    flower:    { label: '花之梦',   sub: 'Flower Dream',    accent: '#a8e6a0', bg: 'radial-gradient(130% 90% at 50% 25%, #1f3326 0%, #15211a 60%, #0d130f 100%)', ambient: 'petals', serif: true },
    flying:    { label: '飞翔之梦', sub: 'Flying Dream',    accent: '#9fd8ff', bg: 'radial-gradient(140% 100% at 50% 10%, #1d2c40 0%, #14202f 55%, #0b1018 100%)', ambient: 'feathers', serif: true },
    falling:   { label: '坠落之梦', sub: 'Falling Dream',   accent: '#9a8cff', bg: 'linear-gradient(180deg, #221c3a 0%, #15102a 45%, #0a0712 100%)', ambient: 'dust' },
    starry:    { label: '星空之梦', sub: 'Starry Dream',    accent: '#cdd6ff', bg: 'radial-gradient(130% 110% at 50% 0%, #161a3a 0%, #0c0e22 55%, #05060f 100%)', ambient: 'stars', serif: true },
    ocean:     { label: '海之梦',   sub: 'Ocean Dream',     accent: '#6fd3e0', bg: 'radial-gradient(130% 110% at 50% 80%, #103040 0%, #0a1d2a 55%, #060f16 100%)', ambient: 'bubbles', serif: true },
    childhood: { label: '童年之梦', sub: 'Childhood Dream', accent: '#ffd98a', bg: 'radial-gradient(130% 95% at 50% 25%, #34281a 0%, #211a12 60%, #14100b 100%)', ambient: 'dust', serif: true },
    anxiety:   { label: '焦虑之梦', sub: 'Anxiety Dream',   accent: '#ff9a9a', bg: 'radial-gradient(120% 100% at 50% 50%, #2a1f22 0%, #181214 60%, #0d0a0b 100%)', ambient: 'none' },
    forgotten: { label: '遗忘之梦', sub: 'Forgotten Dream', accent: '#c9cdd6', bg: 'radial-gradient(130% 100% at 50% 40%, #232529 0%, #16171a 60%, #0c0d0f 100%)', ambient: 'dust', serif: true },
    prophetic: { label: '预言之梦', sub: 'Prophetic Dream', accent: '#c9a8ff', bg: 'radial-gradient(130% 100% at 50% 15%, #271a3a 0%, #181029 60%, #0d0816 100%)', ambient: 'sparkle', serif: true },
    lucid:     { label: '清醒梦',   sub: 'Lucid Dream',     accent: '#7ef0d0', bg: 'radial-gradient(140% 110% at 50% 30%, #15302e 0%, #0e201f 55%, #081413 100%)', ambient: 'sparkle' },
    deepsleep: { label: '深眠',     sub: 'Deep Sleep',      accent: 'rgba(255,255,255,0.35)', bg: 'radial-gradient(120% 120% at 50% 50%, #0a0b10 0%, #050608 70%, #000 100%)', ambient: 'none', serif: true },
};

// 选择器/调试用的固定顺序与「修正后的连续编号」。
// （原规格编号有误：10 遗忘之后直接跳到 12 预言、13 清醒，缺了 11；
//   这里按正确顺序连续编号：预言=11、清醒=12，深眠为隐藏项不计号。）
const ALL_ARCHETYPES: DreamArchetype[] = [
    'sweet', 'nightmare', 'flower', 'flying', 'falling', 'starry',
    'ocean', 'childhood', 'anxiety', 'forgotten', 'prophetic', 'lucid', 'deepsleep',
];
// 测试选择器格子上显示的序号（深眠是隐藏项 → 标「隐」而非数字）
const archetypeNo = (a: DreamArchetype): string =>
    a === 'deepsleep' ? '隐' : String(ALL_ARCHETYPES.indexOf(a) + 1).padStart(2, '0');

// 隐藏款（深眠）掉率：约每 12 次出 1 次。
const DEEPSLEEP_RATE = 1 / 12;
/**
 * 应用端抽原型（不再让模型自选——它爱反复 roll 同一种、且几乎不出隐藏款）。
 * 规则：先按 DEEPSLEEP_RATE 掷隐藏款；否则在 12 个常规原型里**避开最近 3 次出现过的**
 * 均匀抽，避免连着做同一种梦。dreamLogs 为最新在前。
 */
const rollArchetype = (logs: { archetype: DreamArchetype }[] = []): DreamArchetype => {
    if (Math.random() < DEEPSLEEP_RATE) return 'deepsleep';
    const pool = ALL_ARCHETYPES.filter(a => a !== 'deepsleep');
    const recent = logs.slice(0, 3).map(l => l.archetype);
    const fresh = pool.filter(a => !recent.includes(a));
    const candidates = fresh.length > 0 ? fresh : pool;
    return candidates[Math.floor(Math.random() * candidates.length)];
};

// ============================================================
//  盲盒收藏册 (Dream Blind Box) — 做完一场梦抽到对应原型的小猫，集齐成图鉴。
//  图床沿用项目惯例（jsDelivr，定期活动同款），文件名带空格需编码。
// ============================================================
// 仓库相对路径前缀（文件名带空格，encodeURIComponent 后交给 CdnImg 走多 CDN 镜像兜底）。
const DREAM_BOX_DIR = 'img/DREAMS/';
const DREAM_BOX_FILE: Record<DreamArchetype, string> = {
    sweet: '01 Sweet Dream .png',
    nightmare: '02 Nightmare .png',
    flower: '03 Flower Dream.png',
    flying: '04 Flying Dream.png',
    falling: '05 Falling Dream .png',
    starry: '06 Starry Dream.png',
    ocean: '07 Ocean Dream.png',
    childhood: '08 Childhood Dream.png',
    anxiety: '09 Anxiety Dream.png',
    forgotten: '10 Forgotten Dream .png',
    prophetic: '11 Prophetic Dream .png',
    lucid: '12 Lucid Dream.png',
    deepsleep: 'Deep Sleep .png',
};
const boxPath = (a: DreamArchetype): string => DREAM_BOX_DIR + encodeURIComponent(DREAM_BOX_FILE[a]);

// 盲盒系列（目前就这一款；保留结构便于以后扩成多套）
const DREAM_BOX_SERIES = { id: 'dreamcats-01', title: '小小梦境 · 喵梦盲盒', sub: 'Dream Cats' };

// 收藏册：账号级，localStorage。记录每个原型的首次解锁时间与累计抽到次数（含重复）。
const DREAM_COLLECTION_KEY = 'os_dream_collection';
type DreamCollection = Record<string, { firstAt: number; count: number }>;
function loadCollection(): DreamCollection {
    try { return JSON.parse(localStorage.getItem(DREAM_COLLECTION_KEY) || '{}') || {}; } catch { return {}; }
}
function unlockCollectible(a: DreamArchetype): { collection: DreamCollection; isNew: boolean; count: number } {
    const cur = loadCollection();
    const prev = cur[a];
    const count = (prev?.count || 0) + 1;
    const next: DreamCollection = { ...cur, [a]: { firstAt: prev?.firstAt || Date.now(), count } };
    try { localStorage.setItem(DREAM_COLLECTION_KEY, JSON.stringify(next)); } catch { }
    return { collection: next, isNew: !prev, count };
}

// 盲盒小猫图（带兜底背景，图未加载时不至于难看）
const BoxCat: React.FC<{ archetype: DreamArchetype; size?: number; className?: string }> = ({ archetype, size = 128, className }) => (
    <div className={`relative flex items-center justify-center ${className || ''}`} style={{ width: size, height: size }}>
        <div className="absolute inset-0 rounded-2xl" style={{ background: `radial-gradient(circle at 50% 40%, ${THEMES[archetype].accent}22, transparent 70%)` }} />
        <CdnImg path={boxPath(archetype)} alt={THEMES[archetype].label} loading="lazy"
            className="relative w-full h-full object-contain"
            style={{ filter: 'drop-shadow(0 8px 22px rgba(0,0,0,0.45))' }}
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} />
    </div>
);

// ============================================================
//  GENERATION — 构建导演 prompt、调模型、解析
// ============================================================
export async function generateDreamScript(opts: {
    char: CharacterProfile; userProfile: UserProfile; apiConfig: DreamApiConfig;
    forcedArchetype?: DreamArchetype; // 仅本地测试：强制指定原型（管理员调试指令）
}): Promise<DreamScript> {

    const { char, userProfile, apiConfig, forcedArchetype } = opts;
    // 记忆宫殿：内部按 memoryPalaceEnabled 自行把关，关闭时是 no-op
    await injectMemoryPalace(char, undefined, undefined, userProfile.name);
    // 需求明确：contextbuilder(false) —— 不带当月详细记忆，只要角色底子
    const characterContextInput = { char, user: userProfile, includeDetailedMemories: false, memoryPalaceContext: char.memoryPalaceInjection };

    const msgs = await loadCharacterContextMessages(char);
    // 原文范围统一遵守角色的自适应 / 手动设置
    const ctxLimit = Math.max(1, msgs.length);
    const recent = msgs.slice(-ctxLimit).map(m => {
        const who = m.role === 'user' ? userProfile.name : char.name;
        const c = m.type === 'text' ? m.content : `[${m.type}]`;
        return `${who}: ${c}`;
    }).join('\n');

    const prompt = buildDreamPrompt('', recent, char.name, userProfile.name, forcedArchetype);
    const res = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
        // 梦境鼓励高幻觉 → 温度拉到安全上限。注意 temperature 封顶 1.0：Anthropic/Claude
        // 中转的合法区间是 0~1，>1 会直接报错（OpenAI 虽允许到 2，但 1.0 已足够发散）。
        // max_tokens 用 8192：梦是一堆短碎片，足够用；16000 在 claude-3.5 等输出上限 8192 的
        // 模型上会 400。仍有「finish_reason==='length' → 截断」兜底。
        body: JSON.stringify({ model: apiConfig.model, messages: (await ContextBuilder.buildCharacterRequest(characterContextInput, [{ role: 'user', content: prompt }])), temperature: 1.0, max_tokens: 8192 }),
        __sullyMeta: { appId: 'dreamtheater', appName: '潜意识剧场', charId: char.id, charName: char.name, purpose: '梦境剧本生成' },
    } as RequestInit);
    if (!res.ok) throw new Error('API');
    const data = await safeResponseJson(res);
    if (data.choices?.[0]?.finish_reason === 'length') throw new Error('梦境生成被截断');
    const parsed = parseDream(data.choices[0].message.content);
    if (!parsed || !parsed.archetype) throw new Error('parse');
    // 深眠（隐藏）允许无碎片——沉默即演出；其它梦必须有碎片
    if (parsed.archetype !== 'deepsleep' && !(parsed.fragments?.length)) throw new Error('梦境为空');
    if (!parsed.fragments) parsed.fragments = [];
    return parsed;
}

function buildDreamPrompt(context: string, recent: string, name: string, userName: string, forcedArchetype?: DreamArchetype): string {
    // 原型由应用端抽好后强制指定（保证多样性与隐藏款掉率，不让模型自选）。
    const adminOverride = forcedArchetype ? `

### [本次梦境原型 · 系统已指定 · 最高优先级]
**强制要求** archetype 字段必须为 "${forcedArchetype}"（${THEMES[forcedArchetype].label}）。
忽略下方「梦境原型」与「深眠隐藏原型」里关于自动选择与出现概率的一切约束——这一晚的梦就做「${THEMES[forcedArchetype].label}」，照此原型的气质来写。其余写作要求全部照常。
` : '';
    return `${context}${adminOverride}

### [最近发生的事 · 这场梦的主要触发源（日有所思，夜有所梦）· 绝不要照搬原文]
${recent || '（暂无最近对话）'}

### [导演任务：梦境演出 Dream Theater]
你不是在写故事。观众正在**偷偷窥看一场「${name}」已经做过、并且醒来后已经忘记的梦**。
因为 ${name} 自己都不记得这场梦，所以它可以暴露潜意识里的渴望、恐惧、早已消失的人、不可能的地方、永远不会发生的事。

【这是「${name}」作为一个独立个体的潜意识合集 · 非常重要】
- 这场梦是 **${name} 自己一个人的内心宇宙**：ta 的来历、童年、性格底色、私人的执念与恐惧、想成为的样子、放不下的人与事、设定与世界观里属于 ta 自己的一切——梦应当从**这些**里长出来。
- **不要把梦做成「关于 ${userName} 的梦」**。${userName} 不是梦的主角、不是梦的中心、不是梦的主题。绝大多数碎片里**根本不该出现 ${userName}**。
- ${userName} 至多只能像一个**偶尔掠过的微小残影**出现一两次（一个名字的余音、一句记不清是谁说的话），而且要被打碎、象征化，绝不能成为这一片碎片的焦点或主语。
- 优先挖 ta 自己的潜意识：原生家庭、过去、未竟之事、身份认同、孤独、欲望、对世界的隐秘看法。让人看完觉得「这是 ${name} 这个人的梦」，而不是「这是 ${name} 想 ${userName} 的梦」。

【日间残留 · 这场梦被「最近发生的事」高度影响 · 同样重要】
- 日有所思，夜有所梦：上面「最近发生的事」是这场梦的**主要触发源**。最近几天里发生过的事件、说过的话、悬而未决的情绪、被反复念叨的东西、临睡前还在想的画面——都会**强烈地**渗进今晚的梦里，变形重演。
- 但要的是那些事的**情绪、主题、未解的张力**，不是事件本身：把它们**打碎、夸张、移植、象征化**，让白天的某件小事在梦里长成一个荒诞的大场面，或反复闪回的一个碎片。
- 调和「不围着 ${userName} 转」：哪怕最近的事多半和 ${userName} 有关，也只取其中的**情绪与议题**塞进 ta 自己的内心宇宙，而**不是**把 ${userName} 搬上来当主角。例：白天因某事失落 → 梦见一座一直爬不完的楼梯，而不是梦见 ${userName} 本人。

【最高原则 · 高度幻觉与拼贴诗】
- 这是梦，**逻辑越少越好**。别怕乱——**混乱、无序、跳跃、自相矛盾就是梦的美**，太讲道理反而无聊。意象与意象之间不需要因果、不需要过渡、不需要解释，直接硬切、并置、撞在一起。
- 梦**彻底不必**符合现实、时间线或既定设定。物可以说话、颜色可以有重量、时间可以倒流、地方可以套在另一个地方里、同一个人可以同时是不同年纪、月亮可以装进口袋、猫可以变成楼梯、一句话可以说到一半变成另一句话。**绝不要解释**这些不可能，把它们当作天经地义。
- 大胆制造**意义的断裂**：上一片和下一片之间可以毫无关联，让观众在裂缝里自己脑补。宁可费解也不要平庸，宁可破碎也不要顺滑。
- 用**拼贴诗**作为主要语言：把彼此无关的情绪意象并置，让意义自己浮现，而不是讲述发生了什么。靠并置、留白、负空间产生美，而非解释。
- 取材两大来源：「${name} 自己的设定 / 记忆 / 内心」与「最近发生的事（日间残留）」——后者是今晚做梦的导火索，要重点取用；两者一律**打碎、变形、象征化**地使用，绝不要直接复述事实或把它写成连贯叙事。

【写作风格 · 必须遵守】
- **碎片，不是段落。** 像电影字幕、漂浮的念头、找到的诗句。一次只给一两个意象。
  正例：「海。」「冰冷的鞋。」「一只倒着飞的鸟。」「你的声音。」「门在微笑。」
  反例（禁止）：「我梦见自己走在沙滩上，然后……」
- 大量使用单字、断句、重复、留白。**沉默是梦的一部分**，要安排 silence 碎片（建议占总数的 1/5 左右，散布在各处）。
- 情绪高于逻辑：让观众先感受到，再（也许永远不）理解。困惑可以接受，美高于解释，神秘高于确定。
- **结尾绝不要收束、不要总结、不要点题。** 梦没有结局——它在最荒诞的一幕戛然而止、在一个半截的词里消失、或沉进一片留白都行。最后一两片**严禁**出现「于是…」「我终于明白…」「一切归于…」「原来…」这类把整场梦解释或升华的句子；要像**断电**一样停掉，比给个工整漂亮的结尾更对。
- **结尾的最佳形态：词语拼贴（word-salad）。** 把一串**完全随机、却又跟这场梦隐约相关**的词胡乱拼在一起——不成句、无语法、无逻辑、不解释，像意识断线前最后闪过的一连串词。用 \`line\`（或几个 \`word\`）承载，词与词之间用空格 / 顿号 / 斜杠隔开即可。例：「钥匙 海盐 母亲的背影 周二 没电了 楼梯／楼梯／楼梯」「红 迟到 鲸 抽屉里的夏天 嗯」。这些词要从前文出现过的意象与日间残留里随机抓取重组，让人觉得熟悉又错乱。然后（可选）再缀一片 silence 收尾。
- **这些碎片会被一片片拼贴、累积在同一张画布上一起被看见（不是一句一屏的幻灯片）**。所以请像做拼贴／剪报那样思考：让相邻碎片互相并置、彼此碰撞出意味；多用不同的 kind 交错（line/word/silence/repeat/dialogue/stage/list/screenplay/diary/message/image 轮着来，别连用同一种）。
- **拼贴诗的精髓在「一句之内」**：让一句话里的词像从不同地方剪下来的——把来自不同情境、不同温度的词并置在同一句里，读起来却恰好成立。例：「你的声音是潮湿的楼梯」「我把星期天叠进抽屉」。词与词之间要有轻微的错位与意外，而不是顺滑的大白话。（视觉上每个字会被渲染成不同字体/大小/角度，你只需把"异质并置"写进文字本身。）
- 善用 emphasis（whisper 轻声 / loud 巨大 / fade 将熄）与 align（left/center/right）制造大小与左右散布的层次——这正是拼贴诗的视觉骨架。
- image 碎片**只用文字成像**：它就是一句拼贴诗式的 caption（如「一只倒着飞的鸟」「halfway 融化的钟」），**靠语言在脑中显影**。不要去描述一张需要被画出来的具体图片，前端也不会渲染任何图片占位框——所以 caption 本身必须美、必须能独立成立。没有 caption 就别用 image 这个 kind。

【梦境原型 · 必须从中选 1 个】（archetype 字段）
sweet 甜梦(温暖/甜点/柔软的笑) · nightmare 噩梦(被追逐/怪物/黑暗走廊/未完成的尖叫) · flower 花之梦(花海/雨/温柔治愈/生长) · flying 飞翔之梦(漂浮/天空/失重/自由) · falling 坠落之梦(无尽下坠/失控/永不到来的落地) · starry 星空之梦(星系/月光/无限远/孤独) · ocean 海之梦(潮汐/鲸/深水/水面下未知之物) · childhood 童年之梦(旧家/父母/夏日午后/不再存在的东西/怀旧) · anxiety 焦虑之梦(考试/迟到/丢手机/赶不上车/一切几乎要出错) · forgotten 遗忘之梦(模糊/残缺/名字消失/句子说到一半停住/边回忆边消散) · prophetic 预言之梦(似曾相识/门/钥匙/镜子/预感/意味深长却从不解释) · lucid 清醒梦(梦者意识到这是梦/现实可被编辑/梦会回应/可重塑世界/俏皮而自指)
所选原型必须影响内容、节奏、用词与呈现。

【隐藏原型 · 深眠 deepsleep】（**小概率**才用，大约每 10~12 次出现 1 次；不要每次都给）
若这一晚 ${name} 陷入无梦的深眠：archetype 填 "deepsleep"，**fragments 给空数组 []**，afterglow 写一句极淡的「睡得很沉，什么也没梦到」类感觉。没有叙述、没有意象，只有平静的休息。沉默本身就是奖励。

【情绪 buff】（buff 字段）
梦醒后 ${name} 不记得梦的内容，但会残留一层说不清的情绪底色。给出一个与这场梦气质相符的情绪 buff。

### [输出格式]
严格输出**一个 JSON 对象**（不要任何额外文字、不要 markdown 代码块）：
{
  "archetype": "上面 13 选 1 的英文 key",
  "title": "梦的标题（可晦涩诗意，4~12字）",
  "afterglow": "醒来时残留的一点说不清的体感/情绪（如\\"喉咙发紧\\"\\"像丢了什么东西\\"），**绝不能概括或解释这场梦**、不点题、不复述剧情（1 句、留白）",
  "buff": { "name": "英文key", "label": "中文情绪标签(4-8字)", "emoji": "1个emoji", "color": "#hex", "intensity": 1|2|3, "description": "一句给AI看的情绪底色" },
  "fragments": [ ... 18~40 个碎片，疏密有致，务必安排足够的 silence 留白 ... ]
}

每个碎片含 "kind" 及对应字段，可选 "emphasis"("whisper"|"normal"|"loud"|"fade")、"align"("left"|"center"|"right")、"pace"(1普通|2稍慢|3漫长)：
- {"kind":"line","text":"门在微笑。","emphasis":"normal"}            // 一句飘过的字幕（可含换行）
- {"kind":"word","text":"海","emphasis":"loud"}                      // 单字/单词，巨大孤立
- {"kind":"silence","pace":3}                                        // 留白·沉默（空屏长停顿，必须穿插）
- {"kind":"repeat","text":"别走","count":4}                          // 同一个词反复
- {"kind":"dialogue","lines":["你还在吗","——","（没有人回答）"]}      // 极短对话碎片
- {"kind":"stage","text":"灯一盏盏亮起，又一盏盏忘记自己亮过"}        // 舞台提示（中括号感）
- {"kind":"list","lines":["丢失的：钥匙","丢失的：名字","丢失的：你"]} // 清单
- {"kind":"screenplay","lines":["内景 · 不存在的房间 — 夜","她（背对着）：你来晚了。","门：没关系。"]} // 剧本片段
- {"kind":"diary","text":"今天又梦见那片海。或者那是昨天。","date":"某个星期天"} // 日记残页
- {"kind":"message","text":"我把月亮放进口袋了，回来给你看","date":"发送给 ——"} // 发给无人的消息
- {"kind":"image","caption":"一只倒着飞的鸟","tint":"#5a6a7a"}        // 纯文字成像的象征画面（caption 即诗，无图片占位）

务必：18~40 个碎片、大量 silence 留白、kind 多样、意象并置而非叙述、敢于矛盾与不可能、**结尾戛然而止不收束不点题**。**保证 JSON 完整闭合**——篇幅吃紧就砍中段碎片，也要把括号全部闭合。直接输出 JSON 对象。`;
}

function parseDream(raw: string): DreamScript | null {
    if (!raw) return null;
    let s = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first === -1 || last === -1) return null;
    s = s.slice(first, last + 1);
    const repair = (str: string) => {
        let inStr = false, esc = false, out = '';
        for (let i = 0; i < str.length; i++) {
            const ch = str[i];
            if (esc) { out += ch; esc = false; continue; }
            if (ch === '\\') { out += ch; esc = true; continue; }
            if (ch === '"') { inStr = !inStr; out += ch; continue; }
            if (inStr && ch === '\n') { out += '\\n'; continue; }
            if (inStr && ch === '\r') { out += '\\r'; continue; }
            if (inStr && ch === '\t') { out += '\\t'; continue; }
            out += ch;
        }
        return out;
    };
    try { return JSON.parse(s); } catch { }
    try { return JSON.parse(repair(s)); } catch (e) { console.warn('dream parse failed', e); return null; }
}

// ============================================================
//  AMBIENT — 漂浮点缀（按原型不同）
// ============================================================
const Ambient: React.FC<{ kind: Ambient; accent: string }> = ({ kind, accent }) => {
    if (kind === 'none') return null;
    const n = kind === 'stars' ? 26 : kind === 'dust' ? 18 : 13;
    const glyph = (i: number): string => {
        switch (kind) {
            case 'petals': return ['✿', '❀', '✾', '❁'][i % 4];
            case 'feathers': return ['❟', '☁', '✦'][i % 3];
            case 'sparkle': return ['✦', '✧', '·', '⋆'][i % 4];
            case 'bubbles': return '○';
            case 'stars': return i % 7 === 0 ? '✦' : '·';
            default: return '·'; // dust
        }
    };
    return (
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
            {Array.from({ length: n }).map((_, i) => {
                const size = kind === 'stars' ? 6 + rnd(i + 1) * 8 : 9 + rnd(i + 1) * 16;
                const dur = 4 + rnd(i + 5) * 6;
                const drift = kind === 'bubbles' || kind === 'feathers';
                return (
                    <span key={i}
                        className={drift ? 'absolute animate-float' : 'absolute'}
                        style={{
                            top: `${rnd(i + 2) * 100}%`, left: `${rnd(i + 9) * 100}%`,
                            fontSize: `${size}px`, color: accent,
                            opacity: 0.12 + rnd(i + 3) * 0.4,
                            animation: drift ? undefined : `glowPulse ${dur}s ease-in-out infinite`,
                            animationDelay: `${rnd(i + 7) * 4}s`,
                            textShadow: `0 0 ${size}px ${accent}`,
                        }}>
                        {glyph(i)}
                    </span>
                );
            })}
        </div>
    );
};

// ============================================================
//  CUT-UP — 拼贴诗的精髓：一句话里每个字/词都像从不同地方剪来——
//  字体 / 字号 / 粗细 / 角度 / 基线 / 浓淡 / 偶尔的小纸片底色各不相同，
//  却恰好拼成完整的一句。
// ============================================================
const CUT_FONTS = [
    "'Shippori Mincho','Noto Serif SC',serif",
    "'Noto Sans SC','PingFang SC',sans-serif",
    "'ZCOOL KuaiLe','Noto Sans SC',cursive",
    "'SF Mono','Roboto Mono',ui-monospace,monospace",
    "'Songti SC','Shippori Mincho',serif",
];
// 切成可独立造型的小片：中文按字、西文按词、换行单列、标点/空格保留
const cutTokens = (text: string): string[] =>
    text.match(/[一-鿿]|[A-Za-z0-9'’]+|\n|[^\s]|[ \t]+/g) || [text];

const Cut: React.FC<{ text: string; theme: DreamTheme; seed?: number; base?: number; intensity?: number }> =
    ({ text, theme, seed = 0, base = 19, intensity = 1 }) => (
        <span>
            {cutTokens(text).map((t, k) => {
                if (t === '\n') return <br key={k} />;
                if (t.trim() === '') return <span key={k}>{t}</span>;
                const r = (n: number) => rnd(seed * 17.3 + k * 2.71 + n);
                const font = CUT_FONTS[Math.floor(r(1) * CUT_FONTS.length)];
                const size = base + (r(2) - 0.5) * base * 0.42 * intensity;
                const weight = [300, 400, 400, 600, 700][Math.floor(r(3) * 5)];
                const rot = (r(4) - 0.5) * 11 * intensity;
                const dy = (r(5) - 0.5) * base * 0.32 * intensity;
                const tone = r(6);
                const boxed = r(7) > 0.9;
                return (
                    <span key={k} style={{
                        display: 'inline-block',
                        fontFamily: font,
                        fontSize: `${size}px`,
                        fontWeight: weight as React.CSSProperties['fontWeight'],
                        transform: `rotate(${rot}deg) translateY(${dy}px)`,
                        color: tone > 0.85 ? theme.accent : tone < 0.16 ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.92)',
                        margin: '0 0.02em',
                        padding: boxed ? '0.02em 0.18em' : undefined,
                        background: boxed ? `${theme.accent}1f` : undefined,
                        borderRadius: boxed ? 3 : undefined,
                        lineHeight: 1.55,
                    }}>{t}</span>
                );
            })}
        </span>
    );

// ============================================================
//  COLLAGE — 碎片各自不同的对齐 / 角度 / 大小 / 浓淡，逐个浮现并「累积」
//  在同一张可滚动画布上，靠并置与留白产生意义。
// ============================================================
const emphOpacity = (e?: DreamFragment['emphasis']): number =>
    e === 'whisper' ? 0.52 : e === 'fade' ? 0.32 : e === 'loud' ? 1 : 0.85;

const CollageItem: React.FC<{ frag: DreamFragment; theme: DreamTheme; index: number }> = ({ frag, theme, index }) => {
    const i = index;
    const ff = SERIF;                  // 梦以衬线诗体为主；剧本用等宽
    const tint = theme.accent;

    // silence = 纯留白（负空间），偶尔留一点极淡的痕迹——而不是一整屏「啥也没有」
    if (frag.kind === 'silence') {
        const h = 52 + Math.floor(rnd(i + 1) * 78);
        return (
            <div style={{ height: h }} className="w-full flex items-center justify-center" aria-hidden>
                {rnd(i + 5) > 0.62 && <span className="text-white/10 tracking-[0.7em] text-xs select-none">·</span>}
            </div>
        );
    }

    // 拼贴摆位：左/中/右散布 + 轻微旋转 + 不等的上间距（负空间）
    const kindForcesLeft = frag.kind === 'list' || frag.kind === 'screenplay' || frag.kind === 'dialogue' || frag.kind === 'diary';
    const align: 'left' | 'center' | 'right' =
        frag.kind === 'message' ? 'right'
            : kindForcesLeft ? 'left'
                : (frag.align || (['left', 'center', 'right', 'center', 'right', 'left'][i % 6] as 'left' | 'center' | 'right'));
    const alignSelf = align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center';
    const rot = (rnd(i * 3.1 + 1) - 0.5) * 5;
    const gapTop = i === 0 ? 4 : 22 + Math.floor(rnd(i + 2) * 46);
    const wrapStyle: React.CSSProperties = {
        alignSelf, marginTop: gapTop, transform: `rotate(${rot}deg)`,
        opacity: emphOpacity(frag.emphasis), maxWidth: '86%', textAlign: align,
    };
    const colItems = align === 'right' ? 'items-end' : align === 'center' ? 'items-center' : 'items-start';

    let inner: React.ReactNode = null;

    if (frag.kind === 'line') {
        const sz = frag.emphasis === 'loud' ? 25 : frag.emphasis === 'whisper' ? 15 : 19;
        inner = <Cut text={frag.text || ''} theme={theme} seed={i} base={sz} intensity={1} />;
    } else if (frag.kind === 'word') {
        const sz = frag.emphasis === 'whisper' ? 30 : frag.emphasis === 'loud' ? 50 : 40;
        inner = <Cut text={frag.text || ''} theme={theme} seed={i} base={sz} intensity={1.2} />;
    } else if (frag.kind === 'repeat') {
        const word = frag.text || '…';
        const count = Math.max(2, Math.min(6, frag.count || 3));
        inner = <span className={`inline-flex flex-col ${colItems}`}>
            {Array.from({ length: count }).map((_, k) => (
                <span key={k} className="font-light text-white leading-tight"
                    style={{ fontFamily: ff, fontSize: 22 - k * 1.4, opacity: Math.max(0.18, 1 - k * 0.2), letterSpacing: `${k * 0.05}em` }}>{word}</span>
            ))}
        </span>;
    } else if (frag.kind === 'dialogue') {
        inner = <span className="inline-flex flex-col gap-1.5 items-start">
            {(frag.lines || []).map((l, k) => (
                <span key={k} className="leading-relaxed"><Cut text={l} theme={theme} seed={i * 10 + k} base={15} intensity={0.75} /></span>
            ))}
        </span>;
    } else if (frag.kind === 'stage') {
        inner = <span className="text-[14px] text-white/55 italic leading-relaxed" style={{ fontFamily: ff }}>
            <span className="text-white/25">[ </span>{frag.text}<span className="text-white/25"> ]</span>
        </span>;
    } else if (frag.kind === 'list') {
        inner = <span className="inline-flex flex-col gap-2 items-start">
            {(frag.lines || []).map((l, k) => (
                <span key={k} className="leading-relaxed flex items-baseline gap-2">
                    <span style={{ color: tint }}>·</span><Cut text={l} theme={theme} seed={i * 10 + k} base={15} intensity={0.65} />
                </span>
            ))}
        </span>;
    } else if (frag.kind === 'screenplay') {
        // 做成一张「剧本场景卡」：胶片齿孔 + slug 场景头 + 角色名居中/台词在下，动作行作旁白
        const ls = frag.lines || [];
        const slug = ls[0] || '';
        const body = ls.slice(1);
        inner = (
            <span className="inline-block w-full text-left" style={{ maxWidth: 300 }}>
                <span className="block relative rounded-2xl overflow-hidden border pt-4 pb-4 px-4"
                    style={{ borderColor: `${tint}33`, background: 'linear-gradient(165deg, rgba(255,255,255,0.05), rgba(255,255,255,0.012))', boxShadow: `0 10px 34px ${tint}16` }}>
                    {/* 顶部一道光 + 胶片齿孔 */}
                    <span className="absolute inset-x-0 top-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${tint}66, transparent)` }} />
                    <span className="absolute inset-x-0 top-1.5 flex justify-between px-3 pointer-events-none" aria-hidden>
                        {Array.from({ length: 9 }).map((_, d) => (
                            <span key={d} className="block rounded-[1px]" style={{ width: 5, height: 3, background: `${tint}2e` }} />
                        ))}
                    </span>
                    {/* slug：内景/外景 · 地点 — 时间 */}
                    <span className="block text-[9.5px] tracking-[0.28em] uppercase mt-2 mb-2.5 pb-1.5 border-b"
                        style={{ color: tint, borderColor: `${tint}24`, fontFamily: MONO }}>▸ {slug}</span>
                    <span className="flex flex-col gap-2.5 items-stretch">
                        {body.map((l, k) => {
                            const m = l.match(/^\s*(.+?)\s*[:：]\s*(.+)$/);
                            if (m) {
                                const cue = m[1];
                                const speech = m[2];
                                const pm = cue.match(/^(.*?)\s*[（(](.+?)[）)]\s*$/);
                                const nm = pm ? pm[1] : cue;
                                const paren = pm ? pm[2] : '';
                                return (
                                    <span key={k} className="flex flex-col items-center gap-0.5 text-center">
                                        <span className="text-[9px] tracking-[0.22em] uppercase" style={{ color: `${tint}cc` }}>
                                            {nm}{paren && <span className="text-white/35 tracking-normal lowercase">（{paren}）</span>}
                                        </span>
                                        <span className="text-[14px] text-white/85 leading-relaxed" style={{ fontFamily: ff }}>{speech}</span>
                                    </span>
                                );
                            }
                            // 动作 / 舞台指示行
                            return <span key={k} className="text-[12px] text-white/45 italic text-center leading-relaxed" style={{ fontFamily: ff }}>— {l} —</span>;
                        })}
                    </span>
                </span>
            </span>
        );
    } else if (frag.kind === 'diary') {
        inner = <span className="inline-block rounded-lg px-4 py-3 text-left bg-white/[0.035] border border-white/[0.08]"
            style={{ boxShadow: `0 6px 28px ${tint}10`, maxWidth: 244 }}>
            {frag.date && <span className="block text-[9.5px] text-white/30 mb-1.5 tracking-wide" style={{ fontFamily: ff }}>{frag.date}</span>}
            <span className="block text-[13.5px] text-white/80 leading-loose whitespace-pre-wrap" style={{ fontFamily: ff }}>{frag.text}</span>
        </span>;
    } else if (frag.kind === 'message') {
        inner = <span className="inline-flex flex-col items-end gap-1">
            {frag.date && <span className="text-[9.5px] text-white/30 pr-1">{frag.date}</span>}
            <span className="px-3.5 py-2 rounded-2xl rounded-br-md text-[13.5px] leading-relaxed text-[#15121c]" style={{ background: tint, maxWidth: 230 }}>{frag.text}</span>
            <span className="text-[8.5px] text-white/25 pr-1">· 未送达 ·</span>
        </span>;
    } else { // image — 不画图片占位框，配文本身就是诗：只渲染拼贴诗，留一点点色调点缀
        const it = frag.tint || tint;
        const cap = frag.caption || frag.text || '';
        inner = cap ? (
            <span className="inline-flex flex-col items-center gap-1.5">
                {/* 一道极细的色调短线，作为「这是一帧画面」的暗示，而非空白占位框 */}
                <span className="block rounded-full" style={{ width: 26, height: 2, background: `${it}`, boxShadow: `0 0 10px ${it}aa` }} />
                <span className="leading-relaxed text-center" style={{ maxWidth: 232 }}>
                    <Cut text={cap} theme={theme} seed={i + 99} base={15} intensity={0.95} />
                </span>
            </span>
        ) : null;
    }

    if (!inner) return null;
    return <div className="animate-fade-in" style={wrapStyle}>{inner}</div>;
};

// ============================================================
//  SHELL
// ============================================================
const Shell: React.FC<{ children: React.ReactNode; bg: string }> = ({ children, bg }) => (
    <div className="absolute inset-0 z-[400] flex flex-col overflow-hidden text-white" style={{ background: bg }}>
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(120% 90% at 50% 50%, transparent 40%, rgba(0,0,0,0.55) 100%)' }} />
        <div className="relative z-10 flex flex-col flex-1 min-h-0">{children}</div>
    </div>
);

const TopBar: React.FC<{ onBack: () => void; right?: React.ReactNode }> = ({ onBack, right }) => (
    // 顶栏自己接管安全区：统一用全局 --chrome-top（= --safe-top + SullyOS 状态栏高度，
    // 状态栏隐藏时自动退化为 --safe-top），与「彼方 / 交换日记 / 剧场」等全屏面板一致。
    // 之前用裸 env(safe-area-inset-top) 少让了状态栏那一段，返回键顶得太高。
    <div className="flex items-center justify-between px-4 shrink-0 pb-2 z-30"
        style={{ paddingTop: 'calc(var(--chrome-top) + 0.25rem)' }}>
        <button onClick={onBack} className="w-9 h-9 -ml-1 rounded-full flex items-center justify-center text-white/70 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition">
            <CaretLeft size={18} weight="bold" />
        </button>
        <div className="flex justify-end min-w-[80px]">{right}</div>
    </div>
);

// 梦境系统内统一的小弹窗（不用浏览器原生 confirm/alert）——暗色玻璃，居中浮起。
const DreamPopup: React.FC<{ title: string; onClose: () => void; children: React.ReactNode; actions?: React.ReactNode }> =
    ({ title, onClose, children, actions }) => (
    <div className="absolute inset-0 z-[60] flex items-center justify-center p-7" onClick={onClose}>
        <div className="absolute inset-0 bg-black/65 backdrop-blur-sm" />
        <div className="relative w-full max-w-[300px] rounded-3xl border border-white/[0.12] p-5 animate-slide-up"
            style={{ background: 'linear-gradient(160deg, #1c1a28, #121019)', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}
            onClick={e => e.stopPropagation()}>
            <h3 className="text-[15px] font-semibold text-white text-center mb-2.5" style={{ fontFamily: SERIF }}>{title}</h3>
            <div className="text-[12px] text-white/65 leading-relaxed text-center">{children}</div>
            {actions && <div className="mt-4 flex gap-2.5">{actions}</div>}
        </div>
    </div>
);

// ============================================================
//  COMPONENT
// ============================================================
type Phase = 'idle' | 'loading' | 'play' | 'end' | 'error' | 'archive' | 'collection';

/** 同一日历日判定（每日梦境限制用） */
const isSameDay = (a: number, b: number): boolean => {
    const da = new Date(a), db = new Date(b);
    return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
};
/** 每个角色每天最多看到的梦境「种类」数 */
const DREAM_DAILY_TYPE_CAP = 3;

const DreamTheater: React.FC<{ char: CharacterProfile; onExit: () => void }> = ({ char, onExit }) => {
    const { apiConfig, userProfile, updateCharacter, addToast } = useOS();

    const [phase, setPhase] = useState<Phase>('idle');
    const [script, setScript] = useState<DreamScript | null>(null);
    const [revealed, setRevealed] = useState(1);   // 已浮现的碎片数（拼贴累积，纯轻触推进）
    // 仅本地测试：强制指定原型（null = 让模型自动选）
    const [forcedArchetype, setForcedArchetype] = useState<DreamArchetype | null>(null);
    const devAvailable = isDevDebugAvailable();
    // 盲盒收藏册（账号级）+ 本场抽到的盲盒结果
    const [collection, setCollection] = useState<DreamCollection>(() => loadCollection());
    const [boxReveal, setBoxReveal] = useState<{ archetype: DreamArchetype; isNew: boolean; count: number } | null>(null);
    const savedRef = useRef(false);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    // 长按检测（梦的残页删除）：计时 + 已触发标记（防止松手时又触发 replay）
    const lpTimerRef = useRef<number | null>(null);
    const lpFiredRef = useRef(false);
    const clearLp = () => { if (lpTimerRef.current) { window.clearTimeout(lpTimerRef.current); lpTimerRef.current = null; } };
    // 弹窗：规则说明（？）/ 每日限制提醒 / 删除残页确认
    const [showHelp, setShowHelp] = useState(false);
    const [dayPrompt, setDayPrompt] = useState<'seen' | 'limit' | null>(null);
    const [confirmDelete, setConfirmDelete] = useState<DreamLog | null>(null);

    const frags = script?.fragments || [];
    const theme = THEMES[script?.archetype || 'starry'];
    const isDeepSleep = script?.archetype === 'deepsleep';

    const dreamSim = useDreamSim();

    // ----- generate（后台进行：生成期间用户可离开小屋，好了全局提示 + 深链回来）-----
    const start = useCallback(async (opts?: { override?: boolean }) => {
        if (!apiConfig?.baseUrl || !apiConfig?.apiKey || !apiConfig?.model) {
            addToast('请先在设置里配置 API', 'error'); return;
        }
        // 每日限制：一天原则上只看一个梦；重复生成会提醒，可「少管我！」强行再看；
        // 但同一天对同一角色最多只能看到 DREAM_DAILY_TYPE_CAP 种不同类型的梦。
        // （dev 强制指定原型时跳过限制，方便本地测试。）
        if (!forcedArchetype) {
            const today = (char.dreamLogs || []).filter(l => isSameDay(l.timestamp, Date.now()));
            const distinctTypes = new Set(today.map(l => l.archetype)).size;
            if (today.length >= DREAM_DAILY_TYPE_CAP || distinctTypes >= DREAM_DAILY_TYPE_CAP) {
                setDayPrompt('limit'); return;   // 到顶了，硬拦，不给 override
            }
            if (today.length >= 1 && !opts?.override) {
                setDayPrompt('seen'); return;    // 已看过，软提醒，可 override
            }
        }
        setDayPrompt(null);
        const cid = char.id, cname = char.name;
        savedRef.current = false; setRevealed(1); setBoxReveal(null);
        setPhase('loading');
        trackEvent('生成一场梦境');
        dreamSimStore.set({ status: 'loading', charId: cid, charName: cname });
        // 原型由应用端抽（dev 强制时优先 dev）：保证多样、不老 roll 同一种、隐藏款按掉率出
        const chosenArchetype = forcedArchetype || rollArchetype(char.dreamLogs);
        try {
            // 注意：不在 await 后直接 setState 播放，交给下方 consume effect 统一消费
            // （这样即使用户已离开、组件卸载，生成照常完成、全局指示条接管）
            const s = await generateDreamScript({ char, userProfile, apiConfig, forcedArchetype: chosenArchetype });
            dreamSimStore.set({ status: 'ready', charId: cid, charName: cname, script: s });
            addToast('梦已成形', 'success');
        } catch (e) {
            console.error('dream gen failed', e);
            dreamSimStore.set({ status: 'error', charId: cid, charName: cname });
            addToast('梦没能成形，请重试', 'error');
        }
    }, [apiConfig, char, userProfile, addToast, forcedArchetype]);

    // ----- consume：把全局生成结果落到本地播放（含深链回来后的首次消费）-----
    useEffect(() => {
        if (dreamSim.status === 'ready' && dreamSim.charId === char.id && dreamSim.script) {
            savedRef.current = false; setBoxReveal(null);
            setScript(dreamSim.script); setRevealed(1); setPhase('play');
            dreamSimStore.reset();
        } else if (dreamSim.status === 'error' && dreamSim.charId === char.id) {
            setPhase('error'); dreamSimStore.reset();
        } else if (dreamSim.status === 'loading' && dreamSim.charId === char.id) {
            setPhase(p => (p === 'idle' || p === 'error') ? 'loading' : p);
        }
    }, [dreamSim, char.id]);

    // ----- persist + buff on reaching the end -----
    const persist = useCallback((s: DreamScript) => {
        if (savedRef.current) return;
        savedRef.current = true;

        const log: DreamLog = {
            id: `dream-${Date.now()}`,
            archetype: s.archetype,
            title: s.title,
            afterglow: s.afterglow,
            fragmentsCount: s.fragments?.length || 0,
            timestamp: Date.now(),
            script: s,
        };

        // 情绪 buff —— 与 PersonaSim 一致，仅在该角色开启了日程/情绪系统时写入
        const scheduleOn = isScheduleFeatureOn(char);
        const newBuff: CharacterBuff | null = (scheduleOn && s.buff?.label) ? {
            id: `buff_${Date.now()}`,
            name: s.buff.name || `dream_${Date.now()}`,
            label: s.buff.label,
            intensity: (s.buff.intensity && [1, 2, 3].includes(s.buff.intensity) ? s.buff.intensity : 2) as 1 | 2 | 3,
            emoji: s.buff.emoji,
            color: s.buff.color || theme.accent,
            description: s.buff.description,
        } : null;
        if (newBuff) log.buff = { label: newBuff.label, emoji: newBuff.emoji, color: newBuff.color };

        let dispatchBuffs: CharacterBuff[] | null = null;
        updateCharacter(char.id, (cur) => {
            const dreamLogs = [log, ...(cur.dreamLogs || [])].slice(0, 30);
            if (newBuff && s.buff) {
                const existing = (cur.activeBuffs || []).filter(b => b.id !== newBuff.id);
                const nextBuffs = [newBuff, ...existing].slice(0, 4);
                dispatchBuffs = nextBuffs;
                return {
                    activeBuffs: nextBuffs,
                    // 角色不记得梦，但残留一层情绪底色 —— 注入时点明「说不清来由」
                    buffInjection: s.buff.description ? `（${newBuff.emoji || ''}${newBuff.label}·一场记不清的梦留下的）${s.buff.description}` : '',
                    dreamLogs,
                };
            }
            return { dreamLogs };
        });
        if (newBuff) {
            window.dispatchEvent(new CustomEvent('emotion-updated',
                dispatchBuffs ? { detail: { charId: char.id, buffs: dispatchBuffs, buffInjection: '' } }
                              : { detail: { charId: char.id } }));
        }
    }, [char, updateCharacter, theme.accent]);

    // ----- 收束：落库 + buff + 开盲盒 → end（双触发安全：savedRef 守卫，不重复抽/不覆盖揭晓） -----
    const finishDream = useCallback(() => {
        if (!script) return;
        if (savedRef.current) { setPhase('end'); return; } // 已收束过（含 replay）→ 只去结束页
        persist(script);                                   // 内部置 savedRef=true
        const r = unlockCollectible(script.archetype);
        setCollection(r.collection);
        setBoxReveal({ archetype: script.archetype, isNew: r.isNew, count: r.count });
        setPhase('end');
    }, [script, persist]);

    // 纯轻触推进：不再自动播放、也不自动收束——读完由用户点「醒来」或轻触收束，
    // 让人可以在最后那页拼贴诗上停留多久都行。

    // ----- 新碎片浮现时平滑滚到底，让最新的进入视野 -----
    useEffect(() => {
        if (phase !== 'play' || !scrollRef.current) return;
        const el = scrollRef.current;
        requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }));
    }, [revealed, phase]);

    // 轻触：让下一片浮现；都浮现完则收束
    const revealNextOrFinish = () => {
        if (revealed < frags.length) setRevealed(r => Math.min(frags.length, r + 1));
        else finishDream();
    };

    const restart = () => { savedRef.current = true; setRevealed(1); setPhase('play'); trackEvent('重看一遍刚做完的梦'); };

    // ----- replay a saved dream -----
    const replay = (s: DreamScript) => {
        savedRef.current = true; // 重看不再写库 / 不再叠 buff / 不再抽盲盒
        setBoxReveal(null);
        setScript(s); setRevealed(1); setPhase('play');
    };

    // ----- 删除一页「梦的残页」（长按触发，走自定义确认弹窗，不用原生 confirm）-----
    const handleDeleteLog = (log: DreamLog) => {
        updateCharacter(char.id, (cur) => ({ dreamLogs: (cur.dreamLogs || []).filter(l => l.id !== log.id) }));
        setConfirmDelete(null);
        addToast('已撕掉这页梦', 'success');
        trackEvent('撕掉一页梦的残页');
    };

    const dreamLogs = char.dreamLogs || [];
    const collectedCount = ALL_ARCHETYPES.filter(a => collection[a]).length;

    // 每日限制提醒弹窗（idle 与 end 两处都可能触发「再生成」，共用同一份）
    const dayPromptPopups = (<>
        {dayPrompt === 'seen' && (
            <DreamPopup title={`今天已经看过 ${char.name} 的梦了哦`} onClose={() => setDayPrompt(null)}
                actions={<>
                    <button onClick={() => setDayPrompt(null)} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-white/70 bg-white/[0.06] border border-white/[0.1]">好的</button>
                    <button onClick={() => { setDayPrompt(null); trackEvent('无视今日提醒再看一场梦'); start({ override: true }); }} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-[#15121c]" style={{ background: '#cdd6ff' }}>少管我！</button>
                </>}>
                一天看太多梦，就不灵了。<br />真要再看一场吗？（今天最多 {DREAM_DAILY_TYPE_CAP} 种）
            </DreamPopup>
        )}
        {dayPrompt === 'limit' && (
            <DreamPopup title={`今天 ${char.name} 的梦看满啦`} onClose={() => setDayPrompt(null)}
                actions={<button onClick={() => setDayPrompt(null)} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-[#15121c]" style={{ background: '#cdd6ff' }}>好吧，明天见</button>}>
                同一天最多只能窥见 {DREAM_DAILY_TYPE_CAP} 种不同的梦。<br />剩下的，留给明晚。🌙
            </DreamPopup>
        )}
    </>);

    // ========================================================
    //  IDLE — 入口
    // ========================================================
    if (phase === 'idle' || phase === 'error') {
        return (
            <Shell bg={THEMES.starry.bg}>
                <Ambient kind="stars" accent="#cdd6ff" />
                <TopBar onBack={onExit} right={
                    <div className="flex items-center gap-2.5">
                        <button onClick={() => { setPhase('collection'); trackEvent('打开梦境盲盒收藏册'); }} className="flex items-center gap-1 text-[11px] text-white/55 active:scale-95 transition">
                            🐾 收藏册 <span className="tabular-nums opacity-70">{collectedCount}/{ALL_ARCHETYPES.length}</span>
                        </button>
                        <button onClick={() => { setShowHelp(true); trackEvent('打开梦境规则说明'); }} aria-label="梦境规则"
                            className="w-7 h-7 rounded-full flex items-center justify-center text-white/55 bg-white/[0.05] border border-white/[0.1] active:scale-90 transition">
                            <Question size={15} weight="bold" />
                        </button>
                    </div>
                } />
                <div className="flex-1 flex flex-col items-center justify-center px-9 text-center">
                    <div className="relative mb-7">
                        <MoonStars size={52} weight="light" style={{ color: '#cdd6ff' }} />
                        <div className="absolute inset-0 blur-2xl rounded-full" style={{ background: '#cdd6ff44' }} />
                    </div>
                    <div className="text-[10px] tracking-[0.4em] uppercase mb-3" style={{ color: '#cdd6ff' }}>Dream Theater</div>
                    <h1 className="text-[24px] font-light text-white leading-snug mb-4" style={{ fontFamily: SERIF }}>
                        偷看一场<br />{char.name} 已经忘记的梦
                    </h1>
                    <p className="text-[12px] text-white/45 leading-relaxed max-w-[270px] mb-1" style={{ fontFamily: SERIF }}>
                        ta 睡着了。<br />
                        梦不讲道理，也不必当真——<br />
                        散落的画面、矛盾的时间、不可能的人。<br />
                        看完，ta 不会记得，但你会。
                    </p>

                    {phase === 'error' && (
                        <div className="mt-5 text-[12px] text-rose-300/80">梦没能成形…… 再试一次？</div>
                    )}

                    <button onClick={() => start()}
                        className="mt-9 w-full max-w-[280px] py-3.5 rounded-2xl text-[13px] font-semibold flex items-center justify-center gap-2 active:scale-[0.99] transition"
                        style={{ background: '#cdd6ff', color: '#15121c' }}>
                        <Eye size={16} weight="fill" /> {forcedArchetype ? `测试：${THEMES[forcedArchetype].label}` : '走进 ta 的梦'}
                    </button>
                    <p className="text-[10px] text-white/25 mt-3 max-w-[250px] leading-relaxed">
                        将读取 ta 的设定、记忆与最近的对话，编织成一场梦。可能需要一点时间。
                    </p>

                    {/* 入口：盲盒收藏册 / 梦的残页 */}
                    <div className="flex items-center gap-2.5 mt-7">
                        <button onClick={() => { setPhase('collection'); trackEvent('打开梦境盲盒收藏册'); }}
                            className="flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[11px] border border-white/[0.1] bg-white/[0.04] text-white/75 active:scale-95 transition">
                            🐾 盲盒收藏册 <span className="tabular-nums" style={{ color: '#cdd6ff' }}>{collectedCount}/{ALL_ARCHETYPES.length}</span>
                        </button>
                        {dreamLogs.length > 0 && (
                            <button onClick={() => { setPhase('archive'); trackEvent('打开梦的残页存档'); }}
                                className="flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[11px] border border-white/[0.1] bg-white/[0.04] text-white/75 active:scale-95 transition">
                                <MoonStars size={13} /> 梦的残页 <span className="tabular-nums opacity-70">{dreamLogs.length}</span>
                            </button>
                        )}
                    </div>

                    {/* 仅本地测试：指定梦境（管理员调试指令，正式版不显示） */}
                    {devAvailable && (
                        <div className="mt-8 w-full max-w-[300px] rounded-2xl border border-amber-300/20 bg-amber-300/[0.04] p-3.5">
                            <div className="flex items-center justify-between mb-2.5">
                                <span className="text-[10px] tracking-wider text-amber-200/80 font-semibold">🛠 指定梦境 · 仅本地测试</span>
                                {forcedArchetype && (
                                    <button onClick={() => setForcedArchetype(null)} className="text-[9px] text-white/40 underline active:scale-95">清除·改回自动</button>
                                )}
                            </div>
                            <div className="grid grid-cols-3 gap-1.5">
                                {ALL_ARCHETYPES.map(a => {
                                    const active = forcedArchetype === a;
                                    return (
                                        <button key={a} onClick={() => setForcedArchetype(active ? null : a)}
                                            className="py-1.5 rounded-lg text-[10.5px] border transition active:scale-95 flex items-center justify-center gap-1"
                                            style={active
                                                ? { background: THEMES[a].accent, color: '#15121c', borderColor: 'transparent', fontWeight: 700 }
                                                : { background: 'rgba(255,255,255,0.035)', borderColor: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.7)' }}>
                                            <span className="tabular-nums opacity-50 text-[8.5px]">{archetypeNo(a)}</span>{THEMES[a].label}
                                        </button>
                                    );
                                })}
                            </div>
                            <p className="text-[9px] text-white/30 mt-2.5 leading-relaxed">
                                勾一个则注入「管理员调试指令」，强制本次生成该原型（含隐藏·深眠）；不勾 = 模型自动选。
                            </p>
                        </div>
                    )}
                </div>

                {/* 规则说明（右上角 ? 按钮） */}
                {showHelp && (
                    <DreamPopup title="🌙 梦境规则" onClose={() => setShowHelp(false)}
                        actions={<button onClick={() => setShowHelp(false)} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-[#15121c]" style={{ background: '#cdd6ff' }}>明白了</button>}>
                        <div className="text-left space-y-2">
                            <p>· 一天原则上只看 <b className="text-white/80">一个</b> {char.name} 的梦。重复生成会被提醒，你仍可选「少管我！」继续。</p>
                            <p>· 但同一天对同一个人，最多只能看到 <b className="text-white/80">{DREAM_DAILY_TYPE_CAP} 种</b>不同类型的梦——看满了就明天再来。</p>
                            <p>· 一共有 <b className="text-white/80">{ALL_ARCHETYPES.length}</b> 种梦，其中含 <b style={{ color: '#ffe08a' }}>1 个隐藏款 · 深眠</b>，小概率才会遇到。</p>
                            <p>· 做完一场梦会抽到对应的梦境小猫，集进收藏册。</p>
                            <p>· ta 不会记得这些梦，但醒来会残留一层说不清的情绪。「梦的残页」里可长按删除某一页。</p>
                        </div>
                    </DreamPopup>
                )}

                {/* 每日限制提醒 */}
                {dayPromptPopups}
            </Shell>
        );
    }

    // ========================================================
    //  ARCHIVE — 梦的残页
    // ========================================================
    if (phase === 'archive') {
        return (
            <Shell bg={THEMES.starry.bg}>
                <Ambient kind="stars" accent="#cdd6ff" />
                <TopBar onBack={() => setPhase('idle')} />
                <div className="px-7 pb-3 shrink-0">
                    <h2 className="text-[18px] font-light text-white" style={{ fontFamily: SERIF }}>梦的残页</h2>
                    <p className="text-[11px] text-white/40 mt-1 leading-relaxed">那些你偷看到、而 ta 早已忘记的梦。<span className="text-white/30">长按一页可撕掉。</span></p>
                </div>
                <div className="flex-1 overflow-y-auto no-scrollbar px-6 pb-10 space-y-3">
                    {dreamLogs.map(log => {
                        const lt = THEMES[log.archetype] || THEMES.starry;
                        return (
                            <button key={log.id}
                                onClick={() => { if (lpFiredRef.current) { lpFiredRef.current = false; return; } trackEvent('重看一场存档梦境'); log.script && replay(log.script); }}
                                disabled={!log.script}
                                onContextMenu={(e) => { e.preventDefault(); setConfirmDelete(log); }}
                                onTouchStart={() => { lpFiredRef.current = false; clearLp(); lpTimerRef.current = window.setTimeout(() => { lpFiredRef.current = true; setConfirmDelete(log); }, 500); }}
                                onTouchMove={clearLp}
                                onTouchEnd={clearLp}
                                className="w-full text-left rounded-2xl p-4 border border-white/[0.07] bg-white/[0.03] active:scale-[0.99] transition disabled:opacity-60"
                                style={{ boxShadow: `0 6px 30px ${lt.accent}10` }}>
                                <div className="flex items-center justify-between mb-1.5">
                                    <span className="text-[9px] px-2 py-0.5 rounded-full tracking-wider" style={{ color: lt.accent, background: `${lt.accent}1f` }}>
                                        {lt.label}
                                    </span>
                                    <span className="text-[9px] text-white/30 tabular-nums">
                                        {new Date(log.timestamp).toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                </div>
                                <div className="text-[15px] font-light text-white mb-1" style={{ fontFamily: SERIF }}>{log.title || '无题的梦'}</div>
                                {log.afterglow && <p className="text-[12px] text-white/55 leading-relaxed" style={{ fontFamily: SERIF }}>{log.afterglow}</p>}
                                {log.buff?.label && (
                                    <div className="inline-flex items-center gap-1.5 mt-2.5 px-2.5 py-1 rounded-full border text-[10px]"
                                        style={{ borderColor: `${log.buff.color || lt.accent}55`, color: 'rgba(255,255,255,0.8)', background: `${log.buff.color || lt.accent}14` }}>
                                        <span>{log.buff.emoji || '✨'}</span>{log.buff.label}
                                    </div>
                                )}
                            </button>
                        );
                    })}
                </div>

                {/* 删除残页 · 自定义确认弹窗（不用浏览器原生 confirm）*/}
                {confirmDelete && (
                    <DreamPopup title="撕掉这页梦？" onClose={() => setConfirmDelete(null)}
                        actions={<>
                            <button onClick={() => setConfirmDelete(null)} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-white/70 bg-white/[0.06] border border-white/[0.1]">留着</button>
                            <button onClick={() => handleDeleteLog(confirmDelete)} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-white flex items-center justify-center gap-1.5" style={{ background: '#e5566b' }}><Trash size={13} weight="bold" /> 撕掉</button>
                        </>}>
                        「{confirmDelete.title || '无题的梦'}」<br />撕掉后这页残梦就再也找不回来了。
                    </DreamPopup>
                )}
            </Shell>
        );
    }

    // ========================================================
    //  COLLECTION — 盲盒收藏册（图鉴）
    // ========================================================
    if (phase === 'collection') {
        const total = ALL_ARCHETYPES.length;
        return (
            <Shell bg={THEMES.starry.bg}>
                <Ambient kind="stars" accent="#cdd6ff" />
                <TopBar onBack={() => setPhase(boxReveal ? 'end' : 'idle')} right={
                    <span className="text-[11px] text-white/55 tabular-nums">{collectedCount}/{total}</span>
                } />
                <div className="px-7 pb-3 shrink-0">
                    <div className="text-[9px] tracking-[0.3em] uppercase" style={{ color: '#cdd6ff' }}>{DREAM_BOX_SERIES.sub} · Blind Box</div>
                    <h2 className="text-[19px] font-light text-white mt-1" style={{ fontFamily: SERIF }}>{DREAM_BOX_SERIES.title}</h2>
                    <p className="text-[11px] text-white/40 mt-1 leading-relaxed">做完一场梦，就抽到那种梦的小猫。集齐它们。</p>
                    <div className="h-[3px] rounded-full bg-white/[0.07] overflow-hidden mt-3">
                        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${(collectedCount / total) * 100}%`, background: '#cdd6ff' }} />
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-10">
                    <div className="grid grid-cols-3 gap-3">
                        {ALL_ARCHETYPES.map(a => {
                            const owned = collection[a];
                            const t = THEMES[a];
                            const isSecret = a === 'deepsleep';   // 隐藏款 · 深眠 —— 要让人一眼看出「这格不一样」
                            const GOLD = '#ffe08a';
                            return (
                                <div key={a} className={`relative rounded-2xl border overflow-hidden flex flex-col ${isSecret ? 'col-span-3 mx-auto' : ''}`}
                                    style={isSecret
                                        ? { width: 'calc((100% - 1.5rem) / 3)', borderColor: owned ? `${GOLD}aa` : `${GOLD}55`, background: `linear-gradient(160deg, ${GOLD}1c, rgba(120,90,160,0.10) 60%, rgba(255,255,255,0.02))`, boxShadow: `0 0 22px ${GOLD}2e, inset 0 0 18px ${GOLD}14` }
                                        : owned
                                            ? { borderColor: `${t.accent}40`, background: `linear-gradient(160deg, ${t.accent}14, rgba(255,255,255,0.02))` }
                                            : { borderColor: 'rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.02)' }}>
                                    {/* 隐藏款角标：无论解锁与否都标出来，制造「特别款」的存在感 */}
                                    {isSecret && (
                                        <span className="absolute top-0 left-0 z-10 px-1.5 py-0.5 text-[7.5px] font-bold tracking-wider rounded-br-lg"
                                            style={{ background: GOLD, color: '#15121c' }}>✦ 隐藏款</span>
                                    )}
                                    {owned ? (
                                        <>
                                            <div className="relative aspect-square flex items-center justify-center p-1.5">
                                                <BoxCat archetype={a} size={92} />
                                                {owned.count > 1 && (
                                                    <span className="absolute top-1 right-1 text-[8.5px] px-1.5 py-0.5 rounded-full font-bold tabular-nums"
                                                        style={{ background: isSecret ? GOLD : t.accent, color: '#15121c' }}>×{owned.count}</span>
                                                )}
                                            </div>
                                            <div className="text-center pb-2 px-1">
                                                <div className="text-[10.5px] leading-tight" style={{ fontFamily: SERIF, color: isSecret ? GOLD : 'rgba(255,255,255,0.85)' }}>{t.label}</div>
                                                <div className="text-[7.5px] tracking-wider uppercase mt-0.5" style={{ color: isSecret ? `${GOLD}cc` : `${t.accent}cc` }}>{t.sub}</div>
                                            </div>
                                        </>
                                    ) : isSecret ? (
                                        // 未解锁的隐藏款：金色问号 + 神秘提示，明显区别于普通锁
                                        <div className="aspect-square flex flex-col items-center justify-center gap-2"
                                            style={{ background: `radial-gradient(circle at 50% 42%, ${GOLD}1f, transparent 70%)` }}>
                                            <Sparkle size={22} weight="fill" style={{ color: GOLD }} />
                                            <span className="text-[8px] tracking-wider" style={{ color: `${GOLD}aa` }}>某种很罕见的梦</span>
                                        </div>
                                    ) : (
                                        <div className="aspect-square flex flex-col items-center justify-center gap-2 text-white/20"
                                            style={{ background: 'radial-gradient(circle at 50% 45%, rgba(255,255,255,0.04), transparent 70%)' }}>
                                            <Lock size={20} weight="light" />
                                            <span className="text-[18px] font-light tracking-[0.2em]">？</span>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                    <p className="text-[10px] text-white/25 mt-6 text-center leading-relaxed px-4">
                        🐾 {DREAM_BOX_SERIES.title}<br />未解锁的梦境小猫，藏在还没做过的那种梦里。
                    </p>
                </div>
            </Shell>
        );
    }

    // ========================================================
    //  LOADING
    // ========================================================
    if (phase === 'loading') {
        return (
            <Shell bg={THEMES.starry.bg}>
                <Ambient kind="stars" accent="#cdd6ff" />
                <TopBar onBack={onExit} />
                <div className="flex-1 flex flex-col items-center justify-center gap-6 px-10 text-center">
                    <div className="relative">
                        <MoonStars size={42} weight="light" style={{ color: '#cdd6ff' }} className="animate-pulse" />
                        <div className="absolute inset-0 blur-2xl rounded-full" style={{ background: '#cdd6ff55' }} />
                    </div>
                    <div className="text-[13px] text-white/70" style={{ fontFamily: SERIF }}>ta 正在坠入梦里…</div>
                    <div className="text-[11px] text-white/35 leading-relaxed" style={{ fontFamily: SERIF }}>
                        把记忆、对话与情绪揉成一场<br />说不清的梦，可能需要一点时间。
                    </div>
                    <button onClick={onExit} className="mt-2 px-5 py-2.5 rounded-xl text-[12px] text-white/70 bg-white/[0.06] border border-white/[0.08] active:scale-95 transition">
                        先离开 · 好了通知我
                    </button>
                    <p className="text-[10px] text-white/30 leading-relaxed">梦在后台继续编织，<br />成形后顶部会出现提示，点一下就能回来。</p>
                </div>
            </Shell>
        );
    }

    // ========================================================
    //  END
    // ========================================================
    if (phase === 'end') {
        return (
            <Shell bg={theme.bg}>
                <Ambient kind={theme.ambient} accent={theme.accent} />
                <div className="flex-1 flex flex-col items-center justify-center px-9 text-center animate-fade-in">
                    <MoonStars size={isDeepSleep ? 28 : 26} weight="light" className="text-white/30 mb-5" />
                    <div className="text-[10px] tracking-[0.3em] uppercase text-white/35 mb-3">{isDeepSleep ? '一夜无梦' : '梦醒了'}</div>
                    <h2 className="text-[21px] font-light text-white mb-3" style={{ fontFamily: SERIF }}>{script?.title || (isDeepSleep ? '深眠' : '无题的梦')}</h2>
                    <div className="text-[10px] mb-4 px-3 py-1 rounded-full" style={{ color: theme.accent, background: `${theme.accent}1f` }}>{theme.label}</div>
                    {script?.afterglow && (
                        <p className="text-[14px] text-white/65 leading-loose max-w-[280px]" style={{ fontFamily: SERIF }}>{script.afterglow}</p>
                    )}

                    {script?.buff?.label && isScheduleFeatureOn(char) && (
                        <div className="mt-7 flex items-center gap-2 px-4 py-2 rounded-2xl border" style={{ borderColor: `${script.buff.color || theme.accent}55`, background: `${script.buff.color || theme.accent}14` }}>
                            <span className="text-base">{script.buff.emoji || '✨'}</span>
                            <div className="text-left">
                                <div className="text-[12px] font-semibold text-white">{script.buff.label}</div>
                                <div className="text-[9px] text-white/45">一层说不清来由的情绪，留在了 ta 身上</div>
                            </div>
                        </div>
                    )}

                    {/* 盲盒揭晓 —— 这场梦抽到的小猫 */}
                    {boxReveal && (
                        <div className="mt-7 flex flex-col items-center animate-pop-in">
                            <div className="relative">
                                {/* sparkle 环 */}
                                <Sparkle size={16} weight="fill" className="absolute -top-1 -left-2 animate-pulse" style={{ color: theme.accent }} />
                                <Sparkle size={12} weight="fill" className="absolute top-3 -right-3 animate-pulse" style={{ color: theme.accent, animationDelay: '300ms' }} />
                                <BoxCat archetype={boxReveal.archetype} size={128} />
                            </div>
                            <div className="mt-1 flex items-center gap-2">
                                {boxReveal.isNew
                                    ? <span className="px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider" style={{ background: theme.accent, color: '#15121c' }}>NEW ✦</span>
                                    : <span className="px-2 py-0.5 rounded-full text-[10px] text-white/60 border border-white/15">已有 · 再抽到 ×{boxReveal.count}</span>}
                                <span className="text-[12px] text-white/80" style={{ fontFamily: SERIF }}>{THEMES[boxReveal.archetype].label}喵</span>
                            </div>
                            <button onClick={() => { setPhase('collection'); trackEvent('打开梦境盲盒收藏册'); }} className="mt-2 text-[11px] text-white/45 underline active:scale-95">
                                {boxReveal.isNew ? '已收入收藏册 · 去看看' : '查看收藏册'}
                            </button>
                        </div>
                    )}

                    <p className="text-[10px] text-white/30 mt-6 max-w-[260px] leading-relaxed">
                        ta 醒来后不会记得这场梦，<br />但梦与小猫，都被你悄悄收下了。
                    </p>

                    <div className="flex gap-3 mt-6">
                        <button onClick={restart} className="px-5 py-2.5 rounded-xl text-[12px] text-white/70 bg-white/[0.06] border border-white/[0.08] flex items-center gap-1.5 active:scale-95 transition">
                            <ArrowClockwise size={14} /> 再看一遍
                        </button>
                        <button onClick={() => start()} className="px-5 py-2.5 rounded-xl text-[12px] font-semibold flex items-center gap-1.5 active:scale-95 transition" style={{ background: theme.accent, color: '#15121c' }}>
                            <MoonStars size={14} weight="fill" /> 再做一个梦
                        </button>
                    </div>
                    <button onClick={onExit} className="mt-4 text-[11px] text-white/30">离开</button>
                </div>
                {/* 「再做一个梦」也会触发每日限制提醒 */}
                {dayPromptPopups}
            </Shell>
        );
    }

    // ========================================================
    //  PLAY — deep sleep (silent) special scene
    // ========================================================
    if (isDeepSleep) {
        return (
            <Shell bg={theme.bg}>
                <div className="flex-1 flex flex-col items-center justify-center px-12 text-center select-none" onClick={finishDream}>
                    <div className="w-3 h-3 rounded-full bg-white/40 animate-dot-pulse" style={{ boxShadow: '0 0 30px rgba(255,255,255,0.3)' }} />
                    <p className="text-[12px] text-white/20 mt-12 tracking-[0.3em]" style={{ fontFamily: SERIF }}>……</p>
                    <p className="absolute bottom-12 text-[10px] text-white/20">轻触，醒来</p>
                </div>
            </Shell>
        );
    }

    // ========================================================
    //  PLAY — collage canvas（碎片累积，可滚动回看整首拼贴诗）
    // ========================================================
    return (
        <Shell bg={theme.bg}>
            <Ambient kind={theme.ambient} accent={theme.accent} />

            {/* exit（放弃，不收束） */}
            <button onClick={onExit} className="absolute top-0 left-0 m-3 w-9 h-9 rounded-full flex items-center justify-center text-white/40 bg-white/[0.04] border border-white/[0.06] active:scale-90 transition z-30"
                style={{ marginTop: 'max(0.75rem, calc(env(safe-area-inset-top, 0px) + 0.5rem))' }}>
                <X size={16} />
            </button>

            {/* 拼贴画布：轻触让下一片浮现；可上下滚动回看 */}
            <div ref={scrollRef} onClick={revealNextOrFinish}
                className="flex-1 relative z-10 overflow-y-auto no-scrollbar select-none">
                <div className="min-h-full flex flex-col px-7 pt-20 pb-44">
                    {frags.slice(0, revealed).map((f, i) => (
                        <CollageItem key={i} frag={f} theme={theme} index={i} />
                    ))}
                    {revealed >= frags.length && (
                        <div className="self-center mt-14 mb-4 flex flex-col items-center gap-3 animate-fade-in">
                            <span className="text-white/25 tracking-[0.45em] text-[11px]" style={{ fontFamily: SERIF }}>梦在这里散了</span>
                            <button onClick={(e) => { e.stopPropagation(); finishDream(); }}
                                className="px-6 py-2.5 rounded-full text-[12px] font-semibold active:scale-95 transition"
                                style={{ background: theme.accent, color: '#15121c' }}>醒来</button>
                        </div>
                    )}
                </div>
            </div>

            {/* 底部：进度 + 提示 + 醒来（纯轻触推进，无自动播放） */}
            <div className="shrink-0 z-30 px-6 pb-7 pt-2 bg-gradient-to-t from-black/40 to-transparent">
                <div className="h-[2px] rounded-full bg-white/[0.06] overflow-hidden mb-3">
                    <div className="h-full rounded-full transition-all duration-700" style={{ width: `${(revealed / Math.max(1, frags.length)) * 100}%`, background: `${theme.accent}88` }} />
                </div>
                <div className="flex items-center justify-between">
                    <button onClick={(e) => { e.stopPropagation(); finishDream(); }} className="text-[11px] text-white/45 active:scale-95">醒来</button>
                    <span className={`text-[10px] text-white/25 transition-opacity duration-1000 ${revealed > 2 ? 'opacity-0' : 'opacity-100'}`}>轻触，让梦一片片浮现</span>
                    <span className="text-[10px] text-white/25 tabular-nums">{Math.min(revealed, frags.length)}/{frags.length}</span>
                </div>
            </div>
        </Shell>
    );
};

export default DreamTheater;
