import React, { useEffect, useState } from 'react';
import type { DialogueApiConfig } from '../types';
import ApiSlotEditor from '../components/settings/ApiSlotEditor';
import { readFriendFeedApi, saveFriendFeedApi } from '../utils/friendFeedApi';

export default function FriendFeedApi(_props: { onSaved?: () => void; onBack?: () => void }) {
  const [savedSlot, setSavedSlot] = useState<DialogueApiConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const sync = () => {
      void readFriendFeedApi()
        .then((value) => {
          if (alive) {
            setSavedSlot(value);
            setLoaded(true);
          }
        })
        .catch((e) => {
          if (alive) {
            setError(e instanceof Error ? e.message : '读取失败');
            setLoaded(true);
          }
        });
    };
    sync();
    window.addEventListener('sully:api-preset-updated', sync);
    return () => {
      alive = false;
      window.removeEventListener('sully:api-preset-updated', sync);
    };
  }, []);

  return (
    <div className="friend-feed-form ff-settings-page pb-8" aria-label="哔哔 API 配置">
      <header className="ff-settings-intro">
        <h2>哔哔用哪个 API？</h2>
        <p>用于首页刷新、刷新评论区和用户评论后的即时接话。</p>
      </header>
      {loaded && (
        <div className="rounded-2xl bg-white p-4 shadow-sm border border-slate-200/80 text-slate-800">
          <ApiSlotEditor
            slotName="哔哔"
            value={savedSlot}
            onCommit={async (next) => {
              setError('');
              setSavedSlot(next ?? null);
              try {
                await saveFriendFeedApi(next ?? null);
              } catch (e) {
                setError(e instanceof Error ? e.message : '保存失败');
              }
            }}
            followButtonLabel="恢复跟随角色与全局设置"
            helperText="开启独立 API 时优先使用此处配置；恢复跟随则按『本次互动角色独立 API → 全局主对话 API』自动选择。"
            meta={{ appId: 'friend_feed', appName: '哔哔' }}
          />
        </div>
      )}
      <p className="friend-feed-settings-hint">
        主回复里顺带互动仍用本次主 API；20% 自主浏览仍搭情绪副 API 的便车。分享图片沿聊天的识图配置处理。
      </p>
      {error && (
        <p role="alert" className="friend-feed-error">
          {error}
        </p>
      )}
    </div>
  );
}
