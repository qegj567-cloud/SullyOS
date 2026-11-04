import React from 'react';
import {createRoot} from 'react-dom/client';
import BibiIcon from '../../components/os/BibiIcon';
import {Icons} from '../../constants';
import {getAcnhIcon} from '../../components/os/acnhIcons';
import {AppID} from '../../types';

const DesktopIcon = Icons.FriendFeed;
createRoot(document.getElementById('root')!).render(<>
  <style>{`
    *{box-sizing:border-box}body{margin:0;background:#F6F3E9;color:#584b38;font-family:system-ui,sans-serif}
    main{max-width:580px;margin:0;padding:30px 24px}header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #584b3820;padding-bottom:16px}header b{font-size:22px}header span{font-size:12px;color:#8b826d}
    .hero{display:flex;align-items:center;justify-content:center;gap:20px;padding:32px 0 30px}.hero svg{width:190px;height:190px}.island-hero{background:#82d5bb;border-radius:34%;display:grid;place-items:center;padding:14px}.hero h1{font-size:44px;letter-spacing:.08em;margin:0 0 12px}.hero p{font-size:15px;line-height:1.9;margin:0;color:#8b826d}
    .contexts{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid #584b3820;padding-top:24px;gap:14px}.sample{height:112px;display:flex;align-items:center;justify-content:center;gap:10px}.label{text-align:center;font-size:11px;color:#8b826d;letter-spacing:.1em}
    .tile{width:68px;height:68px;border-radius:34%;display:grid;place-items:center;background:#82d5bb}.tile>div{width:78%;height:78%}.w-full{width:100%}.h-full{height:100%}.ordinary{background:#e6e7df;border-radius:18px}.ordinary>div{width:50%;height:50%}.caption{font-size:11px;text-align:center;margin-top:6px;font-weight:600}.phone{background:#f1e5c9;border-radius:17px;width:58px;height:58px;display:grid;place-items:center}.small{font-size:16px;font-weight:700}
    @media(max-width:560px){main{padding:24px 18px}.hero{gap:14px}.hero svg{width:170px;height:170px}.island-hero{background:#82d5bb;border-radius:34%;display:grid;place-items:center;padding:14px}.hero h1{font-size:40px}.hero p{font-size:12px}.contexts{gap:6px}.sample{gap:6px}.tile{width:52px;height:52px}}
  `}</style>
  <main><header><b>哔哔</b><span>小话痨，来啦。</span></header>
    <section className="hero"><div className="island-hero"><BibiIcon variant="island"/></div><div><h1>哔——</h1><p>个头不大，话可不少。<br/>正在很认真地胡说八道。</p></div></section>
    <section className="contexts">
      <div><div className="sample"><div><div className="tile ordinary"><div><DesktopIcon className="w-full h-full"/></div></div><div className="caption">哔哔</div></div></div><div className="label">默认桌面 · 单色线条</div></div>
      <div><div className="sample"><div><div className="tile"><div>{getAcnhIcon(AppID.FriendFeed)}</div></div><div className="caption">哔哔</div></div></div><div className="label">森间手记 · 无勾线</div></div>
      <div><div className="sample"><div><div className="phone"><BibiIcon variant="island" size={40}/></div><div className="caption">哔哔</div></div></div><div className="label">小屋手机 · 无勾线</div></div>
    </section>
  </main>
</>);
