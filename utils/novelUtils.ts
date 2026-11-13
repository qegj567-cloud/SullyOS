
import { CharacterProfile, NovelBook, NovelSegment, UserProfile } from '../types';
import { ContextBuilder } from './context';
import { safeResponseJson } from './safeApi';

// --- Visual Themes ---
export const NOVEL_THEMES = [
    { id: 'sakura', name: '樱花 (Sakura)', bg: 'bg-pink-50', paper: 'bg-[#fff5f7]', text: 'text-slate-700', accent: 'text-pink-500', button: 'bg-pink-400', activeTab: 'bg-pink-500 text-white' },
    { id: 'parchment', name: '羊皮纸 (Vintage)', bg: 'bg-[#f5e6d3]', paper: 'bg-[#fdf6e3]', text: 'text-[#433422]', accent: 'text-[#8c6b48]', button: 'bg-[#b58900]', activeTab: 'bg-[#b58900] text-white' },
    { id: 'kraft', name: '牛皮纸 (Kraft)', bg: 'bg-[#d7ccc8]', paper: 'bg-[#e7e0d8]', text: 'text-[#3e2723]', accent: 'text-[#5d4037]', button: 'bg-[#5d4037]', activeTab: 'bg-[#5d4037] text-white' },
    { id: 'midnight', name: '深夜 (Midnight)', bg: 'bg-[#0f172a]', paper: 'bg-[#1e293b]', text: 'text-slate-300', accent: 'text-blue-400', button: 'bg-blue-600', activeTab: 'bg-blue-600 text-white' },
    { id: 'matcha', name: '抹茶 (Matcha)', bg: 'bg-[#ecfccb]', paper: 'bg-[#f7fee7]', text: 'text-emerald-800', accent: 'text-emerald-600', button: 'bg-emerald-500', activeTab: 'bg-emerald-500 text-white' },
];

export interface GenerationOptions {
    write: boolean;
    comment: boolean;
    analyze: boolean;
}

// --- INTELLIGENT TAGGING SYSTEM ---
export const extractWritingTags = (char: CharacterProfile): string[] => {
    if (!char) return ['风格未定'];

    const tags = new Set<string>();
    // Only the dedicated writing profile describes the author. User impressions,
    // nicknames and mixed world settings cannot be treated as character traits.
    // 从已保存的创作档案提取
    if (char.writerPersona) {
        const p = char.writerPersona;
        if (p.includes('新手')) tags.add('青涩');
        if (p.includes('大师')) tags.add('老练');
        if (p.includes('诗意')) tags.add('诗意');
        if (p.includes('大白话')) tags.add('口语化');
        if (p.includes('写实')) tags.add('写实');
        if (p.includes('动作')) tags.add('动作流');
        if (p.includes('情感')) tags.add('情感流');
        if (p.includes('对话')) tags.add('对话密集');
    }

    // 未命中标签也不凭空猜测角色风格。
    let result = Array.from(tags);
    if (result.length === 0) {
        result = [char.writerPersona?.trim() ? '自定义风格' : '待分析'];
    }
    
    // 稳定排序：基于角色名 + 标签名生成固定顺序，避免每次渲染都变化
    const hash = (str: string) => {
        let h = 0;
        for (let i = 0; i < str.length; i++) {
            h = ((h << 5) - h) + str.charCodeAt(i);
            h |= 0;
        }
        return h;
    };
    const seed = hash(char.name || 'default');
    
    return result
        .sort((a, b) => {
            const hashA = hash(a + seed.toString());
            const hashB = hash(b + seed.toString());
            return hashA - hashB;
        })
        .slice(0, 5);
};

// impression is the character's view OF THE USER, never a character personality.
const writerIdentityBoundary = (char: CharacterProfile, user: UserProfile): string => `
【人物归属边界】
- 本次作者/分析对象只有角色「${char.name}」（char）；「${user.name}」（user）是共创搭档。
- 核心设定、世界观、世界书和记忆可能同时描述多个人，必须按每句话的明确主语区分归属。挂载给角色不等于全部描述角色本人。
- 世界书里属于 user、用户或「${user.name}」的经历、职业、性格、MBTI、喜好和习惯仍属于用户，不能移植为作者特征。
- 「我眼中的${user.name} / 私密印象档案」是角色对用户的看法；其中观察到的特质和 TA 的喜好描述用户，不是角色本人的人格。这部分仅供判断共创互动方式。
- 用户备注/爱称不能当作角色的身份或物种。不要把小说中的人物设定当成作者身份。
- 归属不明或没有依据的能力、偏好、专业知识标记为未知或依据不足，不拿另一人的资料补齐；不要编造当前没有提供的剧情。
`.trim();

