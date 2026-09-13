import React, { useEffect, useMemo, useRef, useState } from 'react';
import { trackEvent } from '../../utils/analytics';

// SullyOS 冷启动「世界入场」电影化序列 —— 取代传统黑屏 spinner。
// 目标：让人觉得「进入了一个小世界」，而不是「在等一个 App 加载完」。
//   · 深空大气场景 + 相机缓慢前推 + 漂浮尘埃/闪烁星点 + 核心柔光（呼吸）
//   · logo 从景深中浮现（远→近对焦），随后 tagline 与一道光线（UI 萌芽）
//   · 数据就绪 + 停留够时长后，整场景「推进穿过」并淡出，无缝交还给锁屏
// 设计取舍（呼应本项目对「动静过多反而显卡」的敏感）：
//   · 只在「本会话首次冷启动」播放完整版；同会话刷新走极短版，不反复占用用户
//   · 全程仅动 transform / opacity（GPU 友好）；数据没加载完就持续呼吸等待，绝不出现 spinner
//   · 可轻触跳过；尊重 prefers-reduced-motion
//   · 用内联 @keyframes 而非 Tailwind 自定义 animate-*（CDN 版 Tailwind 不可靠生成自定义动画类）

const BOOT_SEEN_KEY = 'sullyos_boot_seen_session';

