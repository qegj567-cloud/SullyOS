// Ported verbatim from character_creator.html; parity tests guard palette and pixel rules.
export interface CreatorHairTint { hueIdx:number; sat:number; light:number; color?:string; gradientColor?:string }
export const HUE_PALETTE = [
  /* 第一排：自然色 */
  { name: "墨黑",   hex: "#2B1810", h: 18,  fixedL: 14, fixedS: 30 },
  { name: "深棕",   hex: "#5C3A1E", h: 28,  fixedL: 25, fixedS: 50 },
  { name: "栗棕",   hex: "#8B5A2B", h: 28,  fixedL: 36, fixedS: 55 },
  { name: "亚麻",   hex: "#C9A878", h: 35,  fixedL: 63, fixedS: 40 },
  { name: "蜂蜜金", hex: "#E8C97A", h: 42,  fixedL: 70, fixedS: 65 },
  { name: "奶茶",   hex: "#D9B894", h: 30,  fixedL: 72, fixedS: 35 },
  { name: "奶白银", hex: "#E8E0D8", h: 35,  fixedL: 88, fixedS: 15 },
  { name: "灰",     hex: "#9B9B9B", h: 0,   fixedL: 60, fixedS: 0 },
  { name: "焦糖橙", hex: "#D67A3C", h: 22 },
  /* 第二排：鲜艳色 */
  { name: "珊瑚红", hex: "#FF6B7A", h: 354 },
  { name: "玫红",   hex: "#E04578", h: 338 },
  { name: "樱花粉", hex: "#F58AD4", h: 318 },
  { name: "薰衣紫", hex: "#B083F0", h: 264 },
  { name: "蓝紫",   hex: "#7C8FF0", h: 230 },
  { name: "天空蓝", hex: "#6EC4F4", h: 200 },
  { name: "薄荷绿", hex: "#6FD9B8", h: 158 },
  { name: "嫩绿",   hex: "#A8D86B", h: 88 },
  { name: "明黄",   hex: "#FFE070", h: 48 },
];

export function hslToRgb(h:number, s:number, l:number) {
  s /= 100; l /= 100;
  const k = (n:number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n:number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

export function colorHsl(hex:string) {
  const [r,g,b]=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255),max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min,l=(max+min)/2;
  return {h:delta===0?0:60*(max===r?(g-b)/delta+(g<b?6:0):max===g?(b-r)/delta+2:(r-g)/delta+4),s:delta===0?0:delta/(1-Math.abs(2*l-1))*100,lightOffset:l*100-50};
}

export function resolveTint(c:CreatorHairTint):{h:number;s:number;lightOffset:number;color?:string;gradientColor?:string} {
  if (/^#[\da-f]{6}$/i.test(c.color||''))return {...colorHsl(c.color!),color:c.color,gradientColor:/^#[\da-f]{6}$/i.test(c.gradientColor||'')?c.gradientColor:undefined};
  const hue = HUE_PALETTE[c.hueIdx];
  if (hue.fixedL !== undefined) {
    const satOffset = (c.sat - 50) * 0.4;
    const finalS = Math.max(0, Math.min(100, hue.fixedS! + satOffset));
    const lightOffset = (hue.fixedL - 50) + c.light * 0.8;
    return { h: hue.h, s: finalS, lightOffset };
  }
  return { h: hue.h, s: c.sat, lightOffset: c.light };
}

export function hexForTint(c:CreatorHairTint) {
  if (/^#[\da-f]{6}$/i.test(c.color||'')) return c.color!;
  const hue = HUE_PALETTE[c.hueIdx];
  let h, s, l;
  if (hue.fixedL !== undefined) {
    const satOffset = (c.sat - 50) * 0.4;
    s = Math.max(0, Math.min(100, hue.fixedS! + satOffset));
    l = Math.max(5, Math.min(95, hue.fixedL + c.light * 0.8));
    h = hue.h;
  } else {
    h = hue.h; s = c.sat; l = Math.max(10, Math.min(90, 50 + c.light));
  }
  const rgb = hslToRgb(h, s, l);
  return `#${rgb.map(v => v.toString(16).padStart(2, "0")).join("")}`;
}

export function tintCreatorHairPixels(px:Uint8ClampedArray, width:number, height:number, tint:ReturnType<typeof resolveTint> & {skin?:boolean}, preserveLineart=25) {
  const TH = preserveLineart, SOFT = 10;
  let reference=50;
  if(tint.skin&&tint.color){let sum=0,n=0;for(let i=0;i<px.length;i+=4){const gray=.299*px[i]+.587*px[i+1]+.114*px[i+2];if(px[i+3]>180&&gray>TH+SOFT){sum+=gray;n++;}}if(n)reference=sum/n/255*100;}
  const rows=[];
  if(tint.gradientColor){const a=[1,3,5].map(i=>parseInt(tint.color!.slice(i,i+2),16)),b=[1,3,5].map(i=>parseInt(tint.gradientColor!.slice(i,i+2),16));for(let y=0;y<height;y++){const t=Math.max(0,Math.min(1,(y/Math.max(1,height-1)-.1)/.6));rows[y]=colorHsl('#'+a.map((v,i)=>Math.round(v+(b[i]-v)*t).toString(16).padStart(2,'0')).join(''));}}
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    if (TH > 0 && gray <= TH) {
      px[i] = 0; px[i + 1] = 0; px[i + 2] = 0;
      continue;
    }
    const dye=rows[Math.floor(i/4/width)]||tint;
    const newL = Math.max(5, Math.min(95, gray / 255 * 100 + dye.lightOffset + 50-reference));
    const newRgb = hslToRgb(dye.h, dye.s, newL);
    if (TH > 0 && gray <= TH + SOFT) {
      const t = (gray - TH) / SOFT;
      px[i]     = Math.round(newRgb[0] * t);
      px[i + 1] = Math.round(newRgb[1] * t);
      px[i + 2] = Math.round(newRgb[2] * t);
    } else {
      px[i] = newRgb[0]; px[i + 1] = newRgb[1]; px[i + 2] = newRgb[2];
    }
  }

}