/** Authored coverage from the accepted current-body try-on, in base body space.
 * Per-piece coverage means taking one item off restores its skin independently.
 */
export function halloweenCoverage(part:string,outfit:string,x:number,y:number){
 if(part==='socks')return y<({pumpkin:1.37,ghost:1.49,apprentice:1.26,witch:1.19}[outfit]??.90);
 if(part==='boots')return y<.54;
 if(part==='shoes')return y<.225;
 if(part==='hooded-top')return x<.46&&y>2.26&&y<3.04||x>.37&&x<1.49&&y>2.88&&y<3.30;
 if(part==='romper')return x<.47&&y>1.90&&y<3.0;
 if(part==='sleeves')return x>.38&&x<1.49&&y>2.76&&y<3.40;
 if(['dress','coat','tailcoat'].includes(part))return outfit==='witch'&&x>.24&&x<1.49&&y>2.76&&y<3.38||x<.44&&y>2.28&&y<3.03||x>.28&&x<1.49&&y>2.76&&y<3.40;
 if(part==='shorts')return x<.49&&y>1.64&&y<2.20;
 if(part==='trousers')return x<.49&&y>.58&&y<2.20;
 if(part==='waistcoat')return x<.40&&y>2.28&&y<3.00;
 return false;
}
