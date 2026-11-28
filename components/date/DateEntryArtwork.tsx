import React, { useId } from 'react';

export type DateEntryChoice = 'approach' | 'invite' | 'direct';

export const DATE_ENTRY_CHOICES: { id: DateEntryChoice; label: string; detail: string }[] = [
    { id: 'approach', label: '靠近 TA', detail: '走进 TA 的此刻' },
    { id: 'invite', label: '让 TA 靠近', detail: '等 TA 来到身边' },
    { id: 'direct', label: '直接见面', detail: '从这一刻开始' },
];

const outline = 'M17 3H103Q106 15 117 18V207C104 210 104 222 117 225V262Q106 265 103 277H17Q14 265 3 262V225C16 222 16 210 3 207V18Q14 15 17 3Z';
const inset = 'M20 7H100Q104 19 113 22V204C100 209 100 224 113 229V258Q103 262 100 273H20Q17 262 7 258V229C20 224 20 209 7 204V22Q16 19 20 7Z';

/** All ticket material, notches and decorative strokes are native SVG, not a screenshot. */
export function DateTicketFrame() {
    const id = useId().replace(/:/g, '');
    return <svg className="date-ticket__frame" viewBox="0 0 120 280" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <defs>
            <linearGradient id={`${id}-night`} x1="0" y1="0" x2=".8" y2="1">
                <stop stopColor="#344e58" stopOpacity=".78" /><stop offset=".48" stopColor="#17343e" stopOpacity=".88" /><stop offset="1" stopColor="#655d55" stopOpacity=".7" />
            </linearGradient>
            <linearGradient id={`${id}-paper`} x1=".1" y1="0" x2=".85" y2="1">
                <stop stopColor="#f5ebe2" stopOpacity=".66" /><stop offset=".45" stopColor="#ffe7c9" stopOpacity=".85" /><stop offset="1" stopColor="#ead3bd" stopOpacity=".7" />
            </linearGradient>
            <linearGradient id={`${id}-edge`} x1="0" y1="0" x2="1" y2="1">
                <stop stopColor="#fff5df" /><stop offset=".45" stopColor="#ad967f" /><stop offset=".75" stopColor="#e9bd99" /><stop offset="1" stopColor="#fbecda" />
            </linearGradient>
            <linearGradient id={`${id}-sheen`}><stop stopColor="#fff8e5" stopOpacity="0" /><stop offset=".5" stopColor="#fff8e5" stopOpacity=".35" /><stop offset="1" stopColor="#fff8e5" stopOpacity="0" /></linearGradient>
            <clipPath id={`${id}-clip`}><path d={outline} /></clipPath>
            <pattern id={`${id}-grain`} width="13" height="17" patternUnits="userSpaceOnUse"><circle cx="2" cy="4" r=".3" fill="#fff1d8" /><circle cx="10" cy="13" r=".4" fill="#fff1d8" /></pattern>
        </defs>
        <path d={outline} fill={`url(#${id}-night)`} />
        <path className="date-ticket__paper" d={outline} fill={`url(#${id}-paper)`} />
        <g clipPath={`url(#${id}-clip)`}>
            <rect width="120" height="280" fill={`url(#${id}-grain)`} opacity=".12" />
            <rect className="date-ticket__sheen" x="-100" y="0" width="90" height="280" fill={`url(#${id}-sheen)`} />
        </g>
        <path d={outline} fill="none" stroke={`url(#${id}-edge)`} strokeWidth=".9" />
        <path className="date-ticket__inner-edge" d={inset} fill="none" stroke="#e8d4b9" strokeOpacity=".7" strokeWidth=".42" />
        <path className="date-ticket__perforation" d="M18 218H102" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeDasharray=".1 3.7" opacity=".65" />
    </svg>;
}

export function DateTicketIcon({ choice }: { choice: DateEntryChoice }) {
    return <svg className="date-ticket__icon" viewBox="0 0 100 100" fill="none" stroke="currentColor" strokeWidth=".9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        {choice === 'approach' ? <>
            <path d="M72 27C44 12 18 35 22 57C24 77 54 81 70 63" opacity=".45" />
            <path d="M26 78C43 65 62 49 78 20M43 64L39 48M54 54L55 35M65 41L79 37M56 53L73 50M37 70L27 57" strokeWidth="1.2" />
            <path d="M39 50Q31 44 34 35Q42 39 39 50ZM55 39Q49 28 55 22Q60 32 55 39ZM73 28Q70 16 80 10Q81 20 73 28ZM69 39Q77 29 84 32Q83 39 69 39ZM60 52Q70 44 78 47Q74 54 60 52ZM32 63Q24 60 23 51Q31 54 32 63Z" fill="currentColor" fillOpacity=".45" />
        </> : choice === 'invite' ? <>
            <path d="M75 37C64 16 31 19 23 45M21 46C40 32 66 37 82 52M21 46Q32 37 40 48Q50 40 58 51Q71 44 82 52C79 34 61 22 46 26M46 26Q32 32 40 48M46 26Q58 33 58 51M53 44L45 77Q41 88 36 80" />
            <path d="M42 16l3-5M54 16l2-5M64 21l3-5M74 25l3-5M65 10l2-4M54 5l2-3M79 16l2-4M33 65l2-4M70 64l2-5" opacity=".8" />
            <path d="M30 75C14 57 19 30 41 19" opacity=".35" />
        </> : <>
            <path d="M28 58C15 35 38 15 57 18C79 21 81 43 69 51" opacity=".7" />
            <ellipse cx="52" cy="68" rx="30" ry="7" opacity=".45" /><ellipse cx="52" cy="67" rx="20" ry="4" opacity=".8" />
            <path d="M52 48C53 59 55 61 64 62C55 63 53 65 52 76C51 65 49 63 40 62C49 61 51 59 52 48Z" fill="currentColor" stroke="none" />
        </>}
    </svg>;
}

export function DateFlourish({ footer = false }: { footer?: boolean }) {
    return footer ? <svg className="date-entry__footer-art" viewBox="0 0 390 85" fill="none" aria-hidden="true" focusable="false">
        <path d="M-12 60C104-17 178 92 305 47C350 32 375 20 405-5" stroke="currentColor" strokeWidth=".5" />
        <path d="M309 46Q318 36 326 20M316 38Q312 29 319 23Q322 32 316 38ZM323 27Q322 17 331 12Q332 22 323 27Z" stroke="currentColor" strokeWidth=".5" fill="currentColor" fillOpacity=".6" />
    </svg> : <svg className="date-entry__flourish" viewBox="0 0 200 30" fill="none" aria-hidden="true" focusable="false"><path d="M4 25C73-20 139 47 196 4" stroke="currentColor" strokeWidth=".7" /></svg>;
}
