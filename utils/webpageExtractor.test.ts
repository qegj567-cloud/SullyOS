import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { detectFirstUrl, detectXhsShortUrl, extractXhsShareTitle, isXhsUrl, extractXhsNoteId, extractXhsNoteLink, expandShortUrl, parseWebpageHtml, extractWebpageContent } from './webpageExtractor';

describe('detectFirstUrl', () => {
  it('从一句话里揪出 http(s) 链接', () => {
    expect(detectFirstUrl('看看这个 https://example.com/article 挺有意思'))
      .toBe('https://example.com/article');
    expect(detectFirstUrl('http://foo.bar/baz')).toBe('http://foo.bar/baz');
  });

  it('中文句号不进 URL，英文尾标点被剥掉', () => {
    // 中文句号不在 URL 字符集里, 正则到此截断
    expect(detectFirstUrl('链接是 https://example.com/x。后面还有字')).toBe('https://example.com/x');
    // 英文句点/右括号结尾要被剥掉
    expect(detectFirstUrl('see (https://example.com/a).')).toBe('https://example.com/a');
  });

  it('没有链接时返回 null', () => {
    expect(detectFirstUrl('就是普通聊天没有网址')).toBeNull();
    expect(detectFirstUrl('')).toBeNull();
    expect(detectFirstUrl('ftp://nope.com')).toBeNull();
  });
});

describe('isXhsUrl', () => {
  it('识别小红书域名（已有专门 MCP 路径，网页抓取要避开）', () => {
    expect(isXhsUrl('https://www.xiaohongshu.com/explore/abc')).toBe(true);
    expect(isXhsUrl('https://xhslink.com/xxx')).toBe(true);
    expect(isXhsUrl('http://xhslink.cn/o/3hJ4anvedNl')).toBe(true);
    expect(isXhsUrl('https://www.rednote.com/explore/abc')).toBe(true);
    expect(isXhsUrl('https://example.com')).toBe(false);
    expect(isXhsUrl('https://rednote.com.example.com/explore/abc')).toBe(false);
    expect(isXhsUrl('https://fake-rednote.com/explore/abc')).toBe(false);
  });
});

describe('detectXhsShortUrl', () => {
  it('识别手机版 xhslink.cn 完整分享文案', () => {
    const text = '办公室的领导看着不苟言笑 http://xhslink.cn/o/3hJ4anvedNl 存下链接，去【小红书】阅读全文~';
    expect(detectXhsShortUrl(text)).toBe('http://xhslink.cn/o/3hJ4anvedNl');
  });

  it('继续兼容 xhslink.com 和不带协议的短链', () => {
    expect(detectXhsShortUrl('https://xhslink.com/a/AbC_123-xy')).toBe('https://xhslink.com/a/AbC_123-xy');
    expect(detectXhsShortUrl('看看 xhslink.cn/o/AbC123')).toBe('https://xhslink.cn/o/AbC123');
  });

  it('不接受相似恶意域名', () => {
    expect(detectXhsShortUrl('https://xhslink.cn.example.com/o/AbC123')).toBeNull();
    expect(detectXhsShortUrl('https://fake-xhslink.cn/o/AbC123')).toBeNull();
  });
});

describe('extractXhsShareTitle', () => {
  it('从新版手机分享文案的短链前提取标题，不把【小红书】当标题', () => {
    const text = '人机恋教主~ a社是不是该给你和你的克颁发结婚证嘞？ ... http://xhslink.cn/o/3udN9HGr5iT 把文本复制下来，打开【小红书】即可查看。';
    expect(extractXhsShareTitle(text))
      .toBe('人机恋教主~ a社是不是该给你和你的克颁发结婚证嘞？');
  });

  it('继续支持旧版【标题 | 小红书】格式', () => {
    const text = '【今天也要好好吃饭 | 小红书】 https://xhslink.com/a/AbC123';
    expect(extractXhsShareTitle(text)).toBe('今天也要好好吃饭');
  });

  it('只有应用名而没有标题时返回空，允许接口标题兜底', () => {
    const text = 'http://xhslink.cn/o/AbC123 打开【小红书】即可查看';
    expect(extractXhsShareTitle(text)).toBe('');
  });
});

describe('extractXhsNoteId', () => {
  const NOTE_ID = '6858ccaa0000000013013c94';

  it('从国内和新版 RedNote 完整链接中提取笔记 ID', () => {
    expect(extractXhsNoteId(`看看这个 https://www.xiaohongshu.com/explore/${NOTE_ID}?xsec_token=abc`))
      .toBe(NOTE_ID);
    expect(extractXhsNoteId(`分享给你 https://www.rednote.com/explore/${NOTE_ID}?xsec_token=abc`))
      .toBe(NOTE_ID);
    expect(extractXhsNoteId(`www.rednote.com/discovery/item/${NOTE_ID}`))
      .toBe(NOTE_ID);
  });

  it('支持短链展开后落到 rednote.com 的最终链接', () => {
    expect(extractXhsNoteId(`https://rednote.com/item/${NOTE_ID}?xsec_source=app_share`))
      .toBe(NOTE_ID);
  });

  it('不把相似恶意域名或非笔记页面误判成小红书笔记', () => {
    expect(extractXhsNoteId(`https://rednote.com.example.com/explore/${NOTE_ID}`)).toBeNull();
    expect(extractXhsNoteId(`https://fake-rednote.com/explore/${NOTE_ID}`)).toBeNull();
    expect(extractXhsNoteId('https://www.rednote.com/explore')).toBeNull();
  });
});

