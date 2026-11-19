// Real Settings in an isolated browser profile; never imported by the app.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { OSProvider } from '../../context/OSContext';
import Settings from '../../apps/Settings';
import FAQApp from '../../apps/FAQApp';
import { AppID } from '../../types';
import { appShortcutLaunch } from '../../utils/appShortcutLaunch';
import { SULLY_HELP_DESK_ID } from '../../utils/sullyIdentity';
import { handleLocalBack } from '../../utils/localBackHandlers';
import { UpdateNotificationController } from '../../components/UpdateNotificationEvent';
import { AMSG_RECENT_UPDATE_KEY, SULLY_SUPPORT_NOTICE_KEY } from '../../utils/novemberNotices';
import { requestSettingsFocus } from '../../utils/settingsNavigation';

Object.assign(window, { sullySupportBack: handleLocalBack });
const params = new URLSearchParams(location.search);
if (params.has('desk')) appShortcutLaunch.request({ appId: AppID.FAQ, entryId: SULLY_HELP_DESK_ID });
if (params.has('support')) requestSettingsFocus('support');
function Fixture() {
    const [notices, setNotices] = useState(() => params.has('notices') &&
        [AMSG_RECENT_UPDATE_KEY, SULLY_SUPPORT_NOTICE_KEY].some(key => !localStorage.getItem(key)));
    return <OSProvider>{params.has('desk') ? <FAQApp /> : <Settings />}{notices && <UpdateNotificationController onClose={() => setNotices(false)} />}</OSProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
