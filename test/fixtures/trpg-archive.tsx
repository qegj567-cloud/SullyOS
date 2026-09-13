import React from 'react';
import { createRoot } from 'react-dom/client';
import GameApp from '../../apps/GameApp';
import { OSProvider } from '../../context/OSContext';
import { DB } from '../../utils/db';
const longText='第一段完整剧情。'.repeat(35)+'\n\n第二段结尾标记：旧塔的灯终于亮了。';
async function boot(){
    await DB.saveGame({id:'qa-archive',title:'完整原文测试',theme:'fantasy',worldSetting:'测试',playerCharIds:[],logs:[
        {id:'l1',role:'gm',content:longText,timestamp:1,archived:true},
        {id:'l2',role:'player',speakerName:'小雨',content:'旧版归档也保留的尾句。',timestamp:2,archived:true},
        {id:'l3',role:'gm',content:'当前剧情',timestamp:3},
    ],summaries:[{id:'s1',content:'前情总结',logCount:1,logIds:['l1'],createdAt:1},{id:'s2',content:'旧版总结',logCount:1,createdAt:2}],status:{location:'塔下',health:100,sanity:100,gold:0,inventory:[]},createdAt:1,lastPlayedAt:2});
    createRoot(document.getElementById('root')!).render(<OSProvider><GameApp/></OSProvider>);
}
void boot();
