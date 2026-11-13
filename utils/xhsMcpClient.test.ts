import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    normalizeNote,
    XHS_SPIDER_V3_EXPERIMENT,
    XhsMcpClient,
    normalizeXhsComments,
    normalizeXhsLiteDetail,
    parseXhsCount,
} from './xhsMcpClient';

describe('XHS Lite response normalization', () => {
    it('parses compact counters without turning 1.2万 into 1', () => {
        expect(parseXhsCount('1.2万')).toBe(12_000);
        expect(parseXhsCount('3万+')).toBe(30_000);
        expect(parseXhsCount('2.5k')).toBe(2_500);
        expect(parseXhsCount('1,234')).toBe(1_234);
    });

    it('reads snake_case interaction counters returned by Lite', () => {
        expect(normalizeNote({
            note_id: 'note-1',
            title: '标题',
            interact_info: {
                liked_count: '1.2万',
                collected_count: '345',
                comment_count: '67',
                share_count: '8',
            },
        })).toMatchObject({
            noteId: 'note-1',
            likes: 12_000,
            collects: 345,
            commentCount: 67,
            shareCount: 8,
        });
    });

    it('keeps user/user_info authors and nested sub_comments', () => {
        const payload = {
            data: {
                note: { note_id: 'note-1', title: '标题' },
                comments: {
                    list: [{
                        comment_id: 'comment-1',
                        content: '一级评论',
                        like_count: '1.2万',
                        user: { user_id: 'user-1', nickname: '甲' },
                        sub_comments: [{
                            comment_id: 'comment-2',
                            content: '回复内容',
                            like_count: '2',
                            user_info: { user_id: 'user-2', nickname: '乙' },
                        }],
                    }],
                },
            },
        };

        expect(normalizeXhsComments(payload)).toMatchObject([{
            commentId: 'comment-1',
            userId: 'user-1',
            author: '甲',
            likes: 12_000,
            subComments: [{
                commentId: 'comment-2',
                userId: 'user-2',
                author: '乙',
                parentCommentId: 'comment-1',
            }],
        }]);
        expect(normalizeXhsLiteDetail(payload).comments).toEqual([
            {
                author: '甲',
                content: '一级评论',
                likes: 12_000,
                commentId: 'comment-1',
                userId: 'user-1',
            },
            {
                author: '乙',
                content: '回复内容',
                likes: 2,
                commentId: 'comment-2',
                userId: 'user-2',
            },
        ]);
    });
});

