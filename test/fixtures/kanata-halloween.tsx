// Run in an isolated browser context: fixture-only local state, no model calls.
import React, { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { HalloweenChibi, KanataHalloweenProvider } from '../../apps/vrWorld/KanataHalloween';
import { FishArt } from '../../apps/vrWorld/FishArt';
import { HALLOWEEN_COSTUMES, freshHalloween, finishHalloweenDialogue } from '../../utils/vrWorld/kanataHalloween';
import { createFishingMarketState, saveFishingMarketState } from '../../utils/vrWorld/fishingMarket';
import { ensureDinosaurGarden } from '../../utils/vrWorld/dinosaurGarden';
import { createGardenRenderer } from '../../apps/vrWorld/dinosaur/renderer';
import caian from '../../assets/sar/caian-chibi.png';
const at = new Date(2026,9,29,12).getTime();
const state = ensureDinosaurGarden(finishHalloweenDialogue(createFishingMarketState(1), 'aiven', '我', false, at), {id:'user',name:'我',kind:'user'}, at);
state.kanataHalloween = {...freshHalloween(),costumes:Object.fromEntries(HALLOWEEN_COSTUMES.map(c=>[c.id,c.id]))};
saveFishingMarketState(state);
function Fixture() {
    const host = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const renderer = createGardenRenderer(host.current!, { play:()=>{}, selectProp:()=>{}, select:()=>{}, place:()=>{}, error:message=>{document.getElementById('model-status')!.textContent=message;}, ready:()=>{document.getElementById('model-status')!.textContent='模型已就绪';} });
        void renderer.sync(state, 'kanata-halloween-2026-pumpkin-dino', 'portrait');
        return () => renderer.dispose();
    }, []);
    return <KanataHalloweenProvider><main><h1>彼方 · 万圣节</h1><div className="costumes">{HALLOWEEN_COSTUMES.map(c=><figure key={c.id}><HalloweenChibi actorId={c.id} img={caian} name={c.name} style={{width:170,height:170}}/><figcaption>{c.name}</figcaption></figure>)}</div><div className="fish-row">{['glass-minnow','cloud-carp','rain-drum','sunneedle','moss-eel','thunder-ray','snow-lantern','moon-envelope','static-whale'].map(id=><FishArt key={id} speciesId={id} halloweenHat/>)}</div><h2>万圣小恐龙</h2><div ref={host} id="garden-preview"/><p id="model-status">模型载入中</p></main></KanataHalloweenProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
