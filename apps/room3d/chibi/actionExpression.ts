export type ActionExpression='neutral'|'speaking'|'smiling'|'sleeping'|'surprised'|'tender';
export function actionExpression(motion:string,category='',label=''):ActionExpression {
 if(motion==='sleep')return 'sleeping';
 if(motion==='speaking'||motion==='bed-talk'||motion==='stream'||/聊天手势|交谈|争论/.test(label))return 'speaking';
 if(/吓了一跳/.test(label))return 'surprised';
 if(['close','greet'].includes(category)||/开心鼓掌|热情鼓掌|点头回应/.test(label)||/^(wave|hug|dance|mirror-admire)/.test(motion))return 'smiling';
 return 'neutral';
}
/** A short phrase pause separates syllable groups; this is gesture timing, not audio lip sync. */
export function actionMouthFrame(expression:ActionExpression,time:number){
 if(expression==='speaking'){
  const phrase=((time%2.7)+2.7)%2.7,syllable=((time%.31)+.31)%.31;
  return {mouth:phrase<2.12&&syllable<.18?'open' as const:'closed' as const,nextIn:.06};
 }
 return {mouth:expression==='smiling'?'smile' as const:expression==='sleeping'||expression==='tender'?'closed' as const:expression==='surprised'?'open' as const:'base' as const,nextIn:Infinity};
}
