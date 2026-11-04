import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { FishingCatch, FishingWeather } from '../../utils/vrWorld/fishingMarket';
import { speciesById } from '../../utils/vrWorld/fishingMarket';
import { createSimpleFishingGame, castSimpleFishingGame, simpleFishingShadow, createFishingGame, fishingArcWidth, stepFishingGame, type FishingPhase } from '../../utils/vrWorld/fishingGame';
import { FishArt } from './FishArt';

const SIMPLE_MODE_KEY='vr_fishing_simple_mode';
export const FishingGame: React.FC<{
    weather: FishingWeather; onCast: () => FishingCatch; onCaught: (caught: FishingCatch) => Promise<void>; onOpenCollection?:()=>void;
}> = ({ weather, onCast, onCaught, onOpenCollection }) => {
    const canvas=useRef<HTMLCanvasElement>(null),frame=useRef(createFishingGame()),pending=useRef<FishingCatch|null>(null);
    const callback=useRef(onCaught);callback.current=onCaught;
    const notified=useRef(false),savingRef=useRef(false),manualClock=useRef(false);
    const [phase,setPhase]=useState<FishingPhase>('idle');
    const [simple,setSimple]=useState(()=>{try{return localStorage.getItem(SIMPLE_MODE_KEY)==='true';}catch{return false;}});
    const simpleRef=useRef(simple);simpleRef.current=simple;
    const initialMode=useRef(false);if(!initialMode.current){initialMode.current=true;if(simple)frame.current=createSimpleFishingGame();}
    const [saving,setSaving]=useState(false),[error,setError]=useState('');
    const deliver=useCallback(async()=>{
        if(!pending.current||notified.current||savingRef.current)return;
        notified.current=true;savingRef.current=true;setSaving(true);setError('');
        try{await callback.current(pending.current);}
        catch(e){setError(e instanceof Error?e.message:'存档失败，请重试收鱼');}
        finally{savingRef.current=false;setSaving(false);}
    },[]);
    const draw=useCallback(()=>{
        const c=canvas.current,ctx=c?.getContext('2d');if(!c||!ctx)return;
        const dpr=Math.min(window.devicePixelRatio||1,2),w=c.width/dpr,h=c.height/dpr;
        ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
        const s=frame.current,cx=w/2,cy=h*.48,r=Math.min(w*.28,h*.3,130);
        const bg=ctx.createLinearGradient(0,0,w*.25,h);
        bg.addColorStop(0,weather.kind==='storm'?'#405661':'#507e81');bg.addColorStop(.45,'#28585f');bg.addColorStop(1,'#102e39');
        ctx.fillStyle=bg;ctx.fillRect(0,0,w,h);
        const light=ctx.createRadialGradient(w*.16,0,0,w*.16,0,h*.95);light.addColorStop(0,'#d6e8c42b');light.addColorStop(1,'#d6e8c400');ctx.fillStyle=light;ctx.fillRect(0,0,w,h);
        for(let i=0;i<17;i++){
            ctx.strokeStyle=i%3===0?'#e5f5da16':'#c6ede90b';ctx.lineWidth=i%3===0?2:1;ctx.beginPath();
            for(let x=0;x<=w;x+=7){const y=i*h/16+Math.sin(x*.015+i+s.elapsed*.4)*7;x===0?ctx.moveTo(x,y):ctx.lineTo(x,y);}ctx.stroke();
        }
        if(['rain','storm','snow'].includes(weather.kind)){
            ctx.strokeStyle='#e2f2e52a';for(let i=0;i<20;i++){const x=(i*91+19)%w,y=(i*67+s.elapsed*30)%h;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x-2,y+(weather.kind==='snow'?2:9));ctx.stroke();}
        }
        ctx.save();ctx.translate(cx,cy);
        if(!simpleRef.current&&(s.phase==='hooked'||s.phase==='waiting')){
            ctx.strokeStyle='#d8eee926';ctx.lineWidth=1;ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.stroke();
            if(s.phase==='hooked'){
                ctx.strokeStyle='#afead5';ctx.lineWidth=10;ctx.lineCap='round';ctx.beginPath();ctx.arc(0,0,r,s.playerAngle-fishingArcWidth(s),s.playerAngle+fishingArcWidth(s));ctx.stroke();
                ctx.save();ctx.translate(Math.cos(s.fishAngle)*r,Math.sin(s.fishAngle)*r);ctx.rotate(s.fishAngle+Math.PI/2);ctx.fillStyle='#fff6de';ctx.beginPath();ctx.ellipse(0,0,10,4.5,0,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.moveTo(-7,0);ctx.lineTo(-14,-6);ctx.lineTo(-14,6);ctx.closePath();ctx.fill();ctx.restore();
                ctx.strokeStyle='#e9d6ad';ctx.lineWidth=2;ctx.beginPath();ctx.arc(0,0,32,-Math.PI/2,-Math.PI/2+s.progress*Math.PI*2);ctx.stroke();
                ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle='#eef7f4';ctx.font='500 19px Georgia,serif';ctx.fillText(Math.round(s.progress*100)+'%',0,0);
            }
        }
        if(!simpleRef.current&&(s.phase==='idle'||s.phase==='waiting')){
            for(let i=0;i<3;i++){ctx.strokeStyle=`rgba(220,240,224,${.16-i*.04})`;ctx.lineWidth=1;ctx.beginPath();ctx.ellipse(0,9,16+i*18,5+i*6,0,0,Math.PI*2);ctx.stroke();}
            ctx.strokeStyle='#ebead5a0';ctx.lineWidth=.8;ctx.beginPath();ctx.moveTo(w*.27,-h*.6);ctx.quadraticCurveTo(14,-42,0,0);ctx.stroke();
            ctx.fillStyle='#e6ac7e';ctx.beginPath();ctx.ellipse(0,0,3,9,.15,0,Math.PI*2);ctx.fill();ctx.fillStyle='#fff0cd';ctx.beginPath();ctx.ellipse(0,-3,3,4,.15,0,Math.PI*2);ctx.fill();
        }
        ctx.restore();
        if(simpleRef.current){
            const shadow=simpleFishingShadow(s.elapsed),cast=s.simpleCast;
            const fishing=s.phase==='waiting'||s.phase==='hooked';
            const fishX=fishing&&cast?cast.fishX:shadow.x,fishY=fishing&&cast?cast.fishY:shadow.y;
            if((s.phase==='idle'&&shadow.visible)||(fishing&&s.elapsed<2.8)){
                const approach=fishing&&cast?Math.min(1,s.elapsed/2.6):0;
                const fx=(fishX+(cast?cast.castX-fishX:0)*approach)*w,fy=(fishY+(cast?cast.castY-fishY:0)*approach)*h;
                ctx.save();ctx.translate(fx,fy);ctx.rotate(Math.sin(s.elapsed*.7)*.35);ctx.fillStyle='#072e3d88';ctx.shadowColor='#102f35';ctx.shadowBlur=12;
                ctx.beginPath();ctx.ellipse(0,0,25,9,0,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.moveTo(-18,0);ctx.lineTo(-35,-12);ctx.lineTo(-31,12);ctx.closePath();ctx.fill();ctx.restore();
            }
            if(fishing&&cast){
                const flight=s.phase==='waiting'?Math.min(1,s.elapsed/.7):1;
                const reel=s.phase==='hooked'?Math.min(1,s.elapsed/.9):0;
                const bx=(.85+(cast.castX-.85)*flight)*w,by=(1.1+(cast.castY-1.1)*flight)*h-Math.sin(flight*Math.PI)*h*.22-reel*h*.7;
                ctx.strokeStyle='#f0ead4aa';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(w*.85,h);ctx.quadraticCurveTo(w*.72,by-36,bx,by);ctx.stroke();
                if(flight===1&&reel===0){for(let i=0;i<3;i++){const pulse=(s.elapsed*14+i*17)%55;ctx.strokeStyle='rgba(229,243,225,'+(.28*(1-pulse/55))+')';ctx.beginPath();ctx.ellipse(bx,by+7,9+pulse,3+pulse*.32,0,0,Math.PI*2);ctx.stroke();}}
                ctx.save();ctx.translate(bx,by+Math.sin(s.elapsed*6)*2);ctx.fillStyle='#d49872';ctx.beginPath();ctx.ellipse(0,0,4,10,0,0,Math.PI*2);ctx.fill();ctx.fillStyle='#fff2d0';ctx.beginPath();ctx.ellipse(0,-4,4,5,0,0,Math.PI*2);ctx.fill();ctx.restore();
            }
        }
    },[weather.kind]);
    const advance=useCallback((ms:number)=>{
        let remaining=Math.max(0,Math.min(ms,60000));
        while(remaining>0){const n=Math.min(1000/120,remaining);stepFishingGame(frame.current,n/1000);remaining-=n;}
        setPhase(frame.current.phase);if(frame.current.phase==='caught')void deliver();draw();
    },[deliver,draw]);
    useEffect(()=>{
        const c=canvas.current;if(!c)return;
        const resize=()=>{const r=c.getBoundingClientRect(),dpr=Math.min(window.devicePixelRatio||1,2);c.width=Math.max(1,Math.round(r.width*dpr));c.height=Math.max(1,Math.round(r.height*dpr));draw();};
        const observer=new ResizeObserver(resize);observer.observe(c);resize();return()=>observer.disconnect();
    },[draw]);
    useEffect(()=>{
        let raf=0,last=0;const tick=(now:number)=>{if(!manualClock.current&&document.visibilityState!=='hidden')advance(last?Math.min(50,now-last):0);last=now;raf=requestAnimationFrame(tick);};
        raf=requestAnimationFrame(tick);return()=>cancelAnimationFrame(raf);
    },[advance]);
    useEffect(()=>{
        const release=()=>{frame.current.held=false;};
        const down=(e:KeyboardEvent)=>{
            if((e.target as HTMLElement)?.closest('input,textarea,select,button'))return;
            if(e.code==='Space'){e.preventDefault();if(!simpleRef.current)frame.current.held=true;}
            if(e.key.toLowerCase()==='f'){const promise=document.fullscreenElement?document.exitFullscreen?.():canvas.current?.closest('.fishing-shell')?.requestFullscreen?.();void promise?.catch(()=>{});}
        };
        const up=(e:KeyboardEvent)=>{if(e.code==='Space')release();};
        window.addEventListener('keydown',down);window.addEventListener('keyup',up);window.addEventListener('blur',release);document.addEventListener('visibilitychange',release);
        return()=>{window.removeEventListener('keydown',down);window.removeEventListener('keyup',up);window.removeEventListener('blur',release);document.removeEventListener('visibilitychange',release);};
    },[]);
    useEffect(()=>{
        const target=window as Window&{render_game_to_text?:()=>string;advanceTime?:(ms:number)=>void};
        const render=()=>JSON.stringify({mode:'tide-resonance-fishing',simple,saving,error,coordinates:simple?'water normalized: origin top-left, x right, y down':'angles: radians; zero right; positive clockwise',...(simple?{shadow:simpleFishingShadow(frame.current.elapsed)}:{}),...frame.current,arcHalfWidth:fishingArcWidth(frame.current),weather:weather.kind,weatherSource:weather.source,catch:phase==='caught'&&!saving&&!error?pending.current?.speciesId:undefined});
        const step=(ms:number)=>{manualClock.current=true;advance(ms);};target.render_game_to_text=render;target.advanceTime=step;
        return()=>{if(target.render_game_to_text===render)delete target.render_game_to_text;if(target.advanceTime===step)delete target.advanceTime;};
    },[advance,weather,simple,saving,error,phase]);
    const cast=(aim?:{x:number;y:number})=>{
        if(savingRef.current||frame.current.phase==='waiting'||frame.current.phase==='hooked'||(error&&pending.current))return;
        setError('');notified.current=false;
        try{pending.current=onCast();}catch(e){pending.current=null;setError(e instanceof Error?e.message:'没能抛竿，请再试一次');return;}
        frame.current=simple?castSimpleFishingGame(frame.current,Math.random(),aim):{...createFishingGame(speciesById(pending.current.speciesId)?.difficulty),phase:'waiting'};
        setPhase(frame.current.phase);canvas.current?.focus();draw();
    };
    const active=phase==='waiting'||phase==='hooked';
    const switchMode=(value:boolean)=>{if(active||savingRef.current||error)return;setSimple(value);simpleRef.current=value;frame.current=value?createSimpleFishingGame():createFishingGame();setPhase('idle');pending.current=null;try{localStorage.setItem(SIMPLE_MODE_KEY,String(value));}catch{}draw();};
    const release=()=>{frame.current.held=false;};
    return <section className="fishing-game" data-simple={simple} onContextMenu={e=>e.preventDefault()} onDragStart={e=>e.preventDefault()}>
        <div className="fishing-game-toolbar">
            <span className="fishing-weather" title={weather.detail}>{weather.label}<small>{weather.source==='real'?'真实':'模拟'}</small></span>
            <div className="fishing-mode" role="group" aria-label="钓鱼方式">{[[false,'手动'],[true,'简单']].map(([value,label])=><button type="button" key={String(label)} disabled={active||saving||!!error} aria-pressed={simple===value} onClick={()=>switchMode(value as boolean)}>{label}</button>)}</div>
        </div>
        <div className="fishing-water">
            <canvas ref={canvas} tabIndex={0} aria-label={simple?'钓鱼水面，看到鱼影后点附近抛竿':'钓鱼水面，按住空格或水面控制光弧'}
                onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();e.currentTarget.focus();e.currentTarget.setPointerCapture(e.pointerId);if(!simple)frame.current.held=true;else{const rect=e.currentTarget.getBoundingClientRect();cast({x:(e.clientX-rect.left)/rect.width,y:(e.clientY-rect.top)/rect.height});}}}
                onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}/>
            {phase==='caught'&&!saving&&!error&&pending.current&&<div className="fishing-catch fish-reveal" role="status">
                <FishArt speciesId={pending.current.speciesId} halloweenHat={pending.current.halloweenHat} size={168} animated/>
                <strong>{speciesById(pending.current.speciesId)?.name}</strong><span>{pending.current.sizeCm} cm · {'✦'.repeat(pending.current.quality)}</span>
                {onOpenCollection&&<button type="button" onClick={onOpenCollection}>查看收藏 →</button>}
            </div>}
            {phase==='idle'&&simple&&<div className="fishing-simple-hint">看到鱼影，点附近抛竿</div>}
            {phase==='escaped'&&<div className="fishing-water-status" role="status">{simple?'空军了，鱼影溜走了':'鱼影游远了'}</div>}
            {saving&&<div className="fishing-water-status" role="status">收进水箱…</div>}
        </div>
        {error&&<div className="fishing-error" role="alert">{error}{pending.current&&<button type="button" className="fish-action" disabled={saving} onClick={()=>{notified.current=false;void deliver();}}>重试收鱼</button>}</div>}
        <div className="fishing-game-controls"><button type="button" className="fish-action primary" disabled={saving||active||!!(error&&pending.current)} onClick={()=>cast()}>{saving?'收进水箱…':active?(simple?(phase==='waiting'?'等鱼靠近…':'收线…'):'正在钓鱼'):phase==='idle'?'抛竿':'再钓一次'}</button>
            {active&&<button type="button" className="fish-action" onClick={()=>{frame.current.phase='escaped';release();setPhase('escaped');draw();}}>收竿</button>}
        </div>
    </section>;
};
