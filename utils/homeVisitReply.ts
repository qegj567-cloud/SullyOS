import {extractFriendFeedReplyTags} from './friendFeedReplyFormat';
import {decideHomeVisit} from './homeVisits';

/** Caller passes canonical CHAR_TRUE for SAR, never the display rewrite. */
export async function consumeHomeVisitReply(charId:string,raw:string,extra:unknown[]=[]){
 const spoken=raw.replace(/<(think|thinking|thought)>[\s\S]*?(?:<\/\1>|$)/gi,'');
 const parsed=extractFriendFeedReplyTags(spoken,'HOME_VISIT_REPLY');let text=parsed.text;
 try{const value=JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g,''));if(value&&typeof value==='object'&&!Array.isArray(value)&&'homeVisitReplies' in value){if(!Array.isArray(value.homeVisitReplies))throw Error('串门回复格式不正确');parsed.actions.push(...value.homeVisitReplies);delete value.homeVisitReplies;text=JSON.stringify(value);}}catch(error){if(error instanceof Error&&error.message==='串门回复格式不正确')throw error;}
 for(const action of [...parsed.actions,...extra].slice(0,3)){if(!action||typeof action!=='object')throw Error('串门回复格式不正确');const a=action as {id?:unknown;accept?:unknown};if(typeof a.id!=='string'||typeof a.accept!=='boolean')throw Error('串门回复需要申请 ID 和明确的同意或拒绝');await decideHomeVisit(charId,a.id,a.accept);}
 return text;
}
