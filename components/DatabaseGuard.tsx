import React, { useEffect, useState } from 'react';
import { openDB } from '../utils/db';
import { checkDatabaseReadable, databaseFailure, subscribeDatabaseFailure, type DatabaseFailure } from '../utils/databaseHealth';
import { trackEvent } from '../utils/analytics';
import type { DatabaseRescueResult } from '../utils/databaseRescueExport';
import DatabaseDiagnosticDetails from './DatabaseDiagnosticDetails';
import './DatabaseGuard.css';

export default function DatabaseGuard({ children, readiness }: { children: React.ReactNode; readiness?: Promise<void> }) {
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<DatabaseFailure | null>(null);
  const [rescuing, setRescuing] = useState(false);
  const [rescueProgress, setRescueProgress] = useState('');
  const [rescueResult, setRescueResult] = useState<DatabaseRescueResult | null>(null);
  const [rescueError, setRescueError] = useState('');
  const [savingFile, setSavingFile] = useState(false);
  const [saveStatus, setSaveStatus] = useState('');

  useEffect(() => {
    let active = true, failed = false;
    const fail = (error: unknown) => {
      if (!active) return;
      failed = true;
      setFailure(databaseFailure(error));
      setReady(false);
    };
    const unsubscribe = subscribeDatabaseFailure(fail);
    void (readiness || checkDatabaseReadable(openDB)).then(() => {
      if (active && !failed) setReady(true);
    }, fail);
    return () => { active = false; unsubscribe(); };
  }, [readiness]);

  if (ready && !failure) return <>{children}</>;
  // Keep a mounted marker for the pre-React startup watchdog while storage is checked silently.
  if (!failure) return <div hidden data-database-pending aria-busy="true" />;
  const duplicateIndex = failure.message.includes('Index with the same ID already exists');
  const missingFile = failure.name === 'NotReadableError' || /missing file|Affected record should be considered irrecoverable/i.test(failure.message);

  const handleStartRescue = async () => {
    if (rescuing) return;
    setRescuing(true);
    setRescueError('');
    setRescueResult(null);
    setSaveStatus('');
    setRescueProgress('正在扫描本地数据库…');
    try {
      const { exportDamagedDatabaseRescue } = await import('../utils/databaseRescueExport');
      const result = await exportDamagedDatabaseRescue(text => setRescueProgress(text));
      setRescueResult(result);
      setRescueProgress('');
      trackEvent('导出数据库抢救备份', { 结果: '成功' });
    } catch (error) {
      const msg = error instanceof Error && error.message ? error.message : String(error || '未知错误');
      setRescueError(`抢救导出未能完成：${msg}`);
      setRescueProgress('');
      trackEvent('导出数据库抢救备份', { 结果: '失败' });
    } finally {
      setRescuing(false);
    }
  };

  const handleSaveRescueFile = async () => {
    if (!rescueResult || savingFile) return;
    setSavingFile(true);
    setSaveStatus('');
    try {
      const { shareOrDownloadBlob } = await import('../utils/shareExport');
      const outcome = await shareOrDownloadBlob({
        blob: rescueResult.blob,
        fileName: rescueResult.fileName,
        shareTitle: 'SullyOS 紧急抢救备份',
        nativeChunked: true,
      });
      if (outcome === 'shared') {
        setSaveStatus('已拉起系统分享，请确认备份文件已妥善保存到本地或网盘后再做清理操作。');
        trackEvent('保存数据库抢救备份', { 结果: '已分享' });
      } else if (outcome === 'downloaded') {
        setSaveStatus('已开始下载抢救备份，请确认文件完整保存后再做清理操作。');
        trackEvent('保存数据库抢救备份', { 结果: '已下载' });
      } else {
        setSaveStatus('已取消保存，可再次点击上方按钮保存抢救备份。');
        trackEvent('保存数据库抢救备份', { 结果: '取消' });
      }
    } catch (error) {
      const msg = error instanceof Error && error.message ? error.message : String(error || '保存失败');
      setSaveStatus(`保存失败：${msg}`);
      trackEvent('保存数据库抢救备份', { 结果: '失败' });
    } finally {
      setSavingFile(false);
    }
  };

  return <main className="database-guard">
    <section aria-labelledby="database-guard-title">
      <span className="database-guard-label">SULLYOS · 本地存档</span>
      <h1 id="database-guard-title">暂时无法读取本地数据</h1>
      <p role="alert">读取失败不代表数据已被清空。主界面已暂停加载，请先保留当前浏览器和原访问网址。</p>
      {duplicateIndex && <p>浏览器报告数据库内部索引冲突。目前无法确认存档是否完整；清理网站数据无法保留原存档。</p>}
      {missingFile && <p>浏览器报告本地数据文件缺失，目前无法确认受损范围。可先在下方生成抢救备份，保存仍能读取的数据；已经丢失的文件无法保证恢复。</p>}
      <ul>
        <li>不要卸载应用、清除网站数据或用空备份覆盖已有备份。</li>
        <li>可关闭同站点的其他标签页与桌面入口，再重试；持续失败请先导出抢救备份并反馈诊断。</li>
      </ul>
      <div className="database-guard-actions">
        <button type="button" onClick={() => location.reload()}>重新读取</button>
        <a href={`${import.meta.env.BASE_URL}recover.html`}>检查网页更新</a>
      </div>
      <div className="database-guard-rescue" aria-labelledby="database-guard-rescue-title">
        <h2 id="database-guard-rescue-title">紧急抢救导出备份</h2>
        <p>逐条扫描本机仍可访问的聊天、角色、记忆与素材，自动跳过已损坏无法读取的记录并打包成标准备份（不会修改或删除当前本地数据）。</p>
        <div className="database-guard-rescue-actions">
          {!rescueResult ? (
            <button type="button" onClick={handleStartRescue} disabled={rescuing}>
              {rescuing ? '正在抢救打包…' : '生成抢救备份包'}
            </button>
          ) : (
            <>
              <button type="button" className="database-guard-primary" onClick={handleSaveRescueFile} disabled={savingFile || rescuing}>
                {savingFile ? '正在调起保存…' : '保存抢救备份 (.zip)'}
              </button>
              <button type="button" onClick={handleStartRescue} disabled={rescuing || savingFile}>
                {rescuing ? '正在重新打包…' : '重新生成'}
              </button>
            </>
          )}
        </div>
        {rescueProgress && <span role="status">{rescueProgress}</span>}
        {rescueError && <p role="alert" className="database-guard-rescue-error">{rescueError}</p>}
        {rescueResult && <p role="status" className="database-guard-rescue-summary">{rescueResult.summaryText}</p>}
        {saveStatus && <span role="status">{saveStatus}</span>}
      </div>
      <DatabaseDiagnosticDetails failure={failure} initiallyOpen />
    </section>
  </main>;
}
