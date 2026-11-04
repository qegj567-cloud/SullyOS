export type PhotoLook={preset:'natural'|'neon'|'dream'|'afterglow'|'watercolor'|'daylight';glow:number;fringe:number;vignette:number;exposure:number};
export const photoLooks:Record<PhotoLook['preset'],PhotoLook>={
 natural:{preset:'natural',glow:0,fringe:0,vignette:0,exposure:1},
 neon:{preset:'neon',glow:.42,fringe:.28,vignette:.35,exposure:1},
 dream:{preset:'dream',glow:.62,fringe:.16,vignette:.18,exposure:1.12},
 afterglow:{preset:'afterglow',glow:.3,fringe:.38,vignette:.6,exposure:.82},
 watercolor:{preset:'watercolor',glow:.15,fringe:0,vignette:.1,exposure:1.06},
 daylight:{preset:'daylight',glow:.55,fringe:.60,vignette:.12,exposure:1.02},
};
export function paintPhoto(source:HTMLCanvasElement,out:HTMLCanvasElement,look:PhotoLook){
 if(out.width!==source.width||out.height!==source.height){out.width=source.width;out.height=source.height;}
 const ctx=out.getContext('2d')!;const w=out.width,h=out.height;
 ctx.save();ctx.clearRect(0,0,w,h);
 ctx.filter=`brightness(${look.exposure*(look.preset==='neon'?.82:1)}) saturate(${look.preset==='natural'?1:['watercolor','daylight'].includes(look.preset)?1.08:1.45}) contrast(${look.preset==='natural'?1:['watercolor','daylight'].includes(look.preset)?1.03:1.2})`;
 ctx.drawImage(source,0,0);ctx.filter='none';
 const illustrated=look.preset==='watercolor'||look.preset==='daylight';
 if(illustrated){
  const pixels=ctx.getImageData(0,0,w,h),d=pixels.data;
  for(let i=0;i<d.length;i+=4){const r=d[i],g=d[i+1],b=d[i+2],l=(r*.2126+g*.7152+b*.0722)/255,shade=1-l;
   if(look.preset==='watercolor'){
    // Warm paper whites, restrained saturation, lifted green-grey shadows.
    const grey=l*255;d[i]=r*.86+grey*.14+9;d[i+1]=g*.9+grey*.1+8;d[i+2]=b*.85+grey*.15+shade*8-4;
   }else{
    // Clear cool shadows and warm luminous highlights; retain the actual scene.
    d[i]=r+Math.pow(l,2)*14-shade*7;d[i+1]=g+shade*5+l*5;d[i+2]=b+shade*17-l*7;
   }
  }
  ctx.putImageData(pixels,0,0);
 }
 if(look.preset!=='natural'&&!illustrated){
  const g=ctx.createLinearGradient(0,0,w,h);g.addColorStop(0,look.preset==='dream'?'#fb86c5':'#ad36e4');g.addColorStop(1,'#28cce9');ctx.globalCompositeOperation='soft-light';ctx.globalAlpha=.46;ctx.fillStyle=g;ctx.fillRect(0,0,w,h);
 }
 if(look.glow>0){
  // Extract coloured highlights too: luminance alone discards bright blue/pink.
  // Work at reduced resolution; the extracted light is blurred anyway.
  const light=document.createElement('canvas'),scale=Math.min(1,640/Math.max(w,h));
  light.width=Math.max(1,Math.round(w*scale));light.height=Math.max(1,Math.round(h*scale));
  const l=light.getContext('2d')!;l.drawImage(out,0,0,light.width,light.height);
  const pixels=l.getImageData(0,0,light.width,light.height),d=pixels.data;
  for(let i=0;i<d.length;i+=4){const peak=Math.max(d[i],d[i+1],d[i+2])/255;const t=Math.max(0,Math.min(1,(peak-.5)/.4));const gain=t*t*(3-2*t);d[i]*=gain;d[i+1]*=gain;d[i+2]*=gain;}
  l.putImageData(pixels,0,0);ctx.globalCompositeOperation='screen';
  for(const [radius,weight] of [[.004,.55],[.016,.4],[.04,.25]]){ctx.globalAlpha=Math.min(1,look.glow*weight);ctx.filter=`blur(${Math.max(w,h)*radius}px)`;ctx.drawImage(light,0,0,w,h);}
  ctx.filter='none';
 }
 if(look.preset!=='natural'&&!illustrated){
  ctx.globalCompositeOperation='screen';ctx.globalAlpha=.25+Math.min(1,look.glow)*.4;
  for(const [x,y,color] of [[0,h*.3,'#c12aff'],[w,h*.65,'#08ccec']] as const){const g=ctx.createRadialGradient(x,y,0,x,y,w*.8);g.addColorStop(0,color);g.addColorStop(1,'transparent');ctx.fillStyle=g;ctx.fillRect(0,0,w,h);}
 }
 if(look.fringe>0){
  // Screen-space colour fringing, baked into the same canvas used for export.
  const layer=document.createElement('canvas');layer.width=w;layer.height=h;const c=layer.getContext('2d')!;
  for(const [color,sign] of [['#ff398b',-1],['#23ddff',1]] as const){c.clearRect(0,0,w,h);c.globalCompositeOperation='source-over';c.drawImage(source,sign*look.fringe*w*.008,0);c.globalCompositeOperation='multiply';c.fillStyle=color;c.fillRect(0,0,w,h);ctx.globalCompositeOperation='screen';ctx.globalAlpha=look.fringe*.3;ctx.drawImage(layer,0,0);}
 }
 ctx.globalCompositeOperation='source-over';ctx.globalAlpha=1;
 if(look.vignette>0){const v=ctx.createRadialGradient(w/2,h*.45,Math.min(w,h)*.18,w/2,h*.45,Math.max(w,h)*.67);v.addColorStop(0,'transparent');v.addColorStop(1,`rgba(12,4,29,${look.vignette})`);ctx.fillStyle=v;ctx.fillRect(0,0,w,h);}
 ctx.restore();
}
