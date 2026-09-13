import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchMemberActions, type DispatchContext } from './dispatch';
import { DB } from '../db';

const ctx: DispatchContext = {
    groupId: 'g-emoji', memberIds: ['c-emoji'], characters: [{id:'c-emoji',name:'角色'}] as any,
    emojis: [{name:'开心',url:'https://example.com/happy.png',categoryId:'visible'}, {name:'私有',url:'https://example.com/hidden.png',categoryId:'hidden'}],
    categories: [{id:'visible',name:'公共'}, {id:'hidden',name:'隐藏',allowedCharacterIds:['other']}] as any,
    refresh: async () => {}, addToast: () => {}, userName:'用户',
};
afterEach(() => vi.restoreAllMocks());
describe('group sticker format recovery', () => {
    it.each(['[[你发送了表情包：开心]]','[SEND_EMOJI: 开心]','【发送了表情包: 开心】'])('dispatches %s as an emoji without losing text', async content => {
        const save = vi.spyOn(DB, 'saveMessage').mockResolvedValue(1 as any);
        await dispatchMemberActions([{charId:'c-emoji',content:content+'\n后一句'}], ctx);
        expect(save.mock.calls.map(([m])=>[m.type,m.content])).toEqual([['emoji','https://example.com/happy.png'],['text','后一句']]);
    });
    it('does not bypass pack visibility or activate unrelated action aliases', async () => {
        const save = vi.spyOn(DB, 'saveMessage').mockResolvedValue(1 as any);
        await dispatchMemberActions([{charId:'c-emoji',content:'[[你发送了表情包: 私有]]\n[ACTION:TRANSFER: 520]'}], ctx);
        expect(save.mock.calls.map(([m])=>[m.type,m.content])).toEqual([['text','[ACTION:TRANSFER: 520]']]);
    });
});