// --- Helper: Writer Persona Analysis (Simple) ---
export const analyzeWriterPersonaSimple = (char: CharacterProfile): string => {
    if (!char) return '未知风格';
    return `### ${char.name} 的创作人格档案 (Simple)
**核心性格**: 尚未进行写作风格分析，以角色核心设定中明确属于本人的特质为准。
**笔触**: 随角色本人设定和当前创作内容决定，不预设固定风格。
**审美**: 未分析，不使用用户的喜好代替。
**禁忌**: 仅遵循明确属于角色本人的创作偏好，不把用户印象或其他人物设定当成作者特征。`;
};

// --- Helper: Extract Writing Taboos ---
export const extractWritingTaboos = (char: CharacterProfile): string => `
## ${char.name} 的写作偏好与禁忌
以角色核心设定及创作档案中明确属于作者本人的偏好为准；没有依据时不额外强加禁忌。
用户的喜好、雷区和习惯仅用于共创互动，不自动变成作者本人的价值观或写作限制。
`;

// --- Helper: Writer Persona Analysis (Deep) ---
export const generateWriterPersonaDeep = async (
    char: CharacterProfile,
    userProfile: UserProfile,
    apiConfig: any,
    updateCharacter: (id: string, updates: Partial<CharacterProfile>) => void,
    force: boolean = false
): Promise<string> => {
    if (!char) return "Error: No Character";

    if (!force && char.writerPersona && char.writerPersonaGeneratedAt) {
        const age = Date.now() - char.writerPersonaGeneratedAt;
        if (age < 7 * 24 * 60 * 60 * 1000) {
            return char.writerPersona;
        }
    }
    
    const analysisPrompt = `本次任务是人物写作风格分析，不是继续角色扮演。请作为写作教练，根据提供的分区资料分析「${char.name}」本人写小说时的风格。

### 分析任务

请从以下**8个维度**分析这个角色的写作风格：

#### 1. 写作能力 (Skill Level)
他/她实际上擅长写作吗？还是只是想写？
- 新手：经常用错词，逻辑混乱，但有热情
- 业余：能写通顺，但技巧生硬
- 熟练：有自己的风格，技巧自然
- 大师：行云流水，深谙叙事之道

#### 2. 语言风格 (Language)
他/她说话/写作时用什么语言？
- 大白话：口语化，"就是那种感觉你懂吧"
- 书面语：规范、优雅
- 诗意：比喻、意象丰富
- 学术：专业术语，逻辑严密

#### 3. 表现手法 (Technique)
他/她倾向写实还是写意？
- 写实：精确描写，像纪录片
- 印象派：捕捉感觉，模糊但有氛围
- 象征派：用隐喻，一切都有深意

#### 4. 叙事重心 (Focus)
他/她写作时最关注什么？
- 动作：打斗、追逐、机械操作
- 情感：内心戏、人际关系
- 对话：角色互动、语言交锋
- 氛围：环境、意境、美学

#### 5. 偏好与禁忌 (Preference)
他/她喜欢写什么？讨厌写什么？
- 喜欢的题材/场景
- 避之不及的俗套

#### 6. 角色理解 (Character View)
他/她怎么看待自己笔下的【小说主角】（Fictional Protagonist）？
(注意：是指小说里的人物，不是指正在和他对话的用户)
- 是英雄？受害者？工具人？
- 会不会对主角的行为有自己的意见？

#### 7. 剧情态度 (Plot Opinion)
他/她对当前剧情有什么看法？
- 认为合理吗？
- 会不会想改变走向？
- 有没有更想写的支线？

#### 8. 互动倾向 (Collaboration Style)
他/她会怎么和共创搭档（用户）互动？
- 会吐槽搭档写得不对吗？
- 会用专业术语"互殴"吗？
- 还是默默接受搭档的设定？
- 态度是冷漠、热情、傲娇还是温柔？(参考性格特质)

---

**输出格式**（严格遵守, 不要用markdown标记）：

写作能力: (新手/业余/熟练/大师) - 一句话说明理由

语言风格: (大白话/书面语/诗意/学术) - 举例说明

表现手法: (写实/印象派/象征派) - 具体描述

叙事重心: (动作/情感/对话/氛围) - 为什么

偏好题材: (列举3个) | 禁忌俗套: (列举3个)

主角看法: (他/她怎么看待小说主角？一句话)

剧情态度: (对当前剧情的看法，30字)

互动模式: (与用户的互动风格？)

专业术语: (如果这个角色有特定领域的专业知识，列举3-5个术语；没有则写"无")

---

**字数要求**：总共400-600字。`;

    try {
        const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'Authorization': `Bearer ${apiConfig.apiKey}` 
            },
            body: JSON.stringify({
                model: apiConfig.model,
                messages: await ContextBuilder.buildCharacterRequest({
                    char, user: userProfile,
                    timeOptions: { skipTimeAwareness: true },
                    instructions: `${writerIdentityBoundary(char, userProfile)}\n\n${analysisPrompt}`,
                }, [{ role: 'user', content: `请分析${char.name}本人的写作风格；${userProfile.name}是共创搭档。` }]),
                temperature: 0.7,
                max_tokens: 8000
            }),
            __sullyMeta: {
                appId: 'novel',
                appName: '一起写小说',
                charId: char.id,
                charName: char.name,
                purpose: '生成写手文风设定',
            },
        } as RequestInit);
        
        if (response.ok) {
            const data = await safeResponseJson(response);
            const content = data.choices?.[0]?.message?.content;
            if (typeof content !== 'string' || !content.trim()) throw new Error('分析未返回有效内容，请重试');
            const rawPersona = content.trim();
            
            const formattedPersona = `
### ${char.name} 的创作人格档案（AI深度分析）

${rawPersona}

---
*分析生成于: ${new Date().toLocaleDateString('zh-CN')}*
`.trim();
            
            updateCharacter(char.id, { 
                writerPersona: formattedPersona,
                writerPersonaGeneratedAt: Date.now()
            });
            
            return formattedPersona;
        } else {
            throw new Error(`API Error: ${response.status}`);
        }
    } catch (e: any) {
        console.error('Deep analysis failed:', e);
        throw e;
    }
};

