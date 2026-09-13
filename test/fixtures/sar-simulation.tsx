// Isolated browser QA only. Never open this fixture with production user storage.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SARAssemblyCabinetOverlay } from '../../apps/vrWorld/SARAssemblyCabinet';
import { DB } from '../../utils/db';
import { getSARSimulationThreadId, SAR_SIMULATION_STORAGE_KEY } from '../../utils/vrWorld/sarSimulation';

const char = { id:'sar-reader-char',name:'阿岚',avatar:'',systemPrompt:'说话温和，做事有主见。',vrState:{enabled:true,api:{baseUrl:'http://127.0.0.1:5177/sar-qa-api',model:'qa-model',apiKey:'fixture-only'}} } as any;
const runId='sar-reader-run';
async function boot(){
    if(!localStorage.getItem(SAR_SIMULATION_STORAGE_KEY)){
        const card={id:'sar-reader-card',charId:char.id,charName:char.name,variantId:'variant-01',storyId:'story-01',createdAt:1,updatedAt:1,profile:{
            title:'雨停之前',logline:'在一座总是下雨的城里，他替你留了一盏灯。',identity:'城南修伞铺的主人，能听见雨水里的旧声音。',lifePatch:'他没有离开这座城，而是接下了家中的小店。',relationship:'你是他愿意留灯等候的人。',steelSeal:'答应等的人，我会等到。',patchCost:'他能听见许多故事，却很少说自己的事。',behaviorShift:'习惯先替别人安顿好眼前的小事。',userMaskTitle:'借住的人',userIdentity:'你暂住在修伞铺楼上，有一把还没修好的旧伞。',userLifePatch:'你带着少量行李来到城南，去留由你决定。',worldName:'长雨城',worldPremise:'雨水偶尔会带来远处的声音，居民早已习惯与雨生活。',arrivalPoint:'黄昏，你回到修伞铺。',activeCrisis:'送信的人没有像往常一样来，阿岚把留给他的茶重新温了一遍。',sharedObjective:'阿岚想请邻居顺路问问送信人的情况，你可以陪他，也可以留在店里。',countdown:'雨夜缓缓过去，今晚没有必须赶上的期限。',hiddenTruth:'HIDDEN_QA_SECRET：雨里保存着城外旧车站的声音。',climaxChoice:'HIDDEN_QA_CHOICE：他可能再次面对离城的机会。',openingScene:'雨沿着屋檐落下来，把街对面的招牌洗得模糊。\n\n修伞铺还亮着灯。阿岚听见门响，将桌边那杯热茶往你这边推了推。',openingLine:'回来啦。先坐，外面冷。',playerPrompt:'你可以坐下来，或做自己想做的事。'
        }};
        localStorage.setItem(SAR_SIMULATION_STORAGE_KEY,JSON.stringify({version:2,cards:[card],runs:[{id:runId,cardId:card.id,createdAt:1,updatedAt:2,status:'active',interactionsUsed:2,maxInteractions:50}]}));
        const base={charId:getSARSimulationThreadId(runId),type:'text' as const};
        await DB.saveMessage({...base,role:'user',content:'我坐到他身边，把冻凉的手递过去。',metadata:{source:'sar_simulation',sarRunId:runId,sarTurn:1,sarMode:'offline'}});
        await DB.saveMessage({...base,role:'assistant',content:'阿岚用掌心包住你的手，没有急着松开。\n\n“怎么凉成这样。”他将椅子往你这边挪了一点，“茶还烫，等一会儿再喝。”',metadata:{source:'sar_simulation',sarRunId:runId,sarTurn:1,sarMode:'offline',sarWorldNarration:'门外的脚步声远了。檐下那盏灯，在雨里轻轻晃着。'}});
        await DB.saveMessage({...base,role:'user',content:'先不管别的了，陪我待一会儿。',metadata:{source:'sar_simulation',sarRunId:runId,sarTurn:2,sarMode:'offline'}});
        await DB.saveMessage({...base,role:'assistant',content:'“好。”\n\n他应得很快，伸手把半开的窗合上。雨声隔着一层玻璃，忽然变得很远。\n\n阿岚重新坐回你身边，将你的手放进自己的口袋里。',metadata:{source:'sar_simulation',sarRunId:runId,sarTurn:2,sarMode:'offline',sarWorldNarration:'',sarDirectorState:{sceneFacts:['两人在修伞铺相伴，只过去几分钟'],openThreads:['送信人未到；邻居稍后会顺路询问'],offscreenFacts:['HIDDEN_QA_FACT：邻居尚未出发'],declinedHooks:['用户此刻不想追问送信人的事'],revealedFacts:['雨夜里送信人还没出现']}}});
    }
    createRoot(document.getElementById('root')!).render(<SARAssemblyCabinetOverlay onClose={()=>{}} characters={[char]} userProfile={{name:'我'} as any} groups={[]} apiConfig={{baseUrl:'',model:''} as any}/>);
    // The official game client can inspect the reader without a canvas click target.
    if(new URLSearchParams(location.search).get('open')==='story'){
        let step=0;
        const observer=new MutationObserver(()=>{
            const button=document.querySelector<HTMLButtonElement>(step===0?'.sarc-library-book':'.sarc-card-start button');
            if(button){step++;if(step===2)observer.disconnect();button.click();}
        });
        observer.observe(document.getElementById('root')!,{childList:true,subtree:true});
    }
}
void boot();
