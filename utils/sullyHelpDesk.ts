import { AppID, type APIConfig, type CharacterProfile } from '../types';
import { ContextBuilder } from './context';
import { extractContent, safeFetchJson } from './safeApi';
import { SULLY_HELP_DESK_ID, SULLY_PERSONALITY } from './sullyIdentity';
import { normalizeLlmBaseUrl } from './llmEndpoint';
import handbook from '../docs/sully-11-handbook.md?raw';
import type { HelpDeskSettings } from './sullyHelpSettings';

export type HelpDeskMessage = { role: 'user' | 'assistant'; content: string };

const helpDeskCharacter: CharacterProfile = {
    id: SULLY_HELP_DESK_ID, name: 'Sully-11', description: '糯米机客服 · 工号 11',
    avatar: 'sully/head.png', memories: [],
    systemPrompt: `有许多个分工不同的 Sully。你是工号 11，在「使用帮助」值班，负责 SullyOS（糯米机，又名手抓糯米机）的使用答疑。私聊里陪用户的 Sully 和你各有自己的岗位和经历。
${SULLY_PERSONALITY}
答疑时一样可以冒一句怪话；按钮名、报错和操作步骤要说清楚。`,
};

const normalizeSearch = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

function titleTerms(text: string) {
    const pairs = [...text.matchAll(/(?=([\u3400-\u9fff]{2}))/g)].map(hit => hit[1]);
    return [...new Set([...(text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []), ...pairs])];
}

const chapters = handbook.split(/^## /m).slice(1).map(section => {
    const [heading, capabilityLine, ...lines] = section.trim().split(/\r?\n/);
    const [title, ...aliases] = heading.split(' | ');
    const capabilities = capabilityLine.replace(/^能力：/, '');
    const body = lines.filter(line => !line.startsWith('核对：')).join('\n').trim();
    const indexTerms = new Set([title, ...aliases, capabilities].flatMap(text => titleTerms(normalizeSearch(text))));
    const bodyTerms = new Set(titleTerms(normalizeSearch(body)));
    return { title, aliases: [title, ...aliases].map(normalizeSearch), capabilities, body, indexTerms, bodyTerms };
});

// 「交卷」比每页都出现的「角色」更能定位操作。索引和权重都在本机从同一本手册生成。
const termWeights = new Map<string, number>();
for (const chapter of chapters) {
    for (const term of new Set([...chapter.indexTerms, ...chapter.bodyTerms])) {
        termWeights.set(term, (termWeights.get(term) ?? 0) + 1);
    }
}
for (const [term, frequency] of termWeights) {
    termWeights.set(term, Math.log(chapters.length / frequency));
}
const directory = chapters.map(chapter => `${chapter.title} · ${chapter.capabilities}`).join('\n');

function findChapters(question: string) {
    const terms = titleTerms(question);
    const ranked = chapters.map(chapter => {
        let score = 0;
        for (const term of terms) {
            const weight = termWeights.get(term) ?? 0;
            if (chapter.indexTerms.has(term)) score += 2 * weight;
            else if (chapter.bodyTerms.has(term)) score += weight;
        }
        for (const alias of chapter.aliases) {
            if (question.includes(alias)) score += 2 * Math.min(alias.length, 8);
        }
        return { chapter, score };
    }).sort((a, b) => b.score - a.score);
    const minimum = Math.max(3, ranked[0].score * 0.35);
    return ranked.filter(hit => hit.score >= minimum).slice(0, 4).map(hit => hit.chapter);
}

export function buildHelpDeskKnowledge(
    faq: readonly { q: string; reason: string; solution: string; supportAnswer?: string }[],
    releases: readonly { title: string; subtitle: string }[],
) {
    const references = [
        ...faq.map(item => ({ terms: titleTerms(item.q), text: `${item.q}\n${item.supportAnswer ?? item.solution}`, kind: '常见问题' })),
        ...releases.map(item => ({ terms: titleTerms(item.title + item.subtitle), text: `${item.title}：${item.subtitle}`, kind: '更新日志摘要' })),
    ];
    return (history: HelpDeskMessage[]) => {
        const questions = history.filter(m => m.role === 'user').slice(-3).reverse().map(m => normalizeSearch(m.content));
        const score = (terms: string[], query: string) => terms.reduce((sum, term) => sum + (query.includes(term) ? Math.min(term.length, 8) : 0), 0);
        const current = questions[0] ?? '';
        const hits = findChapters(current);
        if (hits.length === 0 || /^(那|然后|接下来|还是|这个|它|在哪|怎么操作)/.test(current)) {
            const previous = questions.slice(1).map(findChapters).find(results => results.length);
            if (previous && !hits.includes(previous[0])) hits.splice(1, 0, previous[0]);
        }
        const referenceHits = references.map(ref => ({ ref, score: Math.max(0, ...questions.map((q, i) => score(ref.terms, q) / (i + 1))) }))
            .filter(hit => hit.score > 0).sort((a, b) => b.score - a.score).slice(0, 2);
        return [
            '按值班手册回答，把条件与箭头翻成用户看得懂的下一步。优先依据本轮设置摘要和手册，FAQ 与版本摘要作补充。角色开关只属于所选排查角色，问其他角色时可请用户切换范围。区分已配置和已验证成功。只看到列出的设置，私聊、设备画面、余额及日志不可见。缺少现象就问一句；目录有名字但没有所需步骤时，不猜菜单、不索取凭据或备份。',
            '【手册目录】\n' + directory,
            ...hits.slice(0, 4).map(chapter => `【${chapter.title}】\n${chapter.body}`),
            ...referenceHits.map(({ ref }) => `【${ref.kind}】${ref.text}`),
        ].join('\n\n');
    };
}

export async function askSullyHelpDesk(api: APIConfig, knowledge: ReturnType<typeof buildHelpDeskKnowledge>, history: HelpDeskMessage[], settings: HelpDeskSettings, signal: AbortSignal) {
    const messages = await ContextBuilder.buildCharacterRequest({
        char: helpDeskCharacter, user: { name: '用户', bio: '', avatar: '' },
        layout: { deferVolatile: true }, groupOptions: { skipUserProfile: true },
        instructions: `${knowledge(history)}\n\n【本轮设置摘要】\n${JSON.stringify(settings)}`,
    }, history.slice(-11));
    const base = normalizeLlmBaseUrl(api.baseUrl, api.apiType);
    const result = await safeFetchJson(`${base}/chat/completions`, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', ...(api.apiKey ? { Authorization: `Bearer ${api.apiKey}` } : {}) },
        body: JSON.stringify({ model: api.model, messages, max_tokens: api.maxTokens ?? 1200, stream: api.stream ?? false }),
    }, 0, 0, { appId: AppID.FAQ, appName: '使用帮助', charId: helpDeskCharacter.id, charName: helpDeskCharacter.name, purpose: '糯米机答疑' });
    const reply = extractContent(result);
    if (!reply) throw new Error('模型没有返回答复正文，请再试一次。');
    return reply;
}