describe('XHS Lite platform affinity', () => {
    afterEach(() => {
        XhsMcpClient.setCookie('');
        vi.restoreAllMocks();
    });

    it('remembers the RedNote backend selected by check-login', async () => {
        XhsMcpClient.setCookie(`a1=${'r'.repeat(52)}; web_session=rednote-session`);
        const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            const url = String(input);
            const headers = new Headers(init?.headers);
            if (url.endsWith('/api/check-login')) {
                expect(headers.has('x-xhs-platform')).toBe(false);
                return new Response(JSON.stringify({
                    logged_in: true,
                    platform: 'rednote',
                    user_id: 'global-user',
                }), { headers: { 'content-type': 'application/json' } });
            }
            if (url.endsWith('/api/search')) {
                expect(headers.get('x-xhs-platform')).toBe('rednote');
                return new Response(JSON.stringify({ success: true, feeds: [{note_id:'a'.repeat(24),xsec_token:'search-token'}], platform: 'rednote' }), {
                    headers: { 'content-type': 'application/json' },
                });
            }
            throw new Error(`unexpected request: ${url}`);
        });

        const login = await XhsMcpClient.checkLogin('https://worker.test/api');
        const search = await XhsMcpClient.search('https://worker.test/api', 'cat');

        expect(login.success).toBe(true);
        expect(search.success).toBe(true);
        const note = normalizeNote(search.data.feeds[0]);
        expect(note.xsecSource).toBe('pc_search');
        expect(new URL(note.url!).hostname).toBe('www.rednote.com');
        expect(new URL(note.url!).searchParams.get('xsec_source')).toBe('pc_search');
        expect(upstream).toHaveBeenCalledTimes(2);
    });
});
describe('Spider v3 hidden client patch', () => {
    let values: Map<string, string>;

    beforeEach(() => {
        values = new Map();
        vi.stubGlobal('localStorage', {
            get length() { return values.size; },
            clear: () => values.clear(),
            getItem: (key: string) => values.get(key) ?? null,
            key: (index: number) => Array.from(values.keys())[index] ?? null,
            removeItem: (key: string) => values.delete(key),
            setItem: (key: string, value: string) => values.set(key, String(value)),
        });
        XhsMcpClient.setCookie(`a1=${'a'.repeat(52)}; web_session=test-session`);
    });

    afterEach(() => {
        XhsMcpClient.setCookie('');
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    const unavailableDetail = () => ({
        success: true,
        data: {
            note: { note_id: 'a'.repeat(24), title: 'test' },
            comments: { list: [] },
            comments_status: 'unavailable',
            comments_error: { code: 'COMMENT_PROVIDER_NOT_CONFIGURED' },
        },
    });


    it('persists opaque session state and merges comments by default', async () => {
        localStorage.setItem('os_realtime_config', JSON.stringify({ xhsMcpConfig: { rnoteApiKey: 'legacy-paid-key' } }));
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            const url = String(input);
            if (url.endsWith('/api/get-feed-detail')) {
                const safeHeaders = new Headers(init?.headers);
                expect(safeHeaders.has('x-rnote-api-key')).toBe(false);
                return new Response(JSON.stringify(unavailableDetail()), {
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (url.endsWith('/api/xhs-experimental-comments')) {
                const headers = new Headers(init?.headers);
                expect(headers.get('x-xhs-experiment-ack')).toBe(XHS_SPIDER_V3_EXPERIMENT.optInValue);
                expect(headers.get('x-xhs-cookie')).toContain('web_session=test-session');
                const body = JSON.parse(String(init?.body));
                expect(body.acknowledge_risk).toBe(true);
                expect(body.strategy).toBe('no-client-hints');
                return new Response(JSON.stringify({
                    success: true,
                    data: {
                        comments: { list: [{ comment_id: 'comment-1', content: 'patched' }] },
                        comments_status: 'loaded',
                        comments_provider: 'spider-session-v3',
                    },
                    session_state: {
                        version: 1,
                        a1Tag: '6c1b3dc7a706b9dc',
                        loadts: 1785079999000,
                        dsllt: 1785079999000,
                        mnsSeq: 1,
                        signCount: 1,
                        b1Seed: 1,
                        timeOrigin: 1785079998000,
                        webBuild: '6.32.2',
                    },
                }), { headers: { 'content-type': 'application/json' } });
            }
            throw new Error(`unexpected request: ${url}`);
        });

        const result = await XhsMcpClient.getNoteDetail(
            'https://worker.test/api',
            `https://www.xiaohongshu.com/explore/${'a'.repeat(24)}`,
            'token',
        );

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(result.success).toBe(true);
        expect(result.data.data.comments_provider).toBe('spider-session-v3');
        expect(result.data.data.comments.list[0].content).toBe('patched');
        expect(JSON.parse(localStorage.getItem(XHS_SPIDER_V3_EXPERIMENT.sessionKey) || '{}')).toMatchObject({
            version: 1,
            mnsSeq: 1,
            signCount: 1,
        });
    });

    it('persists a per-cookie circuit break after one 406 result', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = String(input);
            if (url.endsWith('/api/get-feed-detail')) {
                return new Response(JSON.stringify(unavailableDetail()), {
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (url.endsWith('/api/xhs-experimental-comments')) {
                return new Response(JSON.stringify({
                    success: false,
                    error_code: 'XHS_EXPERIMENT_HTTP_406',
                    session_state: {
                        version: 1,
                        a1Tag: '6c1b3dc7a706b9dc',
                        loadts: 1785079999000,
                        dsllt: 1785079999000,
                        mnsSeq: 1,
                        signCount: 1,
                        b1Seed: 1,
                        timeOrigin: 1785079998000,
                        webBuild: '6.32.2',
                    },
                }), { headers: { 'content-type': 'application/json' } });
            }
            throw new Error(`unexpected request: ${url}`);
        });

        const first = await XhsMcpClient.getNoteDetail(
            'https://worker.test/api',
            `https://www.xiaohongshu.com/explore/${'a'.repeat(24)}`,
            'token',
            { loadAllComments: true },
        );
        const second = await XhsMcpClient.getNoteDetail(
            'https://worker.test/api',
            `https://www.xiaohongshu.com/explore/${'a'.repeat(24)}`,
            'token',
            { loadAllComments: true },
        );

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(first.data.data.comments_error.code).toBe('SPIDER_V3_CIRCUIT_OPEN');
        expect(second.data.data.comments_error.code).toBe('SPIDER_V3_CIRCUIT_OPEN');
        expect(JSON.parse(localStorage.getItem(XHS_SPIDER_V3_EXPERIMENT.circuitKey) || '{}')).toMatchObject({
            reason: 'XHS_EXPERIMENT_HTTP_406',
        });
    });
});
