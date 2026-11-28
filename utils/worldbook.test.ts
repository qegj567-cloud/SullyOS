import { describe, expect, it } from 'vitest';
import type { MountedWorldbook, Worldbook } from '../types';
import {
    buildWorldbookCatalog,
    computeWorldbookGroupMembershipChanges,
    injectWorldbookDepthEntries,
    isWorldbookEntryActive,
    parseStandardWorldbook,
    resolveWorldbookCategoryMeta,
    resolveWorldbookEntries,
    serializeSullyWorldbook,
    splitWorldbookSections,
    toMountedWorldbook,
    upsertMountedWorldbooks,
} from './worldbook';

const book = (overrides: Partial<MountedWorldbook> = {}): MountedWorldbook => ({
    id: 'book-1',
    title: '测试条目',
    content: '{{char}} 在 {{user}} 提到月亮时会想起故乡。',
    category: '测试',
    ...overrides,
});

describe('worldbook activation', () => {
    it('keeps legacy entries constantly active after character definitions', () => {
        const resolved = resolveWorldbookEntries([book()], [], '阿澈', '小雨');
        expect(resolved).toHaveLength(1);
        expect(resolved[0].position).toBe(1);
        expect(resolved[0].content).toContain('阿澈 在 小雨');
    });

    it('activates keyword entries only when the recent scan buffer matches', () => {
        const keywordBook = book({ constant: false, key: ['月亮'], scanDepth: 2 });
        expect(isWorldbookEntryActive(keywordBook, [{ content: '今晚有月亮' }])).toBe(true);
        expect(isWorldbookEntryActive(keywordBook, [{ content: '今晚下雨' }])).toBe(false);
    });

    it('respects secondary keyword logic and disabled state', () => {
        const selectiveBook = book({
            constant: false,
            key: ['学校'],
            keysecondary: ['老师', '同学'],
            selective: true,
            selectiveLogic: 3,
        });
        expect(isWorldbookEntryActive(selectiveBook, [{ content: '学校里的老师和同学' }])).toBe(true);
        expect(isWorldbookEntryActive(selectiveBook, [{ content: '学校里的老师' }])).toBe(false);
        expect(isWorldbookEntryActive({ ...selectiveBook, disable: true }, [{ content: '学校里的老师和同学' }])).toBe(false);
    });
});

describe('worldbook positions', () => {
    it('splits standard positions and injects at-depth entries using their role', () => {
        const resolved = resolveWorldbookEntries([
            book({ id: 'before', position: 0 }),
            book({ id: 'depth', position: 4, depth: 1, role: 1 }),
        ]);
        const sections = splitWorldbookSections(resolved);
        expect(sections.beforeCharacter.map(entry => entry.book.id)).toEqual(['before']);

        const messages = injectWorldbookDepthEntries(
            [{ role: 'user', content: '一' }, { role: 'assistant', content: '二' }],
            sections.atDepth,
        );
        expect(messages.map(message => message.role)).toEqual(['user', 'user', 'assistant']);
        expect(messages[1].content).toContain('{{char}}');
    });
});

