import React from 'react';
import Modal from '../os/Modal';
import { useOS } from '../../context/OSContext';
import { AppID } from '../../types';
import { requestHolidaySettings } from '../../utils/userHolidays';
import { syncAmsgToolConfigAndPrompts } from '../../utils/amsgStateSync';

export default function UserHolidayIntro({ onDone, onExit }: { onDone: () => void; onExit: () => void }) {
    const { realtimeConfig, updateRealtimeConfig, openApp, characters, userProfile, groups } = useOS();
    const choose = (wantsSetup: boolean) => {
        const userHolidays = { ...realtimeConfig.userHolidays, countryCode: realtimeConfig.userHolidays?.countryCode || '', enabled: false,
            introChoice: wantsSetup ? 'configure' as const : 'declined' as const };
        updateRealtimeConfig({ userHolidays });
        syncAmsgToolConfigAndPrompts({ ...realtimeConfig, userHolidays }, { characters, userProfile, groups });
        if (wantsSetup) { requestHolidaySettings(); openApp(AppID.Settings); onExit(); }
        else onDone();
    };
    return <Modal isOpen title="让 TA 知道你的假期" onClose={() => choose(false)} footer={<div className="mx-auto grid w-full max-w-xs grid-cols-2 gap-3">
        <button onClick={() => choose(false)} className="flex min-h-11 items-center justify-center rounded-2xl bg-slate-100 px-3 py-3 text-center text-xs text-slate-600">我不需要该功能</button>
        <button onClick={() => choose(true)} className="flex min-h-11 items-center justify-center rounded-2xl bg-violet-500 px-3 py-3 text-center text-sm font-bold text-white">去填写</button>
    </div>}>
        <div className="space-y-4 text-sm leading-relaxed text-slate-600">
            <p>选择你生活的国家／地区，假期或调休补班当天，在你的用户信息里添一句提醒。聊天、见面等共用这份信息的场景都能感知。</p>
            <div className="rounded-2xl bg-violet-50 p-4 text-violet-800">例如：今天是{userProfile.name || '你'}所在地的中秋假期，实际休息以自己的日程为准。</div>
            <p>普通日期不额外提示，也不会默认你一定放假。不需要的话可以直接关闭，以后仍可在「设置 → 扩展连接 → 实时感知」开启。</p>
        </div>
    </Modal>;
}
