import React, { useEffect, useState } from 'react';
import Modal from '../os/Modal';
import { ActiveMsg2GlobalConfig } from '../../types';
import { ActiveMsgClient } from '../../utils/activeMsgClient';
import { ActiveMsgStore, maskActiveMsgUserId } from '../../utils/activeMsgStore';

interface ActiveMsgGlobalSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

const ActiveMsgGlobalSettingsModal: React.FC<ActiveMsgGlobalSettingsModalProps> = ({
  isOpen,
  onClose,
  addToast,
}) => {
  const [config, setConfig] = useState<ActiveMsg2GlobalConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pushStatus, setPushStatus] = useState<{
    supported: boolean;
    permission: NotificationPermission | 'unsupported';
    hasSubscription: boolean;
    vapidConfigured: boolean;
    detail?: string;
  } | null>(null);
  const [keyStatus, setKeyStatus] = useState('');

  const refresh = async () => {
    const nextConfig = await ActiveMsgClient.getGlobalConfig();
    const nextPushStatus = await ActiveMsgClient.getPushStatus();
    setConfig({
      ...nextConfig,
      driver: 'neon',
    });
    setPushStatus(nextPushStatus);
  };

  useEffect(() => {
    if (!isOpen) return;
    setAdvancedOpen(false);
    void refresh();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !config) return;
    void ActiveMsgStore.saveGlobalConfig({
      driver: 'neon',
      databaseUrl: config.databaseUrl,
      initSecret: config.initSecret,
    });
  }, [config?.databaseUrl, config?.initSecret, isOpen]);

  const patchConfig = (updates: Partial<ActiveMsg2GlobalConfig>) => {
    setConfig((prev) => ({
      ...(prev || { userId: '', driver: 'neon', databaseUrl: '' }),
      ...updates,
      driver: 'neon',
    }));
  };

  const handleCreateSubscription = async () => {
    setLoading(true);
    try {
      await ActiveMsgClient.ensurePushSubscription();
      await refresh();
      addToast('通知权限和推送订阅已准备完成。', 'success');
    } catch (error: any) {
      addToast(error?.message || '创建推送订阅失败。', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleInitTenant = async () => {
    if (!config?.databaseUrl.trim()) {
      addToast('先把 Neon 数据库连接串贴进去。', 'error');
      return;
    }

    setLoading(true);
    try {
      await ActiveMsgClient.initTenant({
        driver: 'neon',
        databaseUrl: config.databaseUrl,
        initSecret: config.initSecret,
      });
      await refresh();
      addToast('已连接成功，主动消息 2.0 可以用了。', 'success');
    } catch (error: any) {
      addToast(error?.message || '连接失败。', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleGetUserKey = async () => {
    setLoading(true);
    try {
      const result = await ActiveMsgClient.verifyUserKey();
      setKeyStatus(`用户密钥检查通过，版本 v${result.version}。`);
      addToast('用户密钥获取成功。', 'success');
    } catch (error: any) {
      setKeyStatus(error?.message || '用户密钥获取失败。');
      addToast(error?.message || '用户密钥获取失败。', 'error');
    } finally {
      setLoading(false);
    }
  };

  if (!config) return null;

  const isInitialized = Boolean(config.tenantId && config.tenantToken);

  return (
    <Modal
      isOpen={isOpen}
      title="主动消息 2.0"
      onClose={onClose}
      footer={(
        <button
          onClick={onClose}
          className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform"
        >
          关闭
        </button>
      )}
    >
      <div className="space-y-4 text-sm text-slate-600">
        <div className="bg-violet-50 border border-violet-100 rounded-2xl p-4 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span className="font-bold text-slate-700">连接方式</span>
            <span className="px-3 py-1 rounded-full bg-violet-500 text-white text-xs font-bold">Neon</span>
          </div>
          <p className="text-xs leading-relaxed text-violet-700">
            这里默认就是给 Neon 用的。把 Neon 提供的数据库连接串贴进来，然后点一次“连接并启用”就行。
          </p>
          <p className="text-[11px] leading-relaxed text-violet-600/80">
            就算你复制的是 <code>psql 'postgresql://...'</code> 整段，系统也会自动帮你清理成可用的连接串。
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-bold text-slate-700">当前状态</span>
            <span className={`text-xs font-bold ${isInitialized ? 'text-emerald-600' : 'text-amber-600'}`}>
              {isInitialized ? '已连接' : '未连接'}
            </span>
          </div>

          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">
              Neon Database URL
            </label>
            <textarea
              value={config.databaseUrl}
              onChange={(event) => patchConfig({ databaseUrl: event.target.value })}
              placeholder="把 Neon 给你的 postgresql://... 连接串贴在这里"
              className="w-full h-28 bg-white/70 border border-slate-200 rounded-2xl px-4 py-3 text-xs font-mono resize-none"
            />
          </div>

          <button
            onClick={handleInitTenant}
            disabled={loading}
            className="w-full py-3 bg-slate-900 text-white font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50"
          >
            {loading ? '处理中...' : isInitialized ? '重新连接并更新' : '连接并启用'}
          </button>

          <p className="text-xs leading-relaxed text-slate-500">
            普通用户只需要这一步。下面那些“密钥 / token / webhook”都是高级信息，不用看。
          </p>
        </div>

        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-bold text-slate-700">通知权限</span>
            <span className={`text-xs font-bold ${pushStatus?.hasSubscription ? 'text-emerald-600' : 'text-amber-600'}`}>
              {pushStatus?.hasSubscription ? '已开启' : '未开启'}
            </span>
          </div>
          <p className="text-xs leading-relaxed text-slate-500">
            这个是第二步。只有你真的想让角色在后台主动推送消息时，才需要点。
          </p>
          {pushStatus?.detail ? (
            <p className="text-xs leading-relaxed text-amber-600">{pushStatus.detail}</p>
          ) : null}
          <button
            onClick={handleCreateSubscription}
            disabled={loading}
            className="w-full py-3 bg-violet-500 text-white font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50"
          >
            {loading ? '处理中...' : '开启通知与推送'}
          </button>
        </div>

        <div className="bg-amber-50 border border-amber-100 rounded-2xl p-4 text-xs leading-relaxed text-amber-700 space-y-2">
          <div className="font-bold text-amber-800">简单说明</div>
          <p>这个功能会把主动消息相关的数据放进你自己的 Neon 数据库里。</p>
          <p>如果你完全信任自己的数据库，就可以用；如果你不想让数据库里出现这些内容，就不要开。</p>
          <p>项目不会额外偷偷建一个中心服务器，还是走你自己的库。</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
          <button
            type="button"
            onClick={() => setAdvancedOpen((prev) => !prev)}
            className="w-full flex items-center justify-between text-left"
          >
            <span className="font-bold text-slate-700">高级信息</span>
            <span className="text-xs font-bold text-slate-400">{advancedOpen ? '收起' : '展开'}</span>
          </button>

          {advancedOpen ? (
            <div className="space-y-3 text-xs">
              <div className="bg-violet-50 border border-violet-100 rounded-2xl p-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-semibold text-slate-700">X-User-Id</span>
                  <span className="font-mono text-violet-600">{maskActiveMsgUserId(config.userId)}</span>
                </div>
                <div className="flex items-start justify-between gap-3">
                  <span className="font-semibold text-slate-700">API Base</span>
                  <span className="font-mono text-[10px] text-violet-600 break-all text-right">{ActiveMsgClient.apiBaseUrl}</span>
                </div>
              </div>

              <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">
                  Init Secret（可选）
                </label>
                <input
                  type="password"
                  value={config.initSecret || ''}
                  onChange={(event) => patchConfig({ initSecret: event.target.value })}
                  placeholder="只有你自己额外配了 init-secret 才需要填"
                  className="w-full bg-white/70 border border-slate-200 rounded-2xl px-4 py-3 text-sm"
                />
              </div>

              <button
                onClick={handleGetUserKey}
                disabled={loading || !config.tenantToken}
                className="w-full py-3 bg-emerald-500 text-white font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50"
              >
                {loading ? '处理中...' : '检查用户密钥'}
              </button>
              {keyStatus ? <p className="text-xs text-emerald-600 leading-relaxed">{keyStatus}</p> : null}

              <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-3">
                <div className="font-bold text-slate-700">初始化结果</div>
                <div className="space-y-2">
                  <div>
                    <div className="font-semibold text-slate-500 mb-1">tenantId</div>
                    <div className="font-mono break-all">{config.tenantId || '未初始化'}</div>
                  </div>
                  <div>
                    <div className="font-semibold text-slate-500 mb-1">tenantToken</div>
                    <textarea readOnly value={config.tenantToken || ''} className="w-full h-16 bg-white rounded-xl px-3 py-2 font-mono resize-none" />
                  </div>
                  <div>
                    <div className="font-semibold text-slate-500 mb-1">cronToken</div>
                    <textarea readOnly value={config.cronToken || ''} className="w-full h-16 bg-white rounded-xl px-3 py-2 font-mono resize-none" />
                  </div>
                  <div>
                    <div className="font-semibold text-slate-500 mb-1">cronWebhookUrl</div>
                    <textarea readOnly value={config.cronWebhookUrl || ''} className="w-full h-16 bg-white rounded-xl px-3 py-2 font-mono resize-none" />
                  </div>
                  <div>
                    <div className="font-semibold text-slate-500 mb-1">masterKeyFingerprint</div>
                    <div className="font-mono break-all">{config.masterKeyFingerprint || '未生成'}</div>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
};

export default React.memo(ActiveMsgGlobalSettingsModal);
