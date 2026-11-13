// 网页分享 — 把用户粘贴的网址抓成「角色能看见」的纯文字。
//
// 设计目标（对齐 html_card / xhs_card 的「卡片给人看、纯文字摘要喂 LLM」模式）：
//  1) 用户在聊天里粘贴一个 http(s) 链接 → 抓取网页 → 存成 webpage_card 消息；
//  2) 卡片在聊天里渲染成标题 + 摘要的小卡（components/chat/MessageItem.tsx）；
//  3) 上下文 / 归档只看到剥离 HTML 后的纯文字正文（utils/messageFormat.ts），角色就「读到」了网页内容。
//
// 提取链路（extractWebpageContent，逐层降级）：
//  1. apizero content-extract（主）：服务端文本密度算法，浏览器直连（CORS 全开），
//     正文干净、配额充裕（匿名 5000 次/天/IP，带 key 10000 次/天，key 与 videoParser 共用）。
//     疑似 SPA 壳（正文过短）/ 服务挂了 → 降级下一层。
//  2. 用户配置 Firecrawl 时，用 /scrape 读取动态页（Key 本地保存，直接请求服务商）。
//  3. sfworker /fetch-webpage（Jina Reader 无头渲染，SPA 也能读）→ 失败退裸 HTML。
//  4. 前端直连抓裸 HTML + DOMParser 启发式提取（多数站点会被 CORS 挡掉，纯末路兜底）。

import { htmlToText } from './htmlPrompt';
import { getProxyWorkerUrl } from './proxyWorker';
import { getVideoParseKey } from './videoParser';
import { getFirecrawlApiKey, scrapeWebpageWithFirecrawl } from './firecrawl';

// sfworker：项目自带的通用代理 Worker（小红书签名 / 网易云 weapi / Brave 搜索 / WebDAV /
// 网页抓取都走它，代码见 worker/index.js）。地址走中心配置 utils/proxyWorker.ts，
// 用户可在「设置 → 网络代理 (Worker)」里换成自部署实例。
const sfworkerUrl = (): string => getProxyWorkerUrl();

/** 视频平台分享的附加信息（utils/videoParser.ts 解析产出，webpage_card 复用展示）。 */
export interface VideoShareInfo {
  /** 平台标识（bilibili / douyin / …）。 */
  platform: string;
  /** 平台中文名（哔哩哔哩 / 抖音），卡片角标用。 */
  platformLabel?: string;
  /** 视频还是图集。 */
  contentType?: 'video' | 'image';
  authorName?: string;
  authorAvatar?: string;
  playCount?: number;
  likeCount?: number;
  commentCount?: number;
  shareCount?: number;
  collectCount?: number;
  /** 原平台发布时间（字符串原样保留）。 */
  publishTime?: string;
  /** 图集张数（contentType === 'image' 时）。 */
  imageCount?: number;
}

/** 抓取并解析后的网页结构。卡片 metadata 存这一份。 */
export interface ExtractedWebpage {
  /** 抓取用的原始 URL（跳转后可能与 finalUrl 不同）。 */
  url: string;
  /** 重定向后的最终 URL（worker 能拿到时回填，否则等于 url）。 */
  finalUrl?: string;
  /** 网页标题（<title> / og:title）。 */
  title: string;
  /** 站点名（og:site_name / 域名兜底）。 */
  siteName?: string;
  /** 提取出的正文纯文字（已截断到 MAX_CONTENT_CHARS）。 */
  content: string;
  /** 短摘要（meta description / 正文开头）。 */
  excerpt: string;
  /** 封面图 URL（og:image / 正文首图），卡片显示用。 */
  image?: string;
  /** 正文是否因超长被截断。 */
  truncated: boolean;
  /** 抓取时间戳。 */
  fetchedAt: number;
  /** 实际命中的抓取来源，便于诊断和实时展示，不参与角色提示词。 */
  provider?: 'apizero-content' | 'apizero-video' | 'firecrawl' | 'jina' | 'worker-raw' | 'direct';
  /** 视频平台分享时的附加信息（走 videoParser 解析路径才有）。 */
  video?: VideoShareInfo;
}

/** 卡片 metadata 里正文的存储上限：太长既占 IndexedDB 也没必要全留。 */
const MAX_CONTENT_CHARS = 8000;
/** 摘要长度。 */
const EXCERPT_CHARS = 140;

/** apizero content-extract 端点（与 videoParser 的 video-parse 同一服务商、同一 key）。 */
const APIZERO_EXTRACT_ENDPOINT = 'https://v1.apizero.cn/api/content-extract';
/** 提取正文短于这个就当失败：多半是 SPA 壳 / 反爬占位页，让 Jina（无头渲染）接手。 */
const MIN_EXTRACT_CHARS = 80;
const APIZERO_TIMEOUT_MS = 20000;