export const getFewShotExamples = (_char: CharacterProfile) => `
**通用表达参考（不代表作者性格）**：
避免没有剧情依据的机械量化，例如「他的眼泪流了8滴，呼吸频率降低了15%」。
可以用具体动作承载情绪，例如「他在门口停下，握住门把，又松开」。
这只是表达方法示例；实际语气、节奏和详略仍按作者本人的设定与创作档案决定。
`;

// --- Prompt Builder ---
export const buildPrompt = (
    char: CharacterProfile, 
    userProfile: UserProfile,
    activeBook: NovelBook | null,
    userText: string, 
    storyContext: string,
    options: GenerationOptions,
    contextSegments: NovelSegment[],
    characters: CharacterProfile[]
) => {

    const writerPersona = char.writerPersona || analyzeWriterPersonaSimple(char);
    const fewShot = getFewShotExamples(char);
    const extractedTaboos = extractWritingTaboos(char); 
    const protagonistContext = activeBook?.protagonists.map(p => `- ${p.name} (${p.role}): ${p.description}`).join('\n') || '无';
    
    const bookInfo = `
小说：《${activeBook?.title}》
世界观：${activeBook?.worldSetting}
主要角色：
${protagonistContext}
`;
    
    const systemPrompt = `


# 当前模式：小说共创 (Co-Writing Mode)
你正在与 **${userProfile.name}** (用户) 合作撰写小说。
书名：《${activeBook?.title}》

${writerIdentityBoundary(char, userProfile)}

**你的角色**：
1. 你是小说作者之一，${userProfile.name}是本次共创搭档；你对搭档的态度参考关系背景，但不能把搭档的人格当成自己的人格。
2. 在【分析】和【吐槽】环节，请完全保持你的人设（语气、性格、对用户的态度）。
3. 如果你们关系亲密，不要表现得像个陌生的AI工具人；如果你们关系紧张/傲娇，也要体现出来。

# 身份设定
你是 **${char.name}**。
你正在用自己的方式参与小说《${activeBook?.title}》的创作。

---

# ⚠️ 反趋同协议 (Anti-Cliché Protocol)

## 你必须记住：
1. **你是${char.name}，你有你的性格，你或许很擅长写作刻画，也有可能你的文字表达能力其实很差劲，这取决于你是谁，你的经历等**
   - 不要写出"AI味"的文字
   - 不要试图"完美"或"教科书式"
   
2. **每个作者的笔触必须不同**
   ${extractedTaboos}

3. **绝对禁止的AI通病**：
   - ❌ "仿佛/似乎/好像" → 要么确定，要么别写
   - ❌ "内心五味杂陈" → 说清楚是哪五味
   - ❌ "眼神中透露出XXX" → 写动作，不要总结情绪
   - ❌ "月光洒在..." → 2024年了，别用这种意象
   - ❌ 对称的排比句 → 真人不会这么说话
   - ❌ **数字量化描写** → 禁止"心跳了83次"、"肌肉收缩了12次"这种机械化表达

4. **⚠️ 数字使用铁律**：
   - ✅ 允许：剧情必需的数字（"3个敌人"、"第5层楼"）
   - ✅ 允许：对话中的数字（"给我5分钟"）
   - ❌ 禁止：生理反应的数字（心跳、呼吸、眨眼次数）
   - ❌ 禁止：情绪量化（"焦虑指数上升37%"）
   - ❌ 禁止：无意义的精确数字（"等待了127秒"）

---

# 你的写作人格
${writerPersona}

# 风格参考 (Do vs Don't)
${fewShot}

---

# 上文回顾
${storyContext}

${bookInfo}

---

# 用户指令
${userText || '[用户未输入，请根据上文自然续写]'}

---
`;

    let tasks = `### [创作任务]
请按以下结构输出JSON。
`;

    let jsonStructure = [];

    if (options.analyze) {
        tasks += `
1. **分析**: 以${char.name}的视角，简评上文。
   - 语气：保持你的人设（${char.name}）。
   - 内容：如果是你觉得不合理的地方，可以直接指出；如果觉得好，可以夸奖搭档。
`;
        jsonStructure.push(`"analysis": { "reaction": "第一反应", "focus": "关注点", "critique": "评价" }`);
    }

    if (options.write) {
        tasks += `
2. **正文续写**: 
   - 场景化: 描写动作、环境、感官。
   - 节奏: 符合你的性格。
   - 字数: 400-800字。
`;
        jsonStructure.push(`"writer": { "content": "正文内容", "technique": "技巧", "mood": "基调" }`);
    }

    if (options.comment) {
        const recentOtherAuthors = contextSegments
        .slice(-5)
        .filter(s => s.authorId !== 'user' && s.authorId !== char.id && (s.role === 'writer' || s.type === 'story'))
        .map(s => {
            const author = characters.find(c => c.id === s.authorId);
            return { name: author?.name || 'Unknown', content: s.content.substring(0, 100) };
        });

        tasks += `
3. **吐槽/感想 (带互动)**: 
   写完后的第一人称碎碎念。这是你直接对用户说的话。
   
   ${recentOtherAuthors.length > 0 ? `
   **特别提示**：最近有其他作者也写了内容：
   ${recentOtherAuthors.map(a => `- ${a.name}写的：${a.content}`).join('\n')}
   
   如果你（${char.name}）对他们的写法有意见，可以在吐槽里说出来！
   - 如果你觉得他们理解错了角色，可以反驳
   - 如果你有专业知识（${char.description}），可以用术语纠正
   - 如果你就是看不惯，直说！
   ` : ''}
   
   ${char.description?.includes('猫') ? '必须有"喵"！' : ''}
`;
        jsonStructure.push(`"comment": { "content": "即时反应（与用户对话）" }`);
    }

    return `${systemPrompt}

${tasks}

### 最终输出格式 (Strict JSON, No Markdown)
{
  ${jsonStructure.join(',\n  ')},
  "meta": { "tone": "本段情绪基调", "suggestion": "简短的下一步建议" }
}
`;
};

