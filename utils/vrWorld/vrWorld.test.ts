import { describe, it, expect, beforeEach } from 'vitest';
import { chunkNovelText, chunkNovelTextAsync, getReadingWindow, buildNovel } from './novel';
import { parseVROutput, parseMusicOutput, parseGuestbookOutput, parseGymOutput, parsePostOfficeOutput, parsePostOfficeReadOutput } from './prompts';
import { maskPen } from './postOffice';
import { decodeBytes } from './decodeText';
import { VRScheduler } from './scheduler';

// scheduler 的 attachListeners 会访问 document/window（node 环境下没有），补最简 stub。
const g = globalThis as any;
if (typeof g.document === 'undefined') g.document = { visibilityState: 'hidden', addEventListener() {}, removeEventListener() {} };
if (typeof g.window === 'undefined') g.window = { addEventListener() {}, removeEventListener() {} };

describe('VRScheduler.reconcile', () => {
    beforeEach(() => {
        localStorage.removeItem('vr_schedules');
        localStorage.removeItem('vr_last_fire');
    });

    it('补建 enabled 但缺调度的角色（导入备份后的核心场景）', () => {
        // 模拟导入后：角色在 IndexedDB 里 enabled，但 localStorage 调度表为空
        VRScheduler.reconcile([{ charId: 'c1', intervalMinutes: 120 }]);
        expect(VRScheduler.isActiveFor('c1')).toBe(true);
        expect(VRScheduler.getIntervalMinutes('c1')).toBe(120);
        // 首火时间从现在起算，不会立刻触发
        const lastFire = JSON.parse(localStorage.getItem('vr_last_fire')!).c1;
        expect(Date.now() - lastFire).toBeLessThan(2000);
    });

    it('清掉已删除/已关闭角色的残留调度', () => {
        VRScheduler.start('c1', 120);
        VRScheduler.start('c2', 60);
        VRScheduler.reconcile([{ charId: 'c1', intervalMinutes: 120 }]); // c2 不再 enabled
        expect(VRScheduler.isActiveFor('c1')).toBe(true);
        expect(VRScheduler.isActiveFor('c2')).toBe(false);
        expect(JSON.parse(localStorage.getItem('vr_last_fire')!).c2).toBeUndefined();
    });

    it('间隔被改过 → 跟随最新设定，且不重置已有首火时间', () => {
        VRScheduler.start('c1', 120);
        const fireBefore = JSON.parse(localStorage.getItem('vr_last_fire')!).c1;
        VRScheduler.reconcile([{ charId: 'c1', intervalMinutes: 240 }]);
        expect(VRScheduler.getIntervalMinutes('c1')).toBe(240);
        expect(JSON.parse(localStorage.getItem('vr_last_fire')!).c1).toBe(fireBefore);
    });
});

describe('parsePostOfficeReadOutput', () => {
    it('parses reaction + activity', () => {
        const out = parsePostOfficeReadOutput('<感触>没想到真的有人懂。</感触><动态>读完回信怔了几秒</动态>');
        expect(out.reaction).toContain('有人懂');
        expect(out.activity).toContain('怔了');
    });
});

describe('maskPen', () => {
    it('hides the real name and is stable per name', () => {
        const a = maskPen('林深');
        expect(a).not.toBe('林深');
        expect(maskPen('林深')).toBe(a); // 同名同笔名
        expect(maskPen('')).toBe('匿名旅人');
    });
});

describe('parsePostOfficeOutput', () => {
    it('parses a new letter', () => {
        const out = parsePostOfficeOutput('<写信>今天又想起一些没说完的话。</写信><动态>寄了封漂流信</动态>');
        expect(out.newLetter).toContain('没说完');
        expect(out.reply).toBeUndefined();
        expect(out.activity).toContain('漂流信');
    });
    it('parses a reply', () => {
        const out = parsePostOfficeOutput('<回信>你说的我懂，挺住。</回信><动态>回了一封陌生来信</动态>');
        expect(out.reply).toContain('挺住');
        expect(out.newLetter).toBeUndefined();
    });
});

