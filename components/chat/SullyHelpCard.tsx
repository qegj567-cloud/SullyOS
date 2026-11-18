import React from 'react';
import { useOS } from '../../context/OSContext';
import { AppID } from '../../types';
import { appShortcutLaunch } from '../../utils/appShortcutLaunch';
import { SULLY_HELP_DESK_ID } from '../../utils/sullyIdentity';

export function SullyHelpCard() {
    const { openApp } = useOS();
    return (
        <button type="button" className="flex items-center gap-3 rounded-2xl bg-white p-3 text-left text-slate-800 shadow-sm"
            onClick={() => {
                appShortcutLaunch.request({ appId: AppID.FAQ, entryId: SULLY_HELP_DESK_ID });
                openApp(AppID.FAQ);
            }}>
            <img src="sully/head.png" alt="" className="h-10 w-10 rounded-xl" />
            <span><strong className="block text-sm">找 Sully-11 答疑</strong>
                <span className="text-xs text-slate-500">打开使用帮助 →</span></span>
        </button>
    );
}
