import React, { useId } from 'react';

export function AmsgIcon({ name, className = '' }: { name: 'message' | 'layers' | 'chevron' | 'bell' | 'device' | 'signal' | 'link' | 'settings' | 'info' | 'clock' | 'send'; className?: string }) {
  const paths = {
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5" /></>,
    chevron: <path d="m9 5 7 7-7 7" />,
    message: <><path d="M5 3h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M8 10h.01M12 10h.01M16 10h.01" strokeWidth="3" /></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4M12 2V1" /></>,
    device: <><rect x="5" y="2" width="14" height="20" rx="2" /><path d="M10 5h4M12 19h.01" /></>,
    signal: <><path d="M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14M8 8a6 6 0 0 0 0 8M16 8a6 6 0 0 1 0 8M12 14v8" /><circle cx="12" cy="11" r="2" /></>,
    link: <><path d="m10 14 4-4M9 16l-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M15 8l2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(0 -1)" /></>,
    settings: <><path d="M3 7h5M13 7h8M3 17h10M18 17h3" /><circle cx="10" cy="7" r="3" /><circle cx="16" cy="17" r="3" /></>,
    info: <><circle cx="12" cy="12" r="10" /><path d="M12 11v6M12 7h.01" /></>,
    clock: <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 3" /></>,
    send: <><path d="m13 3 8 0 0 8M21 3 10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" /></>,
  };
  return <svg className={`amsg-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

/** Lightweight vector illustration; no image download or generated text baked into the UI. */
export function AmsgNotificationArt() {
  const id = useId().replace(/:/g, '');
  return <svg className="amsg-notification-art" viewBox="0 0 220 160" fill="none" aria-hidden="true">
    <defs><linearGradient id={`${id}-paper`} x1="65" y1="62" x2="152" y2="127" gradientUnits="userSpaceOnUse"><stop stopColor="#e9dbff" /><stop offset="1" stopColor="#c8a5ee" stopOpacity=".5" /></linearGradient><linearGradient id={`${id}-bell`} x1="132" y1="26" x2="159" y2="80"><stop stopColor="#f2e9ff" /><stop offset="1" stopColor="#d9c0f7" /></linearGradient></defs>
    <ellipse cx="112" cy="96" rx="103" ry="27" transform="rotate(-14 112 96)" stroke="#cfb4f6" strokeWidth="1.8" />
    <g transform="rotate(-10 111 93)"><rect x="60" y="61" width="104" height="70" rx="8" fill={`url(#${id}-paper)`} stroke="#b18bdc" strokeWidth="2" /><path d="m63 65 42 36a10 10 0 0 0 13 0l43-36M63 128l35-32m63 32-34-32" stroke="#bba0df" strokeWidth="2" /></g>
    <path d="M140 37c-1-10 7-15 8-6 14 0 21 10 21 25 0 10 5 14 8 17 3 5-7 7-19 7s-26 1-26-5 8-10 8-20V37Z" fill={`url(#${id}-bell)`} stroke="#a474d7" strokeWidth="2.5" strokeLinejoin="round" /><path d="M151 81c1 7 10 7 11 0" stroke="#a474d7" strokeWidth="2.5" />
    <g fill="#b68ce6"><path d="m33 45 2 7 6 2-6 2-2 7-2-7-6-2 6-2Z" /><path d="m182 15 2 7 6 2-6 2-2 7-2-7-6-2 6-2Z" /><path d="m192 120 2 6 5 2-5 2-2 6-2-6-5-2 5-2Z" /></g>
  </svg>;
}