describe('parseGuestbookOutput', () => {
    it('parses posts (with reply) + activity, caps at 4', () => {
        const raw = [
            '<彼方>',
            '<留言 回复="#a1b2">同意楼上</留言>',
            '<留言>顺便问个问题</留言>',
            '<留言>再补一条</留言>',
            '<留言>第四条</留言>',
            '<留言>第五条应被忽略</留言>',
            '<动态>在留言簿接了句嘴</动态>',
            '</彼方>',
        ].join('\n');
        const out = parseGuestbookOutput(raw);
        expect(out.posts).toHaveLength(4);
        expect(out.posts[0].replyLabel).toBe('a1b2');
        expect(out.posts[1].replyLabel).toBeUndefined();
        expect(out.posts.map(p => p.content)).toEqual(['同意楼上', '顺便问个问题', '再补一条', '第四条']);
        expect(out.activity).toContain('接了句嘴');
    });
});

describe('parseGymOutput', () => {
    it('parses behavior + activity', () => {
        const out = parseGymOutput('<行为>和某人打赛博拳击</行为><动态>输得心服口服</动态>');
        expect(out.behavior).toBe('和某人打赛博拳击');
        expect(out.activity).toBe('输得心服口服');
    });
});

describe('parseMusicOutput', () => {
    it('parses pick / review / behavior / activity', () => {
        const raw = [
            '<彼方>',
            '<点歌 序号="3"/>',
            '<乐评>前奏一出我就跪了，但副歌太水。</乐评>',
            '<行为>跟着鼓点甩头，顺手给屏幕外录了一段。</行为>',
            '<动态>在听歌房单曲循环到上头。</动态>',
            '</彼方>',
        ].join('\n');
        const out = parseMusicOutput(raw);
        expect(out.pickIdx).toBe(3);
        expect(out.review).toContain('副歌');
        expect(out.behavior).toContain('甩头');
        expect(out.activity).toContain('上头');
    });

    it('tolerates missing pick/review (only behavior+activity)', () => {
        const out = parseMusicOutput('<行为>靠在角落放空</行为><动态>没什么想点的</动态>');
        expect(out.pickIdx).toBeUndefined();
        expect(out.review).toBeUndefined();
        expect(out.behavior).toBe('靠在角落放空');
        expect(out.activity).toBe('没什么想点的');
    });
});

describe('decodeBytes', () => {
    it('decodes UTF-8 Chinese', () => {
        const bytes = new Uint8Array([0xE4, 0xBD, 0xA0, 0xE5, 0xA5, 0xBD]); // 你好
        const r = decodeBytes(bytes.buffer);
        expect(r.text).toBe('你好');
        expect(r.encoding).toBe('utf-8');
    });

    it('strips UTF-8 BOM', () => {
        const bytes = new Uint8Array([0xEF, 0xBB, 0xBF, 0xE4, 0xBD, 0xA0]); // BOM + 你
        const r = decodeBytes(bytes.buffer);
        expect(r.text).toBe('你');
        expect(r.encoding).toBe('utf-8');
    });

    it('falls back to gb18030 for GBK bytes', () => {
        const bytes = new Uint8Array([0xC4, 0xE3, 0xBA, 0xC3]); // 你好 in GBK
        const r = decodeBytes(bytes.buffer);
        // 环境支持 gb18030 时应正确解出中文；不支持则至少不抛错
        expect(r.encoding === 'gb18030' || r.encoding === 'utf-8?').toBe(true);
        if (r.encoding === 'gb18030') expect(r.text).toBe('你好');
    });
});

