import React, { useEffect, useState } from 'react';
import Modal from './Modal';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import { CLOUD_GEN_PURPOSE_META } from '../../utils/cloudGen/types';
import {
    closeCloudGenSheet,
    getCloudGenSheet,
    setCloudGenHintOff,
    subscribeCloudGenSheet,
    type CloudGenSheetRequest,
} from '../../utils/cloudGen/hint';
import type { ActiveMsg2PushStatus } from '../../utils/activeMsgClient';

/**
 * 这台设备此刻收得到通知没有：和 2.0 设置「通知设置」读的是同一份本机推送状态。
 * 只看本机这一侧（有订阅、权限给了），不为一句文案去问 Worker。
 */
export const isPushDeliverable = (status: Pick<ActiveMsg2PushStatus, 'hasSubscription' | 'permission'>): boolean =>
    status.hasSubscription && status.permission === 'granted';

/** 说明页正文。只有这次会发通知、且这台设备收得到时，才说「会弹出消息通知」。 */
export const cloudGenSheetCopy = (willNotify: boolean): string =>
    `这次请求交给了你的主动消息 2.0 后台，在云端生成。现在可以暂时退出应用，生成不会中断。${willNotify ? '生成完毕会弹出消息通知。' : '生成完毕后，回到应用就能看到。'}`;

// 「云端生成」小条点开后的说明页。PhoneShell 上只挂这一份，日程小条和人格模拟、梦境的胶囊都打开它。
const CloudGenSheet: React.FC = () => {
    const [req, setReq] = useState<CloudGenSheetRequest | null>(getCloudGenSheet);
    // null = 还没查完：先按「回到应用就能看到」说，查明收得到再改口，免得许下送不到的通知。
    const [pushOk, setPushOk] = useState<boolean | null>(null);

    useEffect(() => subscribeCloudGenSheet(setReq), []);

    useEffect(() => {
        setPushOk(null);
        if (!req?.notify) return;
        let live = true;
        import('../../utils/activeMsgClient')
            .then(({ ActiveMsgClient }) => ActiveMsgClient.getPushStatus())
            .then((status) => { if (live) setPushOk(isPushDeliverable(status)); })
            .catch(() => { if (live) setPushOk(false); });
        return () => { live = false; };
    }, [req]);

    useLocalBackHandler(() => { closeCloudGenSheet(); return true; }, 120, !!req);

    if (!req) return null;
    const feature = CLOUD_GEN_PURPOSE_META[req.purpose]?.label ?? '';
    return (
        <Modal
            isOpen
            title={`云端生成 · ${feature}`}
            onClose={closeCloudGenSheet}
            footer={<>
                <button
                    type="button"
                    onClick={() => { setCloudGenHintOff(req.purpose, true); closeCloudGenSheet(); }}
                    className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform"
                >
                    本功能不再提醒
                </button>
                <button
                    type="button"
                    onClick={closeCloudGenSheet}
                    className="flex-1 py-3 bg-slate-800 text-white font-bold rounded-2xl active:scale-95 transition-transform"
                >
                    知道了
                </button>
            </>}
        >
            <p className="text-sm leading-relaxed text-slate-700">{cloudGenSheetCopy(req.notify && pushOk === true)}</p>
            <p className="mt-3 text-xs leading-relaxed text-slate-400">不再提醒后，可以在「主动消息 2.0 → 功能总览 → 云端生成」里恢复。</p>
        </Modal>
    );
};

export default CloudGenSheet;
