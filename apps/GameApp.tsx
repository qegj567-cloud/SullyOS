
import React, { useState, useEffect, useRef } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { GameSession, GameTheme, CharacterProfile, GameLog, GameActionOption, GameSummary } from '../types';
import { ContextBuilder } from '../utils/context';
import { extractContent, extractJson } from '../utils/safeApi';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import Modal from '../components/os/Modal';
import { Planet, RocketLaunch, Lightning, LockSimple, DiceFive, Toolbox, FloppyDisk, ArrowsClockwise, DoorOpen } from '@phosphor-icons/react';

// --- Themes Configuration (Enhanced) ---
const GAME_THEMES: Record<GameTheme, { bg: string, text: string, accent: string, font: string, border: string, cardBg: string, gradient: string, optionNormal: string, optionChaotic: string, optionEvil: string }> = {
    fantasy: {
        bg: 'bg-[#1a120b]',
        text: 'text-[#e5e5e5]',
        accent: 'text-[#fbbf24]',
        font: 'font-serif',
        border: 'border-[#78350f]',
        cardBg: 'bg-[#2a2018]',
        gradient: 'from-[#451a03] to-[#1a120b]',
        optionNormal: 'bg-[#451a03] border-[#78350f] text-[#fbbf24]',
        optionChaotic: 'bg-[#78350f] border-[#b45309] text-[#fcd34d]',
        optionEvil: 'bg-[#3f0f0f] border-[#7f1d1d] text-[#fca5a5]'
    },
    cyber: {
        bg: 'bg-[#020617]',
        text: 'text-[#94a3b8]',
        accent: 'text-[#22d3ee]',
        font: 'font-mono',
        border: 'border-[#1e293b]',
        cardBg: 'bg-[#0f172a]/80',
        gradient: 'from-[#0f172a] to-[#020617]',
        optionNormal: 'bg-[#0f172a] border-[#1e293b] text-[#22d3ee]',
        optionChaotic: 'bg-[#1e1b4b] border-[#4338ca] text-[#a78bfa]',
        optionEvil: 'bg-[#450a0a] border-[#7f1d1d] text-[#fca5a5]'
    },
    horror: {
        bg: 'bg-[#0f0000]',
        text: 'text-[#d4d4d8]',
        accent: 'text-[#ef4444]',
        font: 'font-serif',
        border: 'border-[#450a0a]',
        cardBg: 'bg-[#2b0e0e]',
        gradient: 'from-[#450a0a] to-[#000000]',
        optionNormal: 'bg-[#2b0e0e] border-[#450a0a] text-[#d4d4d8]',
        optionChaotic: 'bg-[#3f1d1d] border-[#7f1d1d] text-[#fda4af]',
        optionEvil: 'bg-[#450a0a] border-[#991b1b] text-[#ef4444]'
    },
    modern: {
        bg: 'bg-slate-50',
        text: 'text-slate-700',
        accent: 'text-blue-600',
        font: 'font-sans',
        border: 'border-slate-200',
        cardBg: 'bg-white',
        gradient: 'from-slate-100 to-white',
        optionNormal: 'bg-white border-slate-200 text-slate-600',
        optionChaotic: 'bg-yellow-50 border-yellow-200 text-yellow-700',
        optionEvil: 'bg-red-50 border-red-200 text-red-700'
    }
};

// 每累积这么多条「未归档日志」就触发一次自动总结
const AUTO_SUMMARY_THRESHOLD = 20;
// 自动总结后保留最近这么多条日志不折叠，保证阅读与剧情连贯
const KEEP_RECENT_AFTER_SUMMARY = 4;
// AI 世界观生成的可选风格
const WORLD_STYLES = ['高奇幻', '赛博朋克', '克苏鲁恐怖', '武侠江湖', '末世废土', '校园日常', '悬疑推理', '蒸汽朋克', '西部拓荒', '宫廷权谋'];

