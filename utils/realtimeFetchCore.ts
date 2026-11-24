/**
 * realtimeFetchCore — 联网搜索 / Notion / 飞书 的纯 fetch 核心（环境无关叶子模块）
 *
 * 这里放的是 agenticTools 数据工具会用到的读取类请求实现：只依赖 fetch 和
 * proxyWorker 的地址解析，不碰 IndexedDB / DOM / localStorage，所以前端
 * （realtimeContext 的 Manager 委托调用）和 amsg worker（服务端工具循环里
 * 直接调用）共用同一份，行为、文案单份维护。
 *
 * 往这里加代码前先确认：不 import 任何带浏览器依赖的模块（db / keepAlive 等）。
 * `pnpm build:workers` 会把这份打进 amsg worker bundle，带进浏览器依赖会在
 * 构建期直接暴露。
 */

import { getProxyWorkerUrl } from './proxyWorker';

export interface SearchResult {
    title: string;
    description: string;
    url: string;
}

export interface DiaryPreview {
    id: string;
    title: string;
    date: string;
    url: string;
}

export interface FeishuDiaryPreview {
    recordId: string;
    title: string;
    date: string;
    content: string;
}

// ==================== 通用纯文本/JSON 错误摘要（Worker 安全叶子） ====================

const summarizeRealtimeHttpError = (rawText: string): string => {
    const trimmed = (rawText || '').trim();
    if (!trimmed) return '';
    if (/^\s*<(?:!doctype|html|head|body)\b/i.test(trimmed)) {
        const title = trimmed.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim() || '';
        const h1 = trimmed.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || '';
        return [title, h1 && h1 !== title ? h1 : ''].filter(Boolean).join(' · ').slice(0, 140) || '网关返回 HTML 错误页';
    }
    try {
        const parsed = JSON.parse(trimmed);
        const rawErr = parsed?.error ?? parsed?.msg ?? parsed?.message;
        if (typeof rawErr === 'string' && rawErr.trim()) return rawErr.trim().slice(0, 140);
        if (rawErr && typeof rawErr === 'object') {
            const inner = rawErr.message || rawErr.msg || rawErr.code || rawErr.type;
            if (typeof inner === 'string' || typeof inner === 'number') return String(inner).slice(0, 140);
        }
        if (typeof parsed?.message === 'string' && parsed.message.trim()) return parsed.message.trim().slice(0, 140);
        if (parsed?.code !== undefined) return `code=${parsed.code}`;
    } catch { /* plain text */ }
    return trimmed.slice(0, 140);
};

// ==================== 联网搜索（Brave，经代理 worker） ====================

/**
 * 主动搜索 - 让AI角色能够主动搜索任意内容
 * Active Search - Let AI characters actively search for anything
 *
 * 这个函数任何情况下都不抛异常，网络异常也会被 catch 成 `success: false`。
 *
 * 光看 `success` 分不清「请求根本没跑通」和「搜过了，一条都没有」——两者都是 false。
 * 调用方要是把它们当成同一件事，角色就会把一次没发出去的搜索说成「我刚搜了下，没什么」。
 * `reached` 就是用来分这两种的：它为 true 才表示真的问到了搜索服务并拿回一份读得懂的结果。
 */
export const performSearch = async (query: string, apiKey: string, signal?: AbortSignal): Promise<{ success: boolean; results: SearchResult[]; message: string; reached: boolean }> => {
    signal?.throwIfAborted();
    if (!query || !apiKey) {
        return { success: false, results: [], message: '缺少搜索关键词或API Key', reached: false };
    }

    try {
        // 使用自建的 Cloudflare Worker 代理
        const workerUrl = `${getProxyWorkerUrl()}/search?q=${encodeURIComponent(query)}&count=5`;

        const response = await fetch(workerUrl, {
            signal,
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'X-Brave-API-Key': apiKey
            }
        });

        // 先读取 text，避免非 JSON 响应直接 crash
        const text = await response.text();

        // 非 2xx：没搜成，reached 保持 false
        if (!response.ok) {
            const detail = summarizeRealtimeHttpError(text);
            console.error('[Search] API error:', response.status, detail);
            signal?.throwIfAborted();
            return { success: false, results: [], message: `搜索失败: ${detail || `HTTP ${response.status}`}`, reached: false };
        }

        // 解析 JSON
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            signal?.throwIfAborted();
            console.error('Search response not JSON:', text.slice(0, 200));
            // 回了东西但读不懂，等于不知道搜到了什么，同样不能算"搜过了"
            return { success: false, results: [], message: '搜索返回格式错误', reached: false };
        }

        // Brave Search API 返回结构
        if (data.web?.results && data.web.results.length > 0) {
            const results: SearchResult[] = data.web.results.slice(0, 5).map((item: any) => ({
                title: item.title,
                description: item.description || '',
                url: item.url
            }));
            return { success: true, results, message: '搜索成功', reached: true };
        }

        // 这一条才是真的"搜过了，没有相关结果"
        return { success: false, results: [], message: '没有找到相关结果', reached: true };
    } catch (e: any) {
        signal?.throwIfAborted();
        console.error('Search failed:', e);
        return { success: false, results: [], message: `搜索出错: ${e.message}`, reached: false };
    }
};

