import React from 'react';

type BibiIconProps = React.SVGProps<SVGSVGElement> & {
  size?: number | string;
  variant?: 'mascot' | 'island' | 'line';
};

/** 哔哔的小话痨：所有入口共用同一个轮廓，不依赖字体或外部图片。 */
export default function BibiIcon({size = '1em', variant = 'mascot', ...props}: BibiIconProps) {
  // 默认桌面与 Phosphor regular 一致：单色、透明底、2/24 的线宽。
  if (variant === 'line') return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false" {...props}>
    <g stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12C3 6 6 3 10 4C12 1 16 3 16 5C20 6 21 12 19 16C18 20 5 21 3 16Z"/>
      <path d="M7.5 9v.5M14.5 8.5V9M21 3l1-1M22 7h1M7 20l-1 2M15 20l1 2"/>
      <path d="M7 13C7 11 15 11 15 13C15 18 7 18 7 13Z"/>
    </g>
  </svg>;
  const island = variant === 'island';
  return <svg width={size} height={size} viewBox="0 0 100 100" fill="none" aria-hidden="true" focusable="false" {...props}>
    <g stroke={island ? 'none' : '#584B38'} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M33 74 29 85Q35 89 41 84L43 76M57 76 59 86Q66 89 70 83L66 73" fill="#F4CD76"/>
      <path d="M24 49Q14 42 12 48Q10 55 23 61M72 48Q79 36 84 41Q89 47 76 58" fill="#FFF5D6"/>
      <path d="M22 48C21 30 30 19 44 21C49 13 61 17 63 25C78 28 81 47 77 62C75 76 65 81 48 80C31 80 20 73 22 48Z" fill="#FFF5D6"/>
    </g>
    <path d="M36 37 36 41M59 35 60 39" stroke="#584B38" strokeWidth="5" strokeLinecap="round"/>
    <path d="M33 53C33 45 41 44 49 44C58 44 66 47 65 57C64 69 59 74 49 73C39 72 33 64 33 53Z" fill="#584B38"/>
    <path d="M45 45 45 50Q49 52 52 49L52 45" fill="#FFFDF4"/>
    <path d="M40 65Q49 57 60 65Q57 70 49 70Q44 70 40 65Z" fill="#E99480"/>
    <path d="M84 26 89 21M87 33 94 32" stroke="#584B38" strokeWidth="3.5" strokeLinecap="round"/>
  </svg>;
}
