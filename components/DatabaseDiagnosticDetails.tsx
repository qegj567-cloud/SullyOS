import React, { useState } from 'react';
import type { DatabaseFailure } from '../utils/databaseHealth';
import { databaseDiagnosticReport } from '../utils/databaseOpenDiagnostics';

/** History is read only when opened/copied, including after the archive recovers. */
export default function DatabaseDiagnosticDetails({ failure, initiallyOpen = false }: {
  failure?: DatabaseFailure; initiallyOpen?: boolean;
}) {
  const [diagnostic, setDiagnostic] = useState(() => initiallyOpen ? databaseDiagnosticReport(failure) : '');
  const [copyStatus, setCopyStatus] = useState('');
  return <details open={initiallyOpen || undefined} className="w-full text-left" onToggle={event => {
    if (event.currentTarget.open) setDiagnostic(databaseDiagnosticReport(failure));
  }}>
    <summary className="cursor-pointer">本地数据库诊断（不含聊天、角色或密钥）</summary>
    <p className="mt-2 leading-relaxed">仅保存在本机，不自动上传；读取恢复后仍可复制最近的记录。</p>
    <textarea aria-label="数据库诊断" readOnly value={diagnostic}
      className="mt-2 h-44 w-full select-text rounded-lg border border-slate-200 bg-white p-2 font-mono text-xs" />
    <button type="button" className="mt-2 rounded-lg border border-slate-200 px-3 py-2" onClick={async () => {
      const latest = databaseDiagnosticReport(failure);
      setDiagnostic(latest);
      try { await navigator.clipboard.writeText(latest); setCopyStatus('已复制，可发给开发者排查'); }
      catch { setCopyStatus('请长按或选中上方文字复制'); }
    }}>复制诊断</button>
    <span role="status" className="mt-2 block">{copyStatus}</span>
  </details>;
}