describe('手机小红书分享回归', () => {
  const noteId = '6aa4aaf6000000000b00eab5';
  const shortUrl = 'https://xhslink.cn/o/2KuQOsv8aMN';
  const noteUrl = `http://www.xiaohongshu.com/discovery/item/${noteId}?xsec_source=app_share&xsec_token=test%2Btoken%3D`;
  const captchaUrl = `https://www.xiaohongshu.com/website-login/captcha?redirectPath=${encodeURIComponent(noteUrl)}&verifyType=217`;

  afterEach(() => vi.unstubAllGlobals());

  it('识别用户手机分享文案以及 Markdown 链接', () => {
    for (const link of [shortUrl, `[${shortUrl}](${shortUrl})`]) {
      const text = `胡闹厨房别太胡闹 敌人8双人满血的含金量 两个人重开... ${link} 先复制一下，打开【小红书】看看这篇好文！`;
      expect(detectXhsShortUrl(text)).toBe(shortUrl);
      expect(extractXhsShareTitle(text)).toBe('胡闹厨房别太胡闹 敌人8双人满血的含金量 两个人重开');
    }
  });

  it('兼容线上旧代理的验证码页响应，恢复笔记和 token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true, data: { finalUrl: captchaUrl },
    }))));
    const expanded = await expandShortUrl(shortUrl);
    expect(extractXhsNoteLink(expanded)).toMatchObject({ noteId, xsecToken: 'test+token=', xsecSource:'app_share', url:noteUrl });
    expect(extractXhsNoteId(expanded)).toBe(noteId);
  });

  it('兼容直接笔记 URL 和电脑版文案，token 仅解码一次', () => {
    expect(extractXhsNoteLink(noteUrl)).toMatchObject({ noteId, xsecToken: 'test+token=', xsecSource:'app_share', url:noteUrl });
    expect(extractXhsNoteLink(`80 【胡闹厨房别太胡闹 - 兮橙 | 小红书】 😆 code 😆 [https://www.xiaohongshu.com/discovery/item/${noteId}?xsec_token=desktop_token=](https://www.xiaohongshu.com/discovery/item/${noteId}?xsec_token=desktop_token=)`))
      .toMatchObject({ noteId, xsecToken: 'desktop_token=' });
    expect(extractXhsNoteLink(noteUrl.replace('test%2Btoken%3D', 'test%253D'))?.xsecToken).toBe('test%3D');
  });

  it('不从外站或无效验证码回跳链接中提取笔记', () => {
    expect(extractXhsNoteLink(captchaUrl.replace('https://www.xiaohongshu.com/', 'https://example.com/'))).toBeNull();
    expect(extractXhsNoteLink(`https://www.xiaohongshu.com/website-login/captcha?redirectPath=${encodeURIComponent(noteUrl.replace('www.xiaohongshu.com', 'example.com'))}`)).toBeNull();
    expect(extractXhsNoteLink('https://www.xiaohongshu.com/website-login/captcha?verifyType=217')).toBeNull();
  });
});

describe('parseWebpageHtml', () => {
  // node 测试环境无 DOMParser，会走正则 fallback（htmlToText）。两条路径都应产出标题/正文。
  const html = `
    <html><head>
      <title>测试标题</title>
      <meta name="description" content="这是一段网页摘要描述">
      <meta property="og:site_name" content="测试站">
    </head><body>
      <nav>导航不该进正文</nav>
      <article><p>第一段正文内容。</p><p>第二段正文内容。</p></article>
      <script>console.log('noise')</script>
    </body></html>`;

  it('提取出正文文字（去掉 script 噪音）', () => {
    const r = parseWebpageHtml(html, 'https://test.example.com/p');
    expect(r.content).toContain('第一段正文内容');
    expect(r.content).toContain('第二段正文内容');
    expect(r.content).not.toContain('console.log');
  });

  it('没有站点名时用域名兜底', () => {
    const r = parseWebpageHtml('<p>hi</p>', 'https://www.foo.bar/x');
    expect(r.siteName).toBe('foo.bar');
    expect(r.title).toBeTruthy();
  });

  it('摘要非空且有上限', () => {
    const longBody = '<p>' + '内容'.repeat(500) + '</p>';
    const r = parseWebpageHtml(longBody, 'https://x.com');
    expect(r.excerpt.length).toBeLessThanOrEqual(141); // 140 + 省略号
  });
});

