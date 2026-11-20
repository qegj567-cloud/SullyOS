import React, { useEffect, useState } from 'react';
import ConfirmDialog from './ConfirmDialog';
import { acknowledgeRecalledSoundNotice, hasRecalledSoundNotice, RECALLED_SOUND_EVENT } from '../../utils/recalledNotificationSound';

export default function RecalledSoundNotice() {
    const [open, setOpen] = useState(hasRecalledSoundNotice);
    useEffect(() => {
        const show = () => setOpen(hasRecalledSoundNotice());
        window.addEventListener(RECALLED_SOUND_EVENT, show);
        show();
        return () => window.removeEventListener(RECALLED_SOUND_EVENT, show);
    }, []);
    const close = () => { acknowledgeRecalledSoundNotice(); setOpen(false); };
    return <ConfirmDialog isOpen={open} title="提示音已停用" confirmText="知道了" cancelText="关闭"
        message="这段提示音曾被误打包分享，现已停用。本次不会播放该音频；聊天使用时会恢复默认静音。其他装扮不受影响，你可以重新选择喜欢的提示音。"
        onConfirm={close} onCancel={close} />;
}
