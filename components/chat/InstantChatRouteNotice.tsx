/**
 * 「这一轮没上云，在本地生成」的提示条（输入框正上方那一条）。
 *
 * 为什么要有：即时对话的开关写着「已开启」，消息却在本地生成——这中间的落差过去只留在
 * console 和观察窗里，用户查不到。他能看到的只有本地直连失败时那条读不懂的网络报错，
 * 于是以为是自己网络坏了。线上真实故障里，有人就这么卡了四个小时。
 *
 * 只报四档，都是「用户想上云、实际没上」的情形：
 *   worker-outdated              问到了，那台 Worker 确实跑不动 → 指路去更新
 *   worker-unreachable           这一刻够不着云端 → 别叫人去更新，多半是网络，会自己好
 *   sar-module-worker-outdated   SAR 模块生效中，那台 Worker 是旧 bundle、拆不了模块回复的信封 → 指路去更新
 *   sar-module-worker-unverified SAR 模块生效中，这一刻没问到 Worker 版本 → 探到就会自己回去
 *
 * 用户自己关掉的（disabled / char-disabled）、点单流程那种本该留在本地的，一律不出声——
 * 那些是正常行为，报了就成骚扰。
 */
import React, { useEffect, useState } from 'react';
import { AMSG_INSTANT_CHAT_ROUTE_EVENT, type InstantChatRouteDetail } from '../../utils/amsgInstantChat';

const NOTICES: Record<string, { title: string; hint: string }> = {
    'worker-outdated': {
        title: '这一轮在本地生成',
        hint: '云端 Worker 版本较旧，暂不支持即时对话，请去设置里更新一下',
    },
    'worker-unreachable': {
        title: '这一轮在本地生成',
        hint: '一时连不上云端，网络恢复后会自动恢复',
    },
    'sar-module-worker-outdated': {
        title: '这一轮在本地生成',
        hint: 'SAR 模块生效中，云端那台 Worker 还是旧版本，去设置里更新一下',
    },
    'sar-module-worker-unverified': {
        title: '这一轮在本地生成',
        hint: 'SAR 模块生效中，正在确认云端 Worker 版本，确认后会自动恢复',
    },
};

const InstantChatRouteNotice: React.FC<{ charId: string }> = ({ charId }) => {
    const [reason, setReason] = useState<string | null>(null);

    useEffect(() => {
        // 换会话先清干净：上一个角色那轮的结论跟这个角色没关系。
        setReason(null);
        const onRoute = (event: Event) => {
            const detail = (event as CustomEvent<InstantChatRouteDetail>).detail;
            if (!detail || detail.charId !== charId) return;
            // reason 为 null（这一轮走成了云端）或不在名单里的原因，都当「没什么好说的」收起来。
            setReason(detail.reason && NOTICES[detail.reason] ? detail.reason : null);
        };
        window.addEventListener(AMSG_INSTANT_CHAT_ROUTE_EVENT, onRoute);
        return () => window.removeEventListener(AMSG_INSTANT_CHAT_ROUTE_EVENT, onRoute);
    }, [charId]);

    const notice = reason ? NOTICES[reason] : null;
    if (!notice) return null;

    return (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-amber-50 border-b border-amber-200/70 text-[11px] text-amber-800">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
            <span className="font-bold shrink-0">{notice.title}</span>
            <span className="opacity-70 truncate">· {notice.hint}</span>
        </div>
    );
};

export default InstantChatRouteNotice;
