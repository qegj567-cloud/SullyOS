import React, { useEffect, useRef, useState } from 'react';
import {
    User, MoonStars, HeartStraight, BookOpen,
    House, Buildings, UsersThree, Briefcase, Lightning, Heartbeat,
    Repeat, Smiley, Handshake, GraduationCap, Sparkle, Feather, DotsThree,
    PencilSimple, Trash,
} from '@phosphor-icons/react';
import type { PlateEntry, PlateRoom, RoomPlate } from '../../utils/memoryPalace/types';
import { PLATE_ROOMS, PLATE_TITLES, PLATE_ENTRY_CAPS, PLATE_ENTRY_HARD_MAX_CHARS } from '../../utils/memoryPalace/types';
import { ROOM_PLATES_UPDATED_EVENT, RoomPlateDB, mutatePlate } from '../../utils/memoryPalace/db';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';

/**
 * 房间门牌面板（神经链接 · 底色认知）— 淡紫梦境皮肤
 *
 * 展示四块门牌的常驻条目。门牌由封盒/消化自动蒸馏维护，这里只提供
 * 审计入口：查看、改写、删除——蒸错的事实一旦常驻会被自信地重复很久，
 * 必须有人工纠错的口子。
 */

const ROOM_ICON: Record<PlateRoom, React.ReactNode> = {
    user_room: <User size={22} weight="duotone" />,
    self_room: <MoonStars size={22} weight="duotone" />,
    bedroom:   <HeartStraight size={22} weight="duotone" />,
    study:     <BookOpen size={22} weight="duotone" />,
};

const ROOM_HINT: Record<PlateRoom, string> = {
    user_room: '关于TA的稳定事实：家庭、居住、重要他人、雷区',
    self_room: '角色对自己的稳定认知',
    bedroom:   '关系的质地——只有现象，没有定义',
    study:     '会什么、在学什么',
};

/** tag → 条目小图标（按包含匹配，兜底 Sparkle） */
const TAG_ICONS: Array<{ match: string[]; icon: React.ReactNode }> = [
    { match: ['家庭', '家人'],           icon: <House size={16} weight="duotone" /> },
    { match: ['居住', '住'],             icon: <Buildings size={16} weight="duotone" /> },
    { match: ['重要他人', '朋友', '人际'], icon: <UsersThree size={16} weight="duotone" /> },
    { match: ['工作', '职'],             icon: <Briefcase size={16} weight="duotone" /> },
    { match: ['雷区', '禁忌'],           icon: <Lightning size={16} weight="duotone" /> },
    { match: ['健康', '身体'],           icon: <Heartbeat size={16} weight="duotone" /> },
    { match: ['习惯', '作息'],           icon: <Repeat size={16} weight="duotone" /> },
    { match: ['性格', '情绪'],           icon: <Smiley size={16} weight="duotone" /> },
    { match: ['约定', '默契'],           icon: <Handshake size={16} weight="duotone" /> },
    { match: ['技能', '学习', '知识'],    icon: <GraduationCap size={16} weight="duotone" /> },
];

function tagIcon(tag?: string): React.ReactNode {
    if (tag) {
        for (const t of TAG_ICONS) {
            if (t.match.some(m => tag.includes(m) || m.includes(tag))) return t.icon;
        }
    }
    return <Sparkle size={16} weight="duotone" />;
}

/** 区块之间的小装饰分隔 */
const SectionDivider: React.FC = () => (
    <div className="flex items-center justify-center gap-2 py-1 text-violet-200">
        <Sparkle size={10} weight="fill" />
        <Sparkle size={14} weight="fill" className="text-violet-300" />
        <Sparkle size={10} weight="fill" />
    </div>
);

interface RoomPlatePanelProps {
    charId: string;
    userName?: string;
}