describe('standard worldbook import', () => {
    it('converts entries into a SullyOS category without losing activation metadata', () => {
        const imported = parseStandardWorldbook(JSON.stringify({
            entries: {
                0: {
                    uid: 7,
                    comment: '月亮设定',
                    content: '月亮是蓝色的。',
                    key: ['月亮'],
                    keysecondary: [],
                    constant: false,
                    selective: false,
                    order: 120,
                    position: 4,
                    depth: 2,
                    role: 0,
                    disable: false,
                    probability: 80,
                    useProbability: true,
                },
            },
        }), '导入测试', 1234);

        expect(imported).toHaveLength(1);
        expect(imported[0]).toMatchObject({
            title: '月亮设定',
            category: '导入测试',
            key: ['月亮'],
            constant: false,
            position: 4,
            depth: 2,
            role: 0,
            order: 120,
            probability: 80,
            useProbability: true,
            sourceUid: 7,
        });
    });

    it('reads legacy arrays and keeps their imported entry settings through a native export', () => {
        const legacy = { entries: [{ uid: 42, comment: '旧条目', content: '内容', key: ['春'], disable: true }] };
        const books = parseStandardWorldbook(JSON.stringify(legacy), '旧书');
        const [restored] = parseStandardWorldbook(serializeSullyWorldbook(books), '新书');
        expect(restored).toMatchObject({ sourceUid: 42, title: '旧条目', key: ['春'], disable: true });
    });

    it('reports an unsupported native version before interpreting its entries', () => {
        const futureBook = { format: 'sullyos-worldbook', version: 2, worldbook: { entries: {} } };
        expect(() => parseStandardWorldbook(JSON.stringify(futureBook), '测试')).toThrow('暂不支持此糯米机世界书版本');
    });

    it('exports a distinct SullyOS document and preserves local titles and imported metadata on round trip', () => {
        const source = [{
            ...book({
                id: 'export-1',
                title: '导出条目',
                content: '导出内容',
                constant: false,
                key: ['导出'],
                position: 4,
                depth: 3,
                role: 2,
            }),
            category: '导出组',
            createdAt: 1,
            updatedAt: 1,
        }];

        const json = serializeSullyWorldbook([...source, { ...source[0], sourceUid: 73 }]);
        const raw = JSON.parse(json);
        expect(raw).toMatchObject({ format: 'sullyos-worldbook', version: 1 });
        expect(raw).not.toHaveProperty('entries');
        expect(raw.worldbook.entries['0']).toMatchObject({
            comment: '导出条目',
            key: ['导出'],
            position: 4,
            depth: 3,
            role: 2,
        });

        const imported = parseStandardWorldbook(json, '重新导入', 2);
        expect(imported[0].sourceUid).toBeUndefined();
        expect(imported[1].sourceUid).toBe(73);
        expect(imported[0]).toMatchObject({
            title: '导出条目',
            content: '导出内容',
            key: ['导出'],
            position: 4,
            depth: 3,
            role: 2,
        });
    });
});