// ==================== Notion（经代理 worker /notion/*） ====================

/**
 * 按日期查找角色的日记（通过 Worker 代理）
 * 支持一天多篇日记，全部返回
 *
 * 不抛异常。`success: false` 只有一个意思：这次查询没跑通（凭据不对 / 代理挂了 / 断网）。
 * 「那天真的没写日记」是 `success: true` + `entries` 为空——调用方别把这两种混成一件事。
 */
export const notionGetDiaryByDate = async (
    apiKey: string,
    databaseId: string,
    characterName: string,
    date: string, signal?: AbortSignal  // YYYY-MM-DD
): Promise<{ success: boolean; entries: DiaryPreview[]; message: string }> => {
    signal?.throwIfAborted();
    try {
        const response = await fetch(`${getProxyWorkerUrl()}/notion/query`, {
            signal,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Notion-API-Key': apiKey
            },
            body: JSON.stringify({
                database_id: databaseId,
                filter: {
                    and: [
                        {
                            property: 'Name',
                            title: { starts_with: `[${characterName}]` }
                        },
                        {
                            property: 'Date',
                            date: { equals: date }
                        }
                    ]
                },
                sorts: [{ property: 'Date', direction: 'descending' }],
                page_size: 10
            })
        });

        const text = await response.text();

        if (!response.ok) {
            const detail = summarizeRealtimeHttpError(text);
            console.error('[Notion] Query diary by date failed:', response.status, detail);
            return { success: false, entries: [], message: `查询失败: ${detail || response.status}` };
        }

        const data = JSON.parse(text);

        if (!data.results || data.results.length === 0) {
            return { success: true, entries: [], message: `没有找到 ${date} 的日记` };
        }

        const entries: DiaryPreview[] = data.results.map((page: any) => {
            const title = page.properties?.Name?.title?.[0]?.plain_text || '无标题';
            const cleanTitle = title.replace(/^\[.*?\]\s*/, '');
            return {
                id: page.id,
                title: cleanTitle,
                date: page.properties?.Date?.date?.start || '',
                url: page.url
            };
        });

        return { success: true, entries, message: `找到 ${entries.length} 篇日记` };
    } catch (e: any) {
        signal?.throwIfAborted();
        const reason = e instanceof Error ? e.message : String(e || '请求异常');
        console.error('[Notion] Get diary by date failed:', reason);
        return { success: false, entries: [], message: `查询失败: ${reason}` };
    }
};

/**
 * 读取日记页面的完整内容（通过 Worker 代理）
 * 调用 /notion/blocks/:pageId 端点，将 blocks 转换为可读文本
 *
 * 不抛异常。`success: false` = 这一篇没读到；页面真的没写字是 `success: true` +
 * content 为「（空白日记）」。
 */
export const notionReadDiaryContent = async (
    apiKey: string,
    pageId: string, signal?: AbortSignal
): Promise<{ success: boolean; content: string; message: string }> => {
    signal?.throwIfAborted();
    try {
        const response = await fetch(`${getProxyWorkerUrl()}/notion/blocks/${pageId}`, {
            signal,
            method: 'GET',
            headers: {
                'X-Notion-API-Key': apiKey
            }
        });

        const text = await response.text();

        if (!response.ok) {
            const detail = summarizeRealtimeHttpError(text);
            console.error('[Notion] Read diary content failed:', response.status, detail);
            return { success: false, content: '', message: `读取失败: ${detail || response.status}` };
        }

        const data = JSON.parse(text);

        if (!data.results || data.results.length === 0) {
            return { success: true, content: '（空白日记）', message: '日记内容为空' };
        }

        // 将 Notion blocks 转换为可读文本
        const content = notionBlocksToText(data.results);
        return { success: true, content, message: '读取成功' };
    } catch (e: any) {
        signal?.throwIfAborted();
        console.error('Read diary content failed:', e);
        return { success: false, content: '', message: `读取失败: ${e.message}` };
    }
};

