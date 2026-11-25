import React, { useState } from 'react';

interface Props {
  foreground: boolean;
  otherCallBars: number;
  resume(): void;
  children(retain: (value: boolean) => void): React.ReactNode;
}

/** Keep one call mounted across SullyOS screens only for the opted-in session. */
export function CompanionSessionSlot({ foreground, otherCallBars, resume, children }: Props) {
  const [retained, retain] = useState(false);
  if (!foreground && !retained) return null;
  return <>
    <div className="absolute inset-0" hidden={!foreground}>{children(retain)}</div>
    {!foreground && <button type="button" onClick={resume} aria-label="返回同行"
      className="absolute left-1/2 -translate-x-1/2 z-[55] rounded-full bg-emerald-800 text-white px-4 py-2 text-xs font-bold shadow"
      style={{ top: `calc(max(1.75rem, var(--chrome-top, 1.5rem)) + ${otherCallBars * 1.75}rem)` }}>
      同行中 · 点击返回
    </button>}
  </>;
}
