import React, { useState } from 'react';

function report(): string {
  // Provided by the dependency-free script in index.html and recover.html.
  const read = (window as Window & { __sullyStartupDiagnosticReport?: () => string }).__sullyStartupDiagnosticReport;
  return read?.() || '当前页面未提供启动记录。旧版本的故障无法补记。';
}

export default function StartupDiagnosticDetails() {
  const [diagnostic, setDiagnostic] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  return <details className="mt-3 w-full text-left" onToggle={event => {
    if (event.currentTarget.open) setDiagnostic(report());
  }}>
    <summary className="cursor-pointer">网页启动诊断（含最近异常记录）</summary>
    <p className="mt-2 leading-relaxed">启动异常自动保留在本机，恢复后也能复制。不保存聊天或密钥，不自动上传。</p>
    <textarea aria-label="网页启动诊断" readOnly value={diagnostic}
      className="mt-2 h-44 w-full select-text rounded-lg border border-slate-200 bg-white p-2 font-mono text-xs" />
    <button type="button" className="mt-2 rounded-lg border border-slate-200 px-3 py-2" onClick={async () => {
      const latest = report();
      setDiagnostic(latest);
      try { await navigator.clipboard.writeText(latest); setCopyStatus('已复制，可发给开发者排查'); }
      catch { setCopyStatus('请长按或选中上方文字复制'); }
    }}>复制启动诊断</button>
    <span role="status" className="mt-2 block">{copyStatus}</span>
  </details>;
}