/**
 * 读取用户笔记页面的完整内容
 * 复用 notionReadDiaryContent 的逻辑（都是通过 pageId 读 blocks）
 */
export const notionReadNoteContent = notionReadDiaryContent;

/**
 * 按关键词搜索用户笔记
 *
 * 不抛异常。`success: false` = 这次搜索没跑通；「没有这篇笔记」是 `success: true` + entries 为空。
 */
export const notionSearchUserNotes = async (
    apiKey: string,
    notesDatabaseId: string,
    keyword: string,
    limit: number = 5, signal?: AbortSignal
): Promise<{ success: boolean; entries: DiaryPreview[]; message: string }> => {
    signal?.throwIfAborted();
    try {
        const response = await fetch(`${getProxyWorkerUrl()}/notion/query`, {
            signal,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Notion-API-Key': apiKey
            },
            body: JSON.stringify({
                database_id: notesDatabaseId,
                filter: {
                    property: 'Name',
                    title: { contains: keyword }
                },
                sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
                page_size: limit
            })
        });

        const text = await response.text();

        if (!response.ok) {
            return { success: false, entries: [], message: `搜索失败: ${response.status}` };
        }

        const data = JSON.parse(text);

        if (!data.results || data.results.length === 0) {
            return { success: true, entries: [], message: `没有找到关于"${keyword}"的笔记` };
        }

        const entries: DiaryPreview[] = data.results.map((page: any) => {
            const title = page.properties?.Name?.title?.[0]?.plain_text
                || page.properties?.['名称']?.title?.[0]?.plain_text
                || page.properties?.Title?.title?.[0]?.plain_text
                || '无标题';
            const date = page.properties?.Date?.date?.start
                || page.properties?.['日期']?.date?.start
                || page.last_edited_time?.split('T')[0]
                || '';
            return {
                id: page.id,
                title,
                date,
                url: page.url || ''
            };
        });

        return { success: true, entries, message: `找到 ${entries.length} 篇笔记` };
    } catch (e: any) {
        signal?.throwIfAborted();
        const reason = e instanceof Error ? e.message : String(e || '请求异常');
        console.error('[Notion] Search user notes failed:', reason);
        return { success: false, entries: [], message: `搜索失败: ${reason}` };
    }
};

/** 将 Notion blocks 转换为可读文本（readDiaryContent / readNoteContent 共用） */
export function notionBlocksToText(blocks: any[]): string {
    const lines: string[] = [];

    for (const block of blocks) {
        const type = block.type;

        if (type === 'divider') {
            lines.push('---');
            continue;
        }

        // 提取 rich_text
        const richText = block[type]?.rich_text;
        if (!richText) continue;

        const text = richText.map((rt: any) => rt.plain_text || rt.text?.content || '').join('');
        if (!text.trim()) continue;

        switch (type) {
            case 'heading_1':
                lines.push(`# ${text}`);
                break;
            case 'heading_2':
                lines.push(`## ${text}`);
                break;
            case 'heading_3':
                lines.push(`### ${text}`);
                break;
            case 'quote':
                lines.push(`> ${text}`);
                break;
            case 'callout':
                const emoji = block.callout?.icon?.emoji || '📌';
                lines.push(`${emoji} ${text}`);
                break;
            case 'bulleted_list_item':
                lines.push(`- ${text}`);
                break;
            case 'numbered_list_item':
                lines.push(`· ${text}`);
                break;
            case 'to_do':
                const checked = block.to_do?.checked ? '✅' : '⬜';
                lines.push(`${checked} ${text}`);
                break;
            case 'toggle':
                lines.push(`▶ ${text}`);
                break;
            case 'code':
                lines.push(`\`\`\`\n${text}\n\`\`\``);
                break;
            default:
                lines.push(text);
        }
    }

    return lines.join('\n');
}

// ==================== 飞书多维表格（经代理 worker /feishu/*） ====================

