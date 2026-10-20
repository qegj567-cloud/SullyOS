import React, { useEffect, useState } from 'react';
import Modal from '../os/Modal';
import { useOS } from '../../context/OSContext';
import { generateVapidKeyPair } from '../../utils/vapidGen';
import { loadPushVapid, savePushVapid, clearPushVapid } from '../../utils/pushVapid';
import { trackEvent } from '../../utils/analytics';

interface PushVapidSettingsModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 推送凭据 (VAPID) 配置面板.
 *
 * 这对密钥是主动消息 2.0 Worker 签推送用的: 一键部署时自动沿用, 手动部署时照着填进
 * Worker env. 整个站点只有一个 pushManager 订阅, 所以它放在设置顶层当全局推送凭据管.
 *
 * 私钥也存 localStorage 方便复制到 CF Worker env, 这里不当成一次性密钥处理.
 */
export const PushVapidSettingsModal: React.FC<PushVapidSettingsModalProps> = ({ open, onClose }) => {
  const { addToast } = useOS();

  const [publicKey, setPublicKey] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    if (!open) return;
    const v = loadPushVapid();
    setPublicKey(v.vapidPublicKey);
    setPrivateKey(v.vapidPrivateKey);
    setShowPrivateKey(false);
  }, [open]);

  const persist = (pub: string, priv: string) => {
    savePushVapid({ vapidPublicKey: pub, vapidPrivateKey: priv });
  };

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const kp = await generateVapidKeyPair();
      setPublicKey(kp.publicKey);
      setPrivateKey(kp.privateKey);
      persist(kp.publicKey, kp.privateKey);
      setShowPrivateKey(true);
      addToast('已生成新的 VAPID 密钥对', 'success');
      // 只报「这次生成成没成」。不带「之前配没配过」——那等于上报凭据配置状态。
      trackEvent('生成 VAPID 密钥对', { result: 'success' });
    } catch (e) {
      const err = e as { message?: string } | null;
      addToast(err?.message ?? '生成失败', 'error');
      // 只报「失败了」这一件事：报错原文可能带路径，留在 toast / console 里就够。
      trackEvent('生成 VAPID 密钥对', { result: 'error' });
    } finally {
      setGenerating(false);
    }
  };

  const handleClear = () => {
    if (!confirm('确定清空 VAPID 密钥对？之后重新部署的 Worker 会换成新的一对，推送订阅需要重建。')) {
      trackEvent('清空 VAPID 密钥对', { confirmed: false });
      return;
    }
    trackEvent('清空 VAPID 密钥对', { confirmed: true });
    clearPushVapid();
    setPublicKey('');
    setPrivateKey('');
    addToast('VAPID 已清空', 'success');
  };

  const handleCopyPublicKey = async () => {
    if (!publicKey) return;
    await navigator.clipboard.writeText(publicKey);
    addToast('公钥已复制', 'success');
    trackEvent('复制 VAPID 公钥');
  };

  const handleCopyPrivateKey = async () => {
    if (!privateKey) {
      addToast('私钥尚未生成', 'error');
      return;
    }
    await navigator.clipboard.writeText(privateKey);
    addToast('私钥已复制', 'success');
    trackEvent('复制 VAPID 私钥');
  };

  const handleCopyEnv = async () => {
    let pub = publicKey.trim();
    let priv = privateKey.trim();
    if (!pub || !priv) {
      await handleGenerate();
      const v = loadPushVapid();
      pub = v.vapidPublicKey;
      priv = v.vapidPrivateKey;
      if (!pub || !priv) return;
    }
    const lines = [
      `VAPID_PUBLIC_KEY=${pub}`,
      `VAPID_PRIVATE_KEY=${priv}`,
      `# 可选：`,
      `# VAPID_EMAIL=mailto:you@example.com`,
    ];
    await navigator.clipboard.writeText(lines.join('\n'));
    addToast('env 已复制（含真实密钥）', 'success');
    trackEvent('复制 Worker env 清单');
  };

  const handleSave = () => {
    persist(publicKey.trim(), privateKey.trim());
    addToast('推送凭据已保存', 'success');
    onClose();
  };

  const maskedPrivateKey = privateKey
    ? privateKey.slice(0, 4) + '•'.repeat(Math.max(8, privateKey.length - 8)) + privateKey.slice(-4)
    : '';

  return (
    <Modal
      isOpen={open}
      title="推送凭据 (VAPID)"
      onClose={onClose}
      footer={
        <div className="flex gap-2 w-full">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl text-sm"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="flex-1 py-3 bg-indigo-500 text-white font-bold rounded-2xl shadow-lg shadow-indigo-200 text-sm"
          >
            保存
          </button>
        </div>
      }
    >
      <div className="space-y-5 text-sm">

        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-3 text-[11px] text-amber-800 leading-relaxed">
          <p className="font-bold mb-1">⚠ 一份 VAPID, 两个用法</p>
          <p>
            浏览器订阅 push 用<b>公钥</b>; Worker 签名 push 用<b>私钥</b>.
            主动消息 2.0 部署 Worker 时<b>用的就是这一对</b> ——
            Worker 上的公钥和浏览器订阅绑的不一致时, 推送会被 403 拒掉.
          </p>
          <p className="mt-1">
            生成 / 改了之后, 你的 CF Worker env (<code>VAPID_PUBLIC_KEY</code> + <code>VAPID_PRIVATE_KEY</code>) 也要同步更新, 否则签名校验会失败.
          </p>
        </div>

        {/* 公钥 */}
        <div className="bg-slate-50 rounded-2xl p-4 space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-[11px] text-slate-500 font-medium">VAPID 公钥</label>
            {publicKey && (
              <button
                type="button"
                onClick={() => void handleCopyPublicKey()}
                className="text-[11px] text-slate-500 hover:text-slate-700 font-medium"
              >
                复制
              </button>
            )}
          </div>
          <input
            type="text"
            value={publicKey}
            onChange={(e) => setPublicKey(e.target.value)}
            placeholder="BA…（点下方「生成新密钥对」自动生成）"
            className="w-full text-[11px] font-mono bg-white border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-400"
          />
        </div>

        {/* 私钥 */}
        <div className="bg-slate-50 rounded-2xl p-4 space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-[11px] text-slate-500 font-medium">VAPID 私钥</label>
            <div className="flex items-center gap-3">
              {privateKey && (
                <>
                  <button
                    type="button"
                    onClick={() => setShowPrivateKey((s) => !s)}
                    className="text-[11px] text-slate-500 hover:text-slate-700 font-medium"
                  >
                    {showPrivateKey ? '隐藏' : '显示'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCopyPrivateKey()}
                    className="text-[11px] text-indigo-500 hover:text-indigo-600 font-medium"
                  >
                    复制
                  </button>
                </>
              )}
            </div>
          </div>
          {showPrivateKey ? (
            <textarea
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              rows={3}
              placeholder="点下方「生成新密钥对」自动生成"
              className="w-full font-mono text-[11px] bg-white border border-slate-200 rounded-xl p-2 resize-none leading-relaxed focus:outline-none focus:border-indigo-400"
            />
          ) : (
            <div className="w-full text-[11px] font-mono bg-white border border-slate-200 rounded-xl px-3 py-2 text-slate-500 select-none break-all">
              {maskedPrivateKey || '尚未生成'}
            </div>
          )}
          <p className="text-[10px] text-slate-400 leading-relaxed">
            私钥保存在当前浏览器中，方便部署或更新 Worker 时随时复制。
          </p>
        </div>

        {/* 操作 */}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => void handleGenerate()}
            disabled={generating}
            className={`py-2.5 rounded-xl text-[11px] font-bold ${generating ? 'bg-slate-200 text-slate-400' : 'bg-indigo-500 text-white hover:bg-indigo-600'}`}
          >
            {generating ? '生成中…' : (publicKey ? '🔄 重新生成密钥对' : '生成新密钥对')}
          </button>
          <button
            type="button"
            onClick={() => void handleCopyEnv()}
            disabled={generating}
            className={`py-2.5 rounded-xl text-[11px] font-bold border border-slate-200 ${generating ? 'bg-slate-100 text-slate-400' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
          >
            复制 env 清单
          </button>
        </div>

        {(publicKey || privateKey) && (
          <div className="text-center">
            <button
              type="button"
              onClick={handleClear}
              className="text-[11px] text-rose-500 hover:text-rose-600 font-medium underline-offset-2 hover:underline"
            >
              清空 VAPID（重新部署后推送订阅要重建）
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
};