describe('mounted worldbook synchronization', () => {
    it('copies edited activation and injection settings into the character mount cache', () => {
        const mounted = toMountedWorldbook({
            ...book({
                constant: false,
                key: ['月亮'],
                keysecondary: ['夜晚'],
                selective: true,
                selectiveLogic: 0,
                position: 4,
                depth: 2,
                role: 1,
                disable: true,
                order: 180,
                scanDepth: 6,
                useProbability: true,
                probability: 75,
            }),
            category: '同步测试',
            createdAt: 1,
            updatedAt: 2,
        });

        expect(mounted).toMatchObject({
            constant: false,
            key: ['月亮'],
            keysecondary: ['夜晚'],
            selective: true,
            position: 4,
            depth: 2,
            role: 1,
            disable: true,
            order: 180,
            scanDepth: 6,
            useProbability: true,
            probability: 75,
        });
        expect(mounted).not.toHaveProperty('createdAt');
        expect(mounted).not.toHaveProperty('updatedAt');
    });

    it('mounts a complete generated group without duplicates and keeps it injectable', () => {
        const now = Date.now();
        const generated: Worldbook[] = [
            { ...book({ id: 'generated-1', title: '常驻校规', content: '午夜后禁止离开宿舍。', constant: true, order: 10, position: 1 }), category: '学院', createdAt: now, updatedAt: now },
            { ...book({ id: 'generated-2', title: '雨夜钟楼', content: '钟楼会在雨夜开放。', constant: false, key: ['钟楼'], scanDepth: 4, order: 20, position: 1 }), category: '学院', createdAt: now, updatedAt: now },
        ];
        const mounted = upsertMountedWorldbooks([book({ id: 'existing', title: '已有条目', order: 300 })], generated);
        const retried = upsertMountedWorldbooks(mounted, generated);

        expect(retried.map(entry => entry.id)).toEqual(['existing', 'generated-1', 'generated-2']);
        expect(retried.filter(entry => entry.category === '学院')).toHaveLength(2);
        expect(resolveWorldbookEntries(retried, [{ content: '我们去钟楼看看' }]).map(entry => entry.book.id)).toEqual(['generated-1', 'generated-2', 'existing']);
    });

    it('treats bookDisabled separately from entry disable and strips personal group/bookDisabled on single-book JSON export', () => {
        const activeEntry = book({ id: 'a-1', category: '世界书A', group: '现代组', constant: true, disable: false });
        const dividerEntry = book({ id: 'a-2', category: '世界书A', group: '现代组', constant: true, disable: true });

        // 整本书停用时，原本启用的词条也不生效；重新开启整本书后，作者原本停用的分割线依然保持停用
        expect(isWorldbookEntryActive({ ...activeEntry, bookDisabled: true }, [])).toBe(false);
        expect(isWorldbookEntryActive({ ...activeEntry, bookDisabled: false }, [])).toBe(true);
        expect(isWorldbookEntryActive({ ...dividerEntry, bookDisabled: false }, [])).toBe(false);

        const mounted = toMountedWorldbook({
            ...activeEntry,
            category: '世界书A',
            group: '  现代组  ',
            bookDisabled: true,
            createdAt: 1,
            updatedAt: 2,
        });
        expect(mounted.group).toBe('现代组');
        expect(mounted.bookDisabled).toBe(true);

        const exported = JSON.parse(serializeSullyWorldbook([mounted, { ...dividerEntry, bookDisabled: true }]));
        expect(exported).not.toHaveProperty('group');
        expect(exported.worldbook).not.toHaveProperty('group');
        expect(exported.worldbook.entries['0']).not.toHaveProperty('group');
        expect(exported.worldbook.entries['0']).not.toHaveProperty('bookDisabled');
        expect(exported.worldbook.entries['0'].disable).toBe(false);
        expect(exported.worldbook.entries['1'].disable).toBe(true);
    });

    it('groups whole worldbooks into outer groups, computes group/book switch state, and inherits meta for existing worldbooks', () => {
        const now = 100;
        const makeWb = (id: string, category: string, extra: Partial<Worldbook> = {}): Worldbook => ({
            id,
            title: id,
            content: '设定',
            category,
            createdAt: now,
            updatedAt: now,
            ...extra,
        });
        const flatCatalog = buildWorldbookCatalog([makeWb('1', 'A'), makeWb('2', 'B')]);
        expect(flatCatalog.hasNamedGroups).toBe(false);
        expect(flatCatalog.packages.map(pkg => pkg.category)).toEqual(['A', 'B']);

        const books = [
            makeWb('a1', '世界书A', { group: 'AB组', bookDisabled: false }),
            makeWb('a2', '世界书A', { group: 'AB组', bookDisabled: false, disable: true }),
            makeWb('b1', '世界书B', { group: 'AB组', bookDisabled: true }),
            makeWb('c1', '世界书C', { group: 'C组', bookDisabled: true }),
            makeWb('d1', '世界书D'),
        ];
        const catalog = buildWorldbookCatalog(books);
        expect(catalog.hasNamedGroups).toBe(true);
        expect(catalog.groupNames).toEqual(['AB组', 'C组']);
        expect(catalog.groups.map(g => ({ name: g.name, isUngrouped: g.isUngrouped, anyEnabled: g.anyEnabled, allEnabled: g.allEnabled, cats: g.packages.map(p => p.category) }))).toEqual([
            { name: 'AB组', isUngrouped: false, anyEnabled: true, allEnabled: false, cats: ['世界书A', '世界书B'] },
            { name: 'C组', isUngrouped: false, anyEnabled: false, allEnabled: false, cats: ['世界书C'] },
            { name: '未分组', isUngrouped: true, anyEnabled: true, allEnabled: true, cats: ['世界书D'] },
        ]);
        expect(catalog.packages.find(p => p.category === '世界书A')?.enabledEntryCount).toBe(1);

        // 往已存在的停用世界书里新加词条时继承所属分组与整书停用状态
        expect(resolveWorldbookCategoryMeta(books, '世界书B')).toEqual({ group: 'AB组', bookDisabled: true });
        expect(resolveWorldbookCategoryMeta(books, '新世界书')).toEqual({});

        // 编辑 AB组：移出 B、移入 D，并改名为「新AB组」
        const changes = computeWorldbookGroupMembershipChanges(catalog.packages, '新AB组', ['世界书A', '世界书D'], 'AB组');
        expect(changes).toEqual([
            { ids: ['a1', 'a2', 'd1'], group: '新AB组' },
            { ids: ['b1'], group: undefined },
        ]);

        // 解散 AB组：只退回未分组，不删条目
        expect(computeWorldbookGroupMembershipChanges(catalog.packages, '', [], 'AB组')).toEqual([
            { ids: ['a1', 'a2', 'b1'], group: undefined },
        ]);
    });
});
