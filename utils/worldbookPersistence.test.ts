import { afterEach, describe, expect, it, vi } from 'vitest';
import { DB } from './db';
import { toMountedWorldbook, isWorldbookEntryActive } from './worldbook';
import type { CharacterProfile, Worldbook } from '../types';
const book = (id: string, category = '同组'): Worldbook => ({ id, title: id, content: '内容', category, createdAt: 1, updatedAt: 1, key: ['月亮'], keysecondary: ['海边'], constant: false, selective: true, selectiveLogic: 3 });
const char = (id: string, books: Worldbook[]): CharacterProfile => ({ id, name: id, avatar: '', systemPrompt: '保持人设', mountedWorldbooks: books.map(toMountedWorldbook) } as CharacterProfile);
afterEach(() => vi.restoreAllMocks());
describe('世界书库与角色缓存事务', () => {
  it('整组改名/切换保留 ID、两层关键词和部分挂载，不给未挂载角色加条目', async () => {
    const a=book('batch-a'), b=book('batch-b'), local=book('card-only');
    await DB.saveWorldbook(a); await DB.saveWorldbook(b);
    await DB.saveCharacter(char('both',[a,b,local])); await DB.saveCharacter(char('partial',[b])); await DB.saveCharacter(char('none',[]));
    await DB.mutateWorldbooks([a.id,b.id],{category:'常驻版',constant:true});
    expect((await DB.getCharacter('both'))?.mountedWorldbooks?.map(w=>w.id)).toEqual([a.id,b.id,local.id]);
    expect((await DB.getCharacter('partial'))?.mountedWorldbooks?.map(w=>w.id)).toEqual([b.id]);
    expect((await DB.getCharacter('none'))?.mountedWorldbooks).toEqual([]);
    for(const w of (await DB.getAllWorldbooks()).filter(w=>[a.id,b.id].includes(w.id))) {
      expect(w).toMatchObject({category:'常驻版',constant:true,key:['月亮'],keysecondary:['海边'],selective:true});
      expect(isWorldbookEntryActive(w,[])).toBe(true);
    }
    await DB.mutateWorldbooks([a.id,b.id],{constant:false});
    const updated=(await DB.getCharacter('both'))!.mountedWorldbooks!;
    expect(updated[2]).toEqual(toMountedWorldbook(local));
    expect(isWorldbookEntryActive(updated[0],[{content:'月亮'}])).toBe(false);
    expect(isWorldbookEntryActive(updated[0],[{content:'海边的月亮'}])).toBe(true);
  });
  it('批量删除不会因旧快照复活另一条，也不按同名分类误删角色自带条目', async () => {
    const a=book('delete-a'), b=book('delete-b'), local=book('delete-local');
    await DB.saveWorldbook(a); await DB.saveWorldbook(b); await DB.saveCharacter(char('delete-char',[a,b,local]));
    await DB.mutateWorldbooks([a.id,b.id],null);
    expect((await DB.getAllWorldbooks()).some(w=>[a.id,b.id].includes(w.id))).toBe(false);
    expect((await DB.getCharacter('delete-char'))?.mountedWorldbooks).toEqual([toMountedWorldbook(local)]);
  });
  it('角色缓存写入失败时整个事务回滚，库和挂载都保持原样', async () => {
    const a=book('abort-book');await DB.saveWorldbook(a);await DB.saveCharacter(char('abort-char',[a]));
    const original=IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,...args:any[]) {
      const request=(original as any).apply(this,args) as IDBRequest;
      if(this.name==='characters') request.addEventListener('success',()=>this.transaction.abort());
      return request;
    });
    await expect(DB.mutateWorldbooks([a.id],{category:'不应保存'})).rejects.toBeTruthy();
    expect((await DB.getAllWorldbooks()).find(w=>w.id===a.id)?.category).toBe(a.category);
    expect((await DB.getCharacter('abort-char'))?.mountedWorldbooks).toEqual([toMountedWorldbook(a)]);
  });
});
