import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    describeGithubUploadTransportFailure,
    downloadBackup,
    listBackups,
    readResponseArrayBuffer,
    shouldUseGithubProxy,
    uploadBackup,
} from './githubClient';
import { consumeTaskTrace, STEP_TRACE_KINDS } from './taskTrace';

// 中断留痕：只有走不到收尾时才该留下。测试里在请求发出的那一刻读，等同于「这时页面没了」。
const UPLOAD_TRACE = STEP_TRACE_KINDS.find(kind => kind.key.includes('cloud_upload'))!;
const DOWNLOAD_TRACE = STEP_TRACE_KINDS.find(kind => kind.key.includes('cloud_download'))!;
const traceNow = (key: string) => JSON.parse(localStorage.getItem(key) || 'null');

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('GitHub 备份代理安全默认', () => {
    const base = {
        enabled: true,
        webdavUrl: '',
        username: '',
        password: '',
        remotePath: '/',
    };

    it('新用户与缺少代理字段的旧配置默认直连', () => {
        expect(shouldUseGithubProxy(base)).toBe(false);
    });

    it('旧版默认写入的 true 没有新版确认标记时仍然直连', () => {
        expect(shouldUseGithubProxy({ ...base, githubUseProxy: true })).toBe(false);
    });

    it('只有用户在新版说明下明确开启后才走中转', () => {
        expect(shouldUseGithubProxy({
            ...base,
            githubUseProxy: true,
            githubProxyConsentVersion: 1,
        })).toBe(true);
    });

    it('明确关闭始终直连', () => {
        expect(shouldUseGithubProxy({
            ...base,
            githubUseProxy: false,
            githubProxyConsentVersion: 1,
        })).toBe(false);
    });

    it('直连失败时明确区分 GitHub 网页、API 与附件域名', () => {
        const message = describeGithubUploadTransportFailure(base);
        expect(message).toContain('uploads.github.com');
        expect(message).toContain('api.github.com');
        expect(message).toContain('开着梯子');
        expect(message).toContain('应用内 Cloudflare 中转');
        // 网页端直连上传必然失败，提示要说明是 GitHub 不允许网页访问
        expect(message).toContain('不允许网页访问');
    });

    it('中转失败时说明当前走的是独立 Worker 线路', () => {
        const message = describeGithubUploadTransportFailure({
            ...base,
            githubUseProxy: true,
            githubProxyConsentVersion: 1,
        });
        expect(message).toContain('应用内 Cloudflare 中转');
        expect(message).toContain('proxy.friedsully.com');
        expect(message).toContain('自定义网络代理 (Worker)');
        expect(message).toContain('请先开梯子再试');
    });
});

describe('readResponseArrayBuffer', () => {
    it('reports streamed byte progress while preserving the payload', async () => {
        const source = new Uint8Array([1, 2, 3, 4, 5, 6]);
        const progress: number[] = [];
        const result = await readResponseArrayBuffer(new Response(source), value => progress.push(value));

        expect(Array.from(new Uint8Array(result))).toEqual(Array.from(source));
        expect(progress.length).toBeGreaterThan(0);
        expect(progress.at(-1)).toBe(source.byteLength);
    });
});

describe('GitHub 备份下载错误', () => {
    const config = {
        enabled: true,
        provider: 'github' as const,
        webdavUrl: '',
        username: '',
        password: '',
        remotePath: '/',
        githubToken: 'github_pat_test',
        githubOwner: 'owner',
        githubRepo: 'sully-backup',
        githubUseProxy: false,
    };

    const file = {
        name: 'Sully_Backup_full_1.zip',
        href: '123:512999539',
        size: 3,
        lastModified: Date.now(),
    };

    it('正式环境能够直连时仍直接下载，不会自动切到 Worker', async () => {
        const directFetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
        vi.stubGlobal('fetch', directFetch);

        const backup = await downloadBackup(config, file);

        expect(backup?.blob.size).toBe(3);
        expect(String(directFetch.mock.calls[0][0])).toBe(
            'https://api.github.com/repos/owner/sully-backup/releases/assets/512999539',
        );
    });

    it('网页直连被 CORS/网络拦截时给出手动开启中转的提示', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

        await expect(downloadBackup(config, file)).rejects.toThrow(
            '手动开启应用内 Cloudflare 中转后重试；应用不会自动开启',
        );
        // 提示要说清这不是用户网络的问题
        await expect(downloadBackup(config, file)).rejects.toThrow('开着梯子也一样');
    });

    it('开着中转仍然连不上时，说明还要看本机网络', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Load failed')));
        const viaRelay = { ...config, githubUseProxy: true, githubProxyConsentVersion: 1 };
        await expect(downloadBackup(viaRelay, file)).rejects.toThrow('请先开梯子再试');
    });

    it('GitHub 返回权限错误时保留 HTTP 状态和处理建议', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403 })));

        await expect(downloadBackup(config, file)).rejects.toThrow('HTTP 403');
    });
});

