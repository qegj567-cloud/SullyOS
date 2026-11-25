import { useEffect, useState } from 'react';

export function useCompanionWakeLock(enabled: boolean) {
  const [status, setStatus] = useState('');
  const supported = typeof navigator.wakeLock?.request === 'function';

  useEffect(() => {
    if (!enabled || !supported) { setStatus(''); return; }
    let generation = 0;
    let held: WakeLockSentinel | undefined;
    const release = () => {
      generation++;
      const lock = held;
      held = undefined;
      if (lock && !lock.released) void lock.release().catch(() => {});
    };
    const sync = async () => {
      release();
      if (document.hidden) { setStatus('回到网页后恢复亮屏'); return; }
      const request = generation;
      setStatus('正在申请保持亮屏');
      try {
        const lock = await navigator.wakeLock.request('screen');
        if (request !== generation) { await lock.release(); return; }
        held = lock;
        const lost = () => {
          if (held === lock) { held = undefined; setStatus('系统已释放亮屏，可关闭后重新开启'); }
        };
        lock.addEventListener('release', lost, { once: true });
        if (lock.released) lost(); else setStatus('屏幕正保持常亮');
      } catch {
        if (request === generation) setStatus('系统未允许亮屏，可关闭后重新开启');
      }
    };
    void sync();
    document.addEventListener('visibilitychange', sync);
    return () => { document.removeEventListener('visibilitychange', sync); release(); };
  }, [enabled, supported]);

  return { supported, hint: supported ? status || '网页在前台时，防止屏幕自动熄灭' : '当前浏览器不支持保持亮屏' };
}