describe('extractWebpageContent 提取链路（apizero → Firecrawl → sfworker/Jina）', () => {
  // 长到能过 MIN_EXTRACT_CHARS(80) 的正文样例。
  const LONG_BODY = 'curl 是常用的命令行工具，用来请求 Web 服务器。'.repeat(10);

  // apizero content-extract 的真实响应结构（阮一峰博客实测裁剪版）。
  const apizeroOk = {
    code: 0,
    msg: '成功',
    data: {
      url: 'https://www.ruanyifeng.com/blog/2019/09/curl-reference.html',
      title: 'curl 的用法指南',
      publish_time: '',
      content: LONG_BODY,
      word_count: LONG_BODY.length,
      reading_time: '2 分钟',
      image_count: 1,
      images: ['https://www.ruanyifeng.com/blog/images/cover.png'],
    },
  };

  // 按 URL 分流的 fetch stub：apizero 端点一份响应，sfworker /fetch-webpage 一份响应。
  const stubFetch = (apizeroBody: any, workerBody?: any) => {
    const fn = vi.fn(async (input: any) => {
      const target = String(input);
      const body = target.includes('apizero.cn') ? apizeroBody : workerBody;
      if (body === undefined) throw new Error(`unexpected fetch: ${target}`);
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    });
    vi.stubGlobal('fetch', fn);
    return fn;
  };

  beforeEach(() => {
    localStorage.removeItem('sully_firecrawl_api_key_v1');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('主路径：apizero 成功 → 直接用其结果，不再碰 sfworker', async () => {
    const fn = stubFetch(apizeroOk);
    const wp = await extractWebpageContent('https://www.ruanyifeng.com/blog/2019/09/curl-reference.html');
    expect(wp.title).toBe('curl 的用法指南');
    expect(wp.content).toBe(LONG_BODY);
    expect(wp.siteName).toBe('ruanyifeng.com');
    expect(wp.image).toBe('https://www.ruanyifeng.com/blog/images/cover.png');
    expect(wp.excerpt.length).toBeGreaterThan(0);
    expect(wp.video).toBeUndefined();
    expect(wp.provider).toBe('apizero-content');
    // 只调了 apizero 一次，没走 worker
    expect(fn).toHaveBeenCalledTimes(1);
    expect(String(fn.mock.calls[0][0])).toContain('apizero.cn/api/content-extract');
    expect(String(fn.mock.calls[0][0])).toContain('key=sk_live_'); // 默认携带项目方共享 key
  });

  it('配置 Firecrawl 后：apizero 失败 → Firecrawl 成功，不再请求 Worker', async () => {
    localStorage.setItem('sully_firecrawl_api_key_v1', 'fc-test');
    const firecrawlMarkdown = '# 动态网页\n\n' + LONG_BODY;
    const fn = vi.fn(async (input: any) => {
      const target = String(input);
      const body = target.includes('apizero.cn')
        ? { code: 5020, msg: '目标网页无法访问' }
        : target.includes('api.firecrawl.dev')
          ? { success: true, data: { markdown: firecrawlMarkdown, metadata: { title: 'Firecrawl 标题', sourceURL: 'https://dynamic.example.com/final', ogImage: 'https://dynamic.example.com/cover.jpg' } } }
          : undefined;
      if (body === undefined) throw new Error(`unexpected fetch: ${target}`);
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    });
    vi.stubGlobal('fetch', fn);

    const wp = await extractWebpageContent('https://dynamic.example.com/page');
    expect(wp.title).toBe('Firecrawl 标题');
    expect(wp.content).toContain(LONG_BODY);
    expect(wp.image).toBe('https://dynamic.example.com/cover.jpg');
    expect(wp.provider).toBe('firecrawl');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(String(fn.mock.calls[1][0])).toContain('api.firecrawl.dev/v2/scrape');
  });

  it('apizero 业务失败（code≠0）→ 降级 sfworker/Jina 老链路', async () => {
    const fn = stubFetch(
      { code: 5020, msg: '目标网页无法访问' },
      { success: true, data: { mode: 'reader', title: 'Jina 抓到的标题', content: LONG_BODY } },
    );
    const wp = await extractWebpageContent('https://example.com/a');
    expect(wp.title).toBe('Jina 抓到的标题');
    expect(wp.content).toBe(LONG_BODY);
    expect(wp.provider).toBe('jina');
    expect(fn).toHaveBeenCalledTimes(2); // apizero 一次 + worker 一次
  });

  it('apizero 正文过短（SPA 壳 / 登录墙 / 文档站）→ 降级 Jina 拿正文，不拿壳当正文', async () => {
    const fn = stubFetch(
      { code: 0, data: { title: '标题', content: '请开启 JavaScript', images: [] } },
      { success: true, data: { mode: 'reader', title: '渲染后的真标题', content: LONG_BODY } },
    );
    const wp = await extractWebpageContent('https://spa.example.com/page');
    expect(wp.title).toBe('渲染后的真标题');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('超长正文截断到 8000 字并标记 truncated', async () => {
    const huge = 'x'.repeat(9000);
    stubFetch({ code: 0, data: { title: '长文', content: huge, images: [] } });
    const wp = await extractWebpageContent('https://example.com/long');
    expect(wp.content.length).toBe(8000);
    expect(wp.truncated).toBe(true);
  });
});
