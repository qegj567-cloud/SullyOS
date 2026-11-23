/**
 * 网易云登录面板
 * - 扫码登录 (/login/qr/key → /login/qr/create → /login/qr/check 轮询)
 * - 手机验证码登录 (/captcha/sent → /login/cellphone)
 * - 手动粘贴 MUSIC_U Cookie
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { useMusic, musicApi, normalizeCookie } from '../../context/MusicContext';
import { C, Sparkle, MizuHeader, BokehBg } from './MusicUI';
import { trackEvent } from '../../utils/analytics';

type Mode = 'qr' | 'phone' | 'manual';

interface Props {
  onBack: () => void;
  onLoggedIn: (cookie: string) => void;
}

const NeteaseLoginPanel: React.FC<Props> = ({ onBack, onLoggedIn }) => {
  const { addToast } = useOS();
  const { cfg } = useMusic();

  const [mode, setMode] = useState<Mode>('qr');

  /* ── 扫码 ── */
  const [qrKey, setQrKey] = useState('');
  const [qrImg, setQrImg] = useState('');
  const [qrStatus, setQrStatus] = useState<'idle' | 'waiting' | 'scanned' | 'expired' | 'done'>('idle');
  const pollRef = useRef<number | null>(null);

  const stopPoll = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const startQr = useCallback(async () => {
    stopPoll();
    setQrStatus('waiting');
    setQrImg('');
    try {
      const keyRes = await musicApi.loginQrKey(cfg);
      const key = keyRes?.data?.unikey || keyRes?.unikey;
      if (!key) throw new Error('无法获取 key');
      setQrKey(key);
      const createRes = await musicApi.loginQrCreate(cfg, key);
      const img = createRes?.data?.qrimg || createRes?.qrimg;
      if (!img) throw new Error('无法生成二维码');
      setQrImg(img);

      pollRef.current = window.setInterval(async () => {
        try {
          const r = await musicApi.loginQrCheck(cfg, key);
          const code = r?.code;
          if (code === 800) { setQrStatus('expired'); stopPoll(); }
          else if (code === 801) { setQrStatus('waiting'); }
          else if (code === 802) { setQrStatus('scanned'); }
          else if (code === 803) {
            stopPoll();
            setQrStatus('done');
            const cookie: string = r?.cookie || '';
            const m = cookie.match(/MUSIC_U=([^;]+)/i);
            const musicU = m ? m[1] : '';
            if (!musicU) {
              addToast('登录信息没拿全，请重试。', 'error');
              return;
            }
            onLoggedIn(`MUSIC_U=${musicU}`);
          }
        } catch { /* transient — 下次再试 */ }
      }, 2500);
    } catch (e: any) {
      setQrStatus('idle');
      addToast(`扫码失败：${e.message}`, 'error');
    }
  }, [cfg, addToast, onLoggedIn]);

  useEffect(() => {
    if (mode === 'qr' && qrStatus === 'idle') startQr();
    return () => { stopPoll(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  /* ── 手机号 ── */
  const [phone, setPhone] = useState('');
  const [captcha, setCaptcha] = useState('');
  const [sending, setSending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [loggingIn, setLoggingIn] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = window.setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const sendCaptcha = useCallback(async () => {
    if (!/^\d{11}$/.test(phone)) { addToast('请输入 11 位手机号', 'error'); return; }
    setSending(true);
    try {
      const r = await musicApi.captchaSent(cfg, phone);
      if (r?.code === 200 || r?.data === true) {
        addToast('验证码已发送', 'success');
        setCooldown(60);
      } else {
        addToast(r?.message || '发送失败', 'error');
      }
    } catch (e: any) {
      addToast(`发送失败：${e.message}`, 'error');
    } finally {
      setSending(false);
    }
  }, [phone, cfg, addToast]);

  const doLogin = useCallback(async () => {
    if (!phone || !captcha) { addToast('手机号和验证码都要填', 'error'); return; }
    setLoggingIn(true);
    try {
      const r = await musicApi.loginCellphone(cfg, phone, captcha);
      if (r?.code !== 200) {
        addToast(r?.message || r?.msg || '登录失败', 'error');
        return;
      }
      const cookie: string = r?.cookie || '';
      const m = cookie.match(/MUSIC_U=([^;]+)/i);
      const musicU = m ? m[1] : '';
      if (!musicU) {
        addToast('登录信息没拿全，请重试。', 'error');
        return;
      }
      trackEvent('用手机号验证码登录网易云');
      onLoggedIn(`MUSIC_U=${musicU}`);
    } catch (e: any) {
      addToast(`登录失败：${e.message}`, 'error');
    } finally {
      setLoggingIn(false);
    }
  }, [phone, captcha, cfg, addToast, onLoggedIn]);

  /* ── 手动 Cookie ── */
  const [manualCookie, setManualCookie] = useState('');
  const [showManualCookie, setShowManualCookie] = useState(false);

  const statusText: Record<string, string> = {
    idle: '准备中...', waiting: '请用网易云 App 扫描上方二维码',
    scanned: '已扫描，请在手机上确认', expired: '二维码已过期，请刷新',
    done: '登录中...',
  };

  return (
    <div className="flex flex-col h-full relative"
      style={{ background: `linear-gradient(180deg, #ffffff 0%, ${C.bg} 50%, ${C.bgDeep} 100%)` }}>
      <BokehBg />
      <MizuHeader title="登录网易云" onBack={onBack} />

      {/* Mode switcher */}
      <div className="mx-4 mt-3 flex items-center gap-1 shizuku-glass rounded-full p-1 relative z-10">
        {([
          { k: 'qr' as const, label: '扫码' },
          { k: 'phone' as const, label: '手机号' },
          { k: 'manual' as const, label: 'Cookie' },
        ]).map(t => (
          <button key={t.k} onClick={() => { setMode(t.k); setShowManualCookie(false); }}
            className="flex-1 py-1.5 rounded-full text-[11px] tracking-wider transition-all"
            style={{
              background: mode === t.k ? `linear-gradient(135deg, ${C.primary}, ${C.accent})` : 'transparent',
              color: mode === t.k ? 'white' : C.muted,
            }}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 relative z-10 shizuku-scrollbar">
        {/* ── 扫码 ── */}
        {mode === 'qr' && (
          <div className="flex flex-col items-center">
            <div className="relative rounded-3xl p-4 shizuku-glass-strong"
              style={{ boxShadow: `0 8px 40px ${C.glow}20` }}>
              {qrImg ? (
                <img src={qrImg} alt="qr" className="w-48 h-48 rounded-xl" />
              ) : (
                <div className="w-48 h-48 rounded-xl flex items-center justify-center"
                  style={{ background: C.glass }}>
                  <span className="w-5 h-5 border-2 rounded-full animate-spin"
                    style={{ borderColor: `${C.faint}40`, borderTopColor: C.primary }} />
                </div>
              )}
              <div className="absolute -top-1 -right-1"><Sparkle size={12} color={C.glow} delay={0} /></div>
              <div className="absolute -bottom-1 -left-1"><Sparkle size={10} color={C.sakura} delay={0.7} /></div>
            </div>
            <div className="mt-4 text-center">
              <div className="text-[11px] tracking-wide" style={{ color: C.primary }}>
                {statusText[qrStatus]}
              </div>
              {qrStatus === 'expired' && (
                <button onClick={startQr}
                  className="mt-3 px-4 py-1.5 rounded-full text-[10px] text-white"
                  style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})` }}>
                  刷新二维码
                </button>
              )}
              <div className="text-[9px] mt-2 italic max-w-[220px] mx-auto" style={{ color: C.faint }}>
                打开网易云 App → 我的 → 右上角扫一扫
              </div>
            </div>
          </div>
        )}

        {/* ── 手机号 ── */}
        {mode === 'phone' && (
          <div className="space-y-3 max-w-[320px] mx-auto">
            <div className="rounded-2xl p-3 shizuku-glass">
              <div className="text-[10px] mb-1.5 tracking-wider" style={{ color: C.muted }}>手机号 (仅中国)</div>
              <input
                className="w-full rounded-xl px-3 py-2 outline-none text-sm shizuku-glass"
                style={{ color: C.text }}
                placeholder="13800138000"
                value={phone} onChange={e => setPhone(e.target.value.replace(/\D/g, '').slice(0, 11))}
                inputMode="numeric"
              />
            </div>
            <div className="rounded-2xl p-3 shizuku-glass">
              <div className="text-[10px] mb-1.5 tracking-wider flex justify-between" style={{ color: C.muted }}>
                <span>验证码</span>
                <button
                  onClick={sendCaptcha}
                  disabled={sending || cooldown > 0}
                  className="text-[10px] disabled:opacity-40"
                  style={{ color: C.accent }}
                >
                  {sending ? '发送中...' : cooldown > 0 ? `${cooldown}s 后重发` : '获取验证码'}
                </button>
              </div>
              <input
                className="w-full rounded-xl px-3 py-2 outline-none text-sm shizuku-glass tracking-widest"
                style={{ color: C.text }}
                placeholder="6 位验证码"
                value={captcha} onChange={e => setCaptcha(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
              />
            </div>
            <button
              onClick={doLogin}
              disabled={loggingIn}
              className="w-full py-3 rounded-2xl text-sm text-white tracking-wider relative overflow-hidden disabled:opacity-60"
              style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})`, boxShadow: `0 3px 18px ${C.glow}30` }}
            >
              <span className="relative z-10">{loggingIn ? '登录中...' : '登录'}</span>
            </button>
            <div className="text-[9px] text-center italic" style={{ color: C.faint }}>
              账号密码登录走同一个接口，把密码填在验证码位置也可以（少数老账号）
            </div>
          </div>
        )}

        {/* ── 手动 Cookie ── */}
        {mode === 'manual' && (
          <div className="space-y-3 max-w-[320px] mx-auto">
            <div className="rounded-2xl p-3 shizuku-glass">
              <div className="flex items-center justify-between mb-1.5">
                <div className="text-[10px] tracking-wider" style={{ color: C.muted }}>MUSIC_U Cookie</div>
                {manualCookie ? (
                  <button type="button" onClick={() => setShowManualCookie(v => !v)} className="text-[10px] underline" style={{ color: C.primary }}>
                    {showManualCookie ? '隐藏' : '显示'}
                  </button>
                ) : null}
              </div>
              <input
                type={showManualCookie ? 'text' : 'password'}
                name="netease-music-cookie"
                autoComplete="new-password"
                spellCheck={false}
                className="w-full rounded-xl px-3 py-2.5 outline-none text-[10px] shizuku-glass"
                style={{ color: C.text, fontFamily: 'monospace' }}
                placeholder="MUSIC_U=xxx... 或直接粘贴 cookie 值"
                value={manualCookie}
                onChange={e => {
                  const next = e.target.value;
                  setManualCookie(next);
                  if (!next) setShowManualCookie(false);
                }}
              />
              <div className="text-[9px] mt-1.5 italic" style={{ color: C.faint }}>
                music.163.com 登录 → F12 → Application → Cookies → 复制 MUSIC_U
              </div>
            </div>
            <button
              onClick={() => {
                const final = normalizeCookie(manualCookie);
                if (!final) return;
                trackEvent('手动粘贴 Cookie 登录网易云');
                onLoggedIn(final);
              }}
              className="w-full py-3 rounded-2xl text-sm text-white"
              style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})`, boxShadow: `0 3px 18px ${C.glow}30` }}
            >
              保存并登录
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default NeteaseLoginPanel;