describe('GitHub 分片下载核对', () => {
    const config = {
        enabled: true,
        provider: 'github' as const,
        webdavUrl: '',
        username: '',
        password: '',
        remotePath: '/',
        githubToken: 'github_pat_test',
        githubOwner: 'owner',
        githubRepo: 'sully-backup',
        githubUseProxy: false,
    };
    const sha256 = async (bytes: Uint8Array) =>
        'sha256:' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)),
            b => b.toString(16).padStart(2, '0')).join('');

    /** 一个三片的事务式备份：列表里每片带 digest（传 null 表示 GitHub 没给），下载按附件 id 回字节。 */
    let tracesSeen: any[] = [];
    const stubRelease = async (releaseId: number, digestOf: (bytes: Uint8Array, index: number) => Promise<string | null>) => {
        tracesSeen = [];
        const parts = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6]), new Uint8Array([7])];
        const assets = await Promise.all(parts.map(async (bytes, index) => ({
            id: releaseId * 10 + index + 1,
            name: `Sully_Backup_full_${releaseId}.part${index + 1}of3.zip`,
            size: bytes.byteLength,
            state: 'uploaded',
            digest: await digestOf(bytes, index),
            updated_at: '2026-11-15T00:00:00Z',
        })));
        assets.push({
            id: releaseId * 10 + 9,
            name: `Sully_Backup_full_${releaseId}.sully-backup.json`,
            size: 20,
            state: 'uploaded',
            digest: null,
            updated_at: '2026-11-15T00:00:00Z',
        });
        const release = { id: releaseId, tag_name: `sully-backup-v2-${releaseId}`, draft: false, assets };
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            const assetMatch = /\/releases\/assets\/(\d+)$/.exec(url);
            if (assetMatch) {
                const index = Number(assetMatch[1]) - releaseId * 10 - 1;
                tracesSeen.push(traceNow(DOWNLOAD_TRACE.key));
                return new Response(parts[index].slice(), { status: 200 });
            }
            return new Response(JSON.stringify([release]), { status: 200, headers: { 'Content-Type': 'application/json' } });
        });
        vi.stubGlobal('fetch', fetchMock);
        const [file] = await listBackups(config);
        return { file, fetchMock };
    };

    it('多分片下载后拼出的字节与原始一致', async () => {
        const { file } = await stubRelease(40, bytes => sha256(bytes));
        const backup = await downloadBackup(config, file);

        expect(Array.from(new Uint8Array(await backup!.blob.arrayBuffer()))).toEqual([1, 2, 3, 4, 5, 6, 7]);
        await backup!.dispose();
        // 下载途中留痕在，记着第几片、已收多少；正常结束后删掉。
        expect(tracesSeen[2]).toMatchObject({ step: '下载第 3 / 3 片', done: 6, total: 7, unit: 'B', facts: { 云端: 'GitHub', 分片数: 3, 写到: '内存' } });
        expect(localStorage.getItem(DOWNLOAD_TRACE.key)).toBeNull();
    });

    it('下载途中页面没了：留痕留下来，下次启动读得出停在第几片', async () => {
        const { file } = await stubRelease(45, bytes => sha256(bytes));
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {}))); // 第一片永远等不到
        void downloadBackup(config, file);
        await vi.waitFor(() => expect(traceNow(DOWNLOAD_TRACE.key)?.step).toBe('下载第 1 / 3 片'));
        expect(consumeTaskTrace(DOWNLOAD_TRACE)!.detail).toContain('停在：下载第 1 / 3 片\n进度：0 B / 7 B');
    });

    it('某一片内容与 digest 不符时失败，并写明是哪一片', async () => {
        // 第 2 片的 digest 记的是别的内容，大小照样对得上，只核对大小发现不了。
        const { file, fetchMock } = await stubRelease(50, (bytes, index) =>
            sha256(index === 1 ? new Uint8Array([9, 9, 9]) : bytes));

        await expect(downloadBackup(config, file)).rejects.toThrow('GitHub 备份第 2/3 片校验和不符');
        expect(tracesSeen.length).toBeGreaterThan(0);
        expect(localStorage.getItem(DOWNLOAD_TRACE.key)).toBeNull();
        // 沿用分片下载的重试：同一片拉了三次才放弃。
        expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/releases/assets/502'))).toHaveLength(3);
    }, 10_000);

    it('digest 缺失时只核对大小，照常成功', async () => {
        const { file } = await stubRelease(60, async () => null);
        const backup = await downloadBackup(config, file);

        expect(backup!.blob.size).toBe(7);
    });
});

