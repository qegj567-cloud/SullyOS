import { describe, it, expect, beforeEach } from 'vitest';
import { chunkNovelText, chunkNovelTextAsync, getReadingWindow, buildNovel } from './novel';
import { parseVROutput, parseMusicOutput, parseGuestbookOutput, parseGymOutput, parsePostOfficeOutput, parsePostOfficeReadOutput, parseSignalOutput } from './prompts';
import { rollPoemLines, SIGNAL_LINES_MIN, SIGNAL_LINES_MAX, signalActFor } from './constants';
import { maskPen } from './postOffice';
import { decodeBytes } from './decodeText';
import { VRScheduler, VR_FAIL_LIMIT } from './scheduler';
import { pickNovel, rollRoom, vrAutoGapMs } from './runSession';

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

describe('VRScheduler 熔断', () => {
    beforeEach(() => {
        localStorage.removeItem('vr_schedules');
        localStorage.removeItem('vr_last_fire');
        localStorage.removeItem('vr_fail_streak');
    });

    it('连续调不通模型就掐掉自主登入（令牌失效时别通宵一轮轮撞下去）', () => {
        VRScheduler.start('c1', 120);
        for (let i = 1; i < VR_FAIL_LIMIT; i++) {
            expect(VRScheduler.report('c1', 'failed').tripped).toBe(false);
            expect(VRScheduler.isActiveFor('c1')).toBe(true);
        }
        const last = VRScheduler.report('c1', 'failed');
        expect(last.tripped).toBe(true);
        expect(last.streak).toBe(VR_FAIL_LIMIT);
        expect(VRScheduler.isActiveFor('c1')).toBe(false);
    });

    it('中间成功一次，失败计数归零', () => {
        VRScheduler.start('c1', 120);
        VRScheduler.report('c1', 'failed');
        VRScheduler.report('c1', 'failed');
        VRScheduler.report('c1', 'ok');
        expect(VRScheduler.getFailStreak('c1')).toBe(0);
        expect(VRScheduler.report('c1', 'failed').tripped).toBe(false);
        expect(VRScheduler.isActiveFor('c1')).toBe(true);
    });

    it('压根没走到模型的轮次不算账（没书没歌、房间被别人占着）', () => {
        VRScheduler.start('c1', 120);
        for (let i = 0; i < VR_FAIL_LIMIT + 2; i++) VRScheduler.report('c1', 'skipped');
        expect(VRScheduler.getFailStreak('c1')).toBe(0);
        expect(VRScheduler.isActiveFor('c1')).toBe(true);
    });

    it('重新启用会把上一轮的失败账清掉', () => {
        VRScheduler.start('c1', 120);
        for (let i = 0; i < VR_FAIL_LIMIT; i++) VRScheduler.report('c1', 'failed');
        expect(VRScheduler.isActiveFor('c1')).toBe(false);

        VRScheduler.start('c1', 120);   // 用户换了 API 重新开
        expect(VRScheduler.getFailStreak('c1')).toBe(0);
        expect(VRScheduler.report('c1', 'failed').tripped).toBe(false);
        expect(VRScheduler.isActiveFor('c1')).toBe(true);
    });

    it('熔断只掐当事角色，不连累别人', () => {
        VRScheduler.start('c1', 120);
        VRScheduler.start('c2', 120);
        for (let i = 0; i < VR_FAIL_LIMIT; i++) VRScheduler.report('c1', 'failed');
        expect(VRScheduler.isActiveFor('c1')).toBe(false);
        expect(VRScheduler.isActiveFor('c2')).toBe(true);
    });
});

