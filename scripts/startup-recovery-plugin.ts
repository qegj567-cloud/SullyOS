import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {Plugin,ResolvedConfig} from 'vite';

/** Inline before modules and blocking third-party styles: module crashes cannot disable recovery. */
export function startupRecoveryPlugin(buildId:string):Plugin {
 let config:ResolvedConfig;
 return {
  name:'sully-startup-recovery',
  configResolved(value){config=value;},
  transformIndexHtml:{order:'pre',handler(_html,context){
   if(resolve(context.filename)!==resolve(config.root,'index.html'))return;
   return [
    {tag:'script',attrs:{'data-base':config.base,'data-build':buildId},children:readFileSync(resolve(config.root,'public/startup-recovery.js'),'utf8'),injectTo:'head-prepend'},
    {tag:'script',children:readFileSync(resolve(config.root,'public/user-space-transition.js'),'utf8'),injectTo:'head-prepend'},
   ];
  }},
 };
}
