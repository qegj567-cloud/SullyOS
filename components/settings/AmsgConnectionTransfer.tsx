import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ActiveMsg2GlobalConfig } from '../../types';
import { createAmsgConnectionCode, parseAmsgConnectionCode, verifyAmsgConnection, type AmsgConnection } from '../../utils/amsgConnectionCode';
import { discoverAmsgBackends, type ExistingAmsgBackend } from '../../utils/cfProvision';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import { focusSettingsBackIfNeeded } from './SettingsDetailPage';

export interface AmsgDiscoveryRequest { token: string; scriptName: string; }

export default function AmsgConnectionTransfer({ config, onApply, receive = false, initialToken = '', initialScriptName = 'sullyos-amsg', active = true, discoveryRequest, onDiscoveryStarted, onRestoreBackup, onRedeploy, intent = 'connect' }: {
  config: ActiveMsg2GlobalConfig; onApply: (connection: AmsgConnection) => Promise<void>; receive?: boolean; initialToken?: string; active?: boolean;
  discoveryRequest?: AmsgDiscoveryRequest | null; onDiscoveryStarted?: () => void;
  onRestoreBackup?: () => void;
  onRedeploy?: (token: string, backend: ExistingAmsgBackend) => Promise<void>;
  intent?: 'connect' | 'redeploy';
  initialScriptName?: string;
}) {
  const [mode, setMode] = useState<'send' | 'receive' | null>(receive ? 'receive' : null);
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<AmsgConnection | null>(null);
  const [exportCode, setExportCode] = useState('');
  const [token, setToken] = useState(initialToken);
  const [scriptName, setScriptName] = useState(initialScriptName);
  const [found, setFound] = useState<ExistingAmsgBackend[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [discoveryOpen, setDiscoveryOpen] = useState(intent === 'redeploy');
  const [discoveryError, setDiscoveryError] = useState('');
  const [automaticDiscovery, setAutomaticDiscovery] = useState(false);
  const [focusTarget, setFocusTarget] = useState<'discovery' | 'results' | 'code' | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState('');
  const [pendingRedeploy, setPendingRedeploy] = useState<ExistingAmsgBackend | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const codeForm = useRef<HTMLDivElement>(null);
  const discovery = useRef<HTMLDetailsElement>(null);
  const discoveryStarted = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const section = useRef<HTMLElement>(null);
  useEffect(() => { if (active) focusSettingsBackIfNeeded(section.current); }, [active, mode, preview, exportCode]);
  useLocalBackHandler(() => {
    if (busy) return true;
    if (pendingRedeploy) { setPendingRedeploy(null); return true; }
    if (mode === 'receive' && preview) { setPreview(null); setError(''); return true; }
    if (mode === 'send' && exportCode) { setExportCode(''); setNotice(''); return true; }
    if (recovering && found?.length) { setRecovering(false); setDiscoveryOpen(true); setFocusTarget('results'); return true; }
    if (!receive && mode) { setMode(null); setError(''); return true; }
    return false;
  }, 40, active);
  const find = useCallback(async (lookupToken: string, lookupScriptName: string) => {
    setBusy(true); setDiscoveryError(''); setFound(null); setWarnings([]);
    try {
      const result = await discoverAmsgBackends(
        lookupToken,
        lookupScriptName.trim(),
        ...(config.useRelay ? [{ useRelay: config.useRelay, relayToken: config.relayToken }] : []),
      );
      setFound(result.backends); setWarnings(result.warnings); setToken(lookupToken);
      setSelectedAccount(result.backends.length === 1 ? result.backends[0].account.id : '');
      setRecovering(false); setPendingRedeploy(null); setFocusTarget(result.backends.length ? 'results' : 'discovery');
    }
    catch (e) { setDiscoveryError(e instanceof Error ? e.message : '查找失败，请稍后重试。'); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => {
    // A deployment collision hands off one lookup. Tab changes and StrictMode
    // effect replays must not send it again or retain a second copy of the token.
    if (!active || !discoveryRequest || discoveryStarted.current) return;
    discoveryStarted.current = true;
    setMode('receive'); setDiscoveryOpen(true); setAutomaticDiscovery(true); setFocusTarget('discovery');
    setToken(discoveryRequest.token); setScriptName(discoveryRequest.scriptName);
    void find(discoveryRequest.token, discoveryRequest.scriptName);
    onDiscoveryStarted?.();
  }, [active, discoveryRequest, find, onDiscoveryStarted]);
  useEffect(() => {
    if (!active || !focusTarget) return;
    // Run after the parent has reset the connection page's scroll position.
    const frame = requestAnimationFrame(() => {
      const target = focusTarget === 'results' ? resultsRef.current : focusTarget === 'code' ? codeForm.current : discovery.current;
      const control = focusTarget === 'code' ? target?.querySelector('textarea') : focusTarget === 'discovery' ? target?.querySelector('summary') : target;
      control?.focus({ preventScroll: true }); target?.scrollIntoView?.({ block: 'start' });
      setFocusTarget(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [active, focusTarget]);
  const apply = async () => {
    if (!preview) return;
    setBusy(true); setError('');
    try {
      const checked = parseAmsgConnectionCode(createAmsgConnectionCode(preview));
      await verifyAmsgConnection(checked, { useRelay: config.useRelay, relayToken: config.relayToken });
      await onApply(checked);
      setCode(''); setToken(''); setPreview(null); setMode(null); setNotice('已接回原后台。请到「通知与设备」检查这台设备的通知。');
    } catch (e) { setError(e instanceof Error ? e.message : '连接失败，请重试。'); }
    finally { setBusy(false); }
  };
  return <section ref={section} className="amsg-transfer">
    {!receive && <>
      <h3>在另一台设备使用</h3>
      <p className="amsg-caption">只迁移后台连接，无须导出聊天记录。</p>
      <div className="amsg-action-list">
        <button type="button" disabled={busy || !config.initializedAt} onClick={() => { setMode('send'); setError(''); }}><span>给新设备一份连接码<small>在当前设备生成</small></span><span aria-hidden>↗</span></button>
        <button type="button" disabled={busy} onClick={() => { setMode('receive'); setExportCode(''); setError(''); }}><span>接入已有后台<small>在新设备粘贴连接码</small></span><span aria-hidden>→</span></button>
      </div>
    </>}
    {mode === 'send' && <div className="amsg-transfer-form">
      <p>连接码包含后台地址、密钥和原用户身份，拿到它就能访问你的后台。请只传给自己的设备。</p>
      <button type="button" className="amsg-button-primary" onClick={() => {
        try { setExportCode(createAmsgConnectionCode(config)); setError(''); } catch (e) { setError((e as Error).message); }
      }}>生成连接码</button>
      {exportCode && <><textarea aria-label="本机连接码" readOnly value={exportCode} rows={3} spellCheck={false} />
        <button type="button" className="amsg-button-secondary" onClick={async () => {
          try { await navigator.clipboard.writeText(exportCode); setNotice('连接码已复制，请在新设备的「已有后台／换设备」中粘贴。'); }
          catch { setError('无法自动复制，请长按上方连接码全选复制。'); }
        }}>复制连接码</button><button type="button" className="amsg-text-button" onClick={() => setExportCode('')}>隐藏连接码</button></>}
    </div>}
    {mode === 'receive' && <div className="amsg-transfer-form">
      {((!found?.length && intent === 'connect') || recovering) && <div ref={codeForm} className="amsg-transfer-form">
      <h3>接回原来的后台</h3>
      <p>在原设备的「连接与迁移」生成连接码，粘贴到这里。</p>
      <textarea aria-label="粘贴连接码" placeholder="SULLY-AMSG2:…" autoComplete="off" spellCheck={false} value={code} rows={3} disabled={busy} onChange={e => { setCode(e.target.value); setPreview(null); setError(''); }} />
      {!preview ? <button type="button" className="amsg-button-primary" disabled={busy || !code.trim()} onClick={() => {
        try { setPreview(parseAmsgConnectionCode(code)); setError(''); } catch (e) { setError((e as Error).message); }
      }}>读取连接码</button> : <div className="amsg-connection-preview">
        <span className="amsg-eyebrow">即将连接</span><strong className="break-all">{preview.workerUrl.replace(/^https:\/\//, '')}</strong>
        <label>后台地址（可换成自己的域名）<input type="url" value={preview.workerUrl} disabled={busy} onChange={e => setPreview({ ...preview, workerUrl: e.target.value })} /></label>
        <p>会沿用原用户身份和云端任务。这台设备登记通知后会替换原设备的通知接收位置，原设备仍可重新登记。</p>
        <p>连接码不包含角色和聊天记录；没有原角色的设备不能自动恢复它们。需要完整接续聊天时，请恢复个人备份。</p>
        <button type="button" className="amsg-button-primary" disabled={busy} onClick={() => {
          try { parseAmsgConnectionCode(createAmsgConnectionCode(preview)); void apply(); } catch (e) { setError((e as Error).message); }
        }}>{busy ? '正在连接…' : '验证并连接这台设备'}</button>
      </div>}
      {recovering && <button type="button" className="amsg-text-button" disabled={busy} onClick={() => { setRecovering(false); setPreview(null); setDiscoveryOpen(true); setFocusTarget('results'); }}>返回查找结果</button>}
      </div>}
      {!recovering && <details ref={discovery} className="amsg-disclosure" open={discoveryOpen} onToggle={event => setDiscoveryOpen(event.currentTarget.open)}><summary>{intent === 'redeploy' ? '查找要重新部署的后台' : automaticDiscovery ? '查找已有部署' : '只记得 Cloudflare Token？查找已有部署'}</summary>
        {found?.length ? <div ref={resultsRef} tabIndex={-1} className="amsg-discovery-actions" aria-label="已有后台的下一步">
          <h4>找到 {found.length} 个已有后台</h4>
          {found.length > 1 && <label>选择后台<select aria-label="选择已有后台" disabled={busy || !!pendingRedeploy} value={selectedAccount} onChange={event => setSelectedAccount(event.target.value)}><option value="">请选择账号</option>{found.map(item => <option key={item.account.id} value={item.account.id}>{item.account.name} · {item.scriptName}</option>)}</select></label>}
          {found.filter(item => item.account.id === selectedAccount).map(item => <div key={item.account.id} className="amsg-discovered-backend"><strong>{item.account.name} · {item.scriptName}</strong>{item.urls.map(url => <p key={url}>{url}</p>)}{item.redeploying && <p>后台已暂停，继续完成上次的重新配置。</p>}</div>)}
          {pendingRedeploy ? <div className="amsg-redeploy-confirm" aria-label="重新部署确认">
            <h4>重新部署 {pendingRedeploy.scriptName}？</h4>
            <p>先停止这个后台接收和执行新任务，等待旧任务结束，再换新密钥和数据库。首次等待约 31 分钟，可以关闭页面后回来继续。</p>
            <p className="amsg-caption">旧数据库和本机聊天保留，旧设备需要重新连接。已经发出的通知可能晚到；其他独立部署的后台不会被停用。</p>
            <p className="amsg-caption">使用这个后台的所有用户空间都会受影响。角色设置保留，部署后继续检查通知和角色开关。</p>
            <button type="button" className="amsg-button-primary" disabled={busy} onClick={async () => {
              if (!onRedeploy || !token) return;
              setBusy(true); setDiscoveryError('');
              try { await onRedeploy(token, pendingRedeploy); }
              catch (error) { setDiscoveryError(error instanceof Error ? error.message : '未能开始重新部署，请重试。'); }
              finally { setBusy(false); }
            }}>{busy ? '正在准备…' : '确认重新部署'}</button>
            <button type="button" className="amsg-button-secondary" disabled={busy} onClick={() => setPendingRedeploy(null)}>保留原后台</button>
          </div> : <>
            <p className="amsg-caption">{intent === 'redeploy' ? '确认账号和地址，再重新部署。' : '选择接回原配置，或重新开始。'}</p>
            {intent === 'connect' && !found.find(item => item.account.id === selectedAccount)?.redeploying && <><button type="button" className="amsg-button-primary" disabled={busy} onClick={() => { setRecovering(true); setFocusTarget('code'); }}>用连接码接回</button>
            {onRestoreBackup && <button type="button" className="amsg-button-secondary" disabled={busy} onClick={onRestoreBackup}>从备份恢复</button>}</>}
            {onRedeploy && <button type="button" className={intent === 'redeploy' || found.find(item => item.account.id === selectedAccount)?.redeploying ? 'amsg-button-primary' : 'amsg-button-secondary'} disabled={busy || !selectedAccount || !token} onClick={() => setPendingRedeploy(found.find(item => item.account.id === selectedAccount) || null)}>{found.find(item => item.account.id === selectedAccount)?.redeploying ? '继续重新部署' : '重新部署，不接续旧数据'}</button>}
            {found.length > 1 && !selectedAccount && <p className="amsg-caption">重新部署前，先选择上方的账号。</p>}
            <button type="button" className="amsg-text-button" disabled={busy} onClick={() => { setFound(null); setWarnings([]); setFocusTarget('discovery'); }}>换个 Token 或重新查找</button>
          </>}
          <p className="amsg-caption">Token 仅在本次页面内使用，退出后清除。</p>
        </div> : <>
        <div className="amsg-transfer-form">
          {automaticDiscovery && <p className="amsg-caption">检测到已有部署，已为你转到查找，并带入刚才填写的 Token。</p>}
          <p>查找这枚 Token 有权限访问的后台。此操作只读取部署信息，不会重新安装或清空数据。</p>
          <label>Cloudflare API Token<input type="password" autoComplete="off" value={token} disabled={busy} onChange={e => { setToken(e.target.value); setFound(null); setWarnings([]); }} placeholder="粘贴 Cloudflare API Token" /></label>
          <label>Worker 名称<input value={scriptName} disabled={busy} onChange={e => { setScriptName(e.target.value); setFound(null); setWarnings([]); }} /></label>
          <p className="amsg-caption">一键部署默认是 sullyos-amsg。Token 经当前网络代理查询 Cloudflare，本页不保存。</p>
          <button type="button" className="amsg-button-secondary" disabled={busy || !token.trim()} onClick={() => void find(token, scriptName)}>{busy ? '正在查找…' : '查找已有后台'}</button>
          {found && <div role="status" className="amsg-discovery-results">
            <h4>{found.length ? `找到 ${found.length} 个已有后台` : '没有找到可确认的后台'}</h4>
            {found.map(item => <div key={item.account.id}><strong>{item.account.name} · {item.scriptName}</strong>{item.urls.length ? item.urls.map(url => <p key={url} className="break-all">{url}</p>) : <p>已找到部署，访问地址请从原设备的连接码获取。</p>}</div>)}
            <p>{found.length ? '接下来：在原设备复制连接码，或恢复包含后端连接的个人备份。Cloudflare 不返回已保存的密钥，Token 本身不能恢复原用户身份。' : '请确认 Token 的账号范围、Worker 名称和读取权限。没有找到并不代表原后台已删除。'}</p>
          </div>}
        </div>
        </>}
        {discoveryError && <p role="alert" className="amsg-form-error">{discoveryError}</p>}
        {warnings.map(warning => <p key={warning} role="status">{warning}</p>)}
      </details>}
      {intent === 'connect' && (!found?.length || recovering) && <details className="amsg-disclosure"><summary>原设备不在身边，或已经导入备份</summary><p>个人备份导出时需勾选「包含主动消息 2.0 的后端连接」，恢复时同意恢复连接。如果没带上，可回原设备复制连接码。只凭 Token 和地址无法恢复旧密钥；没有连接码、原设备或带连接的备份时，可选择重新部署。</p>{onRestoreBackup && <button type="button" className="amsg-button-secondary" disabled={busy} onClick={onRestoreBackup}>从备份恢复</button>}<p>「迁入独立用户」会保留目的地的后台连接，不接续来源任务。</p></details>}
    </div>}
    {error && <p role="alert" className="amsg-form-error">{error}</p>}
    {notice && <p role="status" className="amsg-form-notice">{notice}</p>}
  </section>;
}