interface Props {
  /** 数据是否已就绪（IndexedDB 加载完）。未就绪时场景持续呼吸等待，不退场。 */
  dataReady: boolean;
  /** 当前壁纸（url / data / blob / 渐变或颜色字符串 / 空）。开机场景以它为底「活过来」。 */
  wallpaper?: string;
  /** 退场动画播完后回调，交还控制权给 PhoneShell。 */
  onDone: () => void;
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  !!window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const ClassicBootSequence: React.FC<Props> = ({ dataReady, wallpaper, onDone }) => {
  // 壁纸解析：url/data/blob 走 url() 并虚化压暗；渐变/颜色字符串直接当背景；空则回退深空渐变。
  const wp = wallpaper?.trim() || '';
  const wpIsImage = /^(https?:|data:|blob:|\.?\/)/.test(wp);
  const wpBackground = wp ? (wpIsImage ? `url(${wp})` : wp) : '';
  // 本会话是否首次看到开场：刷新页面仍属同 session → 走极短版。
  const firstThisSession = useMemo(() => {
    try { return !sessionStorage.getItem(BOOT_SEEN_KEY); } catch { return true; }
  }, []);
  const reduced = useMemo(() => prefersReducedMotion(), []);
  const cinematic = firstThisSession && !reduced;

  const HOLD = cinematic ? 2000 : 520; // 退场前最短停留（也是「等数据」的下限）
  const EXIT = cinematic ? 680 : 300;  // 推进式退场时长

  const [phase, setPhase] = useState<'enter' | 'exit'>('enter');
  const startRef = useRef(0);
  if (startRef.current === 0) {
    startRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  useEffect(() => {
    try { sessionStorage.setItem(BOOT_SEEN_KEY, '1'); } catch { /* ignore */ }
  }, []);

  // 「数据就绪 且 停留够 HOLD」→ 退场；否则一直呼吸等待。
  useEffect(() => {
    if (phase === 'exit') return;
    let raf = 0;
    const tick = () => {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (dataReady && now - startRef.current >= HOLD) {
        setPhase('exit');
        // 只报区间不报精确毫秒。注意这里的时长带 HOLD 下限（完整版 2000ms / 极短版 520ms），
        // 真正有信息量的是 3-8s / 8s+ 这条尾巴 —— 数据加载慢才会落到那儿。
        const waited = now - startRef.current;
        trackEvent('冷启动等待数据就绪', {
          等待档位: waited < 1000 ? '<1s' : waited < 3000 ? '1-3s' : waited < 8000 ? '3-8s' : '8s+',
          开场版本: cinematic ? '完整版' : '极短版',
        });
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [dataReady, phase, HOLD]);

  // 退场动画播完 → 交还控制权。
  useEffect(() => {
    if (phase !== 'exit') return;
    const t = setTimeout(onDone, EXIT);
    return () => clearTimeout(t);
  }, [phase, EXIT, onDone]);

  // 轻触跳过：进入平滑退场（非硬切）。
  const skip = () => {
    if (phase !== 'exit') {
      setPhase('exit');
      trackEvent('跳过开机动画', {
        数据是否已就绪: dataReady ? '是' : '否',
        开场版本: cinematic ? '完整版' : '极短版',
      });
    }
  };

  // 漂浮尘埃（自下而上缓升）与闪烁星点（原地明灭）—— 仅完整版生成，只动 transform/opacity。
  const motes = useMemo(() =>
    cinematic ? Array.from({ length: 16 }, () => ({
      left: Math.random() * 100,
      size: 1.5 + Math.random() * 2.5,
      delay: -Math.random() * 12,
      dur: 11 + Math.random() * 9,
      sway: (Math.random() * 2 - 1) * 24,
      op: 0.25 + Math.random() * 0.45,
    })) : [], [cinematic]);
  const stars = useMemo(() =>
    cinematic ? Array.from({ length: 18 }, () => ({
      left: Math.random() * 100,
      top: Math.random() * 62,
      size: 1 + Math.random() * 1.8,
      delay: -Math.random() * 4,
      dur: 2.4 + Math.random() * 3,
      op: 0.4 + Math.random() * 0.5,
    })) : [], [cinematic]);

  const exiting = phase === 'exit';

  return (
    <div
      onClick={skip}
      aria-label="SullyOS·糯米机"
      className="fixed inset-0 z-[9999] overflow-hidden select-none cursor-pointer"
      style={{
        background: '#05060f',
        opacity: exiting ? 0 : 1,
        transition: `opacity ${EXIT}ms ease-in`,
      }}
    >
      <style>{`
        @keyframes bootSceneIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes bootCamera { from { transform: scale(1) } to { transform: scale(1.06) } }
        @keyframes bootBloom { 0%,100% { opacity:.55; transform: translate(-50%,-50%) scale(1) } 50% { opacity:.85; transform: translate(-50%,-50%) scale(1.08) } }
        @keyframes bootRise { from { transform: translateY(8vh) translateX(0) } to { transform: translateY(-112vh) translateX(var(--sway,0px)) } }
        @keyframes bootTwinkle { 0%,100% { opacity:.15 } 50% { opacity:1 } }
        @keyframes bootLogoIn { 0% { opacity:0; transform: translateY(10px) scale(1.14); filter: blur(10px) } 60% { opacity:1 } 100% { opacity:1; transform: translateY(0) scale(1); filter: blur(0) } }
        @keyframes bootSoftIn { from { opacity:0; transform: translateY(8px) } to { opacity:.8; transform: translateY(0) } }
        @keyframes bootLineIn { from { opacity:0; transform: scaleX(0) } to { opacity:.6; transform: scaleX(1) } }
        @keyframes bootHintIn { from { opacity:0 } to { opacity:.45 } }
      `}</style>

      {/* 退场推进层：退场时整体放大并随根层淡出，营造「相机穿过场景」 */}
      <div
        className="absolute inset-0"
        style={{
          transform: exiting ? 'scale(1.12)' : undefined,
          transition: exiting ? `transform ${EXIT}ms cubic-bezier(0.4,0,0.2,1)` : undefined,
          willChange: 'transform',
        }}
      >
        {/* 相机缓推层：完整版下场景缓慢前移 */}
        <div
          className="absolute inset-0"
          style={{ animation: cinematic ? 'bootCamera 6s ease-out forwards' : undefined, willChange: 'transform' }}
        >
          {/* 深空大气底（无壁纸时的回退；有壁纸时也垫底，让暗部仍有紫调景深） */}
          <div className="absolute inset-0" style={{
            animation: cinematic ? 'bootSceneIn 700ms ease-out both' : 'bootSceneIn 300ms ease-out both',
            background: 'radial-gradient(130% 120% at 50% 118%, #3a2766 0%, #1d1740 34%, #0c0b22 66%, #05060f 100%)',
          }} />
          {/* 壁纸层：以用户壁纸为底「活过来」。图片虚化压暗 + 预放大遮住虚化边；相机层再缓推。 */}
          {wpBackground && (
            <>
              <div className="absolute inset-0 bg-cover bg-center" style={{
                background: wpBackground,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                filter: wpIsImage ? 'blur(10px)' : 'none',
                transform: wpIsImage ? 'scale(1.14)' : undefined,
                animation: cinematic ? 'bootSceneIn 700ms ease-out both' : 'bootSceneIn 300ms ease-out both',
              }} />
              {/* 压暗 scrim：保证柔光/尘埃/logo 在任意壁纸上都清晰可读 */}
              <div className="absolute inset-0" style={{ background: 'rgba(6,7,18,0.5)' }} />
            </>
          )}
          {/* 星云叠加：紫 + 青双光源（screen 混合，轻轻晕染壁纸，与整套世界观统一） */}
          <div className="absolute inset-0" style={{
            mixBlendMode: 'screen',
            background: 'radial-gradient(70% 55% at 72% 22%, rgba(139,108,232,0.30), transparent 60%), radial-gradient(64% 48% at 22% 32%, rgba(64,150,210,0.20), transparent 62%)',
          }} />
          {/* 核心柔光（呼吸）—— logo 所在处的光源 */}
          <div className="absolute" style={{
            left: '50%', top: '42%', width: '120vw', height: '120vw', maxWidth: 900, maxHeight: 900,
            transform: 'translate(-50%,-50%)',
            background: 'radial-gradient(circle, rgba(168,150,255,0.45) 0%, rgba(120,110,220,0.16) 32%, transparent 60%)',
            animation: cinematic ? 'bootBloom 5.5s ease-in-out infinite' : undefined,
            opacity: cinematic ? undefined : 0.6,
          }} />

          {/* 漂浮尘埃 */}
          {motes.map((p, i) => (
            <span key={`m${i}`} className="absolute rounded-full" style={{
              left: `${p.left}%`, bottom: 0, width: p.size, height: p.size,
              ['--sway' as any]: `${p.sway}px`,
              background: 'radial-gradient(circle, rgba(214,205,255,0.95), rgba(214,205,255,0) 70%)',
              opacity: p.op,
              animation: `bootRise ${p.dur}s linear ${p.delay}s infinite`,
              willChange: 'transform',
            }} />
          ))}
          {/* 闪烁星点 */}
          {stars.map((s, i) => (
            <span key={`s${i}`} className="absolute rounded-full" style={{
              left: `${s.left}%`, top: `${s.top}%`, width: s.size, height: s.size,
              background: 'rgba(255,255,255,0.95)',
              boxShadow: '0 0 6px rgba(190,200,255,0.8)',
              opacity: s.op,
              animation: `bootTwinkle ${s.dur}s ease-in-out ${s.delay}s infinite`,
            }} />
          ))}

          {/* 暗角，聚焦中心 */}
          <div className="absolute inset-0" style={{
            background: 'radial-gradient(125% 100% at 50% 44%, transparent 52%, rgba(0,0,0,0.6) 100%)',
          }} />
        </div>

        {/* 前景：logo 自景深浮现 + 光线 + tagline（UI 从场景中生长出来） */}
        <div className="absolute inset-0 flex flex-col items-center justify-center px-8 pointer-events-none">
          <div className="text-white font-light" style={{
            fontSize: 'clamp(38px, 12vw, 64px)',
            letterSpacing: '0.04em',
            textShadow: '0 0 36px rgba(170,150,255,0.55), 0 2px 14px rgba(0,0,0,0.4)',
            animation: cinematic ? 'bootLogoIn 1400ms cubic-bezier(0.22,1,0.36,1) 250ms both' : 'bootLogoIn 600ms ease-out both',
          }}>
            Sully<span style={{ fontWeight: 500 }}>OS</span>
            <small className="block text-center text-[14px] tracking-[0.25em] mt-2">· 糯米机</small>
          </div>
          <div className="mt-3 h-px w-28" style={{
            background: 'linear-gradient(90deg, transparent, rgba(200,190,255,0.85), transparent)',
            transformOrigin: 'center',
            animation: cinematic ? 'bootLineIn 900ms ease-out 1100ms both' : 'bootLineIn 400ms ease-out 200ms both',
          }} />
          <div className="mt-3 text-[12px] text-white/85" style={{
            letterSpacing: '0.3em',
            animation: cinematic ? 'bootSoftIn 1200ms ease-out 1250ms both' : 'bootSoftIn 500ms ease-out 250ms both',
          }}>
            欢迎回家！
          </div>
        </div>
      </div>

      {/* 轻触跳过提示（仅完整版、过 1.8s 后；极淡，不打扰） */}
      {cinematic && !exiting && (
        <div className="absolute bottom-10 left-0 right-0 text-center text-[10px] tracking-[0.3em] text-white/40"
             style={{ animation: 'bootHintIn 800ms ease-out 1800ms both' }}>
          轻触进入
        </div>
      )}
    </div>
  );
};

export default ClassicBootSequence;
