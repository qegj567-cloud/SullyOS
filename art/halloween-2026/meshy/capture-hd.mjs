import {chromium} from 'file:///C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const browser=await chromium.launch({channel:'msedge',headless:true});
const textured=process.argv.includes('--textured')||process.argv.includes('--smooth'),suffix=process.argv.includes('--smooth')?'smooth':'textured';
try{const p=await browser.newPage({viewport:{width:1200,height:1000}});p.on('pageerror',e=>console.log('PAGE ERROR',e.message));await p.goto('http://127.0.0.1:5199/art/halloween-2026/meshy/viewer.html');await p.waitForFunction(()=>window.ready);
 const items=textured?['pumpkin-costume','ghost-top','pumpkin-lantern'].map(id=>[id+'-'+suffix,'halloween-batch-04-texture/'+id+'-'+suffix+'.glb']):[...['pumpkin-costume','ghost-top','pumpkin-lantern'].map(id=>[id+'-hd','halloween-batch-03/'+id+'-hd.glb']),['ghost-socks','fitted-socks/ghost-socks.glb']];
 for(const [id,file]of items){await p.evaluate(file=>window.workbench.load(file),file);console.log(id,await p.locator('#info').innerText());for(const view of ['front','side','back']){await p.evaluate(view=>window.workbench.view(view),view);await p.screenshot({path:`art/halloween-2026/meshy/${id}-${view}.png`});}}
}finally{await browser.close();}