// --- Helper: Parse Persona Markdown for UI ---
export const parsePersonaMarkdown = (rawPersona: string) => {
    const lines = rawPersona.split('\n');
    const iconMap: Record<string, string> = {
        '写作能力': '✍️', '语言风格': '💬', '表现手法': '🎨',
        '叙事重心': '🎯', '偏好': '❤️', '禁忌': '🚫',
        '主角': '👤', '剧情': '📖', '互动': '🤝',
        '创作人格': '🧠', '特别注意': '⚠️', '审美': '✨',
        '节奏': '🎵', '关注点': '👁️', '笔触': '🖌️',
        '核心性格': '💎', '专业术语': '📚'
    };
    
    const getIcon = (title: string) => {
        for (const [key, icon] of Object.entries(iconMap)) {
            if (title.includes(key)) return icon;
        }
        return '📌';
    };
    
    const sections: {title: string, content: string[], icon: string}[] = [];
    let currentSection: {title: string, content: string[], icon: string} | null = null;

    // 用 for...of 而不是 forEach：回调里的赋值不进 TS 的控制流分析，
    // 循环结束后 currentSection 会被当成还是初始的 null。
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const headerMatch = trimmed.match(/^###\s*(.+)/) || 
                           trimmed.match(/^\*\*([^*]+)\*\*\s*[:：]\s*(.*)/) ||
                           trimmed.match(/^([^-•\d][^:：]{1,15})[:：]\s*(.*)/);
        
        if (headerMatch) {
            if (currentSection && currentSection.content.length > 0) {
                sections.push(currentSection);
            }
            const title = (headerMatch[1] || '').replace(/\*\*/g, '').trim();
            currentSection = { 
                title: title,
                icon: getIcon(title),
                content: [] 
            };
            const afterColon = headerMatch[2]?.trim();
            if (afterColon) {
                currentSection.content.push(afterColon);
            }
        } else if (currentSection) {
            const cleanLine = trimmed.replace(/^\*\*|\*\*$/g, '').replace(/^[-•]\s*/, '');
            if (cleanLine) {
                currentSection.content.push(cleanLine);
            }
        }
    }

    if (currentSection && currentSection.content.length > 0) {
        sections.push(currentSection);
    }
    
    return sections;
};