describe('自动登入的最小间隔闸', () => {
    const MINUTE = 60_000;

    it('取设定间隔的一半，给后台节流留余量', () => {
        expect(vrAutoGapMs(120)).toBe(60 * MINUTE);
        expect(vrAutoGapMs(30)).toBe(15 * MINUTE);
    });

    it('间隔是脏数据时不能让闸失效 —— NaN 会让所有比较恒为 false', () => {
        // 这几个值以前会算出 NaN 或 0，闸形同虚设：真正失控时一次都拦不住
        for (const dirty of [NaN, 0, -5, undefined, Infinity]) {
            const gap = vrAutoGapMs(dirty as any);
            expect(Number.isFinite(gap)).toBe(true);
            expect(gap).toBeGreaterThanOrEqual(5 * MINUTE);
        }
    });

    it('间隔被写成极小值时由下限兜底', () => {
        expect(vrAutoGapMs(1)).toBe(5 * MINUTE);
        expect(vrAutoGapMs(4)).toBe(5 * MINUTE);
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

describe('彼方手动指定房间', () => {
    it('手动点听歌房时，即使角色没有歌单且房间没在放歌也不会随机跳走', () => {
        expect(rollRoom({} as any, [], null, 'music')).toBe('music');
    });

    it('SAR 活动空间可以手动选择，也进入角色自主活动随机池', () => {
        expect(rollRoom({} as any, [], null, 'sar')).toBe('sar');
        expect(rollRoom({} as any, [], null, undefined, () => 0.999)).toBe('sar');
    });
});

describe('彼方图书馆自动选书', () => {
    const novel = (id: string, segments = 10) => ({
        id,
        title: id,
        segments: Array.from({ length: segments }, (_, idx) => ({ idx, text: `${id}-${idx}`, chars: 4 })),
        totalChars: segments * 4,
        createdAt: 1,
        updatedAt: 1,
    }) as any;

    it('默认在全部未读完书目中 roll，而不是永远选择最近开始的那本', () => {
        const books = [novel('a'), novel('b'), novel('c')];
        const char = { vrState: { novelBookmarks: { c: 2 } } } as any;
        expect(pickNovel(books, char, () => 0)?.id).toBe('a');
        expect(pickNovel(books, char, () => 0.99)?.id).toBe('c');
    });

    it('有多个候选时不会连续两轮选择同一本', () => {
        const books = [novel('a'), novel('b'), novel('c')];
        const char = { vrState: { lastNovelId: 'b' } } as any;
        expect(pickNovel(books, char, () => 0)?.id).toBe('a');
        expect(pickNovel(books, char, () => 0.99)?.id).toBe('c');
    });

    it('优先书单有未读内容时只在优先书目中轮换', () => {
        const books = [novel('a'), novel('b'), novel('c')];
        const char = { vrState: { preferredNovelIds: ['b', 'c'], lastNovelId: 'b' } } as any;
        expect(pickNovel(books, char, () => 0)?.id).toBe('c');
        expect(pickNovel(books, char, () => 0.99)?.id).toBe('c');
    });

    it('优先书目读完后回到全书库的未读书目', () => {
        const books = [novel('a'), novel('b'), novel('c')];
        const char = { vrState: { preferredNovelIds: ['b'], novelBookmarks: { b: 10 } } } as any;
        expect(pickNovel(books, char, () => 0)?.id).toBe('a');
        expect(pickNovel(books, char, () => 0.99)?.id).toBe('c');
    });

    it('空书和损坏书不会进入候选池', () => {
        expect(pickNovel([novel('empty', 0), novel('ok')], {} as any, () => 0)?.id).toBe('ok');
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

    it('picks shift_jis for Japanese kana (not gb18030 mojibake)', () => {
        // こんにちは in Shift_JIS
        const bytes = new Uint8Array([0x82, 0xB1, 0x82, 0xF1, 0x82, 0xC9, 0x82, 0xBF, 0x82, 0xCD]);
        const r = decodeBytes(bytes.buffer);
        expect(r.encoding).not.toBe('gb18030'); // 关键：别再当成中文乱码
        if (r.encoding === 'shift_jis') expect(r.text).toBe('こんにちは');
    });

    it('decodes EUC-JP Japanese kana correctly (no mojibake)', () => {
        // こんにちは in EUC-JP（这串假名字节在 gb18030 里恰好同样映射，关键是结果别是乱码）
        const bytes = new Uint8Array([0xA4, 0xB3, 0xA4, 0xF3, 0xA4, 0xCB, 0xA4, 0xC1, 0xA4, 0xCF]);
        const r = decodeBytes(bytes.buffer);
        expect(r.text).toBe('こんにちは');
    });

    it('honors a forced encoding override', () => {
        const bytes = new Uint8Array([0x82, 0xB1, 0x82, 0xF1]); // こん in Shift_JIS
        const r = decodeBytes(bytes.buffer, 'shift_jis');
        expect(r.encoding).toBe('shift_jis');
        expect(r.text).toBe('こん');
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

    it('strips leaked 回应/段落 attribute residue from content', () => {
        // 模型把 #cgis 回应="#cgis" 复读进了正文开头（用户实测里的真实泄漏）
        const raw = '<批注 段落="5" 回应="#cgis">#cgis 回应="#cgis" 莲干并蒂？这姿势虽缠人</批注><动态>读完</动态>';
        const out = parseVROutput(raw);
        expect(out.annotations).toHaveLength(1);
        expect(out.annotations[0].refLabel).toBe('cgis');
        expect(out.annotations[0].content).toBe('莲干并蒂？这姿势虽缠人');
        expect(out.annotations[0].content).not.toContain('回应');
        expect(out.annotations[0].content).not.toContain('#cgis');
    });

    it('strips a bare leaked #label prefix', () => {
        const out = parseVROutput('<批注 段落="2">#vo2m 这一处写得真好</批注><动态>x</动态>');
        expect(out.annotations[0].content).toBe('这一处写得真好');
    });

    it('does NOT strip legitimate content starting with a quote', () => {
        const out = parseVROutput('<批注 段落="1">「凤骑龙」这名字太刻意了</批注><动态>x</动态>');
        expect(out.annotations[0].content).toBe('「凤骑龙」这名字太刻意了');
    });
});

describe('信号坠落处 · parseSignalOutput', () => {
    it('接龙：抠 <续>（兼容旧 <续句>），剥动态', () => {
        const out = parseSignalOutput('<彼方><续>而你把信号调成了潮汐</续><动态>续了一句</动态></彼方>', 'append', 24);
        expect(out.lines).toEqual(['而你把信号调成了潮汐']);
        expect(out.activity).toBe('续了一句');
        expect(out.title).toBeUndefined();
    });

    it('接龙：一次 1~2 行，按换行拆成多行', () => {
        const out = parseSignalOutput('<续>又一个我，从同一道门\n睁开同样陌生的眼</续>', 'append', 24);
        expect(out.lines).toEqual(['又一个我，从同一道门', '睁开同样陌生的眼']);
    });

    it('起新篇：抠 <标题> + <主题> + <起笔>（兼容旧 <第一句>）', () => {
        const out = parseSignalOutput('<彼方><标题>低电量合唱</标题><主题>写电子生命的死与重生</主题><起笔>电量剩下百分之三</起笔><动态>起了个头</动态></彼方>', 'start', 24);
        expect(out.title).toBe('低电量合唱');
        expect(out.brief).toBe('写电子生命的死与重生');
        expect(out.lines).toEqual(['电量剩下百分之三']);
    });

    it('起新篇：标题里自带的书名号被剥掉（UI 会自己包一层，避免《《…》》）', () => {
        const out = parseSignalOutput('<彼方><标题>《物理隔离》</标题><起笔>门没锁</起笔></彼方>', 'start', 24);
        expect(out.title).toBe('物理隔离');
    });

    it('每行字数硬截断到 cap；最多留 2 行', () => {
        const long = '一二三四五六七八九十一二三四五六七八九十';
        const out = parseSignalOutput(`<续>${long}\n${long}\n第三行不该出现</续>`, 'append', 24);
        expect(out.lines.length).toBeLessThanOrEqual(2);
        out.lines.forEach(l => expect([...l].length).toBeLessThanOrEqual(24));
    });

    it('掉格式兜底：没有标签时取前 1~2 非空行', () => {
        const out = parseSignalOutput('<think>嗯想想</think>\n\n我把黑夜接成了白噪\n（多余的解释）', 'append', 24);
        expect(out.lines[0]).toBe('我把黑夜接成了白噪');
    });

    it('完全空输出 → lines 为空（runSession 据此跳过，不写脏数据）', () => {
        const out = parseSignalOutput('<彼方></彼方>', 'append', 24);
        expect(out.lines).toEqual([]);
    });
});

describe('信号坠落处 · signalActFor（三幕分界）', () => {
    it('40 首 = 10/20/10：第 1/10 首在第一幕，11/30 在第二幕，31/40 在第三幕', () => {
        expect(signalActFor(1, 40).no).toBe(1);
        expect(signalActFor(10, 40).no).toBe(1);
        expect(signalActFor(11, 40).no).toBe(2);
        expect(signalActFor(30, 40).no).toBe(2);
        expect(signalActFor(31, 40).no).toBe(3);
        expect(signalActFor(40, 40).no).toBe(3);
    });
    it('别的册子规模也按 1/4、1/2、1/4 划分且不越界', () => {
        for (const total of [4, 7, 20, 100]) {
            for (let i = 1; i <= total; i++) {
                const act = signalActFor(i, total);
                expect([1, 2, 3]).toContain(act.no);
            }
            expect(signalActFor(1, total).no).toBe(1);
            expect(signalActFor(total, total).no).toBe(3);
        }
    });
});

describe('信号坠落处 · rollPoemLines', () => {
    it('始终落在 [min,max] 闭区间内', () => {
        for (let i = 0; i < 500; i++) {
            const n = rollPoemLines(SIGNAL_LINES_MIN, SIGNAL_LINES_MAX);
            expect(n).toBeGreaterThanOrEqual(SIGNAL_LINES_MIN);
            expect(n).toBeLessThanOrEqual(SIGNAL_LINES_MAX);
            expect(Number.isInteger(n)).toBe(true);
        }
    });
});
