import React, { useEffect, useRef, useState } from 'react';
import { CalendarCheck, CaretRight } from '@phosphor-icons/react';
import { CLOUD_GEN_PURPOSE_META, type CloudGenJobRecord, type CloudGenPurpose } from '../../utils/cloudGen/types';
import { dismissCloudGenJob, listCloudGenJobs, subscribeCloudGenJobs, sweepStaleCloudGenJobs } from '../../utils/cloudGen/registry';
import { isCloudGenHintOff, openCloudGenSheet, subscribeCloudGenSheet } from '../../utils/cloudGen/hint';
import { loadCloudGenLander } from '../../utils/cloudGen/landers';
import { trackCloudGenHint } from '../../utils/cloudGen/analytics';

/** 人格模拟、梦境写好后的「… · 进入」用各自原来的胶囊（PersonaSimIndicator / DreamSimIndicator），这里只管日程的。 */
const OWN_READY_PILL_PURPOSES: ReadonlySet<CloudGenPurpose> = new Set<CloudGenPurpose>(['persona-sim', 'dream']);

/** 「云端生成」提示停留多久后自己往上收起。 */
export const CLOUD_GEN_HINT_MS = 3000;
/** 收起动画时长，和下面的 transition 一致。 */
const COLLAPSE_MS = 300;
/** 上滑多少像素算「收起」。 */
const SWIPE_UP_PX = 16;

export type CloudGenPill =
    | { kind: 'running'; purpose: CloudGenPurpose; label: string; notify: boolean; jobIds: string[] }
    | { kind: 'landed'; label: string; record: CloudGenJobRecord };

/** 登记表 → 这一刻该显示的那颗胶囊。已落地的优先（能点进去）；在飞的只认 Worker 确认收下的。 */
export const pickCloudGenPill = (
    records: CloudGenJobRecord[],
    hintOff: (purpose: CloudGenPurpose) => boolean,
): CloudGenPill | null => {
    // 「不再提醒」连「好了 · 进入」一起藏：日程在本机生成时本来就没有这颗胶囊，选了不再提醒还冒出来就是打扰。
    const landed = records
        .filter((r) => r.status === 'landed' && !OWN_READY_PILL_PURPOSES.has(r.purpose) && !hintOff(r.purpose))
        .sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0))[0];
    if (landed) return { kind: 'landed', label: `${CLOUD_GEN_PURPOSE_META[landed.purpose].label}好了 · 进入`, record: landed };
    // 上传那几秒里切走照样会断，所以没有 acceptedAt 的不提示「可以切出去」。
    const running = records.filter((r) => r.status === 'running' && r.acceptedAt && !hintOff(r.purpose));
    if (running.length === 0) return null;
    const purposes = [...new Set(running.map((r) => r.purpose))];
    const count = purposes.length === 1 && running.length > 1 ? ` ×${running.length}` : '';
    return {
        kind: 'running',
        purpose: purposes[0],
        label: `云端生成 · ${purposes.map((p) => CLOUD_GEN_PURPOSE_META[p].label).join('、')}${count}`,
        // 几份里有一份不发通知，说明页就不承诺通知。
        notify: running.every((r) => r.notify),
        jobIds: running.map((r) => r.jobId),
    };
};

// 收起过的在飞任务（这次打开应用内）。下一次交云端是新的 jobId，照样弹；重开应用也会再弹一次。
const collapsedJobIds = new Set<string>();

