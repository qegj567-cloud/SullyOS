import { describe, expect, it } from 'vitest';
import { ContextBuilder, canCharSeeUserListening } from './context';

// 歌名块、歌单块、音乐互动工具必须按同一个判断出现：
// 工具说「对方正在听的这首歌」却不给歌名时，模型只能编。
const listening = { songName: '晴天', artists: '周杰伦', lyricWindow: [], activeIdx: -1 };
const charWith = (canReadUserMusic?: boolean): any => ({
    id: 'c1',
    name: '小明',
    musicProfile: { canReadUserMusic, playlists: [{ title: '雨天', songs: [] }] },
});

describe('角色能否知道用户正在听的歌', () => {
    it('开关关闭时不注入歌名，也不带出歌单', () => {
        const char = charWith(false);
        expect(canCharSeeUserListening(char, listening)).toBe(false);
        expect(ContextBuilder.buildMusicAtmosphere(char, '用户', listening, null)).toBe('');
    });

    it('开关默认开启时注入歌名', () => {
        const char = charWith(undefined);
        expect(canCharSeeUserListening(char, listening)).toBe(true);
        expect(ContextBuilder.buildMusicAtmosphere(char, '用户', listening, null)).toContain('《晴天》');
    });

    it('一起听算主动分享，开关关闭也能知道', () => {
        const char = charWith(false);
        expect(canCharSeeUserListening(char, listening, true)).toBe(true);
        expect(ContextBuilder.buildMusicAtmosphere(char, '用户', listening, null, true)).toContain('一起听《晴天》');
    });

    it('歌名为空时当作没在听', () => {
        expect(canCharSeeUserListening(charWith(true), { ...listening, songName: '' })).toBe(false);
    });
});