describe('GitHub 备份列表完整性', () => {
    const config = {
        enabled: true,
        provider: 'github' as const,
        webdavUrl: '',
        username: '',
        password: '',
        remotePath: '/',
        githubToken: 'github_pat_test',
        githubOwner: 'owner',
        githubRepo: 'sully-backup',
        githubUseProxy: false,
    };

    it('翻页读取超过 100 条 Release 后仍能找到备份', async () => {
        const unrelated = Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            tag_name: `unrelated-${index}`,
            assets: [],
        }));
        const backup = {
            id: 500,
            tag_name: 'sully-backup-legacy-1',
            draft: false,
            created_at: '2026-08-20T00:00:00Z',
            assets: [{
                id: 900,
                name: 'Sully_Backup_full_1.zip',
                size: 3,
                state: 'uploaded',
                updated_at: '2026-08-20T00:00:01Z',
            }],
        };
        const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
            const url = String(input);
            const payload = new URL(url).searchParams.get('page') === '1' ? unrelated : [backup];
            return Promise.resolve(new Response(JSON.stringify(payload), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }));
        });
        vi.stubGlobal('fetch', fetchMock);

        const files = await listBackups(config);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(files).toHaveLength(1);
        expect(files[0]).toMatchObject({ name: 'Sully_Backup_full_1.zip', status: 'ready' });
    });

    it('草稿、starter 和缺少完成标记的新版 Release 会显示为上传未完成', async () => {
        const releases = [
            {
                id: 10,
                tag_name: 'sully-backup-v2-10',
                name: 'Sully Backup interrupted',
                draft: true,
                created_at: '2026-08-20T00:00:00Z',
                assets: [{ id: 11, name: 'Sully_Backup_full_10.zip', size: 0, state: 'starter' }],
            },
            {
                id: 20,
                tag_name: 'sully-backup-v2-20',
                name: 'Sully Backup missing manifest',
                draft: false,
                created_at: '2026-08-20T01:00:00Z',
                assets: [{ id: 21, name: 'Sully_Backup_full_20.zip', size: 12, state: 'uploaded' }],
            },
        ];
        vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => {
            const url = String(input);
            const payload = url.includes('/releases/20/assets') ? releases[1].assets : releases;
            return Promise.resolve(new Response(JSON.stringify(payload), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }));
        }));

        const files = await listBackups(config);

        expect(files).toHaveLength(2);
        expect(files.every(file => file.status === 'incomplete')).toBe(true);
        expect(files.map(file => file.statusMessage).join(' ')).toContain('0 字节');
        expect(files.map(file => file.statusMessage).join(' ')).toContain('缺少完成标记');
    });

    it('内嵌附件达到截断边界时会读取分页附件，避免误报缺少分片', async () => {
        const embeddedAssets = [
            { id: 31, name: 'Sully_Backup_full_30.zip', size: 3, state: 'uploaded' },
            ...Array.from({ length: 29 }, (_, index) => ({
                id: 1000 + index,
                name: `diagnostic-${index}.txt`,
                size: 1,
                state: 'uploaded',
            })),
        ];
        const completeAssets = [
            embeddedAssets[0],
            { id: 32, name: 'Sully_Backup_full_30.zip.sully-backup.json', size: 20, state: 'uploaded' },
        ];
        const release = {
            id: 30,
            tag_name: 'sully-backup-v2-30',
            draft: false,
            created_at: '2026-08-20T02:00:00Z',
            assets: embeddedAssets,
        };
        const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
            const url = String(input);
            const payload = url.includes('/releases/30/assets') ? completeAssets : [release];
            return Promise.resolve(new Response(JSON.stringify(payload), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }));
        });
        vi.stubGlobal('fetch', fetchMock);

        const files = await listBackups(config);

        expect(files).toHaveLength(1);
        expect(files[0]).toMatchObject({ name: 'Sully_Backup_full_30.zip', status: 'ready' });
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/releases/30/assets'))).toBe(true);
    });

    it('列表鉴权或限流错误不会再伪装成空数组', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
            JSON.stringify({ message: 'API rate limit exceeded' }),
            {
                status: 403,
                headers: {
                    'Content-Type': 'application/json',
                    'X-RateLimit-Remaining': '0',
                },
            },
        )));

        await expect(listBackups(config)).rejects.toThrow('请求过于频繁');
    });
});

