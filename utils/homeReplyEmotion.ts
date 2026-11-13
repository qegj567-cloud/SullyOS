import type {HomeReplyRequest} from './homeConversation';
import {homeEmotionEnabled} from './homeEmotion';
import {makeDebugLogger,isEmotionEvalSkipped} from './devDebug';
const timingLog=makeDebugLogger('api','Home emotion timing');
/** Uses the same evaluator, API selection and buff persistence as private chat. */
export async function evaluateHomeReplyEmotion(args:HomeReplyRequest,messages:Array<{role:string;content:any}>){
 if(args.signal.aborted||!homeEmotionEnabled(args.char)||isEmotionEvalSkipped()){timingLog.info('未启动：已取消、情绪未开启或调试跳过');return;}
 const custom=args.char.emotionConfig?.api;
 const api=custom?.baseUrl?{...custom,stream:(custom as typeof custom & {stream?:boolean}).stream??args.api.stream}:args.api;
 if(!api.baseUrl||!api.model)return;
 const started=performance.now();timingLog.info('开始加载共享情绪评估器');
 try{
  const {evaluateEmotionBackground}=await import('../hooks/useChatAI');
  if(args.signal.aborted)return;
  timingLog.info('启动共享情绪评估器',{moduleReadyMs:Math.round(performance.now()-started)});
  await evaluateEmotionBackground(args.regenerating?{...args.char,buffInjection:'',activeBuffs:[]}:args.char,args.user,String(messages[0]?.content||''),messages.slice(1),{baseUrl:api.baseUrl,apiKey:api.apiKey||'',model:api.model,stream:!!api.stream},args.signal,args.secretOrigin,{appId:'room3d',appName:'3D家园'});
 }catch(error){console.warn('[Home emotion] 情绪更新失败',error instanceof Error?error.message:String(error));}
}
