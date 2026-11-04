import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import NavigationBallSettings from '../../components/settings/NavigationBallSettings';
import { DraggableNavigationBall } from '../../components/os/NavigationBall';
import { useNavigationBallEnabled, useNavigationPickerOpen } from '../../utils/navigationBall';
import { requestSettingsFocus, useSettingsFocus } from '../../utils/settingsNavigation';
import { AppID } from '../../types';
import { handleLocalBack } from '../../utils/localBackHandlers';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import NavigationBallNotice from '../../components/os/NavigationBallNotice';
// Isolated UI fixture: no OSProvider, database access or SW registration.
function Fixture() {
  const enabled = useNavigationBallEnabled();
  const pickerOpen = useNavigationPickerOpen();
  const [route, setRoute] = useState('设置');
  const [apiOpen, setApiOpen] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const characters = [{ id: 'sully', name: 'Sully' }, { id: 'xiaoyu', name: '小雨' }];
  useSettingsFocus('api', () => { setRoute('设置'); setApiOpen(true); });
  useLocalBackHandler(() => { if (route !== '装扮预览') return false; setRoute('美化列表'); return true; }, 20);
  useLocalBackHandler(() => { if (route !== '美化列表') return false; setRoute('设置'); return true; }, 10);
  return <main className="qa-phone"><div className="qa-content"><h1>快捷导航验证</h1><NavigationBallSettings characters={characters} loadWorlds={async () => [{ id: 'demo', name: '海边的家' }]} />
    <div className="qa-route"><p role="status">当前页面：{route}</p><button onClick={() => setRoute('装扮预览')}>打开装扮预览</button><button className="ml-4" onClick={() => setNoticeOpen(true)}>预览悬浮球通知</button></div>
    {apiOpen && <div role="region" aria-label="API 配置">API 配置（隔离预览，不读写凭据）</div>}
  </div>{noticeOpen && <NavigationBallNotice onDone={() => setNoticeOpen(false)} onConfigure={() => { setNoticeOpen(false); requestSettingsFocus('navigation'); }} />}{enabled && !pickerOpen && <DraggableNavigationBall onBack={() => { if (!handleLocalBack()) setRoute('桌面'); }} onHome={() => setRoute('桌面')}
    onApi={() => requestSettingsFocus('api')} characters={characters}
    onConfigure={() => { setRoute('设置'); requestSettingsFocus('navigation'); }}
    onShortcut={shortcut => setRoute([shortcut.appId === AppID.Chat ? 'Message' : shortcut.appId === AppID.Room ? shortcut.roomTab || '小屋' : shortcut.appId, shortcut.targetName].filter(Boolean).join(' / '))} />}</main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