// 鲁棒解析 AI 世界观生成结果。
// 兼容三种情况：① 期望的「标题：xxx === 正文」分隔格式；② 模型不听话仍吐 JSON
// （含被截断的残缺 JSON）；③ 完全无结构的纯文本。任何情况都不把脏标记露给用户。
const parseWorldGen = (raw: string): { title: string; worldSetting: string } => {
    let text = raw.trim();
    // 去掉可能的代码块围栏
    text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();

    let title = '';
    let worldSetting = '';

    // 情况②：看起来像 JSON（即使被截断）—— 用正则抠字段，不依赖 JSON.parse
    if (/"?worldSetting"?\s*:/.test(text) || /^\s*\{/.test(text)) {
        const tMatch = text.match(/"?title"?\s*:\s*"((?:[^"\\]|\\.)*)"/);
        // worldSetting 可能未闭合（被截断），所以允许匹配到结尾
        const wMatch = text.match(/"?worldSetting"?\s*:\s*"((?:[^"\\]|\\.)*?)(?:"\s*[},]|"\s*$|$)/);
        if (tMatch) title = tMatch[1];
        if (wMatch) worldSetting = wMatch[1];
        // 还原被转义的字符
        const unescape = (s: string) => s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        title = unescape(title);
        worldSetting = unescape(worldSetting);
        if (worldSetting || title) return { title: title.trim(), worldSetting: worldSetting.trim() };
    }

    // 情况①：分隔符格式
    const titleMatch = text.match(/^\s*(?:标题|title)\s*[:：]\s*(.+)$/im);
    if (titleMatch) {
        title = titleMatch[1].trim().replace(/^[《"']|[》"']$/g, '');
        text = text.replace(titleMatch[0], '').trim();
    }
    // 去掉分隔线与可能的「世界观/正文」标签
    text = text.replace(/^\s*[=\-—]{2,}\s*$/m, '').trim();
    text = text.replace(/^\s*(?:世界观设定|世界观|正文|lore)\s*[:：]?\s*/i, '').trim();

    worldSetting = text;
    return { title: title.trim(), worldSetting: worldSetting.trim() };
};

// 投掷一颗 D20
const rollD20 = () => Math.floor(Math.random() * 20) + 1;
// 把骰点结果翻译成成功度描述，供 GM 判定
const rollFlavor = (n: number) => {
    if (n === 20) return '大成功(Critical Success)';
    if (n === 1) return '大失败(Critical Failure)';
    if (n >= 15) return '成功(Success)';
    if (n >= 8) return '勉强(Partial)';
    return '失败(Failure)';
};

// --- Markdown Renderer Component ---
const GameMarkdown: React.FC<{ content: string, theme: any, customStyle?: { fontSize: number, color: string } }> = ({ content, theme, customStyle }) => {
    // Helper: Parse Inline Styles (**bold**, *italic*, `code`)
    const parseInline = (text: string) => {
        const parts = text.split(/(\*\*.*?\*\*|\*.*?\*|`.*?`)/g);
        return parts.map((part, i) => {
            if (part.startsWith('**') && part.endsWith('**')) {
                return <strong key={i} className={`font-bold ${theme.accent}`}>{part.slice(2, -2)}</strong>;
            }
            if (part.startsWith('*') && part.endsWith('*')) {
                return <em key={i} className="italic opacity-70 text-[95%] mx-0.5">{part.slice(1, -1)}</em>;
            }
            if (part.startsWith('`') && part.endsWith('`')) {
                return <code key={i} className="bg-black/20 px-1 py-0.5 rounded font-mono text-[0.9em] opacity-90 mx-0.5">{part.slice(1, -1)}</code>;
            }
            return <span key={i}>{part}</span>;
        });
    };

    // Split by newlines to handle blocks
    const lines = content.split('\n');
    
    // Dynamic Style Object
    const styleObj = {
        fontSize: customStyle ? `${customStyle.fontSize}px` : undefined,
        color: customStyle?.color || undefined
    };

    return (
        <div className="space-y-[0.5em] text-justify leading-relaxed" style={styleObj}>
            {lines.map((line, i) => {
                const trimmed = line.trim();
                if (!trimmed) return <div key={i} className="h-[0.5em]"></div>;
                
                // Headers (Relative sizing)
                if (trimmed.startsWith('### ')) return <h3 key={i} className={`text-[1.1em] font-bold uppercase tracking-wider mt-[0.5em] mb-[0.2em] opacity-90 ${theme.accent}`}>{trimmed.slice(4)}</h3>;
                if (trimmed.startsWith('## ')) return <h3 key={i} className="text-[1.25em] font-bold mt-[0.6em] mb-[0.3em] opacity-95">{trimmed.slice(3)}</h3>;
                if (trimmed.startsWith('# ')) return <h3 key={i} className="text-[1.5em] font-black mt-[0.8em] mb-[0.5em] text-center border-b border-current pb-2 opacity-90">{trimmed.slice(2)}</h3>;
                
                // Blockquotes
                if (trimmed.startsWith('> ')) return <div key={i} className="border-l-2 border-current pl-3 py-1 my-2 italic opacity-70 text-[0.9em] bg-black/5 rounded-r">{parseInline(trimmed.slice(2))}</div>;
                
                // Lists
                if (trimmed.startsWith('- ') || trimmed.startsWith('• ')) {
                    return <div key={i} className="flex gap-2 pl-1"><span className={`opacity-50 ${theme.accent}`}>•</span><span>{parseInline(trimmed.slice(2))}</span></div>;
                }

                // Numbered list
                const numMatch = trimmed.match(/^(\d+)\.\s+(.*)/);
                if (numMatch) {
                    return <div key={i} className="flex gap-2 pl-1"><span className={`font-mono opacity-60 ${theme.accent}`}>{numMatch[1]}.</span><span>{parseInline(numMatch[2])}</span></div>;
                }

                // Separator
                if (trimmed === '---' || trimmed === '***') {
                    return <div key={i} className="h-px bg-current opacity-20 my-[1em]"></div>;
                }

                // Standard Paragraph
                return <div key={i}>{parseInline(trimmed)}</div>;
            })}
        </div>
    );
};

const GameApp: React.FC = () => {
    const { closeApp, characters, userProfile, apiConfig, addToast, updateCharacter } = useOS();
    const [view, setView] = useState<'lobby' | 'create' | 'play'>('lobby');
    const [games, setGames] = useState<GameSession[]>([]);
    const [activeGame, setActiveGame] = useState<GameSession | null>(null);
    const [lobbyPage, setLobbyPage] = useState(0); // 存档大厅分页（每页 5 条）
    
    // Creation State
    const [newTitle, setNewTitle] = useState('');
    const [newWorld, setNewWorld] = useState('');
    const [newTheme, setNewTheme] = useState<GameTheme>('fantasy');
    const [selectedPlayers, setSelectedPlayers] = useState<Set<string>>(new Set());
    const [isCreating, setIsCreating] = useState(false);
    // 世界观 AI 辅助生成
    const [worldStyle, setWorldStyle] = useState<string>('高奇幻');
    const [worldIdea, setWorldIdea] = useState('');        // 用户额外给的灵感/想法（可选）
    const [isGeneratingWorld, setIsGeneratingWorld] = useState(false);

    // Play State
    const [userInput, setUserInput] = useState('');
    const [isTyping, setIsTyping] = useState(false);
    const [isSummarizing, setIsSummarizing] = useState(false); // 自动总结全屏反馈
    const [showArchived, setShowArchived] = useState(false);    // 已归档剧情折叠展开
    const [lastRoll, setLastRoll] = useState<number | null>(null); // 最近一次自动骰点结果（瞬时展示）
    const [lastTokenUsage, setLastTokenUsage] = useState<{prompt?: number, completion?: number, total: number} | null>(null);
    const [totalTokensUsed, setTotalTokensUsed] = useState(0);
    
    // [FIX] Use Container Ref instead of Element Ref for safer scrolling
    const logsContainerRef = useRef<HTMLDivElement>(null);

    // 长按删除存档卡片
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const longPressFired = useRef(false);

    // UI Toggles
    const [showSystemMenu, setShowSystemMenu] = useState(false);
    const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
    const [isArchiving, setIsArchiving] = useState(false);
    const [showTools, setShowTools] = useState(false); // Default hidden
    const [showParty, setShowParty] = useState(true);  // Default visible
    const [uiSettings, setUiSettings] = useState<{fontSize: number, color: string}>({ fontSize: 14, color: '' });

    // SAN Lock: Sync from activeGame on load
    const [sanityLocked, setSanityLocked] = useState(false);
    useEffect(() => {
        if (activeGame) setSanityLocked(!!activeGame.sanityLocked);
    }, [activeGame?.id]);

    useEffect(() => {
        loadGames();
    }, []);

    // 删除/新增存档后，把页码钳制在有效范围内
    const LOBBY_PAGE_SIZE = 5;
    useEffect(() => {
        const maxPage = Math.max(0, Math.ceil(games.length / LOBBY_PAGE_SIZE) - 1);
        if (lobbyPage > maxPage) setLobbyPage(maxPage);
    }, [games.length, lobbyPage]);

    // [FIX] Updated Auto-scroll logic: Use scrollTop on container
    useEffect(() => {
        if (view === 'play' && logsContainerRef.current) {
            // Use setTimeout to ensure render is complete, allowing smooth scroll to new bottom
            setTimeout(() => {
                if (logsContainerRef.current) {
                    logsContainerRef.current.scrollTo({
                        top: logsContainerRef.current.scrollHeight,
                        behavior: 'smooth'
                    });
                }
            }, 100);
        }
    }, [activeGame?.logs, view, isTyping]);

    const loadGames = async () => {
        const list = await DB.getAllGames();
        setGames(list.sort((a,b) => b.lastPlayedAt - a.lastPlayedAt));
    };

    // --- Helper: Robust API Call ---
    const fetchGameAPI = async (prompt: string, maxTokens: number = 8000) => {
        const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
                model: apiConfig.model,
                messages: [{ role: "user", content: prompt }],
                temperature: 0.9, 
                max_tokens: maxTokens,
                stream: false
            })
        });

        if (!response.ok) throw new Error(`HTTP Error ${response.status}`);

        const text = await response.text();
        let json: any;
        try {
            json = JSON.parse(text);
        } catch {
            // Try stripping "data: " prefix (common in proxy misconfigurations)
            const cleaned = text.replace(/^data: /, '').trim();
            try {
                json = JSON.parse(cleaned);
            } catch {
                // Detect HTML responses
                if (text.trimStart().startsWith('<')) {
                    throw new Error('API返回了HTML而非JSON，请检查API地址是否正确');
                }
                throw new Error(`API返回了无法解析的格式: ${text.slice(0, 100)}`);
            }
        }

        if (json.usage?.total_tokens) {
            const usage = {
                prompt: json.usage.prompt_tokens || undefined,
                completion: json.usage.completion_tokens || undefined,
                total: json.usage.total_tokens
            };
            setLastTokenUsage(usage);
            setTotalTokensUsed(prev => prev + json.usage.total_tokens);
        }

        return json;
    };

    // --- Helper: Build Synchronized Context (Neural Link) ---
    const buildSyncContext = async (players: CharacterProfile[]) => {
        let fullContext = "";

        // [优化] 多人同场时，把"用户档案 / 共有世界观 / 被多名角色挂载的世界书"提取到顶部
        // 只铺一次，避免每个角色块里重复贴同一份世界书（去重，省 token 也防串台）。
        const sharedScene = ContextBuilder.buildGroupSharedScene(players, userProfile);
        if (sharedScene.text) {
            fullContext += `${sharedScene.text}\n`;
        }

        for (const p of players) {
            // 1. Base Context (Identity & Worldview)
            // [优化] 记忆读取：跑团多人同场，不再倾倒每个角色逐日的详细日记（极易让 LLM 把
            //   A 的记忆安到 B 头上 = 串台）。改为 includeDetailedMemories=false（仅长期核心记忆）
            //   + 下方按需注入的记忆宫殿向量召回（只取与当前情境相关的片段）。
            //   同时跳过共享场景里已铺过的用户档案 / 世界书 / 世界观，彻底去重。
            await injectMemoryPalace(p);
            const core = ContextBuilder.buildCoreContext(p, userProfile, false, undefined, {
                skipUserProfile: true,
                skipWorldview: sharedScene.worldviewIsShared,
                skipWorldbookIds: sharedScene.sharedWorldbookIds,
            });
            fullContext += `\n<<< 角色档案: ${p.name} (ID: ${p.id}) >>>\n${core}\n`;

            // 记忆宫殿召回（includeDetailedMemories=false 时 buildCoreContext 不会自动带，这里按需补回）
            // [防串台] 召回文本自带的标题是泛指的"你脑海中浮现…"，多角色同场时"你"会混淆。
            //   这里用显式归属把它锁死到当前角色名下，并提醒 LLM 严禁挪用给别人。
            if (p.memoryPalaceEnabled && p.memoryPalaceInjection && p.memoryPalaceInjection.trim()) {
                fullContext += `\n【注意：以下记忆宫殿召回【仅属于 ${p.name}】，是 TA 一个人的私人记忆，绝不可当成其他角色的经历或挪用给别人】\n`;
                fullContext += `${p.memoryPalaceInjection}\n`;
                fullContext += `【${p.name} 的私人记忆结束】\n`;
            }

            // 2. Neural Link: Private Chat Sync
            try {
                const msgs = await DB.getMessagesByCharId(p.id, true);
                const privateMsgs = msgs.filter(m => !m.groupId); // Only private chats (Neural Link needs full history)
                
                const lastMsg = privateMsgs[privateMsgs.length - 1];
                const now = Date.now();
                let status = "普通";
                let gapDesc = "未知";
                
                if (lastMsg) {
                    const diffMins = (now - lastMsg.timestamp) / 1000 / 60;
                    if (diffMins < 60) {
                        gapDesc = `刚刚 (${Math.floor(diffMins)}分钟前)`;
                        status = "热恋/熟络 (Hot)";
                    } else if (diffMins < 24 * 60) {
                        gapDesc = `今天 (${Math.floor(diffMins/60)}小时前)`;
                        status = "正常 (Normal)";
                    } else {
                        const days = Math.floor(diffMins / (24 * 60));
                        gapDesc = `${days}天前`;
                        status = "疏远 (Cold)";
                    }
                    
                    // Get last 8 messages for context
                    const recentLog = privateMsgs.slice(-8).map(m => 
                        `[${m.role === 'user' ? 'Me' : p.name}]: ${m.content.substring(0, 40).replace(/\n/g, ' ')}`
                    ).join('\n');
                    
                    fullContext += `
=== 神经链接 (Neural Link): 私聊记忆同步 ===
该角色与玩家的【私聊状态】：${gapDesc}
关系温度: ${status}
最近私聊话题 (作为后台记忆，不要直接复述，但要影响你的态度):
${recentLog}

【GM强制指令 (Meta Instruction)】: 
1. **打破第四面墙**: 允许角色表现出“正在和用户一起玩游戏”的意识。
2. **关系继承**: 
   - 如果状态是"Hot"，跑团时要更有默契，可以吐槽“刚才私聊时你不是这么说的”。
   - 如果状态是"Cold"，跑团时可以表现得生疏、傲娇或抱怨“好久不见怎么突然拉我来冒险”。
   - **绝对禁止**像陌生人一样对待玩家。你们是老相识。
=====================================\n`;
                } else {
                    fullContext += `[神经链接: 无私聊记录] (视为初次见面)\n`;
                }
            } catch (e) {
                console.error("Sync failed for", p.name, e);
            }
            fullContext += `<<< 档案结束 >>>\n`;
        }
        return fullContext;
    };

    // --- AI 世界观生成 (帮想不出剧本的用户起一个设定) ---
    const handleGenerateWorld = async () => {
        if (!apiConfig.apiKey) {
            addToast('请先配置 API Key', 'error');
            return;
        }
        setIsGeneratingWorld(true);
        try {
            // [鲁棒性] 改用带分隔符的纯文本格式而非 JSON——即使被截断也能干净解析；
            // 不再限制字数，给足 token 防止半路砍断。
            const prompt = `你是一位资深的 TRPG（桌面跑团）剧本设计师。请按照指定风格，原创一个适合开团的世界观设定。
**风格基调**: ${worldStyle}
${worldIdea.trim() ? `**玩家的灵感/想法（请务必围绕它发挥）**: ${worldIdea.trim()}` : ''}

请严格按下面的纯文本格式输出，**不要用 JSON，不要代码块，不要额外说明**：

标题：<一个有吸引力的剧本标题>
===
<世界观正文。请写充分、生动，篇幅自由不设上限，包含：时代/地点背景与基调氛围、当前世界的核心矛盾或危机、玩家小队的处境与初始目标钩子、一两个可探索的悬念或势力。留足玩家发挥空间，不要写死结局。>`;

            const data = await fetchGameAPI(prompt, 6000);
            const raw = (extractContent(data) || '').trim();
            if (!raw) throw new Error('AI 返回了空响应');

            const parsed = parseWorldGen(raw);
            if (parsed.worldSetting) setNewWorld(parsed.worldSetting);
            if (parsed.title && !newTitle.trim()) setNewTitle(parsed.title);
            addToast('世界观已生成，可继续编辑', 'success');
        } catch (e: any) {
            addToast(`生成失败: ${e.message}`, 'error');
        } finally {
            setIsGeneratingWorld(false);
        }
    };

    // --- Creation Logic ---
    const handleCreateGame = async () => {
        if (!newTitle.trim() || !newWorld.trim() || selectedPlayers.size === 0) {
            addToast('请填写完整信息并选择至少一名角色', 'error');
            return;
        }
        
        if (!apiConfig.apiKey) {
            addToast('请先配置 API Key 以生成序章', 'error');
            return;
        }

        setIsCreating(true);

        try {
            const tempId = `game-${Date.now()}`;
            const players = characters.filter(c => selectedPlayers.has(c.id));
            
            // Build Context with Sync
            const playerContext = await buildSyncContext(players);

            // Generate Prologue Prompt
            const prompt = `### TRPG 序章生成 (Game Start)
**剧本标题**: ${newTitle}
**世界观设定**: ${newWorld}
**玩家**: ${userProfile.name}
**队友**: ${players.map(p => p.name).join(', ')}

### 角色数据 (包含私聊记忆)
${playerContext}

### 任务
你现在是 **Game Master (GM)**。请为这个冒险故事生成一个**精彩的开场 (Prologue)**。
1. **剧情描述**: 描述这个世界正在发生什么、小队所处的环境与正在逼近的事件。**先有世界，再有人**——开场不要围着玩家转，而是把舞台和危机铺开。
2. **角色反应**: 简要描述队友们的初始状态或第一句台词。请**务必**参考【神经链接】中的私聊状态来决定他们的态度；同时让每个角色展现**自己的性格与目的**，而不是一上来就众星捧月地讨好玩家。
3. **初始选项**: 给出三个玩家可以采取的行动选项（每个选项玩家执行时都会自动骰 D20 判定，因此选项应是"有成败风险的尝试"而非必然成功的动作）。

### 一致性自检 (Consistency Check)
输出前，请在心里核对：每个角色的台词/行为是否**只**来自 TA 自己的"角色档案"（性格、记忆、印象）？严禁把某个角色的记忆、口癖或人设安到另一个角色身上（防止"串台"）。

### 输出格式 (Strict JSON)
{
  "gm_narrative": "序章剧情描述...",
  "characters": [
    { "charId": "角色ID", "action": "初始动作", "dialogue": "第一句台词" }
  ],
  "startLocation": "起始地点名称",
  "suggested_actions": [
    { "label": "选项1 (中立/正直/推进剧情)", "type": "neutral" },
    { "label": "选项2 (乐子人/搞怪/出其不意)", "type": "chaotic" },
    { "label": "选项3 (邪恶/激进/贪婪)", "type": "evil" }
  ]
}`;

            const data = await fetchGameAPI(prompt);
            const rawContent = extractContent(data);
            if (!rawContent) throw new Error('AI 返回了空响应');

            // Robust JSON extraction: handles code fences, trailing commas, extra prose
            const res = extractJson(rawContent);

            const initialLogs: GameLog[] = [];

            if (res) {
                // Structured response - use parsed JSON
                initialLogs.push({
                    id: 'init-gm',
                    role: 'gm',
                    content: `### 序章 · ${newTitle}\n\n${res.gm_narrative || '冒险开始了...'}`,
                    timestamp: Date.now()
                });

                if (Array.isArray(res.characters)) {
                    for (const charAct of res.characters) {
                        const char = players.find(p => p.id === charAct.charId || p.name === charAct.charId);
                        if (char) {
                            initialLogs.push({
                                id: `init-char-${char.id}`,
                                role: 'character',
                                speakerName: char.name,
                                content: `*${charAct.action || ''}* \n"${charAct.dialogue || ''}"`,
                                timestamp: Date.now()
                            });
                        }
                    }
                }
            } else {
                // JSON parse completely failed - use raw text as GM narrative anyway
                console.warn('[GameApp] JSON extraction failed, using raw text as narrative');
                initialLogs.push({
                    id: 'init-gm',
                    role: 'gm',
                    content: `### 序章 · ${newTitle}\n\n${rawContent}`,
                    timestamp: Date.now()
                });
            }

            const newGame: GameSession = {
                id: tempId,
                title: newTitle,
                theme: newTheme,
                worldSetting: newWorld,
                playerCharIds: Array.from(selectedPlayers),
                logs: initialLogs,
                status: {
                    location: res?.startLocation || 'Unknown',
                    health: 100,
                    sanity: 100,
                    gold: 0,
                    inventory: []
                },
                suggestedActions: res?.suggested_actions || [],
                createdAt: Date.now(),
                lastPlayedAt: Date.now()
            };

            await DB.saveGame(newGame);
            setGames(prev => [newGame, ...prev]);
            setActiveGame(newGame);
            setView('play');
            
            // Reset form
            setNewTitle('');
            setNewWorld('');
            setWorldIdea('');
            setSelectedPlayers(new Set());

        } catch (e: any) {
            addToast(`创建失败: ${e.message}`, 'error');
        } finally {
            setIsCreating(false);
        }
    };

    // --- SAN Lock Toggle ---
    const toggleSanityLock = async () => {
        const newVal = !sanityLocked;
        setSanityLocked(newVal);
        if (activeGame) {
            const updated = { ...activeGame, sanityLocked: newVal };
            setActiveGame(updated);
            await DB.saveGame(updated);
            addToast(newVal ? 'SAN 值已锁定' : 'SAN 值已解锁', 'info');
        }
    };

    // --- Gameplay Logic ---
    const handleAction = async (actionText: string, isReroll: boolean = false) => {
        if (!activeGame || !apiConfig.apiKey) return;

        let contextLogs = activeGame.logs;
        let updatedGame = activeGame;
        let currentRoll: number | null = null;

        if (!isReroll) {
            const isSystemAction = actionText.startsWith('[System');
            // [优化] 每个玩家行动默认自动骰一颗 D20（不再需要主动点骰子）。
            // 系统消息不骰点。
            if (!isSystemAction && actionText.trim()) {
                currentRoll = rollD20();
                setLastRoll(currentRoll);
                addToast(`D20 = ${currentRoll} · ${rollFlavor(currentRoll)}`, 'info');
            }

            // Standard Action: Append user log
            const userLog: GameLog = {
                id: `log-${Date.now()}`,
                role: isSystemAction ? 'system' : 'player',
                speakerName: userProfile.name,
                content: actionText,
                timestamp: Date.now(),
                diceRoll: currentRoll ? { result: currentRoll, max: 20 } : undefined
            };

            const updatedLogs = [...activeGame.logs, userLog];
            updatedGame = { ...activeGame, logs: updatedLogs, lastPlayedAt: Date.now(), suggestedActions: [] }; // Clear options while thinking
            setActiveGame(updatedGame);
            await DB.saveGame(updatedGame);
            contextLogs = updatedLogs;
        }

        setUserInput('');
        setIsTyping(true);
        setLastTokenUsage(null);
        addToast('GM 正在推演...', 'info'); // Feedback for Sync

        try {
            // 2. Build Context WITH RELATIONSHIP SYNC
            const players = characters.filter(c => activeGame.playerCharIds.includes(c.id));
            const playerContext = await buildSyncContext(players);

            // 3. Build Status Warning
            let statusWarning = "";
            if (activeGame.status.health <= 30) statusWarning += "\n[WARNING: LOW HP] 玩家濒临死亡，请描述极度的虚弱、伤痛、视野模糊或濒死体验。\n";
            if (activeGame.status.sanity <= 30) statusWarning += "\n[WARNING: LOW SAN] 玩家理智崩溃中，请描述疯狂、幻听、幻视或不可名状的恐惧。\n";
            
            let gameOverTrigger = "";
            if (activeGame.status.health <= 0 || activeGame.status.sanity <= 0) {
                gameOverTrigger = "\n[GAME OVER TRIGGER] 玩家的生命值或理智值已归零。请生成一个悲惨或疯狂的结局 (Bad Ending)，结束本次冒险。\n";
            }

            // [优化] 历史记录：已归档的旧剧情用「前情提要」总结代替，未归档日志保留原文，
            //   并把每条玩家行动的骰点结果一并喂给 GM 用于判定（之前 GM 根本看不到骰点）。
            const serializeLog = (l: GameLog) => {
                const who = l.role === 'gm' ? 'GM' : (l.speakerName || 'System');
                const dice = l.diceRoll ? ` 〔D20=${l.diceRoll.result}/${rollFlavor(l.diceRoll.result)}〕` : '';
                return `[${who}]${dice}: ${l.content}`;
            };
            const summaries = activeGame.summaries || [];
            const recapBlock = summaries.length > 0
                ? `### 前情提要 (Story So Far)\n${summaries.map((s, i) => `【第${i + 1}段】${s.content}`).join('\n\n')}\n\n`
                : '';
            const activeLogText = contextLogs.filter(l => !l.archived).map(serializeLog).join('\n');

            // 当前这步行动的骰点提示
            const rollInstruction = currentRoll
                ? `\n### 本回合判定\n玩家这次行动掷出了 **D20 = ${currentRoll}（${rollFlavor(currentRoll)}）**。请据此裁定行动的成败与代价：20=出乎意料的大成功，1=灾难性大失败，高分顺利、低分受挫。让结果自然融入叙事，不要直接复述数字。\n`
                : '';

            const prompt = `### TRPG 跑团模式: ${activeGame.title}
**当前剧本**: ${activeGame.worldSetting}
**当前场景**: ${activeGame.status.location}
**队伍资源**:
- HP: ${activeGame.status.health}%
- SAN: ${activeGame.status.sanity || 100}%
- GOLD: ${activeGame.status.gold || 0}
- 物品: ${activeGame.status.inventory.join(', ') || '空'}

${statusWarning}
${gameOverTrigger}

### 冒险小队 (The Party)
1. **${userProfile.name}** (玩家/User)
${players.map(p => `2. **${p.name}** (ID: ${p.id}) - 你的队友`).join('\n')}

### 角色档案 & 神经链接 (Character Sheets & Neural Links)
${playerContext}

${recapBlock}### 冒险记录 (Recent Log)
${activeLogText}
${rollInstruction}
### GM 指令 (Game Master Instructions)
你现在是这场跑团游戏的 **主持人 (GM)**。
**现在的状态**：这是一群真实的朋友（基于神经链接中的私聊关系）在一起玩跑团游戏。

**请遵循以下法则**：
1. **全员「入戏」 (Roleplay First)**:
   - 队友们是活生生的冒险者，但同时也带着私聊时的记忆和情感。
   - **拒绝机械感**: 他们应该主动观察环境、吐槽现状、互相开玩笑。
   - **私聊影响 (关键)**: 请根据【神经链接】中的“关系温度”和“最近话题”来调整每个角色的反应。
   - **队内互动**: 队友之间也可以有互动（比如A吐槽B的计划）。

2. **去玩家中心 · 让世界自己转 (关键)**:
   - **拒绝修罗场**: 队友们不是来讨好/争抢玩家的 NPC。不要让所有人都把注意力黏在玩家身上、抢着对玩家示好。
   - **各有所图**: 每个角色都带着**自己的目的、立场和情绪**行动，可以分歧、可以自顾自做事、可以暂时忽略玩家。
   - **因地制宜**: 同一个角色在战斗、社交、独处、危机等不同环境下应表现出**不同侧面**，而非一套反应走到底。
   - **剧情自驱**: 世界有自己的节奏——即使玩家什么都不做，也会有事件发生、势力推进、NPC 行动。主动推动主线。

3. **硬核 GM 风格**:
   - **制造冲突**: 不要让旅途一帆风顺。安排陷阱、突发战斗、尴尬的社交场面、或者道德困境。
   - **环境描写**: 描述光影、气味、声音，营造沉浸感。
   - **骰点判定**: 严格依据【本回合判定】的 D20 结果裁定成败，骰得低就要有真实代价。
   - **Markdown 排版**: 请在 \`gm_narrative\` 和 \`dialogue\` 中**积极使用 Markdown**。例如：使用 **加粗** 强调重点，使用 *斜体* 描述动作。

4. **生成选项 (Action Options)**:
   - 请根据当前局势，为玩家提供 3 个可选的行动建议（玩家选择后都会自动骰 D20，因此选项应是有成败风险的尝试）。

### 一致性自检 (Consistency Check)
输出前请最后核对一遍：每个角色的台词、记忆、口癖、性格是否**严格来自 TA 各自的"角色档案"**？绝不能把一个角色的记忆/人设/经历安到另一个角色身上（防止"串台"）。如发现串台，请改正后再输出。

### 输出格式 (Strict JSON)
请仅输出 JSON，不要包含 Markdown 代码块。
{
  "gm_narrative": "GM的剧情描述 (支持Markdown)...",
  "characters": [
    { 
      "charId": "角色ID (必须对应上方列表)", 
      "action": "动作描述", 
      "dialogue": "台词" 
    }
  ],
  "newLocation": "新地点 (可选)",
  "hpChange": 0,
  "sanityChange": 0,
  "goldChange": 0,
  "newItem": "获得物品 (可选)",
  "suggested_actions": [
    { "label": "选项1文本", "type": "neutral" },
    { "label": "选项2文本", "type": "chaotic" },
    { "label": "选项3文本", "type": "evil" }
  ]
}`;

            const data = await fetchGameAPI(prompt);
            const rawContent = extractContent(data);
            if (!rawContent) throw new Error('AI 返回了空响应');

            // Robust JSON extraction
            const res = extractJson(rawContent);

            const newLogs: GameLog[] = [];
            const newStatus = { ...updatedGame.status };

            if (res) {
                // Structured response - use parsed JSON
                if (res.gm_narrative) {
                    newLogs.push({
                        id: `gm-${Date.now()}`,
                        role: 'gm',
                        content: res.gm_narrative,
                        timestamp: Date.now()
                    });
                }

                if (Array.isArray(res.characters)) {
                    for (const charAct of res.characters) {
                        const char = players.find(p => p.id === charAct.charId || p.name === charAct.charId);
                        if (char) {
                            const combinedContent = `*${charAct.action || ''}* \n"${charAct.dialogue || ''}"`;
                            newLogs.push({
                                id: `char-${Date.now()}-${Math.random()}`,
                                role: 'character',
                                speakerName: char.name,
                                content: combinedContent,
                                timestamp: Date.now()
                            });
                        }
                    }
                }

                // Update State (Stats)
                if (res.newLocation) newStatus.location = res.newLocation;
                if (res.hpChange) newStatus.health = Math.max(0, Math.min(100, (newStatus.health || 100) + res.hpChange));
                if (res.sanityChange && !sanityLocked) newStatus.sanity = Math.max(0, Math.min(100, (newStatus.sanity || 100) + res.sanityChange));
                if (res.goldChange) newStatus.gold = Math.max(0, (newStatus.gold || 0) + res.goldChange);
                if (res.newItem) newStatus.inventory = [...newStatus.inventory, res.newItem];
            } else {
                // JSON parse completely failed - still show the raw text as GM narrative
                console.warn('[GameApp] JSON extraction failed, using raw text as narrative');
                newLogs.push({
                    id: `gm-${Date.now()}`,
                    role: 'gm',
                    content: rawContent,
                    timestamp: Date.now()
                });
            }

            const finalGame = {
                ...updatedGame,
                logs: [...contextLogs, ...newLogs],
                status: newStatus,
                suggestedActions: res?.suggested_actions || []
            };
            
            setActiveGame(finalGame);
            await DB.saveGame(finalGame);

            // 回合结束后检查是否需要自动总结归档前文
            setIsTyping(false);
            await runAutoSummaryIfNeeded(finalGame);

        } catch (e: any) {
            addToast(`GM 掉线了: ${e.message}`, 'error');
        } finally {
            setIsTyping(false);
        }
    };

    // --- 自动总结 (每累积 AUTO_SUMMARY_THRESHOLD 条未归档日志触发一次) ---
    // 把旧剧情压缩成小说式「前情提要」，归档折叠原文（不删除），并把总结小卡片
    // 发送到参与角色的记忆与聊天上下文里。
    const runAutoSummaryIfNeeded = async (game: GameSession) => {
        const nonArchived = game.logs.filter(l => !l.archived);
        if (nonArchived.length < AUTO_SUMMARY_THRESHOLD) return;

        // 保留最近 KEEP_RECENT_AFTER_SUMMARY 条不折叠，保证连贯
        const toArchive = nonArchived.slice(0, nonArchived.length - KEEP_RECENT_AFTER_SUMMARY);
        if (toArchive.length < 6) return; // 太少不值得总结

        setIsSummarizing(true);
        try {
            const players = characters.filter(c => game.playerCharIds.includes(c.id));
            const playerNames = players.map(p => p.name).join('、');
            const prevRecap = (game.summaries || []).map((s, i) => `【第${i + 1}段】${s.content}`).join('\n');

            const logText = toArchive.map(l => {
                const who = l.role === 'gm' ? 'GM' : (l.speakerName || 'System');
                return `[${who}]: ${l.content}`;
            }).join('\n');

            const prompt = `你是一位擅长写小说的记录者。请把下面这段 TRPG 跑团剧情，总结成一段**连贯、生动、像小说梗概一样**的前情提要。
${prevRecap ? `\n【已有前情（仅供衔接，不要重复）】\n${prevRecap}\n` : ''}
【本段需要总结的剧情记录】
${logText}

要求：
1. 用第三人称叙述，包含【起因 → 经过 → 结果】的来龙去脉。
2. 重点写清楚**人物之间的关系变化与各自的处境/情绪**（谁和谁更近了/起了冲突/暴露了什么）。
3. 控制在 200~350 字，文笔流畅，不要分点罗列，不要写"总结如下"之类的开场白。

直接输出总结正文：`;

            const data = await fetchGameAPI(prompt, 1500);
            let summaryText = (extractContent(data) || '').trim();
            if (!summaryText) summaryText = '（这段冒险继续推进了剧情）';

            const newSummary: GameSummary = {
                id: `sum-${Date.now()}`,
                content: summaryText,
                logCount: toArchive.length,
                createdAt: Date.now(),
            };

            // 折叠归档原文（标记 archived，不删除）
            const archiveIds = new Set(toArchive.map(l => l.id));
            const archivedLogs = game.logs.map(l => archiveIds.has(l.id) ? { ...l, archived: true } : l);

            const updated: GameSession = {
                ...game,
                logs: archivedLogs,
                summaries: [...(game.summaries || []), newSummary],
            };
            setActiveGame(updated);
            await DB.saveGame(updated);

            // 以小卡片形式发送到参与角色的记忆与聊天上下文
            const now = new Date();
            const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            const cardLine = `和【${playerNames}】一起玩《${game.title}》TRPG，${summaryText}`;
            for (const p of players) {
                const mem = {
                    id: `mem-${Date.now()}-${Math.random()}`,
                    date: dateStr,
                    summary: cardLine,
                    mood: 'fun'
                };
                updateCharacter(p.id, { memories: [...(p.memories || []), mem] });
                await DB.saveMessage({
                    charId: p.id,
                    role: 'system',
                    type: 'text',
                    content: `[TRPG 进度卡: 你正和${playerNames}玩《${game.title}》。${summaryText}]`
                });
            }
            addToast('已自动总结并归档前文', 'success');
        } catch (e) {
            console.error('[GameApp] auto summary failed', e);
            // 总结失败不阻塞游戏，静默跳过
        } finally {
            setIsSummarizing(false);
        }
    };

    const handleReroll = async () => {
        if (!activeGame || isTyping) return;
        
        // Find index of last user/system action
        const logs = activeGame.logs;
        let lastUserIndex = -1;
        for (let i = logs.length - 1; i >= 0; i--) {
            if (logs[i].role === 'player' || logs[i].role === 'system') {
                lastUserIndex = i;
                break;
            }
        }

        if (lastUserIndex === -1) {
            addToast('没有可供重生的上下文', 'info');
            return;
        }

        // Keep logs up to and including the last user input
        const contextLogs = logs.slice(0, lastUserIndex + 1);
        
        // Optimistic Update
        const rolledBackGame = { ...activeGame, logs: contextLogs };
        setActiveGame(rolledBackGame);
        
        await handleAction("", true); // isReroll = true
        addToast('正在重新推演命运...', 'info');
    };

    const handleRollbackLog = async (index: number) => {
        if (!activeGame) return;
        if (!confirm("回退到此条记录？\n(注意：此操作将删除该条记录之后的所有内容，但不会自动重置HP/物品状态，请手动调整)")) return;
        
        const newLogs = activeGame.logs.slice(0, index + 1);
        const updated = { ...activeGame, logs: newLogs };
        await DB.saveGame(updated);
        setActiveGame(updated);
        addToast('时间回溯成功', 'success');
    };

    const handleRestart = async () => {
        if (!activeGame) return;
        if (!confirm('确定要重置当前游戏吗？所有进度将丢失。')) return;

        const initialLog: GameLog = {
            id: 'init',
            role: 'gm',
            content: `欢迎来到 "${activeGame.title}"。\n世界观载入中...\n${activeGame.worldSetting}`,
            timestamp: Date.now()
        };

        const resetGame: GameSession = {
            ...activeGame,
            logs: [initialLog],
            status: {
                location: 'Start Point',
                health: 100,
                sanity: 100,
                gold: 0,
                inventory: []
            },
            suggestedActions: [],
            lastPlayedAt: Date.now()
        };

        await DB.saveGame(resetGame);
        setActiveGame(resetGame);
        setShowSystemMenu(false);
        addToast('游戏已重置', 'success');
    };

    // "Leave" just goes back to lobby (Auto-save is handled by DB calls in handleAction)
    const handleLeave = () => {
        setActiveGame(null);
        setView('lobby');
        setShowSystemMenu(false);
    };

    const handleArchiveAndQuit = async () => {
        if (!activeGame) return;
        setIsArchiving(true);
        setShowSystemMenu(false);
        
        try {
            const players = characters.filter(c => activeGame.playerCharIds.includes(c.id));
            const playerNames = players.map(p => p.name).join('、');
            // Increase log context for summary
            const logText = activeGame.logs.slice(-30).map(l => `${l.role}: ${l.content}`).join('\n');
            
            const prompt = `Task: Summarize the key events of this TRPG session into a short clause (what happened).
Game: ${activeGame.title}
Logs:
${logText}
Output: A concise summary in Chinese (e.g. "探索了地牢并击败了史莱姆"). No preamble.`;

            const data = await fetchGameAPI(prompt);
            let summary = extractContent(data) || '进行了一场冒险';
            summary = summary.replace(/[。\.]$/, ''); // Remove trailing dot

            // Format: 【角色名们】和【用户名】一起玩了xxx，发生了xxxx
            const memoryContent = `【${playerNames}】和【${userProfile.name}】一起玩了《${activeGame.title}》，发生了${summary}`;
            
            // Format: YYYY-MM-DD
            const now = new Date();
            const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

            for (const p of players) {
                // 1. Inject into Memory
                const mem = {
                    id: `mem-${Date.now()}-${Math.random()}`,
                    date: dateStr,
                    summary: memoryContent,
                    mood: 'fun'
                };
                updateCharacter(p.id, { memories: [...(p.memories || []), mem] });

                // 2. Inject into Context via System Message
                await DB.saveMessage({
                    charId: p.id,
                    role: 'system',
                    type: 'text',
                    content: `[TRPG 归档提醒: 刚刚你们一起玩了《${activeGame.title}》。${summary}。]`
                });
            }
            addToast('记忆传递完成 (Chat & Memory)', 'success');
        } catch (e) {
            console.error(e);
            addToast('归档失败', 'error');
        } finally {
            setIsArchiving(false);
            setView('lobby'); 
            setActiveGame(null);
        }
    };

    const handleDeleteGame = (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        setDeleteConfirmId(id);
    };

    // 长按卡片删除：按住约 550ms 触发删除确认，并抑制随后的点击进入
    const startLongPress = (id: string) => {
        longPressFired.current = false;
        cancelLongPress();
        longPressTimer.current = setTimeout(() => {
            longPressFired.current = true;
            if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(30);
            setDeleteConfirmId(id);
        }, 550);
    };
    const cancelLongPress = () => {
        if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
        }
    };
    const handleCardOpen = (g: GameSession) => {
        if (longPressFired.current) { longPressFired.current = false; return; } // 长按已触发删除，忽略点击
        setActiveGame(g);
        setView('play');
    };

    const confirmDeleteGame = async () => {
        if (!deleteConfirmId) return;
        await DB.deleteGame(deleteConfirmId);
        setGames(prev => prev.filter(g => g.id !== deleteConfirmId));
        setDeleteConfirmId(null);
        addToast('存档已删除', 'success');
    };

    // --- Renderers ---

    // 1. Lobby View (Redesigned)
    if (view === 'lobby') {
        return (
            <div className="h-full w-full bg-[#0a0a0a] flex flex-col font-sans relative overflow-hidden">
                {/* Ambient Background */}
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-900/20 via-slate-900/50 to-black z-0"></div>
                <div className="absolute inset-0 z-0 opacity-20" style={{ backgroundImage: 'url("https://www.transparenttextures.com/patterns/stardust.png")' }}></div>

                {/* Header */}
                <div className="h-20 flex items-end justify-between px-6 pb-4 shrink-0 z-10">
                    <button onClick={closeApp} className="p-2 -ml-2 hover:bg-white/10 rounded-full text-white/70 transition-colors">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                    </button>
                    <span className="font-black tracking-[0.2em] text-xl text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-pink-600">TRPG ADVENTURE</span>
                    <button onClick={() => setView('create')} className="w-10 h-10 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center text-white border border-white/10 shadow-lg active:scale-95 transition-all hover:bg-white/20">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                    </button>
                </div>

                {/* Games Grid */}
                <div className="px-6 pt-6 pb-2 flex-1 overflow-y-auto no-scrollbar z-10 space-y-4">
                    {games.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-64 text-slate-500 gap-4">
                            <div className="w-20 h-20 rounded-full bg-white/5 flex items-center justify-center border border-white/5 animate-pulse"><Planet size={48} className="text-indigo-400" /></div>
                            <p className="text-xs tracking-widest uppercase">No Active Adventures</p>
                        </div>
                    )}
                    {games.length > 0 && (
                        <p className="text-[10px] text-white/30 tracking-widest uppercase text-center -mt-2">长按卡片可删除</p>
                    )}
                    {games.slice(lobbyPage * LOBBY_PAGE_SIZE, lobbyPage * LOBBY_PAGE_SIZE + LOBBY_PAGE_SIZE).map(g => {
                        const themeStyle = GAME_THEMES[g.theme] || GAME_THEMES.fantasy;
                        return (
                            <div
                                key={g.id}
                                onClick={() => handleCardOpen(g)}
                                onPointerDown={() => startLongPress(g.id)}
                                onPointerUp={cancelLongPress}
                                onPointerLeave={cancelLongPress}
                                onPointerCancel={cancelLongPress}
                                onContextMenu={(e) => e.preventDefault()}
                                className={`relative overflow-hidden rounded-2xl p-5 cursor-pointer group active:scale-[0.98] transition-all border border-white/5 hover:border-white/20 shadow-lg select-none`}
                            >
                                {/* Card Background */}
                                <div className={`absolute inset-0 bg-gradient-to-br ${themeStyle.gradient} opacity-80 group-hover:opacity-100 transition-opacity`}></div>
                                <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] opacity-10"></div>
                                
                                <div className="relative z-10 flex flex-col gap-2">
                                    <div className="flex justify-between items-start">
                                        <h3 className={`font-bold text-lg text-white leading-tight drop-shadow-md font-serif`}>{g.title}</h3>
                                        <span className={`text-[10px] px-2 py-0.5 rounded border border-white/20 text-white/80 uppercase font-mono tracking-wider bg-black/20`}>{g.theme}</span>
                                    </div>
                                    
                                    <p className="text-xs text-white/60 line-clamp-2 leading-relaxed italic font-serif border-l-2 border-white/20 pl-2">
                                        "{g.worldSetting}"
                                    </p>
                                    
                                    <div className="flex justify-between items-end mt-2 pt-2 border-t border-white/10">
                                        <div className="flex -space-x-2">
                                            {characters.filter(c => g.playerCharIds.includes(c.id)).map(c => (
                                                <img key={c.id} src={c.avatar} className="w-8 h-8 rounded-full border-2 border-black/50 object-cover shadow-sm" />
                                            ))}
                                        </div>
                                        <div className="text-[10px] text-white/40 font-mono">
                                            {new Date(g.lastPlayedAt).toLocaleDateString()}
                                        </div>
                                    </div>
                                </div>

                                {/* Delete Button */}
                                <button onClick={(e) => handleDeleteGame(e, g.id)} className="absolute top-2 right-2 p-2 text-white/20 hover:text-red-400 z-20 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
                                </button>
                            </div>
                        );
                    })}
                </div>

                {/* Pager (每页 5 条) */}
                {games.length > LOBBY_PAGE_SIZE && (() => {
                    const totalPages = Math.ceil(games.length / LOBBY_PAGE_SIZE);
                    return (
                        <div className="flex items-center justify-center gap-4 px-6 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-2 shrink-0 z-10">
                            <button
                                onClick={() => setLobbyPage(p => Math.max(0, p - 1))}
                                disabled={lobbyPage === 0}
                                className="w-9 h-9 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-white/70 active:scale-95 transition-all disabled:opacity-25 hover:bg-white/10"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                            </button>
                            <div className="flex items-center gap-1.5">
                                {Array.from({ length: totalPages }).map((_, i) => (
                                    <button
                                        key={i}
                                        onClick={() => setLobbyPage(i)}
                                        className={`rounded-full transition-all ${i === lobbyPage ? 'w-5 h-1.5 bg-purple-400' : 'w-1.5 h-1.5 bg-white/25 hover:bg-white/40'}`}
                                    />
                                ))}
                            </div>
                            <button
                                onClick={() => setLobbyPage(p => Math.min(totalPages - 1, p + 1))}
                                disabled={lobbyPage >= totalPages - 1}
                                className="w-9 h-9 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-white/70 active:scale-95 transition-all disabled:opacity-25 hover:bg-white/10"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
                            </button>
                        </div>
                    );
                })()}

                {/* Delete Save Confirm Modal (lobby) */}
                <Modal isOpen={!!deleteConfirmId} title="删除存档" onClose={() => setDeleteConfirmId(null)} footer={
                    <div className="flex gap-3 w-full">
                        <button onClick={() => setDeleteConfirmId(null)} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl">取消</button>
                        <button onClick={confirmDeleteGame} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl shadow-lg shadow-red-200">删除</button>
                    </div>
                }>
                    <p className="text-sm text-slate-600 text-center py-4">确定要删除这个存档吗？<br/><span className="text-xs text-red-400 mt-1 block">此操作不可恢复。</span></p>
                </Modal>
            </div>
        );
    }

    // 2. Create View
    if (view === 'create') {
        const THEME_META: Record<GameTheme, { label: string; en: string; gradient: string }> = {
            fantasy: { label: '奇幻', en: 'FANTASY', gradient: 'from-amber-700 to-orange-900' },
            cyber: { label: '赛博', en: 'CYBER', gradient: 'from-cyan-600 to-indigo-900' },
            horror: { label: '恐怖', en: 'HORROR', gradient: 'from-red-800 to-black' },
            modern: { label: '现代', en: 'MODERN', gradient: 'from-sky-500 to-slate-700' },
        };
        const canStart = newTitle.trim() && newWorld.trim() && selectedPlayers.size > 0;
        return (
            <div className="h-full w-full bg-[#0a0a0a] text-white flex flex-col font-sans relative overflow-hidden">
                {/* Ambient Background */}
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-900/30 via-slate-900/40 to-black z-0"></div>
                <div className="absolute inset-0 z-0 opacity-20" style={{ backgroundImage: 'url("https://www.transparenttextures.com/patterns/stardust.png")' }}></div>

                {/* Header */}
                <div className="h-20 flex items-end px-5 pb-4 shrink-0 z-10">
                    <button onClick={() => setView('lobby')} className="p-2 -ml-2 rounded-full text-white/70 hover:bg-white/10 transition-colors"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg></button>
                    <span className="font-black tracking-[0.15em] text-base ml-1 mb-1 text-transparent bg-clip-text bg-gradient-to-r from-purple-300 to-pink-500">创建新世界</span>
                </div>

                <div className="flex-1 overflow-y-auto px-5 pb-6 space-y-5 z-10 no-scrollbar">
                    {/* 剧本标题 */}
                    <div>
                        <label className="text-[11px] font-bold text-white/40 uppercase tracking-wider block mb-2">剧本标题</label>
                        <input value={newTitle} onChange={e => setNewTitle(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3.5 text-sm text-white placeholder-white/25 focus:border-purple-400/60 focus:bg-white/10 outline-none transition-all" placeholder="例如：勇者斗恶龙" />
                    </div>

                    {/* 世界观设定 */}
                    <div>
                        <label className="text-[11px] font-bold text-white/40 uppercase tracking-wider block mb-2">世界观设定 (Lore)</label>
                        <textarea value={newWorld} onChange={e => setNewWorld(e.target.value)} className="w-full h-36 bg-white/5 border border-white/10 rounded-2xl px-4 py-3.5 text-sm leading-relaxed text-white placeholder-white/25 focus:border-purple-400/60 focus:bg-white/10 outline-none resize-none transition-all" placeholder="描述你的世界... 没思路的话，用下方 AI 帮你生成" />

                        {/* AI 世界观生成面板 */}
                        <div className="mt-3 rounded-2xl p-4 bg-gradient-to-br from-purple-500/10 to-pink-500/5 border border-purple-400/20 backdrop-blur-sm">
                            <div className="flex items-center gap-2 mb-3">
                                <span className="w-1 h-3.5 rounded-full bg-gradient-to-b from-purple-400 to-pink-400"></span>
                                <span className="text-xs font-bold text-purple-200">没思路？让 AI 帮你写</span>
                            </div>

                            {/* 风格选择 */}
                            <div className="grid grid-cols-5 gap-1.5 mb-3">
                                {WORLD_STYLES.map(s => (
                                    <button
                                        key={s}
                                        onClick={() => setWorldStyle(s)}
                                        className={`px-1 py-1.5 rounded-lg text-[10px] font-medium border transition-all active:scale-95 ${worldStyle === s ? 'bg-purple-500 text-white border-purple-400 shadow-lg shadow-purple-500/30' : 'bg-white/5 text-white/50 border-white/10 hover:bg-white/10'}`}
                                    >{s}</button>
                                ))}
                            </div>

                            {/* 额外灵感输入 (可选) */}
                            <input
                                value={worldIdea}
                                onChange={e => setWorldIdea(e.target.value)}
                                className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-white placeholder-white/25 focus:border-purple-400/60 outline-none transition-all mb-3"
                                placeholder="再补充点想法？(可选，如：主角是失忆的赏金猎人)"
                            />

                            <button
                                onClick={handleGenerateWorld}
                                disabled={isGeneratingWorld}
                                className="w-full text-xs font-bold py-2.5 rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 text-white active:scale-95 transition-transform flex items-center justify-center gap-2 disabled:opacity-60 shadow-lg shadow-purple-500/20"
                            >
                                {isGeneratingWorld ? <><div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div> 正在生成「{worldStyle}」世界...</> : <>生成世界观</>}
                            </button>
                        </div>
                    </div>

                    {/* 画风主题 */}
                    <div>
                        <label className="text-[11px] font-bold text-white/40 uppercase tracking-wider block mb-2">画风主题</label>
                        <div className="grid grid-cols-4 gap-2">
                            {(['fantasy', 'cyber', 'horror', 'modern'] as GameTheme[]).map(t => {
                                const meta = THEME_META[t];
                                const active = newTheme === t;
                                return (
                                    <button key={t} onClick={() => setNewTheme(t)} className={`relative overflow-hidden rounded-xl py-4 flex flex-col items-center gap-0.5 border transition-all active:scale-95 ${active ? 'border-white/60 ring-1 ring-white/40' : 'border-white/10'}`}>
                                        <div className={`absolute inset-0 bg-gradient-to-br ${meta.gradient} ${active ? 'opacity-90' : 'opacity-40'} transition-opacity`}></div>
                                        <span className="relative text-sm font-bold tracking-wide">{meta.label}</span>
                                        <span className="relative text-[8px] font-mono tracking-[0.2em] opacity-70">{meta.en}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* 邀请玩家 */}
                    <div>
                        <label className="text-[11px] font-bold text-white/40 uppercase tracking-wider block mb-2 flex items-center justify-between">
                            <span>邀请队友</span>
                            {selectedPlayers.size > 0 && <span className="text-purple-300 normal-case font-mono">已选 {selectedPlayers.size} 人</span>}
                        </label>
                        {characters.length === 0 ? (
                            <p className="text-xs text-white/30 py-4 text-center bg-white/5 rounded-xl border border-white/10">还没有角色，先去创建角色吧</p>
                        ) : (
                            <div className="grid grid-cols-4 gap-3">
                                {characters.map(c => {
                                    const sel = selectedPlayers.has(c.id);
                                    return (
                                        <div key={c.id} onClick={() => { const s = new Set(selectedPlayers); if(s.has(c.id)) s.delete(c.id); else s.add(c.id); setSelectedPlayers(s); }} className={`flex flex-col items-center p-2 rounded-2xl border cursor-pointer transition-all active:scale-95 ${sel ? 'border-purple-400 bg-purple-500/15' : 'border-white/5 hover:bg-white/5'}`}>
                                            <div className="relative">
                                                <img src={c.avatar} className={`w-12 h-12 rounded-full object-cover transition-all ${sel ? 'ring-2 ring-purple-400 ring-offset-2 ring-offset-[#0a0a0a]' : 'opacity-80'}`} />
                                                {sel && <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-purple-500 rounded-full flex items-center justify-center border-2 border-[#0a0a0a]"><svg viewBox="0 0 20 20" fill="currentColor" className="w-2.5 h-2.5 text-white"><path fillRule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clipRule="evenodd" /></svg></div>}
                                            </div>
                                            <span className={`text-[9px] mt-2 truncate w-full text-center font-medium ${sel ? 'text-purple-200' : 'text-white/50'}`}>{c.name}</span>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>

                {/* 底部开始按钮 */}
                <div className="p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] border-t border-white/5 bg-black/40 backdrop-blur-md z-10">
                    <button
                        onClick={handleCreateGame}
                        disabled={isCreating || !canStart}
                        className={`w-full py-3.5 font-bold rounded-2xl shadow-lg active:scale-95 transition-all flex items-center justify-center gap-2 ${canStart ? 'bg-gradient-to-r from-purple-500 to-pink-500 text-white shadow-purple-500/30' : 'bg-white/10 text-white/30'}`}
                    >
                        {isCreating ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div> 生成序章...</> : <><RocketLaunch size={18} /> 开始冒险</>}
                    </button>
                </div>
            </div>
        );
    }

    // 3. Play View
    if (!activeGame) return null;
    const theme = GAME_THEMES[activeGame.theme];
    const activePlayers = characters.filter(c => activeGame.playerCharIds.includes(c.id));

    // [FIX] Changed from absolute inset-0 to h-full relative to fix overscroll and height layout issues
    return (
        <div className={`h-full w-full relative flex flex-col ${theme.bg} ${theme.text} ${theme.font} transition-colors duration-500 overflow-hidden`}>
            
            {/* Header */}
            <div className={`h-20 flex items-end justify-between px-4 pb-3 border-b ${theme.border} shrink-0 bg-opacity-90 backdrop-blur z-20 relative`}>
                <div className="flex items-center gap-2">
                    <button onClick={handleLeave} className={`p-2 -ml-2 rounded hover:bg-white/10 active:scale-95 transition-transform`}>
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                    </button>
                    <div className="flex flex-col mb-0.5">
                        <span className="font-bold text-sm tracking-wide line-clamp-1 max-w-[150px]">{activeGame.title}</span>
                        <div className="flex items-center gap-2">
                            <span className="text-[9px] opacity-60 flex items-center gap-1">
                                <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
                                {activeGame.status.location}
                            </span>
                            {lastTokenUsage && <span className="text-[8px] opacity-40 font-mono inline-flex items-center gap-0.5" title={`Prompt: ${lastTokenUsage.prompt || '?'} | Completion: ${lastTokenUsage.completion || '?'} | Total session: ${totalTokensUsed}`}><Lightning size={10} weight="fill" />{lastTokenUsage.prompt || '?'}/{lastTokenUsage.completion || '?'} (∑{totalTokensUsed})</span>}
                        </div>
                    </div>
                </div>
                
                <div className="flex gap-1 mb-1">
                    {/* Toggle Party HUD */}
                    <button onClick={() => setShowParty(!showParty)} className={`p-2 rounded hover:bg-white/10 active:scale-95 transition-transform ${showParty ? theme.accent : 'opacity-50'}`}>
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" /></svg>
                    </button>
                    <button onClick={() => setShowSystemMenu(true)} className={`p-2 -mr-2 rounded hover:bg-white/10 active:scale-95 transition-transform`}>
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" /></svg>
                    </button>
                </div>
            </div>

            {/* --- NEW: Party HUD (Collapsible) --- */}
            {showParty && (
                <div className={`flex gap-4 p-3 overflow-x-auto no-scrollbar border-b ${theme.border} bg-black/20 backdrop-blur-sm z-10 shrink-0 animate-slide-down`}>
                    {/* User Avatar */}
                    <div className="relative group shrink-0">
                        <img src={userProfile.avatar} className="w-10 h-10 rounded-full border-2 border-white/20 object-cover shadow-sm" />
                        <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 bg-black/60 text-white text-[8px] px-1.5 rounded-full backdrop-blur-sm whitespace-nowrap">YOU</div>
                    </div>
                    {/* Teammates */}
                    {activePlayers.map(p => (
                        <div key={p.id} className="relative group shrink-0 cursor-pointer active:scale-95 transition-transform">
                            <img src={p.avatar} className="w-10 h-10 rounded-full border-2 border-white/20 object-cover shadow-sm group-hover:border-white/50 transition-colors" />
                            <div className="absolute inset-0 rounded-full ring-2 ring-transparent group-hover:ring-green-400/50 transition-all"></div>
                            {/* Simple Status Indicator (Green Dot) */}
                            <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-black/50 shadow-sm animate-pulse"></div>
                        </div>
                    ))}
                </div>
            )}

            {/* Stats HUD */}
            <div className={`px-4 py-2 border-b ${theme.border} bg-black/10 backdrop-blur-sm z-10 shrink-0`}>
                <div className="grid grid-cols-3 gap-2">
                    <div className="flex flex-col items-center bg-red-500/20 rounded p-1 border border-red-500/30">
                        <span className="text-[8px] text-red-300 font-bold uppercase">HP (生命)</span>
                        <span className="text-xs font-mono font-bold text-red-100">{activeGame.status.health || 100}</span>
                    </div>
                    <div
                        onClick={toggleSanityLock}
                        className={`flex flex-col items-center bg-blue-500/20 rounded p-1 border cursor-pointer active:scale-95 transition-all ${sanityLocked ? 'border-blue-400 ring-1 ring-blue-400/50' : 'border-blue-500/30'}`}
                    >
                        <span className="text-[8px] text-blue-300 font-bold uppercase flex items-center gap-1">
                            SAN (理智) {sanityLocked && <LockSimple size={10} weight="fill" className="text-blue-400 inline" />}
                        </span>
                        <span className="text-xs font-mono font-bold text-blue-100">{activeGame.status.sanity || 100}</span>
                    </div>
                    <div className="flex flex-col items-center bg-yellow-500/20 rounded p-1 border border-yellow-500/30">
                        <span className="text-[8px] text-yellow-300 font-bold uppercase">GOLD (金币)</span>
                        <span className="text-xs font-mono font-bold text-yellow-100">{activeGame.status.gold || 0}</span>
                    </div>
                </div>
                {/* Token Statistics */}
                {lastTokenUsage && (
                    <div className="mt-1.5 flex items-center justify-between bg-white/5 rounded px-2 py-1 border border-white/10">
                        <span className="text-[8px] text-white/40 font-mono inline-flex items-center gap-0.5"><Lightning size={10} weight="fill" /> 上下文: {lastTokenUsage.prompt ?? '?'} | 回复: {lastTokenUsage.completion ?? '?'} | 本次: {lastTokenUsage.total}</span>
                        <span className="text-[8px] text-white/40 font-mono">∑ {totalTokensUsed}</span>
                    </div>
                )}
            </div>

            {/* Stage / Log Area */}
            <div 
                ref={logsContainerRef} // [FIX] Attach Ref to scrollable container
                className="flex-1 overflow-y-auto p-4 space-y-6 no-scrollbar relative animate-fade-in"
            >
                {/* 已归档剧情 (自动总结后折叠灰显，不删除) */}
                {(activeGame.logs.some(l => l.archived) || (activeGame.summaries && activeGame.summaries.length > 0)) && (
                    <div className="my-2">
                        <button
                            onClick={() => setShowArchived(v => !v)}
                            className={`w-full text-[11px] py-2 px-3 rounded-lg border border-dashed ${theme.border} opacity-60 hover:opacity-100 transition-opacity flex items-center justify-center gap-2 font-mono`}
                        >
                            已归档 {activeGame.logs.filter(l => l.archived).length} 条剧情 · {(activeGame.summaries || []).length} 段前情提要 {showArchived ? '（点击折叠）' : '（点击展开）'}
                        </button>
                        {showArchived && (
                            <div className="mt-3 space-y-4 opacity-50">
                                {/* 前情提要小说式总结 */}
                                {(activeGame.summaries || []).map((s, si) => (
                                    <div key={s.id} className={`p-4 rounded-lg border ${theme.border} ${theme.cardBg} text-xs italic leading-relaxed`}>
                                        <div className="text-[10px] font-bold uppercase tracking-widest mb-1 not-italic opacity-70">前情提要 · 第 {si + 1} 段</div>
                                        <GameMarkdown content={s.content} theme={theme} />
                                    </div>
                                ))}
                                {/* 折叠的原始日志 (灰显) */}
                                <div className={`pl-3 border-l-2 ${theme.border} space-y-2`}>
                                    {activeGame.logs.filter(l => l.archived).map((log, li) => (
                                        <div key={log.id || li} className="text-[11px] leading-snug">
                                            <span className="font-bold opacity-70">{log.role === 'gm' ? 'GM' : (log.speakerName || 'System')}: </span>
                                            <span className="opacity-70">{log.content.replace(/\n+/g, ' ').slice(0, 120)}{log.content.length > 120 ? '…' : ''}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {activeGame.logs.map((log, i) => {
                    if (log.archived) return null; // 归档日志在上方折叠区块渲染
                    const isGM = log.role === 'gm';
                    const isSystem = log.role === 'system';
                    const isCharacter = log.role === 'character';
                    const charInfo = isCharacter ? activePlayers.find(p => p.name === log.speakerName) : null;

                    if (isSystem) {
                        return (
                            <div key={log.id || i} className="flex flex-col items-center my-4 animate-fade-in gap-1 group">
                                <span className="text-[10px] opacity-50 border-b border-dashed border-current pb-0.5 font-mono">{log.content}</span>
                                <button onClick={() => handleRollbackLog(i)} className="text-[9px] text-red-400 opacity-0 group-hover:opacity-100 transition-opacity hover:underline">回退到此处</button>
                            </div>
                        );
                    }

                    if (isGM) {
                        return (
                            <div key={log.id || i} className="animate-fade-in my-4 group relative">
                                <div className={`p-5 rounded-lg border-2 ${theme.border} ${theme.cardBg} shadow-sm relative mx-auto w-full text-sm`}>
                                    <div className="absolute -top-3 left-4 bg-inherit px-2 text-[10px] font-bold uppercase tracking-widest opacity-80 border border-inherit rounded">Game Master</div>
                                    <GameMarkdown content={log.content} theme={theme} customStyle={uiSettings} />
                                </div>
                                <button onClick={() => handleRollbackLog(i)} className="absolute top-2 right-2 text-[9px] bg-red-900/50 text-red-200 px-2 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-800">Rollback</button>
                            </div>
                        );
                    }

                    // Character Log
                    if (isCharacter && charInfo) {
                        return (
                            <div key={log.id || i} className="flex gap-3 animate-slide-up group relative">
                                <img src={charInfo.avatar} className={`w-10 h-10 rounded-full object-cover border ${theme.border} shrink-0 mt-1`} />
                                <div className="flex flex-col max-w-[85%]">
                                    <span className="text-[10px] font-bold opacity-60 mb-1 ml-1">{charInfo.name}</span>
                                    <div className={`px-4 py-2 rounded-2xl rounded-tl-none text-sm ${theme.cardBg} border ${theme.border} shadow-sm relative`}>
                                        <GameMarkdown content={log.content} theme={theme} customStyle={uiSettings} />
                                    </div>
                                    <button onClick={() => handleRollbackLog(i)} className="self-start mt-1 text-[9px] text-red-400 opacity-0 group-hover:opacity-100 transition-opacity hover:underline">回退</button>
                                </div>
                            </div>
                        );
                    }

                    // Player (User) Log
                    return (
                        <div key={log.id || i} className="flex flex-col items-end animate-slide-up group relative">
                            <div className="flex items-center gap-2 mb-1">
                                <span className={`text-[10px] font-bold opacity-60`}>{log.speakerName}</span>
                                {log.diceRoll && (
                                    <span className="text-[10px] bg-white/20 px-1.5 rounded text-yellow-500 font-mono">
                                        <DiceFive size={12} weight="fill" className="inline" /> {log.diceRoll.result}
                                    </span>
                                )}
                            </div>
                            <div className={`px-4 py-2 rounded-2xl rounded-tr-none text-sm bg-orange-600 text-white shadow-md max-w-[85%]`}>
                                {log.content}
                            </div>
                            <button onClick={() => handleRollbackLog(i)} className="mt-1 text-[9px] text-red-400 opacity-0 group-hover:opacity-100 transition-opacity hover:underline">回退</button>
                        </div>
                    );
                })}
                {isTyping && <div className="text-xs opacity-50 animate-pulse pl-2 font-mono">GM 正在计算结果...</div>}
                
                {/* [FIX] Removed logsEndRef usage */}
            </div>

            {/* Controls */}
            {/* Added pb-[env(safe-area-inset-bottom)] to ensure content clears home bar on full screen devices */}
            <div className={`p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] border-t ${theme.border} bg-opacity-90 backdrop-blur shrink-0 z-20 transition-colors duration-500`}>
                
                {/* AI Suggested Options Area */}
                {activeGame.suggestedActions && activeGame.suggestedActions.length > 0 && !isTyping && (
                    <div className="flex gap-2 mb-3 overflow-x-auto no-scrollbar pb-1">
                        {activeGame.suggestedActions.map((opt, idx) => {
                            let styleClass = theme.optionNormal;
                            if (opt.type === 'chaotic') styleClass = theme.optionChaotic;
                            if (opt.type === 'evil') styleClass = theme.optionEvil;
                            
                            return (
                                <button 
                                    key={idx} 
                                    onClick={() => handleAction(opt.label)}
                                    className={`flex-1 min-w-[100px] text-[10px] p-2 rounded-lg border ${styleClass} hover:opacity-80 active:scale-95 transition-all text-left leading-tight shadow-sm`}
                                >
                                    <span className="block font-bold opacity-70 uppercase text-[8px] mb-0.5 tracking-wider">{opt.type}</span>
                                    {opt.label}
                                </button>
                            );
                        })}
                    </div>
                )}

                {/* Collapsible Action Toolbar — 快捷动作 (执行时自动骰 D20) */}
                {showTools && (
                    <div className="flex gap-2 mb-3 animate-fade-in items-center">
                        <span className={`text-[10px] opacity-50 flex items-center gap-1 shrink-0 ${theme.accent}`}>
                            <DiceFive size={16} weight="fill" /> 自动骰点
                            {lastRoll !== null && <span className="font-mono font-bold">上次 {lastRoll}</span>}
                        </span>
                        {['调查', '攻击', '交涉', '潜行', '逃跑'].map(action => (
                            <button key={action} disabled={isTyping} onClick={() => handleAction(action)} className={`flex-1 px-3 py-2 rounded border ${theme.border} hover:bg-white/10 text-xs font-bold transition-colors active:scale-95 disabled:opacity-40`}>{action}</button>
                        ))}
                    </div>
                )}

                <div className="flex gap-2 items-end">
                    {/* Toggle Tools Button */}
                    <button 
                        onClick={() => setShowTools(!showTools)}
                        className={`p-3 h-12 rounded-xl border ${theme.border} hover:bg-white/10 active:scale-95 transition-transform flex items-center justify-center ${showTools ? 'bg-white/20' : ''}`}
                    >
                        <Toolbox size={22} />
                    </button>

                    {/* Reroll Button (Context Sensitive) */}
                    {!isTyping && activeGame.logs.length > 0 && (
                        <button 
                            onClick={handleReroll}
                            className={`p-3 h-12 rounded-xl border ${theme.border} hover:bg-white/10 active:scale-95 transition-transform flex items-center justify-center`}
                            title="重新生成上一轮"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 opacity-70"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
                        </button>
                    )}

                    <textarea 
                        value={userInput} 
                        onChange={e => setUserInput(e.target.value)} 
                        // Removed onKeyDown Enter submission
                        placeholder="你打算做什么..." 
                        className={`flex-1 bg-black/20 border ${theme.border} rounded-xl px-3 py-3 outline-none text-sm placeholder-opacity-30 placeholder-current resize-none h-12 leading-tight focus:bg-black/40 transition-colors`}
                    />
                    <button onClick={() => handleAction(userInput)} className={`${theme.accent} font-bold text-sm px-4 h-12 bg-white/10 rounded-xl hover:bg-white/20 active:scale-95 transition-all flex items-center justify-center`}>
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5" /></svg>
                    </button>
                </div>
            </div>

            {/* System Menu Modal */}
            <Modal isOpen={showSystemMenu} title="系统菜单" onClose={() => setShowSystemMenu(false)}>
                <div className="space-y-4">
                    {/* UI Settings */}
                    <div className="bg-slate-100 p-3 rounded-xl">
                        <label className="text-xs text-slate-500 font-bold mb-3 block border-b border-slate-200 pb-1">阅读设置 (Display)</label>
                        <div className="space-y-3">
                            <div className="flex items-center gap-3">
                                <span className="text-xs text-slate-400 w-8">字号</span>
                                <input 
                                    type="range" 
                                    min="12" 
                                    max="24" 
                                    step="1"
                                    value={uiSettings.fontSize} 
                                    onChange={e => setUiSettings({...uiSettings, fontSize: parseInt(e.target.value)})} 
                                    className="flex-1 h-1.5 bg-slate-300 rounded-lg appearance-none cursor-pointer accent-orange-500" 
                                />
                                <span className="text-xs font-mono text-slate-600 w-6 text-right">{uiSettings.fontSize}</span>
                            </div>
                            <div className="flex items-center gap-3">
                                <span className="text-xs text-slate-400 w-8">颜色</span>
                                <input 
                                    type="color" 
                                    value={uiSettings.color || '#e5e5e5'} 
                                    onChange={e => setUiSettings({...uiSettings, color: e.target.value})} 
                                    className="w-full h-8 rounded cursor-pointer bg-white border border-slate-200 p-0.5" 
                                />
                            </div>
                            <button onClick={() => setUiSettings({ fontSize: 14, color: '' })} className="w-full py-1.5 bg-white border border-slate-200 text-slate-500 text-xs rounded-lg active:scale-95 transition-transform">恢复默认</button>
                        </div>
                    </div>

                    <button onClick={handleArchiveAndQuit} className="w-full py-3 bg-emerald-500 text-white font-bold rounded-2xl shadow-lg flex items-center justify-center gap-2">
                        <FloppyDisk size={18} /> 归档记忆并退出
                    </button>
                    <button onClick={handleRestart} className="w-full py-3 bg-orange-500 text-white font-bold rounded-2xl shadow-lg flex items-center justify-center gap-2">
                        <ArrowsClockwise size={18} /> 重置当前游戏
                    </button>
                    <button onClick={handleLeave} className="w-full py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl flex items-center justify-center gap-2">
                        <DoorOpen size={18} /> 暂时离开 (不归档)
                    </button>
                </div>
            </Modal>

            {/* Delete Save Confirm Modal */}
            <Modal isOpen={!!deleteConfirmId} title="删除存档" onClose={() => setDeleteConfirmId(null)} footer={
                <div className="flex gap-3 w-full">
                    <button onClick={() => setDeleteConfirmId(null)} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl">取消</button>
                    <button onClick={confirmDeleteGame} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl shadow-lg shadow-red-200">删除</button>
                </div>
            }>
                <p className="text-sm text-slate-600 text-center py-4">确定要删除这个存档吗？<br/><span className="text-xs text-red-400 mt-1 block">此操作不可恢复。</span></p>
            </Modal>

            {/* Archive Overlay */}
            {isArchiving && (
                <div className="absolute inset-0 bg-black/80 z-50 flex items-center justify-center text-white flex-col gap-4 animate-fade-in">
                    <div className="w-8 h-8 border-4 border-orange-500 border-t-transparent rounded-full animate-spin"></div>
                    <span className="text-xs tracking-widest font-mono">正在传递记忆...</span>
                </div>
            )}

            {/* Auto-Summary Overlay (每 20 条自动总结的全屏反馈) */}
            {isSummarizing && (
                <div className="absolute inset-0 bg-black/85 z-50 flex items-center justify-center text-white flex-col gap-5 animate-fade-in px-8 text-center">
                    <div className="w-10 h-10 border-4 border-purple-400 border-t-transparent rounded-full animate-spin"></div>
                    <span className="text-sm tracking-widest font-bold">正在总结前文内容…</span>
                    <span className="text-[11px] opacity-50 font-mono leading-relaxed">归档剧情 · 提炼起因经过结果 · 记录人物关系变化</span>
                </div>
            )}
        </div>
    );
};

export default GameApp;
