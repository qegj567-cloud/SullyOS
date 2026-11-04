import React, { useEffect, useState } from 'react';
import { openDB } from '../utils/db';
import { checkDatabaseReadable, databaseFailure, subscribeDatabaseFailure, type DatabaseFailure } from '../utils/databaseHealth';
import DatabaseDiagnosticDetails from './DatabaseDiagnosticDetails';
import './DatabaseGuard.css';

export default function DatabaseGuard({ children, readiness }: { children: React.ReactNode; readiness?: Promise<void> }) {
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<DatabaseFailure | null>(null);
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
  return <main className="database-guard">
    <section aria-labelledby="database-guard-title">
      <span className="database-guard-label">SULLYOS · 本地存档</span>
      <h1 id="database-guard-title">暂时无法读取本地数据</h1>
      <p role="alert">读取失败不代表数据已被清空。主界面已暂停加载，请先保留当前浏览器和原访问网址。</p>
      {duplicateIndex && <p>浏览器报告数据库内部索引冲突。目前无法确认存档是否完整；清理网站数据无法保留原存档。</p>}
      <ul>
        <li>不要清除网站数据、卸载浏览器或用空备份覆盖已有备份。</li>
        <li>可关闭同站点的其他标签页与桌面入口，再重试；持续失败请保留现场并反馈诊断。</li>
      </ul>
      <div className="database-guard-actions">
        <button type="button" onClick={() => location.reload()}>重新读取</button>
        <a href={`${import.meta.env.BASE_URL}recover.html`}>检查网页更新</a>
      </div>
      <DatabaseDiagnosticDetails failure={failure} initiallyOpen />
    </section>
  </main>;
}