/**
 * 从一段文本里揪出第一个 http(s) 链接。返回 null 表示没有可抓的链接。
 * 末尾的常见标点（。，！？、）以及成对括号不算进 URL，避免把中文句号粘进去。
 */
export function detectFirstUrl(text: string): string | null {
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s，。！？；、"'《》()（）【】]+/i);
  if (!m) return null;
  // 去掉尾部可能误吞的英文标点
  return m[0].replace(/[.,;:!?'")\]]+$/, '');
}

const XHS_NOTE_PATH_RE = /^\/(?:discovery\/item|explore|item)\/([a-f0-9]{24})(?:[/?#]|$)/i;
const XHS_SHORT_HOSTS = ['xhslink.com', 'xhslink.cn'];

function isXhsHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return ['xiaohongshu.com', 'rednote.com', ...XHS_SHORT_HOSTS]
    .some(domain => host === domain || host.endsWith(`.${domain}`));
}

/**
 * 从分享文案中提取小红书短链。
 * 桌面/旧版常见 xhslink.com，手机版新版会生成 xhslink.cn。
 */
export function detectXhsShortUrl(text: string): string | null {
  if (!text) return null;

  const candidates: string[] = [...(text.match(/https?:\/\/[^\s，。！？；、"'《》()（）【】]+/ig) || [])];
  const naked = text.match(/(?:^|[\s，。！？；、"'《》()（）【】])((?:www\.)?xhslink\.(?:com|cn)\/[A-Za-z0-9/_-]+)/i)?.[1];
  if (naked) candidates.push(`https://${naked}`);

  for (const candidate of candidates) {
    try {
      const cleaned = candidate.replace(/[.,;:!?'")\]]+$/, '');
      const parsed = new URL(cleaned);
      const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
      if (XHS_SHORT_HOSTS.some(domain => host === domain || host.endsWith(`.${domain}`))) {
        return cleaned;
      }
    } catch {
      // 忽略坏链接，继续检查下一个 URL。
    }
  }
  return null;
}

function cleanXhsShareTitle(raw: string): string {
  return raw
    .replace(/\s*[|｜]\s*(?:小红书|REDnote).*$/i, '')
    .replace(/\s*(?:\.{2,}|…+|。{2,})\s*$/u, '')
    .replace(/^[\s“”"'「」『』《》]+|[\s“”"'「」『』《》]+$/g, '')
    .trim();
}

/**
 * 从小红书分享文案中提取卡片标题。
 *
 * 桌面旧版常见「【标题 | 小红书】」，手机新版则是
 * 「标题 ... http://xhslink.cn/... 打开【小红书】即可查看」。
 * 后一种不能直接取第一个【】块，否则会把应用名“小红书”误当标题。
 */
export function extractXhsShareTitle(text: string): string {
  if (!text) return '';

  const bracketed = [...text.matchAll(/【(.+?)】/g)]
    .map(match => cleanXhsShareTitle(match[1] || ''))
    .find(candidate => candidate && !/^(?:小红书|REDnote)$/i.test(candidate));
  if (bracketed) return bracketed;

  const urls = text.match(/https?:\/\/[^\s，。！？；、'"」』）】]+/ig) || [];
  const xhsUrl = urls.find(candidate => isXhsUrl(candidate.replace(/[.,;:!?'"）)\]】]+$/, '')));
  if (!xhsUrl) return '';

  const prefix = cleanXhsShareTitle(text.slice(0, text.indexOf(xhsUrl)).replace(/\[$/, ''));
  return /^(?:小红书|REDnote)$/i.test(prefix) ? '' : prefix;
}

/** XHS 链接已有专门的 MCP 卡片路径，网页抓取要避开它，免得抢同一条消息。 */
export function isXhsUrl(url: string): boolean {
  try {
    const parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return isXhsHostname(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * 从完整分享文案或单个链接中提取小红书笔记 ID 和已解码的 token。
 * 同时支持国内域名 xiaohongshu.com 和新版国际域名 rednote.com；
 * xhslink.com / xhslink.cn 短链没有 ID，需先 expandShortUrl 后再调用本函数。
 */
export function extractXhsNoteLink(text: string): { noteId: string; xsecToken?: string; xsecSource?: string; url: string } | null {
  if (!text) return null;

  const candidates: string[] = [...(text.match(/https?:\/\/[^\s，。！？；、"'《》()（）【】]+/ig) || [])];
  const naked = text.match(/(?:^|[\s，。！？；、"'《》()（）【】])((?:www\.)?(?:xiaohongshu\.com|rednote\.com)\/[^\s，。！？；、"'《》()（）【】]+)/i)?.[1];
  if (naked) candidates.push(`https://${naked}`);

  for (const candidate of candidates) {
    try {
      // 分享文本可能来自 Markdown；只还原链接中的常见转义。
      let parsed = new URL(candidate.replace(/\\([_&])/g, '$1').replace(/[.,;:!?'")\]]+$/, ''));
      for (let depth = 0; depth < 4; depth++) {
        const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
        const isNoteHost = ['xiaohongshu.com', 'rednote.com']
          .some(domain => host === domain || host.endsWith(`.${domain}`));
        if (!isNoteHost || !/^https?:$/.test(parsed.protocol)) break;
        const noteId = parsed.pathname.match(XHS_NOTE_PATH_RE)?.[1];
        if (noteId) {
          // URLSearchParams 解码一次即可：手机分享常带 %3D，不能原样送给详情 API。
          return { noteId, xsecToken: parsed.searchParams.get('xsec_token') || undefined,
            xsecSource: parsed.searchParams.get('xsec_source') || undefined, url: parsed.href };
        }
        // 兼容旧代理一路 follow 到验证码页的响应，不需要访问或通过验证码。
        if (parsed.pathname !== '/website-login/captcha') break;
        const redirectPath = parsed.searchParams.get('redirectPath');
        if (!redirectPath) break;
        parsed = new URL(redirectPath, parsed.origin);
      }
    } catch {
      // 忽略文案里的坏链接，继续检查下一个 URL。
    }
  }
  return null;
}

export function extractXhsNoteId(text: string): string | null {
  return extractXhsNoteLink(text)?.noteId || null;
}

/**
 * 经 sfworker 展开短链（xhslink.com / xhslink.cn 等），返回跟随 HTTP 重定向后的最终 URL。
 * 小红书短链不含 note id / xsec_token，展开后才拿得到。
 */
export async function expandShortUrl(url: string): Promise<string> {
  const res = await fetch(`${sfworkerUrl()}/expand-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    // 小红书短链在部分网络/代理组合下会一直挂起。及时失败，交给聊天页给出
    // 可操作的网络提示，避免用户看到“发送后什么都没发生”。
    signal: AbortSignal.timeout(12_000),
  });
  const text = await res.text().catch(() => '');
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  if (!res.ok || !parsed?.success) {
    const err = parsed?.error;
    throw new Error((err && (err.message || err)) || `短链展开失败 (HTTP ${res.status})`);
  }
  return String(parsed?.data?.finalUrl || url);
}

/** sfworker /fetch-webpage 的返回：reader=已渲染提取的干净正文；raw=原始 HTML 待前端解析。 */
type WorkerFetchResult =
  | { mode: 'reader'; title: string; content: string; finalUrl?: string }
  | { mode: 'raw'; html: string; finalUrl?: string };

/**
 * 通过 sfworker 的 /fetch-webpage 代理抓取网页（绕过浏览器 CORS）。
 * worker 优先用 Jina Reader 渲染 + 正文提取（SPA 也能读），失败回退裸 HTML。
 * 失败抛错（由 extractWebpageContent 兜底到直连）。
 */
async function fetchViaWorker(url: string): Promise<WorkerFetchResult> {
  const res = await fetch(`${sfworkerUrl()}/fetch-webpage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const text = await res.text().catch(() => '');
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* non-json */ }

  if (!res.ok || !parsed?.success) {
    // sfworker 失败返回 { error: '中文说明' }（字符串）；也兼容 { error: { message } }。
    const err = parsed?.error;
    const msg = (err && (err.message || err)) || `网页抓取失败 (HTTP ${res.status})`;
    throw new Error(typeof msg === 'string' ? msg : '网页抓取失败');
  }
  const data = parsed?.data || {};
  if (data.mode === 'reader' && typeof data.content === 'string' && data.content.trim()) {
    return { mode: 'reader', title: String(data.title || ''), content: data.content, finalUrl: data.finalUrl };
  }
  const html = String(data.html || '');
  if (!html) throw new Error('worker 返回的网页内容为空');
  return { mode: 'raw', html, finalUrl: data.finalUrl };
}

/** 直连兜底：大多数站点会被 CORS 挡掉，仅对放开跨域的页面有效。 */
async function fetchHtmlDirect(url: string): Promise<{ html: string }> {
  const res = await fetch(url, { headers: { Accept: 'text/html,application/xhtml+xml' } });
  if (!res.ok) throw new Error(`直连抓取失败 (HTTP ${res.status})`);
  const html = await res.text();
  if (!html) throw new Error('网页内容为空');
  return { html };
}

/** 从一段正文生成短摘要（截到 EXCERPT_CHARS）。 */
function makeExcerpt(text: string): string {
  const t = (text || '').trim();
  return t.length > EXCERPT_CHARS ? t.slice(0, EXCERPT_CHARS).trim() + '…' : t;
}

/** 从 URL 取站点名（去掉 www.）。 */
function siteNameFromUrl(url: string): string | undefined {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return undefined; }
}

/**
 * 把 HTML 解析成「正文纯文字 + 标题 + 摘要」。纯前端用 DOMParser，不引第三方库。
 * 启发式：去掉 script/style/nav/header/footer/aside 等噪音节点，优先取 <article>/<main>，
 * 退而取 <body>，再用现成的 htmlToText() 转纯文字。
 */
export function parseWebpageHtml(html: string, url: string): {
  title: string;
  siteName?: string;
  content: string;
  excerpt: string;
  image?: string;
} {
  let title = '';
  let siteName: string | undefined;
  let metaDesc = '';
  let content = '';
  let image: string | undefined;

  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // 标题：og:title 优先，其次 <title>。
    const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
    title = (ogTitle || doc.querySelector('title')?.textContent || '').trim();

    siteName = doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content')?.trim() || undefined;
    metaDesc = (
      doc.querySelector('meta[name="description"]')?.getAttribute('content') ||
      doc.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
      ''
    ).trim();
    // 封面图：og:image / twitter:image。
    image = (
      doc.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
      doc.querySelector('meta[name="twitter:image"]')?.getAttribute('content') ||
      ''
    ).trim() || undefined;

    // 干掉明显的非正文噪音节点。
    doc.querySelectorAll(
      'script, style, noscript, nav, header, footer, aside, form, svg, iframe, button, [aria-hidden="true"]'
    ).forEach((el) => el.remove());

    const main = doc.querySelector('article') || doc.querySelector('main') || doc.body;
    content = htmlToText(main?.innerHTML || '');
  } catch {
    // DOMParser 不可用（极端环境）时退回纯正则剥标签。
    content = htmlToText(html);
  }

  if (!siteName) {
    try { siteName = new URL(url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
  }

  let truncatedContent = content;
  if (truncatedContent.length > MAX_CONTENT_CHARS) {
    truncatedContent = truncatedContent.slice(0, MAX_CONTENT_CHARS);
  }

  const excerptSource = metaDesc || truncatedContent;
  const excerpt = excerptSource.length > EXCERPT_CHARS
    ? excerptSource.slice(0, EXCERPT_CHARS).trim() + '…'
    : excerptSource.trim();

  return {
    title: title || siteName || '网页',
    siteName,
    content: truncatedContent,
    excerpt,
    image,
  };
}

/** 从 Jina Reader 的 markdown 正文里揪出第一张图片 URL（![alt](url)）作封面。 */
function firstImageFromMarkdown(md: string): string | undefined {
  const m = md.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/);
  return m ? m[1] : undefined;
}

/**
 * 主路径：apizero content-extract 服务端正文提取（浏览器直连）。
 * 业务失败 / 正文过短（疑似 SPA 壳）抛错，由 extractWebpageContent 降级到 Jina 链路。
 */
async function extractViaApizero(url: string): Promise<ExtractedWebpage> {
  const params = new URLSearchParams({ url });
  const key = getVideoParseKey(); // apizero 的 key 是账号级的，视频解析 / 正文提取通用
  if (key) params.set('key', key);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APIZERO_TIMEOUT_MS);
  let parsed: any = null;
  try {
    const res = await fetch(`${APIZERO_EXTRACT_ENDPOINT}?${params.toString()}`, { signal: controller.signal });
    const text = await res.text().catch(() => '');
    try { parsed = text ? JSON.parse(text) : null; } catch { /* non-json */ }
    if (!parsed) throw new Error(`正文提取服务无响应 (HTTP ${res.status})`);
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('正文提取超时');
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (Number(parsed.code) !== 0) {
    throw new Error(String(parsed.msg || `正文提取失败 (code ${parsed.code})`));
  }
  const d: any = parsed.data || {};
  const rawContent = String(d.content || '').trim();
  if (rawContent.length < MIN_EXTRACT_CHARS) throw new Error('提取到的正文过短');

  const content = rawContent.length > MAX_CONTENT_CHARS ? rawContent.slice(0, MAX_CONTENT_CHARS) : rawContent;
  const finalUrl = String(d.url || '') || undefined;
  const siteName = siteNameFromUrl(finalUrl || url);
  const images: string[] = Array.isArray(d.images)
    ? d.images.filter((u: any) => typeof u === 'string' && /^https?:\/\//i.test(u))
    : [];
  return {
    url,
    finalUrl,
    title: String(d.title || '').trim() || siteName || '网页',
    siteName,
    content,
    excerpt: makeExcerpt(content),
    image: images[0],
    truncated: rawContent.length > MAX_CONTENT_CHARS,
    fetchedAt: Date.now(),
    provider: 'apizero-content',
  };
}

/**
 * 抓取 + 解析一个网页，返回可直接塞进 webpage_card metadata 的结构。
 * 抓取失败（CORS / worker 报错 / 网络）时抛错，调用方负责给用户 toast。
 */
export async function extractWebpageContent(url: string): Promise<ExtractedWebpage> {
  // 主路径：apizero 正文提取。失败（服务挂 / SPA 壳 / 配额）降级到 sfworker/Jina 老链路。
  const viaApizero = await extractViaApizero(url).catch((e) => {
    console.warn('[webpageExtractor] apizero extract failed, fallback to worker/Jina:', e);
    return null;
  });
  if (viaApizero) return viaApizero;

  // 用户自备 Firecrawl Key 时，用它接手 apizero 抓不到的动态页。Key 只在本机保存，
  // 客户端直连 Firecrawl，不经过公共 Worker，也不会挤作者的共享额度。
  if (getFirecrawlApiKey()) {
    const viaFirecrawl = await scrapeWebpageWithFirecrawl(url).catch((e) => {
      console.warn('[webpageExtractor] Firecrawl failed, fallback to worker/Jina:', e);
      return null;
    });
    if (viaFirecrawl) {
      const rawContent = viaFirecrawl.markdown;
      const content = rawContent.length > MAX_CONTENT_CHARS ? rawContent.slice(0, MAX_CONTENT_CHARS) : rawContent;
      const finalUrl = viaFirecrawl.finalUrl;
      const siteName = siteNameFromUrl(finalUrl || url);
      return {
        url,
        finalUrl,
        title: viaFirecrawl.title || siteName || '网页',
        siteName,
        content,
        excerpt: makeExcerpt(content),
        image: viaFirecrawl.image || firstImageFromMarkdown(rawContent),
        truncated: rawContent.length > MAX_CONTENT_CHARS,
        fetchedAt: Date.now(),
        provider: 'firecrawl',
      };
    }
  }

  const viaWorker = await fetchViaWorker(url).catch((e) => {
    // sfworker 抓取报错：记录后让直连兜底再试一把。
    console.warn('[webpageExtractor] sfworker fetch failed, will try direct:', e);
    return null;
  });

  // Jina Reader 路径：worker 已渲染 + 提取好干净正文，直接用，不必再 DOMParser。
  if (viaWorker && viaWorker.mode === 'reader') {
    const finalUrl = viaWorker.finalUrl;
    const rawContent = viaWorker.content;
    const content = rawContent.length > MAX_CONTENT_CHARS ? rawContent.slice(0, MAX_CONTENT_CHARS) : rawContent;
    const siteName = siteNameFromUrl(finalUrl || url);
    return {
      url,
      finalUrl,
      title: (viaWorker.title || '').trim() || siteName || '网页',
      siteName,
      content,
      excerpt: makeExcerpt(content),
      image: firstImageFromMarkdown(rawContent),
      truncated: rawContent.length > MAX_CONTENT_CHARS,
      fetchedAt: Date.now(),
      provider: 'jina',
    };
  }

  // raw HTML 路径：worker 裸抓回退 或 直连兜底，前端自己 DOMParser 提取。
  let html = '';
  let finalUrl: string | undefined;
  if (viaWorker && viaWorker.mode === 'raw') {
    html = viaWorker.html;
    finalUrl = viaWorker.finalUrl;
  } else {
    const direct = await fetchHtmlDirect(url); // 失败直接抛给调用方
    html = direct.html;
  }

  const parsed = parseWebpageHtml(html, finalUrl || url);
  const rawContent = htmlToText(html); // 仅用于判断是否截断
  return {
    url,
    finalUrl,
    title: parsed.title,
    siteName: parsed.siteName,
    content: parsed.content,
    excerpt: parsed.excerpt,
    image: parsed.image,
    truncated: rawContent.length > MAX_CONTENT_CHARS,
    fetchedAt: Date.now(),
    provider: viaWorker?.mode === 'raw' ? 'worker-raw' : 'direct',
  };
}
