import React, { useEffect, useState } from 'react';
import { trackBeautyInbox } from '../../utils/beautyAnalytics';
import { beautyRequest } from '../../utils/beautyShareClient';

interface InboxPage {
  repos: { id: string; workName: string; signature: string; message: string; writtenAt: number }[];
  total: number;
  offset: number;
  pageSize: number;
  nextOffset: number | null;
}

export default function BeautyRepoInbox({ token }: { token: string }) {
  const [request, setRequest] = useState({ offset: 0 });
  const [page, setPage] = useState<InboxPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    beautyRequest<InboxPage>(`/repo-inbox?offset=${request.offset}`, { token }).then(result => {
      if (!active) return;
      setPage(result);
      trackBeautyInbox('success');
    }).catch(reason => {
      if (!active) return;
      setPage(null);
      setError(reason instanceof Error ? reason.message : '收件箱拉取失败，请重试');
      trackBeautyInbox('failure');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, request]);

  return <section aria-label="作者收件箱" aria-busy={loading}>
    <div className="beauty-share-actions">
      <button disabled={loading} onClick={() => setRequest({ offset: 0 })}>{loading ? '正在拉取…' : '刷新收件箱'}</button>
      {page && <span className="beauty-list-count">共 {page.total} 份 Repo</span>}
    </div>
    {error && <p role="alert" className="beauty-share-error">{error}</p>}
    {page?.total === 0 && <p className="beauty-empty">还没有收到 Repo。读者给你作品的小纸条会在管理员审核通过后出现在这里。</p>}
    {page?.repos.map(repo => <article className="beauty-inbox-letter" key={repo.id}>
      <strong>{repo.workName}</strong>
      <p className="beauty-share-message">{repo.message}</p>
      <footer>{repo.signature} · {new Date(repo.writtenAt).toLocaleString()}</footer>
    </article>)}
    {page && page.total > page.pageSize && <div className="beauty-pagination" aria-label="收件箱分页">
      <button disabled={loading || !page.offset} onClick={() => setRequest({ offset: Math.max(0, page.offset - page.pageSize) })}>上一页</button>
      <span>第 {Math.floor(page.offset / page.pageSize) + 1} / {Math.ceil(page.total / page.pageSize)} 页</span>
      <button disabled={loading || page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) setRequest({ offset: page.nextOffset }); }}>下一页</button>
    </div>}
  </section>;
}
