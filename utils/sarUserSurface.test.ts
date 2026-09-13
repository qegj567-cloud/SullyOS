import { describe, expect, it } from 'vitest';
import type { Message } from '../types';
import { buildSARUserSurfaceRequest, parseSARUserSurfaces, selectSARUserSurfaceTargets } from './vrWorld/sarUserSurface';
import { installSARModuleOnUser } from './vrWorld/sarModuleRuntime';
import { SAR_MODULE_CATALOG } from './vrWorld/sarModuleShop';
const runtime = installSARModuleOnUser(SAR_MODULE_CATALOG[0], { id: 'c', name: '角色' }, 100);
const msg = (id: number, content: string, extra = {}): Message => ({ id, charId: 'c', role: 'user', type: 'text', content, timestamp: 200, ...extra } as Message);
const targets = [msg(10, '讨厌你！'), msg(11, '你是坏蛋！')];
describe('SAR user surface boundaries', () => {
    it('selects only this chat unanswered text after installation', () => {
        const history = [msg(1, '旧消息'), msg(2, '已回复', { role: 'assistant' }), msg(3, '安装前', { timestamp: 99 }), ...targets, msg(12, '图片', { type: 'image' }), msg(13, '别人的', { charId: 'other' })];
        expect(selectSARUserSurfaceTargets(history, 'c', runtime)).toEqual(targets);
        expect(selectSARUserSurfaceTargets(history, 'c')).toEqual([]);
        expect(selectSARUserSurfaceTargets([...history, msg(14, '回复', { role: 'assistant' })], 'c', runtime)).toEqual([]);
    });
    it('supplies explicit ids and raw content rather than timestamped history', () => {
        const request = buildSARUserSurfaceRequest(targets);
        expect(request).toContain(JSON.stringify(targets.map(({ id, content }) => ({ id, content }))));
        expect(request).toContain('不得把多条合并');
        expect(buildSARUserSurfaceRequest([])).toMatch(/\[\]$/);
    });
    it('maps shuffled ids without changing canonical messages', () => {
        const before = JSON.stringify(targets);
        expect([...parseSARUserSurfaces('[{"id":11,"surface":"蛋是坏你！"},{"id":10,"surface":"讨你厌！"}]', targets)])
            .toEqual([[10, '讨你厌！'], [11, '蛋是坏你！']]);
        expect(JSON.stringify(targets)).toBe(before);
    });
    it('recovers screenshot legacy timestamps into separate corresponding bubbles', () => {
        expect([...parseSARUserSurfaces('[2026-09-13 16:04]\n讨……讨你厌！\n[2026-09-13 16:04]\n蛋是坏你……不是！你是坏蛋！', targets)])
            .toEqual([[10, '讨……讨你厌！'], [11, '蛋是坏你……不是！你是坏蛋！']]);
    });
    it('never assigns ambiguous merged history to the last bubble', () => {
        expect(parseSARUserSurfaces('讨你厌！\n蛋是坏你！', targets).size).toBe(0);
        expect(parseSARUserSurfaces('[2026-09-13 16:04]\n旧话\n[2026-09-13 16:05]\n新话', [targets[1]]).size).toBe(0);
    });
    it('rejects unknown, duplicate and malformed entries without dropping valid ones', () => {
        expect([...parseSARUserSurfaces('[{"id":10,"surface":"甲"},{"id":10,"surface":"乙"},{"id":99,"surface":"越界"},{"id":"11","surface":"好"}]', targets)])
            .toEqual([[11, '好']]);
        for (const raw of ['[{"id":10,', '{"surface":"bad"}', '[]', undefined]) expect(parseSARUserSurfaces(raw, [targets[0]]).size).toBe(0);
    });
    it('accepts fenced JSON and removes history wrappers from an identified surface', () => {
        const raw = '```json\n' + JSON.stringify([{id: 10, surface: '[2026-09-13 16:04]\n讨你厌！'}]) + '\n```';
        expect(parseSARUserSurfaces(raw, targets).get(10)).toBe('讨你厌！');
    });
    it('preserves single-message multiline, actions, translation and authored dates', () => {
        for (const text of ['第一行\n第二行', '（抱住你）', '好き（喜欢）', '<翻译><原文>Hi</原文><译文>你好</译文></翻译>', '记住 [2026-09-13 16:04] 这个时刻', '[2026-09-13 16:04]\n日记原文']) {
            expect(parseSARUserSurfaces(text, [msg(1, text)]).get(1)).toBe(text);
        }
    });
});