// 飞书 token 缓存
let feishuTokenCache: { token: string; expiresAt: number } | null = null;

/**
 * 获取飞书 tenant_access_token（通过 Worker 代理，带缓存）
 */
export const feishuGetToken = async (appId: string, appSecret: string, signal?: AbortSignal): Promise<{ success: boolean; token: string; message: string }> => {
    signal?.throwIfAborted();
    // 检查缓存是否有效 (提前5分钟过期)
    if (feishuTokenCache && feishuTokenCache.expiresAt > Date.now() + 5 * 60 * 1000) {
        return { success: true, token: feishuTokenCache.token, message: '使用缓存token' };
    }

    try {
        const response = await fetch(`${getProxyWorkerUrl()}/feishu/token`, {
            signal,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ app_id: appId, app_secret: appSecret })
        });

        const text = await response.text();
        if (!response.ok) {
            signal?.throwIfAborted();
            const detail = summarizeRealtimeHttpError(text);
            return { success: false, token: '', message: `获取token失败: ${detail || response.status}` };
        }

        const data = JSON.parse(text);
        if (data.code !== 0) {
            return { success: false, token: '', message: `飞书错误: ${data.msg || '未知错误'}` };
        }

        const token = data.tenant_access_token;
        const expire = (data.expire || 7200) * 1000; // 转为毫秒
        feishuTokenCache = { token, expiresAt: Date.now() + expire };

        return { success: true, token, message: 'Token获取成功' };
    } catch (e: any) {
        signal?.throwIfAborted();
        return { success: false, token: '', message: `网络错误: ${e.message}` };
    }
};

/**
 * 按日期查找角色的日记
 *
 * 不抛异常。`success: false` = 这次查询没跑通（拿不到 token / 接口报错 / 断网）；
 * 「那天真的没写」是 `success: true` + entries 为空。
 */
export const feishuGetDiaryByDate = async (
    appId: string,
    appSecret: string,
    baseId: string,
    tableId: string,
    characterName: string,
    date: string, signal?: AbortSignal  // YYYY-MM-DD
): Promise<{ success: boolean; entries: FeishuDiaryPreview[]; message: string }> => {
    signal?.throwIfAborted();
    try {
        const tokenResult = await feishuGetToken(appId, appSecret, signal);
        if (!tokenResult.success) {
            return { success: false, entries: [], message: tokenResult.message };
        }

        const dateTimestamp = new Date(date).getTime();
        const nextDayTimestamp = dateTimestamp + 24 * 60 * 60 * 1000;

        const response = await fetch(`${getProxyWorkerUrl()}/feishu/bitable/${baseId}/${tableId}/records/search`, {
            signal,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Feishu-Token': tokenResult.token
            },
            body: JSON.stringify({
                filter: {
                    conjunction: 'and',
                    conditions: [
                        { field_name: '角色', operator: 'is', value: [characterName] },
                        { field_name: '日期', operator: 'isGreater', value: [dateTimestamp - 1] },
                        { field_name: '日期', operator: 'isLess', value: [nextDayTimestamp] }
                    ]
                },
                sort: [{ field_name: '日期', desc: true }],
                page_size: 10
            })
        });

        const text = await response.text();
        if (!response.ok) {
            return { success: false, entries: [], message: `查询失败: ${response.status}` };
        }

        const data = JSON.parse(text);
        if (data.code !== 0) {
            return { success: false, entries: [], message: `飞书错误: ${data.msg || '查询失败'}` };
        }

        const items = data.data?.items || [];
        if (items.length === 0) {
            return { success: true, entries: [], message: `没有找到 ${date} 的日记` };
        }

        const entries: FeishuDiaryPreview[] = items.map((item: any) => {
            const fields = item.fields || {};
            const rawTitle = (Array.isArray(fields['标题']) ? fields['标题']?.[0]?.text : fields['标题']) || '无标题';
            const cleanTitle = String(rawTitle).replace(/^\[.*?\]\s*/, '');

            return {
                recordId: item.record_id,
                title: cleanTitle,
                date: date,
                content: (Array.isArray(fields['内容']) ? fields['内容']?.[0]?.text : fields['内容']) || ''
            };
        });

        return { success: true, entries, message: `找到 ${entries.length} 篇日记` };
    } catch (e: any) {
        signal?.throwIfAborted();
        return { success: false, entries: [], message: `查询失败: ${e.message}` };
    }
};