describe('chunkNovelText', () => {
    it('splits text into segments with sequential idx', () => {
        const text = Array.from({ length: 10 }, (_, i) => `这是第${i}个自然段，` + '字'.repeat(80)).join('\n\n');
        const segs = chunkNovelText(text, 200);
        expect(segs.length).toBeGreaterThan(1);
        segs.forEach((s, i) => {
            expect(s.idx).toBe(i);
            expect(s.chars).toBe(s.text.length);
        });
    });

    it('hard-splits an over-long paragraph', () => {
        const huge = '甲'.repeat(2000);
        const segs = chunkNovelText(huge, 300);
        expect(segs.length).toBeGreaterThanOrEqual(6);
    });

    it('returns empty for blank input', () => {
        expect(chunkNovelText('   \n\n  ')).toEqual([]);
    });
});

describe('chunkNovelTextAsync', () => {
    it('matches the sync chunker output', async () => {
        const text = Array.from({ length: 50 }, (_, i) => `第${i}段` + '字'.repeat(120)).join('\n\n');
        const sync = chunkNovelText(text, 300);
        const async = await chunkNovelTextAsync(text, 300);
        expect(async.map(s => s.text)).toEqual(sync.map(s => s.text));
        expect(async.map(s => s.idx)).toEqual(sync.map(s => s.idx));
    });

    it('reports progress and finishes at 1', async () => {
        const ratios: number[] = [];
        await chunkNovelTextAsync('一'.repeat(20000), 400, r => ratios.push(r));
        expect(ratios[ratios.length - 1]).toBe(1);
    });
});

describe('getReadingWindow', () => {
    it('respects budget and advances from bookmark', () => {
        const novel = buildNovel('测试', Array.from({ length: 20 }, (_, i) => '原文段'.repeat(100) + i).join('\n\n'));
        const w1 = getReadingWindow(novel, 0, 1000);
        expect(w1.from).toBe(0);
        expect(w1.to).toBeGreaterThan(0);
        const w2 = getReadingWindow(novel, w1.to, 1000);
        expect(w2.from).toBe(w1.to);
    });

    it('always yields at least one segment and flags end', () => {
        const novel = buildNovel('短', '只有一段');
        const w = getReadingWindow(novel, 0, 1);
        expect(w.segments.length).toBe(1);
        expect(w.reachedEnd).toBe(true);
    });
});

describe('parseVROutput', () => {
    it('parses annotations with seg index and ref, plus activity', () => {
        const raw = `<彼方>
<批注 段落="3">男主也太迟钝了吧</批注>
<批注 段落="5" 回应="#ab12">才不是你说的那样</批注>
<动态>在《某书》读到了初遇，吐槽了男主</动态>
</彼方>`;
        const out = parseVROutput(raw);
        expect(out.annotations).toHaveLength(2);
        expect(out.annotations[0].segIdx).toBe(3);
        expect(out.annotations[1].refLabel).toBe('ab12');
        expect(out.activity).toContain('初遇');
    });

    it('tolerates zero annotations', () => {
        const out = parseVROutput(`<彼方><动态>安静读完</动态></彼方>`);
        expect(out.annotations).toHaveLength(0);
        expect(out.activity).toBe('安静读完');
    });

    it('ignores annotations without a paragraph number', () => {
        const out = parseVROutput(`<批注>没有段落号</批注><动态>x</动态>`);
        expect(out.annotations).toHaveLength(0);
    });

    it('tolerates full-width quotes / colons / no-space tags', () => {
        const raw = [
            '<彼方>',
            '<批注 段落="2">全角引号</批注>',   // 全角引号
            '<批注段落=4>无空格无引号</批注>',     // 无空格、无引号
            '<批注 段落：7 回应：#9f3a>全角冒号+回应</批注>',
            '<动态>读完了</动态>',
            '</彼方>',
        ].join('\n');
        const out = parseVROutput(raw);
        expect(out.annotations.map(a => a.segIdx)).toEqual([2, 4, 7]);
        expect(out.annotations[2].refLabel).toBe('9f3a');
    });

    it('keeps all annotations across many paragraphs', () => {
        const raw = Array.from({ length: 5 }, (_, i) => `<批注 段落="${i * 3}">第${i}条</批注>`).join('') + '<动态>x</动态>';
        const out = parseVROutput(raw);
        expect(out.annotations).toHaveLength(5);
    });
});
