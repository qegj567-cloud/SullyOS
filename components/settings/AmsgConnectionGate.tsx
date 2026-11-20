import React from 'react';

/** Keep the destination visible while the disconnected page is non-interactive. */
export default function AmsgConnectionGate({ connected, onConnect, description = '连接后即可配置角色和通知。', children }: {
  connected: boolean;
  onConnect: () => void;
  description?: string;
  children: React.ReactNode;
}) {
  return <>
    {!connected && <div className="amsg-connect-notice" role="note">
      <div><strong>先连接你的后台</strong><p>{description}</p></div>
      <button type="button" onClick={onConnect}>前往连接与迁移 <span aria-hidden="true">›</span></button>
    </div>}
    <fieldset disabled={!connected} aria-disabled={!connected || undefined} {...(!connected ? { inert: '' } : {})} className="amsg-connection-gated">
      {children}
    </fieldset>
  </>;
}
