import React from 'react';
import { useOS } from '../context/OSContext';
import { AppID } from '../types';
import { requestSettingsFocus } from '../utils/settingsNavigation';
import { appShortcutLaunch } from '../utils/appShortcutLaunch';
import { SULLY_HELP_DESK_ID } from '../utils/sullyIdentity';
import { AMSG_RECENT_UPDATE_KEY, SULLY_SUPPORT_NOTICE_KEY, HELP_STICKERS_UPDATE_KEY } from '../utils/novemberNotices';
import { AmsgRecentUpdatePopup, SullySupportNotice, HelpStickersUpdatePopup } from './os/NovemberUpdatePopups';
import { trackEvent } from '../utils/analytics';

// 历史 key —— 保留给备份兼容与旧版本日志使用。
export const UPDATE_NOTIFICATION_KEY = 'sullyos_update_2026_04_seen';
export const UPDATE_NOTIFICATION_KEY_2026_05 = 'sullyos_update_2026_05_seen';
export const UPDATE_NOTIFICATION_KEY_2026_05_10 = 'sullyos_update_2026_05_10_seen';
export const UPDATE_NOTIFICATION_KEY_2026_05_17 = 'sullyos_update_2026_05_17_seen';
export const UPDATE_NOTIFICATION_KEY_2026_05_25 = 'sullyos_update_2026_05_25_seen';
export const UPDATE_NOTIFICATION_KEY_2026_06_05 = 'sullyos_update_2026_06_05_seen';
export const UPDATE_NOTIFICATION_KEY_2026_06_14 = 'sullyos_update_2026_06_14_seen';
export const UPDATE_NOTIFICATION_KEY_2026_06_21 = 'sullyos_update_2026_06_21_seen';
export const UPDATE_NOTIFICATION_KEY_2026_06_26 = 'sullyos_update_2026_06_26_seen';
export const UPDATE_NOTIFICATION_KEY_2026_07_10 = 'sullyos_update_2026_07_10_seen';
// 本次更新：主动消息 2.0。
export const UPDATE_NOTIFICATION_KEY_2026_08_03 = 'sullyos_update_2026_08_03_amsg2_seen';
// 本次更新：Live2D 视频通话与陪伴桌面。
export const UPDATE_NOTIFICATION_KEY_2026_08_10 = 'sullyos_update_2026_08_10_live2d_seen';
// 本次更新：角色协同工作台。
export const UPDATE_NOTIFICATION_KEY_2026_08_30 = 'sullyos_update_2026_08_30_collaboration_seen';
// 例行维护补充：静态网页环境下部分联网功能的数据流说明。
export const NETWORK_TRANSIT_NOTICE_KEY_2026_08 = 'sullyos_notice_2026_08_network_transit_seen';

export const FAQ_TARGET_SECTION_KEY = 'sullyos_faq_target_section';
export const CHANGELOG_2026_04 = 'changelog-2026-04';
export const CHANGELOG_2026_05 = 'changelog-2026-05';
export const CHANGELOG_2026_05_10 = 'changelog-2026-05-10';
export const CHANGELOG_2026_05_17 = 'changelog-2026-05-17';
export const CHANGELOG_2026_05_27 = 'changelog-2026-05-27';
export const CHANGELOG_2026_06_05 = 'changelog-2026-06-05';
export const CHANGELOG_2026_06_14 = 'changelog-2026-06-14';
export const CHANGELOG_2026_06_21 = 'changelog-2026-06-21';
export const CHANGELOG_2026_06_26 = 'changelog-2026-06-26';
export const CHANGELOG_2026_07_10 = 'changelog-2026-07-10';
export const CHANGELOG_2026_08_03 = 'changelog-2026-08-03';
export const CHANGELOG_2026_08_10 = 'changelog-2026-08-10';
export const CHANGELOG_2026_08_30 = 'changelog-2026-08-30';

/** storage 读不出来时当成看过：宁可少弹一次，也别每次开机都糊用户一脸。 */
const isUpdateSeen = (key: string): boolean => {
    try {
        return !!localStorage.getItem(key);
    } catch {
        return true;
    }
};

interface UpdatePopupProps {
    /** 这条用户自己关掉了 —— 接着弹队列里的下一条。 */
    onDone: () => void;
    /**
     * 用户点了「立刻体验」这类按钮、已经被带去别的 App 了 —— 整串提醒收起来。
     * 后面那几条不标已读，下次启动照弹，免得刚跳过去就被新弹窗盖住。
     */
    onExit: () => void;
}

const HelpStickersAnnouncement: React.FC<UpdatePopupProps> = ({ onExit }) => {
    const { openApp } = useOS();
    return <HelpStickersUpdatePopup onDone={onExit} onVisit={() => {
        appShortcutLaunch.request({ appId: AppID.FAQ, entryId: SULLY_HELP_DESK_ID });
        openApp(AppID.FAQ);
        trackEvent('打开 Sully-11', { 入口: '更新提醒' });
        onExit();
    }} />;
};

const AmsgRecentUpdateAnnouncement: React.FC<UpdatePopupProps> = ({ onDone, onExit }) => {
    const { openApp } = useOS();
    return <AmsgRecentUpdatePopup onDone={onDone} onVisit={() => {
        requestSettingsFocus('amsg2'); openApp(AppID.Settings); onExit();
    }} />;
};

const SullySupportAnnouncement: React.FC<UpdatePopupProps> = ({ onExit }) => {
    const { openApp } = useOS();
    return <SullySupportNotice onDone={onExit} onVisit={() => {
        requestSettingsFocus('support'); openApp(AppID.Settings); onExit();
    }} />;
};

// Only current announcements are eligible, even on a fresh installation.
const UPDATE_QUEUE = [
    { key: HELP_STICKERS_UPDATE_KEY, render: (props: UpdatePopupProps) => <HelpStickersAnnouncement {...props} /> },
    { key: AMSG_RECENT_UPDATE_KEY, render: (props: UpdatePopupProps) => <AmsgRecentUpdateAnnouncement {...props} /> },
    { key: SULLY_SUPPORT_NOTICE_KEY, render: (props: UpdatePopupProps) => <SullySupportAnnouncement {...props} /> },
];

const isPending = (entry: (typeof UPDATE_QUEUE)[number]): boolean => !isUpdateSeen(entry.key);

export const shouldShowUpdateNotification = (): boolean => UPDATE_QUEUE.some(isPending);

interface UpdateNotificationControllerProps {
    onClose: () => void;
}

export const UpdateNotificationController: React.FC<UpdateNotificationControllerProps> = ({ onClose }) => {
    // 进场时把没看过的挑出来定住。每次渲染重算的话，当前这条一被标记已读就会自己从队列里
    // 消失、直接跳到下一条，用户还没来得及点——推进队列的只能是下面 onDone 那一下。
    const [pending, setPending] = React.useState(() => UPDATE_QUEUE.filter(isPending));
    const current = pending[0];

    React.useEffect(() => {
        if (!current) onClose();
    }, [current, onClose]);

    if (!current) return null;

    return (
        <React.Fragment key={current.key}>
            {current.render({
                onDone: () => setPending((rest) => rest.slice(1).filter(isPending)),
                onExit: onClose,
            })}
        </React.Fragment>
    );
};