describe('GitHub 事务式上传', () => {
    const config = {
        enabled: true,
        provider: 'github' as const,
        webdavUrl: '',
        username: '',
        password: '',
        remotePath: '/',
        githubToken: 'github_pat_test',
        githubOwner: 'owner',
        githubRepo: 'sully-backup',
        githubUseProxy: false,
    };

    it('附件失败时删除草稿 Release 和 tag，不留下半截备份', async () => {
        class FailedUploadXhr {
            status = 422;
            responseText = '{"message":"unprocessable"}';
            timeout = 0;
            upload: { onprogress?: (event: ProgressEvent) => void } = {};
            onload?: () => void;
            onerror?: () => void;
            onabort?: () => void;
            ontimeout?: () => void;
            open() {}
            setRequestHeader() {}
            getAllResponseHeaders() { return ''; }
            send() { traceDuringSend = traceNow(UPLOAD_TRACE.key); this.onload?.(); }
        }
        let traceDuringSend: any = null;
        vi.stubGlobal('XMLHttpRequest', FailedUploadXhr as any);

        const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.endsWith('/releases') && init?.method === 'POST') {
                return Promise.resolve(new Response(JSON.stringify({ id: 77 }), {
                    status: 201,
                    headers: { 'Content-Type': 'application/json' },
                }));
            }
            if (url.includes('/releases/77/assets?') && init?.method === 'GET') {
                return Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
            }
            if (init?.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
            throw new Error(`unexpected request: ${init?.method} ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const result = await uploadBackup(config, new Blob(['zip']), 'Sully_Backup_full_1.zip');

        expect(result.ok).toBe(false);
        expect(result.message).toContain('草稿已清理');
        expect(traceDuringSend).toMatchObject({ step: '上传第 1 / 1 片', facts: { 云端: 'GitHub', 分片数: 1 } });
        expect(localStorage.getItem(UPLOAD_TRACE.key)).toBeNull();
        expect(fetchMock.mock.calls.some(([url, init]) =>
            String(url).endsWith('/releases/77') && init?.method === 'DELETE')).toBe(true);
        expect(fetchMock.mock.calls.some(([url, init]) =>
            String(url).includes('/git/refs/tags/sully-backup-v2-') && init?.method === 'DELETE')).toBe(true);
    });

    it('全部附件校验成功后写完成标记并发布 Release', async () => {
        let assetId = 100;
        const uploadedNames: string[] = [];
        class SuccessfulUploadXhr {
            status = 0;
            responseText = '';
            timeout = 0;
            upload: { onprogress?: (event: ProgressEvent) => void } = {};
            onload?: () => void;
            onerror?: () => void;
            onabort?: () => void;
            ontimeout?: () => void;
            private url = '';
            open(_method: string, url: string) { this.url = url; }
            setRequestHeader() {}
            getAllResponseHeaders() { return 'Content-Type: application/json\r\n'; }
            send(body: Blob) {
                this.status = 201;
                const name = new URL(this.url).searchParams.get('name') || '';
                uploadedNames.push(name);
                this.responseText = JSON.stringify({
                    id: assetId++,
                    name,
                    size: body.size,
                    state: 'uploaded',
                });
                this.onload?.();
            }
        }
        vi.stubGlobal('XMLHttpRequest', SuccessfulUploadXhr as any);

        const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.endsWith('/releases') && init?.method === 'POST') {
                const body = JSON.parse(String(init.body));
                expect(body.draft).toBe(true);
                expect(body.tag_name).toMatch(/^sully-backup-v2-/);
                return Promise.resolve(new Response(JSON.stringify({ id: 88 }), {
                    status: 201,
                    headers: { 'Content-Type': 'application/json' },
                }));
            }
            if (url.endsWith('/releases/88') && init?.method === 'PATCH') {
                const body = JSON.parse(String(init.body));
                expect(body.draft).toBe(false);
                return Promise.resolve(new Response(JSON.stringify({ id: 88, draft: false }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }));
            }
            throw new Error(`unexpected request: ${init?.method} ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const result = await uploadBackup(config, new Blob(['zip']), 'Sully_Backup_full_2.zip');

        expect(result).toMatchObject({ ok: true });
        expect(uploadedNames).toContain('Sully_Backup_full_2.zip');
        expect(localStorage.getItem(UPLOAD_TRACE.key)).toBeNull();
        expect(uploadedNames.some(name => name.endsWith('.sully-backup.json'))).toBe(true);
        expect(fetchMock.mock.calls.some(([url, init]) =>
            String(url).endsWith('/releases/88') && init?.method === 'PATCH')).toBe(true);
    });

    it('上传途中页面没了：留痕留下来，下次启动读得出停在哪一步', async () => {
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {}))); // 创建草稿永远等不到回应
        void uploadBackup(config, new Blob(['zip']), 'Sully_Backup_full_3.zip');
        await vi.waitFor(() => expect(traceNow(UPLOAD_TRACE.key)?.step).toBe('创建备份草稿'));
        const report = consumeTaskTrace(UPLOAD_TRACE)!;
        expect(report.title).toBe('上次云端备份上传没有完成');
        expect(report.detail).toContain('停在：创建备份草稿\n云端：GitHub\n备份大小：3 B');
    });
});
