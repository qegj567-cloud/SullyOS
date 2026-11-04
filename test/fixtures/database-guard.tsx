import React from 'react';
import { createRoot } from 'react-dom/client';
import DatabaseGuard from '../../components/DatabaseGuard';
import DatabaseDiagnosticDetails from '../../components/DatabaseDiagnosticDetails';

// Simulated open failure only; never open or modify the user's actual database.
indexedDB.open = (() => {
  const request = { error: new DOMException('Index with the same ID already exists', 'UnknownError'), onerror: null as null | (() => void) };
  queueMicrotask(() => request.onerror?.());
  return request as unknown as IDBOpenDBRequest;
}) as typeof indexedDB.open;
const recovered = new URLSearchParams(location.search).get('mode') === 'recovered';
createRoot(document.getElementById('root')!).render(recovered
  ? <main style={{ maxWidth: 640, margin: '40px auto', padding: 16 }}><h1>恢复后的诊断入口测试</h1><DatabaseDiagnosticDetails /></main>
  : <DatabaseGuard><p>不应挂载的桌面</p></DatabaseGuard>);