// 全局「云端生成」提示 —— 挂在 PhoneShell，贴着安全区下方（与挂起的通话、见面条同一高度）。
// 在飞的提示是一次性的：弹出停 3 秒、或者上滑，就往上收起；日程写好后的「日程好了 · 进入」一直留着，上滑收走。
const CloudGenIndicator: React.FC = () => {
    const [records, setRecords] = useState<CloudGenJobRecord[]>(listCloudGenJobs);
    const [, setVersion] = useState(0);
    const [leaving, setLeaving] = useState(false);
    const swipe = useRef<{ y: number; swiped: boolean } | null>(null);

    useEffect(() => {
        const refresh = () => setRecords(listCloudGenJobs());
        const offJobs = subscribeCloudGenJobs(refresh);
        // 说明页开关和「本功能不再提醒」都走这一路通知。
        const offHint = subscribeCloudGenSheet(() => setVersion((v) => v + 1));
        refresh();
        void sweepStaleCloudGenJobs().catch(() => {});
        return () => { offJobs(); offHint(); };
    }, []);

    const picked = pickCloudGenPill(records, isCloudGenHintOff);
    // 在飞的里只要有一份还没收起过，就（再）弹一次，提示里带上全部在飞的。
    const pill = picked?.kind === 'running' && picked.jobIds.every((id) => collapsedJobIds.has(id)) ? null : picked;
    const runningKey = pill?.kind === 'running' ? pill.jobIds.join(',') : '';

    const collapse = () => {
        if (!pill || leaving) return;
        setLeaving(true);
        window.setTimeout(() => {
            if (pill.kind === 'running') pill.jobIds.forEach((id) => collapsedJobIds.add(id));
            else dismissCloudGenJob(pill.record.jobId);
            setLeaving(false);
            setVersion((v) => v + 1);
        }, COLLAPSE_MS);
    };

    useEffect(() => {
        if (!runningKey) return;
        const timer = window.setTimeout(collapse, CLOUD_GEN_HINT_MS);
        return () => window.clearTimeout(timer);
        // 只按「这一批在飞任务」计时；同一批里重渲染不重新计时。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [runningKey]);

    if (!pill) return null;

    const onTap = async () => {
        if (swipe.current?.swiped) return;
        if (pill.kind === 'running') {
            openCloudGenSheet({ purpose: pill.purpose, notify: pill.notify });
            return;
        }
        try {
            const lander = await loadCloudGenLander(pill.record.purpose);
            lander.open?.(pill.record);
            trackCloudGenHint(pill.record.purpose, 'enter');
            dismissCloudGenJob(pill.record.jobId);
        } catch (error) {
            // 落地代码没加载出来：胶囊留着，可以再点一次。
            console.warn('[cloud-gen] 打开结果失败', error);
        }
    };

    const ready = pill.kind === 'landed';
    return (
        <div className="absolute left-0 w-full flex justify-center px-4 z-[65] pointer-events-none"
            style={{ top: 'max(1.75rem, calc(var(--chrome-top, 1.5rem) + 0.25rem))' }}>
            <button onClick={() => void onTap()}
                onPointerDown={(e) => {
                    swipe.current = { y: e.clientY, swiped: false };
                    // 手指或鼠标滑出胶囊后照样收得到移动事件（鼠标默认不锁定）。
                    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 合成事件没有真实指针 */ }
                }}
                onPointerMove={(e) => {
                    const start = swipe.current;
                    if (start && !start.swiped && start.y - e.clientY > SWIPE_UP_PX) { start.swiped = true; collapse(); }
                }}
                aria-label={ready ? pill.label : `${pill.label}，上滑收起`}
                className={`pointer-events-auto flex items-center gap-2.5 rounded-full active:scale-95 shadow-[0_8px_30px_rgba(0,0,0,0.5)] border transition-[transform,opacity] duration-300 ${ready ? 'animate-notif-pop px-5 py-3' : 'animate-fade-in px-4 py-2.5'} ${leaving ? '-translate-y-[160%] opacity-0' : ''}`}
                style={{
                    touchAction: 'none',
                    ...(ready
                        ? { background: 'linear-gradient(120deg, rgba(167,226,206,0.97), rgba(104,184,160,0.94))', borderColor: 'rgba(167,226,206,0.5)' }
                        : { background: 'rgba(20,34,32,0.94)', borderColor: 'rgba(167,226,206,0.3)' }),
                }}>
                {ready
                    ? <CalendarCheck size={16} weight="fill" className="text-[#10231d]" />
                    : <span className="w-3.5 h-3.5 border-2 border-[#a7e2ce]/40 border-t-[#a7e2ce] rounded-full animate-spin" />}
                <span className={`text-[12px] font-semibold ${ready ? 'text-[#10231d]' : 'text-white/85'}`}>{pill.label}</span>
                {ready && <CaretRight size={13} weight="bold" className="text-[#10231d]/80" />}
            </button>
        </div>
    );
};

export default CloudGenIndicator;
