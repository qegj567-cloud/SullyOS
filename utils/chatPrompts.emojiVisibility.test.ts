import { describe, it, expect } from 'vitest';
import { ChatPrompts } from './chatPrompts';
import type { Emoji, EmojiCategory } from '../types';

// 锁住「角色只能用自己范围内的表情包」的修复。
//
// 表情包分类可以设 allowedCharacterIds 限定可见角色。私聊路径 (Chat.tsx) 在喂给
// LLM 前会按角色过滤；但主动消息 (activeMsgClient.buildCompletePrompt) 之前漏了这步，
// 直接把全部表情塞进 system prompt，导致 B 在主动消息里用到只规定给 A 的表情包。
// 修复把过滤收口到 ChatPrompts.filterVisibleEmojis，两条路径共用。这里钉住 helper 行为。

const categories: EmojiCategory[] = [
  { id: 'public', name: '通用' }, // 无 allowedCharacterIds = 所有人可见
  { id: 'onlyA', name: '只给A', allowedCharacterIds: ['A'] },
  { id: 'emptyList', name: '空名单', allowedCharacterIds: [] }, // 空名单 = 所有人可见
];

const emojis: Emoji[] = [
  { name: '通用表情', url: 'u1', categoryId: 'public' },
  { name: 'A专属', url: 'u2', categoryId: 'onlyA' },
  { name: '无分类', url: 'u3' }, // 无 categoryId 始终可见
  { name: '空名单表情', url: 'u4', categoryId: 'emptyList' },
];

describe('ChatPrompts.filterVisibleEmojis', () => {
  it('保留范围内角色的受限表情', () => {
    const res = ChatPrompts.filterVisibleEmojis(emojis, categories, 'A');
    expect(res.emojis.map(e => e.name).sort()).toEqual(
      ['A专属', '无分类', '空名单表情', '通用表情'].sort(),
    );
    expect(res.categories.map(c => c.id).sort()).toEqual(
      ['emptyList', 'onlyA', 'public'].sort(),
    );
  });

  it('对范围外角色隐藏受限分类下的表情', () => {
    const res = ChatPrompts.filterVisibleEmojis(emojis, categories, 'B');
    expect(res.emojis.map(e => e.name)).not.toContain('A专属');
    // 通用 / 空名单 / 无分类 仍然可见
    expect(res.emojis.map(e => e.name).sort()).toEqual(
      ['无分类', '空名单表情', '通用表情'].sort(),
    );
    expect(res.categories.map(c => c.id)).not.toContain('onlyA');
  });

  it('默认组设为仅自己使用后，旧的无分类记录也从候选清单移除', () => {
    const groups = [...categories,{id:'default',name:'默认',personalOnly:true}];
    expect(ChatPrompts.filterVisibleEmojis(emojis,groups,'A').emojis.map(e=>e.name)).not.toContain('无分类');
  });

  it('没有任何受限分类时原样返回（短路）', () => {
    const openCats: EmojiCategory[] = [{ id: 'public', name: '通用' }];
    const res = ChatPrompts.filterVisibleEmojis(emojis, openCats, 'B');
    expect(res.emojis).toBe(emojis);
  });

  it('同名表情只保留当前角色绑定的版本，避免按名字反查到其他角色的 URL', () => {
    const scopedCategories: EmojiCategory[] = [
      { id: 'onlyA', name: 'A 专属', allowedCharacterIds: ['A'] },
      { id: 'onlyB', name: 'B 专属', allowedCharacterIds: ['B'] },
    ];
    const duplicateNames: Emoji[] = [
      { name: '挥手', url: 'a-only-url', categoryId: 'onlyA' },
      { name: '挥手', url: 'b-only-url', categoryId: 'onlyB' },
    ];

    const res = ChatPrompts.filterVisibleEmojis(duplicateNames, scopedCategories, 'B');

    expect(res.emojis).toEqual([
      { name: '挥手', url: 'b-only-url', categoryId: 'onlyB' },
    ]);
    expect(res.emojis.find(e => e.name === '挥手')?.url).toBe('b-only-url');
  });
});
