import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {THEME_AVATAR_MODE, resolveCollaborationAppearance, type CollaborationAppearance} from './appearance';
import {COLLABORATION_UI_THEME_CSS} from './themeCss';
import appearanceCss from './appearance.css?inline';
import baseCss from '../../components/chat/chatPreview.generated.css?inline';
import {BEAUTY_PREVIEW_AVATAR} from '../../utils/beautyPreviewAssets';

/** Fixed fictional content. The preview never mounts the collaboration engine or reads its DB. */
export function renderCollaborationBeautySample(value: CollaborationAppearance, compact = false) {
  const {uiTheme, dark, customCss} = resolveCollaborationAppearance(value);
  const avatars = value.avatarMode === 'theme' ? THEME_AVATAR_MODE[uiTheme] : value.avatarMode;
  const height = compact ? 360 : 600;
  const markup = renderToStaticMarkup(<main className={`collab-ui-root collab-ui-${uiTheme} ${dark?'collab-ui-dark':''} collab-avatar-${avatars} collab-avatar-style-${value.avatarStyle} flex flex-col overflow-hidden`} style={{height}}>
    <header className="collab-ui-header flex items-center gap-3 border-b px-4 py-3 bg-white">
      <span>‹</span><img src={BEAUTY_PREVIEW_AVATAR} alt="示例角色" className="collab-header-avatar w-8 h-8 object-cover"/>
      <div className="flex-1"><strong>协同工作</strong><small className="block text-slate-400">示例角色 · 沉浸式协同</small></div><span>☰　⚙</span>
    </header>
    <div className="collab-message-list flex-1 min-h-0 overflow-hidden p-4 space-y-5">
      {(['user','assistant'] as const).map(role=><div key={role} className={`collab-message-row collab-message-row-${role} flex gap-2 ${role==='user'?'flex-row-reverse':''}`}>
        <img src={BEAUTY_PREVIEW_AVATAR} alt="示例头像" className={`collab-message-avatar collab-message-avatar-${role} w-8 h-8 object-cover shrink-0`}/>
        <div className="collab-message-stack max-w-[85%]"><div className={`collab-message-bubble collab-message-bubble-${role} rounded-2xl p-3 ${role==='user'?'bg-indigo-600 text-white':'bg-white text-slate-700'}`}>
          {role==='user'?'一起把这些想法整理成一份计划吧。':<><p>好，我们先列出目标，再把步骤慢慢补齐。</p><p className="mt-2">一、整理灵感<br/>二、完善细节</p></>}
        </div></div>
      </div>)}
      {!compact&&<div className="collab-file-card rounded-2xl border bg-white p-4 text-slate-700"><strong>▤　示例计划.md</strong><small className="block mt-2 text-slate-400">示例文件 · 点击预览</small></div>}
    </div>
    <footer className="collab-ui-composer bg-white p-3 border-t"><div className="collab-composer-field flex items-center gap-3 rounded-2xl border p-3"><span>＋</span><span className="flex-1 text-slate-400 text-sm">告诉角色想完成什么…</span><span>➤</span></div></footer>
  </main>);
  return {markup,css:`${baseCss}\n${COLLABORATION_UI_THEME_CSS}\n${appearanceCss}\n.beauty-preview-body{width:360px;height:${height}px;font:14px/1.6 system-ui;--safe-top:0px;--safe-bottom:0px}\n${customCss}`};
}