const RoomPlatePanel: React.FC<RoomPlatePanelProps> = ({ charId, userName }) => {
    const { requestConfirm, confirmDialog } = useConfirmDialog({ portal: true });
    const [plates, setPlates] = useState<Map<PlateRoom, RoomPlate>>(new Map());
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState<{ room: PlateRoom; entryId: string; draft: string } | null>(null);
    const [menuEntryId, setMenuEntryId] = useState<string | null>(null);
    /** 一句一次性提示（改写落空之类），显示在顶部说明卡下面。 */
    const [notice, setNotice] = useState<string | null>(null);

    // 改到一半时云端整理的结果落库，重读会把 plates 整个换掉，而 editing 里记的还是
    // 换掉之前那条。所以正在编辑就先不重读，等这次编辑收尾了再补上。
    const editingRef = useRef(false);
    const missedUpdateRef = useRef(false);
    const reloadRef = useRef<(() => void) | null>(null);
    /** 门牌改动的落库队列（见 editPlate）。补重读要排在它后面。 */
    const pendingWriteRef = useRef<Promise<void>>(Promise.resolve());

    useEffect(() => {
        editingRef.current = editing !== null;
        if (editing !== null || !missedUpdateRef.current) return;
        missedUpdateRef.current = false;
        // 收起编辑框这一刻，这次改动多半还没落库：commitEdit 是先 setEditing(null) 再异步
        // 写进去的。直接重读会跟它抢——重读拿到的是改之前那份，而它的 setPlates 完全可能
        // 排在落库那次之后，面板于是停在旧文本上（库里明明是新的），要等下一次重读才好。
        void pendingWriteRef.current.then(() => reloadRef.current?.());
    }, [editing]);

    useEffect(() => {
        let cancelled = false;
        missedUpdateRef.current = false;
        const load = async () => {
            try {
                const loaded = await RoomPlateDB.getByCharId(charId);
                if (!cancelled) {
                    setPlates(new Map(loaded.map(p => [p.room, p])));
                }
            } catch (e) {
                console.warn('[RoomPlatePanel] 加载门牌失败', e);
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        reloadRef.current = () => { void load(); };
        void load();

        // 云端整理跑完一两分钟后才把结果落库，那时这个面板多半正开着。不重读的话
        // 用户看到的还是提交前那份，得关掉再打开——看上去就像整理压根没跑。
        const onUpdated = (event: Event) => {
            if ((event as CustomEvent<{ charId?: string }>).detail?.charId !== charId) return;
            if (editingRef.current) { missedUpdateRef.current = true; return; }
            void load();
        };
        window.addEventListener(ROOM_PLATES_UPDATED_EVENT, onUpdated);
        return () => {
            cancelled = true;
            reloadRef.current = null;
            window.removeEventListener(ROOM_PLATES_UPDATED_EVENT, onUpdated);
        };
    }, [charId]);

    /**
     * 改门牌一律走 mutatePlate：**从库里现读一份再改**，不拿手上这份整块写回去，而且
     * 同一块门牌上的改动排队走。
     *
     * 这个面板会开着好几分钟，期间动这块门牌的还有另外三条路（云端整理结果落地、本地
     * 整理落库、送达保证兜底并入），它们跟面板互相不知道对方存在。拿渲染时那份改完整块
     * 存回去，就是把中间那次更新原地抹掉；各自在自己那条路里排队也不够——队伍必须是按
     * 门牌的一条，所有路共用，否则「用户刚敲的字」和「一整轮整理的成果」谁后写谁赢，
     * 而两边日志都显示成功。所以队列在 db 那一层（见 mutatePlate），这里只接住结果。
     *
     * `change` 要是纯的——只回答「这份门牌该改成什么样」，回 null 表示不用改。要往界面上
     * 说句话的，在外面等这个 promise 落定之后再说（见 commitEdit）。
     */
    const editPlate = (
        room: PlateRoom,
        change: (plate: RoomPlate) => RoomPlate | null,
    ): Promise<void> => {
        const run = async () => {
            try {
                const saved = await mutatePlate(charId, room, change);
                if (saved) setPlates(prev => new Map(prev).set(saved.room, saved));
            } catch (e) {
                console.warn('[RoomPlatePanel] 门牌改动没存上', e);
                setNotice('这次改动没能存进去，再试一次吧。');
            }
        };
        // 面板自己这条队还留着，但管的是**界面**而不是落库：收起编辑框那一刻要等这次
        // 改动落定了再重读（见上面那个 effect），得有个东西可以等。
        const write = pendingWriteRef.current.then(run, run);
        pendingWriteRef.current = write;
        return write;
    };

    const removeEntry = async (room: PlateRoom, entry: PlateEntry) => {
        setMenuEntryId(null);
        const ok = await requestConfirm({
            title: '删除门牌记录？',
            message: (
                <div className="space-y-2">
                    <p>删除后这条常驻认知不会再出现在每轮对话中：</p>
                    <p className="text-xs text-slate-600 bg-slate-50 border border-slate-100 rounded-xl p-2.5 leading-relaxed">{entry.text}</p>
                </div>
            ),
            confirmText: '确认删除',
            variant: 'danger',
        });
        if (!ok) return;
        void editPlate(room, plate => (
            plate.entries.some(e => e.id === entry.id)
                ? { ...plate, entries: plate.entries.filter(e => e.id !== entry.id), updatedAt: Date.now() }
                : null
        ));
    };

    const commitEdit = () => {
        if (!editing) return;
        const { room, entryId } = editing;
        const text = editing.draft.replace(/\s+/g, ' ').trim().slice(0, PLATE_ENTRY_HARD_MAX_CHARS);
        setEditing(null);
        setNotice(null);
        if (!text) return;
        // 编辑期间这条被整理掉了。默默丢掉的话，用户敲的字就这么没了还不知道；也不能当新
        // 条目补回去——整理刚决定它不该在这块门牌上。说一句，让人自己判断。
        // 只在变换里做个标记、出来之后再提示：变换要保持是纯的，setNotice 塞进去的话，
        // 将来给 editPlate 加一次重试就会弹两遍，而 null 也会同时表示「不用改」和「去报错」。
        let vanished = false;
        void editPlate(room, plate => {
            const target = plate.entries.find(e => e.id === entryId);
            if (!target) {
                vanished = true;
                return null;
            }
            if (target.text === text) return null;
            return {
                ...plate,
                entries: plate.entries.map(e => e.id === entryId ? { ...e, text, updatedAt: Date.now() } : e),
                updatedAt: Date.now(),
            };
        }).then(() => {
            if (vanished) setNotice('刚改的那条在编辑期间已经被整理掉了，这次改写没有落到门牌上。');
        });
    };

    const fmtDate = (ts: number) => new Date(ts).toLocaleDateString();

    if (loading) {
        return (
            <div className="flex items-center justify-center h-40">
                <div className="w-8 h-8 border-4 border-violet-100 border-t-violet-400 rounded-full animate-spin"></div>
            </div>
        );
    }

    const totalEntries = PLATE_ROOMS.reduce((s, r) => s + (plates.get(r)?.entries.length || 0), 0);

    return (
        <div className="space-y-4 animate-fade-in pb-10">
            {/* 顶部说明卡 */}
            <div className="relative overflow-hidden bg-gradient-to-br from-white via-violet-50/70 to-purple-100/50 p-5 rounded-3xl border border-violet-100/80 shadow-[0_10px_35px_-18px_rgba(139,92,246,0.45)]">
                <Feather size={72} weight="duotone" className="absolute -right-3 -bottom-4 text-violet-200/50 rotate-12 pointer-events-none" />
                <div className="text-[10px] text-violet-300 uppercase tracking-[0.25em] font-bold">Resident Knowledge</div>
                <p className="text-xs text-slate-500 mt-2 leading-relaxed relative z-10">
                    门牌是角色从相处中自己蒸馏出的常驻认知——事件盒封存、认知消化时自动整理，每轮对话都在场。
                </p>
                <p className="text-xs text-violet-400/90 mt-1.5 relative z-10">蒸馏的条目可以在这里改写或删除。</p>
            </div>

            {notice && (
                <div className="flex items-start gap-2 bg-amber-50 border border-amber-100 rounded-2xl px-4 py-3">
                    <p className="flex-1 text-xs text-amber-700 leading-relaxed">{notice}</p>
                    <button onClick={() => setNotice(null)} className="shrink-0 text-[11px] font-bold text-amber-500 px-2 py-0.5">知道了</button>
                </div>
            )}

            {totalEntries === 0 && (
                <div className="text-center py-12 bg-gradient-to-b from-white to-violet-50/50 rounded-3xl border border-dashed border-violet-200">
                    <Sparkle size={28} weight="duotone" className="mx-auto text-violet-300 mb-3" />
                    <p className="text-sm text-slate-400">门牌还是空的</p>
                    <p className="text-xs text-slate-300 mt-2 max-w-xs mx-auto leading-relaxed">
                        继续相处：事件盒被压缩/封存、或触发一次认知消化后，角色会自己把沉淀下来的认知写上门牌。
                    </p>
                </div>
            )}

            {PLATE_ROOMS.map((room, roomIdx) => {
                const plate = plates.get(room);
                const entries = plate?.entries || [];
                if (entries.length === 0 && totalEntries === 0) return null;
                const title = room === 'user_room' && userName ? `关于${userName}` : PLATE_TITLES[room];
                return (
                    <React.Fragment key={room}>
                        {roomIdx > 0 && totalEntries > 0 && <SectionDivider />}
                        <div className="bg-gradient-to-b from-white to-violet-50/40 rounded-3xl p-5 border border-violet-100/80 shadow-[0_8px_30px_-16px_rgba(139,92,246,0.35)]">
                            {/* 区块头：圆形徽章 + 标题 + 容量 */}
                            <div className="flex items-center gap-3 mb-1">
                                <div className="shrink-0 w-11 h-11 rounded-full bg-gradient-to-br from-violet-100 to-purple-200/80 border border-white shadow-inner flex items-center justify-center text-violet-500">
                                    {ROOM_ICON[room]}
                                </div>
                                <div className="min-w-0 flex-1">
                                    <h3 className="text-[15px] font-bold text-slate-700 flex items-center gap-1.5">
                                        {title}
                                        <Sparkle size={11} weight="fill" className="text-violet-300" />
                                    </h3>
                                    <p className="text-[10px] text-slate-400 truncate">{ROOM_HINT[room]}</p>
                                </div>
                                <span className="shrink-0 text-[11px] font-bold text-violet-300">{entries.length}/{PLATE_ENTRY_CAPS[room]}</span>
                            </div>

                            {entries.length === 0 ? (
                                <p className="text-xs text-slate-300 italic mt-3 ml-1">暂无条目</p>
                            ) : (
                                <ul className="space-y-2.5 mt-4">
                                    {entries.map((e: PlateEntry) => (
                                        <li key={e.id} className="bg-white/80 rounded-2xl border border-violet-100/70 shadow-sm">
                                            {editing?.room === room && editing.entryId === e.id ? (
                                                /* 编辑态：羽毛笔 + 取消/保存 */
                                                <div className="p-3">
                                                    <textarea
                                                        value={editing.draft}
                                                        onChange={ev => setEditing({ ...editing, draft: ev.target.value })}
                                                        autoFocus
                                                        rows={2}
                                                        className="w-full bg-white border-2 border-violet-200 rounded-xl px-3 py-2 text-sm text-slate-700 resize-none focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:outline-none"
                                                    />
                                                    <div className="flex items-center justify-between mt-2">
                                                        <Feather size={16} weight="duotone" className="text-violet-300 ml-1" />
                                                        <div className="flex gap-2">
                                                            <button onClick={() => setEditing(null)} className="text-xs font-bold text-slate-400 px-4 py-1.5 rounded-xl bg-violet-50 border border-violet-100">取消</button>
                                                            <button onClick={commitEdit} className="text-xs font-bold text-white px-5 py-1.5 rounded-xl bg-gradient-to-r from-violet-500 to-purple-500 shadow-md shadow-violet-200">保存</button>
                                                        </div>
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="flex items-start gap-2.5 p-3">
                                                    {/* 条目图标（按 tag 匹配） */}
                                                    <div className="shrink-0 w-8 h-8 rounded-full bg-violet-50 border border-violet-100/80 flex items-center justify-center text-violet-400 mt-0.5">
                                                        {tagIcon(e.tag)}
                                                    </div>
                                                    <div className="min-w-0 flex-1">
                                                        <p
                                                            className="text-sm text-slate-700 leading-relaxed cursor-pointer"
                                                            onClick={() => { setMenuEntryId(null); setEditing({ room, entryId: e.id, draft: e.text }); }}
                                                            title="点击改写"
                                                        >
                                                            {e.text}
                                                        </p>
                                                        <p className="text-[10px] text-violet-300/90 mt-1">
                                                            {fmtDate(e.firstLearnedAt)} · 得知{e.sourceCount > 1 ? ` · 印证 ${e.sourceCount} 次` : ''}
                                                        </p>
                                                    </div>
                                                    <div className="shrink-0 flex flex-col items-end gap-1.5">
                                                        {e.tag && (
                                                            <span className="text-[10px] text-violet-500 bg-violet-50 border border-violet-100 rounded-full px-2.5 py-0.5 whitespace-nowrap">
                                                                {e.tag}
                                                            </span>
                                                        )}
                                                        <button
                                                            onClick={() => setMenuEntryId(menuEntryId === e.id ? null : e.id)}
                                                            className="text-violet-300 hover:text-violet-500 p-0.5"
                                                            title="更多操作"
                                                        >
                                                            <DotsThree size={18} weight="bold" />
                                                        </button>
                                                    </div>
                                                </div>
                                            )}
                                            {/* … 展开的操作行 */}
                                            {menuEntryId === e.id && !(editing?.entryId === e.id) && (
                                                <div className="flex justify-end gap-2 px-3 pb-3 -mt-1 animate-fade-in">
                                                    <button
                                                        onClick={() => { setMenuEntryId(null); setEditing({ room, entryId: e.id, draft: e.text }); }}
                                                        className="flex items-center gap-1 text-[11px] font-bold text-violet-500 bg-violet-50 border border-violet-100 rounded-xl px-3 py-1.5"
                                                    >
                                                        <PencilSimple size={12} weight="bold" /> 改写
                                                    </button>
                                                    <button
                                                        onClick={() => void removeEntry(room, e)}
                                                        className="flex items-center gap-1 text-[11px] font-bold text-rose-400 bg-rose-50 border border-rose-100 rounded-xl px-3 py-1.5"
                                                    >
                                                        <Trash size={12} weight="bold" /> 删除
                                                    </button>
                                                </div>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    </React.Fragment>
                );
            })}
            {confirmDialog}
        </div>
    );
};

export default RoomPlatePanel;
