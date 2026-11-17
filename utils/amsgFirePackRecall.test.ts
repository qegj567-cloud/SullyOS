/**
 * 云端快照（fire_pack）的记忆连续性回归守卫：
 * - 打包时自己跑召回，自适应上下文归档后云端角色不能对刚归档的事断片；
 * - 角色对象上挂着的旧召回 / 旧门牌一律不进模板；
 * - 召回进库出库都被剥掉，别处留下的旧值不会在下次加载后冒出来。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const recallCalls: Array<{ entryPoint?: string }> = [];
vi.mock('./memoryPalace/pipeline', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./memoryPalace/pipeline')>()),
  injectMemoryPalace: vi.fn(async (char: any, _msgs: unknown, _hint: unknown, _user: unknown, ctx?: { entryPoint?: string }) => {
    recallCalls.push({ entryPoint: ctx?.entryPoint });
    char.memoryPalaceInjection = '- [2026年11月16日（今天）] FRESH_RECALL 一起去看了海（剩余 2 天）';
    char.roomPlatesInjection = 'FRESH_PLATE';
    return {} as any;
  }),
}));

import { buildFirePack } from './activeMsgClient';
import { BILINGUAL_TAIL_REMINDER } from './chatOutputStylePrompt';
import { DB } from './db';
import { spaceDatabaseName } from './userSpaces';

const userProfile = { name: '小明' } as any;
const emptyEmojis = { all: [], categories: [] };
const palaceChar = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: '角色', memories: [], memoryPalaceEnabled: true,
  activeMsg2Config: { enabled: true, tasks: [] }, ...extra,
}) as any;

afterEach(() => {
  recallCalls.length = 0;
  localStorage.clear();
});

describe('fire_pack 召回', () => {
  it('打包时现跑召回，角色身上的旧召回和旧门牌都不进模板', async () => {
    const char = palaceChar('recall-fresh', {
      memoryPalaceInjection: 'STALE_RECALL_FROM_OTHER_APP',
      roomPlatesInjection: 'STALE_PLATE',
    });
    const pack = await buildFirePack(char, userProfile, [], undefined, emptyEmojis);

    expect(recallCalls).toEqual([{ entryPoint: 'proactive_chat' }]);
    expect(pack.template).toContain('FRESH_RECALL');
    expect(pack.template).toContain('FRESH_PLATE');
    expect(pack.template).not.toContain('STALE_RECALL_FROM_OTHER_APP');
    expect(pack.template).not.toContain('STALE_PLATE');
    // 调用方手上的角色对象不被改写。
    expect(char.memoryPalaceInjection).toBe('STALE_RECALL_FROM_OTHER_APP');
  });

  it('只去掉按召回时刻算的相对天数，绝对日期保留', async () => {
    const pack = await buildFirePack(palaceChar('recall-dates'), userProfile, [], undefined, emptyEmojis);
    expect(pack.template).toContain('2026年11月16日');
    expect(pack.template).not.toContain('（今天）');
    expect(pack.template).not.toContain('（剩余 2 天）');
  });

  it('即时对话递来本轮召回时直接复用，不再检索第二遍', async () => {
    const pack = await buildFirePack(palaceChar('recall-reuse'), userProfile, [], undefined, emptyEmojis, {
      palaceRecall: { memoryPalaceInjection: 'TURN_RECALL', roomPlatesInjection: 'TURN_PLATE' },
    });
    expect(recallCalls).toHaveLength(0);
    expect(pack.template).toContain('TURN_RECALL');
    expect(pack.template).toContain('TURN_PLATE');
  });

  it('宫殿关着不跑召回，残留值也不出现', async () => {
    const char = palaceChar('recall-off', { memoryPalaceEnabled: false, memoryPalaceInjection: 'STALE_RECALL' });
    const pack = await buildFirePack(char, userProfile, [], undefined, emptyEmojis);
    expect(recallCalls).toHaveLength(0);
    expect(pack.template).not.toContain('STALE_RECALL');
  });
});

describe('fire_pack 近史与格式', () => {
  it('用户发过的图带识图描述', async () => {
    const char = palaceChar('vision-desc', { memoryPalaceEnabled: false });
    await DB.saveCharacter(char);
    await DB.saveMessage({
      charId: char.id, role: 'user', type: 'image', content: 'data:image/png;base64,AAAA',
      timestamp: Date.now() - 60_000, metadata: { visionDescription: 'AUDIT_VISION_CAT 一只橘猫' },
    } as any);
    const pack = await buildFirePack(char, userProfile, [], undefined, emptyEmojis);
    expect(pack.template).toContain('[图片：AUDIT_VISION_CAT 一只橘猫]');
  });

  it('双语角色在末尾人声锚之前补格式提醒', async () => {
    const char = palaceChar('bilingual-tail', { memoryPalaceEnabled: false });
    localStorage.setItem(`chat_translate_enabled_${char.id}`, 'true');
    localStorage.setItem(`chat_translate_source_lang_${char.id}`, '日语');
    localStorage.setItem(`chat_translate_lang_${char.id}`, '中文');
    const { template } = await buildFirePack(char, userProfile, [], undefined, emptyEmojis);
    const reminderAt = template.lastIndexOf(BILINGUAL_TAIL_REMINDER);
    expect(reminderAt).toBeGreaterThan(-1);
    expect(reminderAt).toBeLessThan(template.lastIndexOf('开口前回到你自己'));
  });

  it('协同功能不再承诺模板里并没有的文件标题', async () => {
    const char = palaceChar('collab-promise', { memoryPalaceEnabled: false, chatCollaborationEnabled: true });
    const { template } = await buildFirePack(char, userProfile, [], undefined, emptyEmojis);
    expect(template).toContain('协同工作');
    expect(template).not.toContain('系统另给已有文件标题');
  });
});

describe('召回字段不落库', () => {
  it('保存时剥掉召回与门牌', async () => {
    await DB.saveCharacter(palaceChar('db-strip-save', { memoryPalaceInjection: 'SAVED_RECALL', roomPlatesInjection: 'SAVED_PLATE' }));
    const loaded = await DB.getCharacter('db-strip-save');
    expect(loaded?.name).toBe('角色');
    expect(loaded).not.toHaveProperty('memoryPalaceInjection');
    expect(loaded).not.toHaveProperty('roomPlatesInjection');
  });

  it('库里早先存下的旧召回，读出来就作废', async () => {
    await DB.saveCharacter(palaceChar('db-strip-load'));
    // 绕过 saveCharacter 写一条带旧召回的老数据，模拟修复前就存进去的行。
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(spaceDatabaseName('AetherOS_Data'));
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('characters', 'readwrite');
      tx.objectStore('characters').put(palaceChar('db-strip-load', { memoryPalaceInjection: 'OLD_RECALL', roomPlatesInjection: 'OLD_PLATE' }));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    const single = await DB.getCharacter('db-strip-load');
    const listed = (await DB.getAllCharacters()).find((c) => c.id === 'db-strip-load');
    for (const loaded of [single, listed]) {
      expect(loaded).toBeDefined();
      expect(loaded).not.toHaveProperty('memoryPalaceInjection');
      expect(loaded).not.toHaveProperty('roomPlatesInjection');
    }
  });
});
