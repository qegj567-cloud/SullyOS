import {prepareFriendFeedEmotionTask, landFriendFeedEmotionAction} from './friendFeedEmotion';
import {extractFriendFeedReplyTags} from './friendFeedReplyFormat';
import type {Message} from '../types';
import type {FriendUserDisclosure} from './friendFeedRecognition';

/** Only the last human text inside the caller's selected context; never read broader DB history. */
export function friendFeedUserDisclosure(messages:(Pick<Message,'id'|'role'|'type'|'content'>&{metadata?:Message['metadata']})[]):FriendUserDisclosure|undefined {
    const message=[...messages].reverse().find(m=>m.role==='user');
    const sharedMessage=[...messages].reverse().find(m=>m.role==='user'&&m.type==='friend_feed_share_card');
    const snapshot=sharedMessage?.metadata?.friendFeedShare;
    const shared=snapshot?.version===1&&typeof snapshot.postId==='string'&&typeof snapshot.text==='string'&&Array.isArray(snapshot.comments)
        ?{postId:snapshot.postId,text:snapshot.text,comments:snapshot.comments.filter((c:any)=>c&&typeof c.id==='string'&&typeof c.text==='string').map((c:any)=>({id:c.id,text:c.text}))}:undefined;
    return message&&(message.type==='text'&&message.content.trim()||shared)?{id:`chat:${message.id}`,text:message.type==='text'?message.content:'',...(shared?{shared}:{})}:undefined;
}

/** Only actual generation calls this; context previews/statistics never take a lease. */
export async function prepareFriendFeedMainTask(charId: string,disclosure?:FriendUserDisclosure) {
    return prepareFriendFeedEmotionTask(charId, Math.random, undefined, 'main',undefined,undefined,disclosure);
}

export async function consumeFriendFeedMainReply(charId: string, raw: string, actions: unknown[] = [], expectedId?: string) {
    const spoken = raw.replace(/<(think|thinking|thought)>[\s\S]*?<\/\1>/gi, '')
        .replace(/<(?:think|thinking|thought)>[\s\S]*$/gi, '');
    const parsed = extractFriendFeedReplyTags(spoken);
    let text = parsed.text;
    const fence = String.fromCharCode(96).repeat(3);
    const jsonText = text.trim().replace(new RegExp('^' + fence + '(?:json)?\\s*|\\s*' + fence + '$', 'g'), '');
    try {
        const envelope = JSON.parse(jsonText);
        if (envelope && typeof envelope === 'object' && !Array.isArray(envelope) && 'friendFeedAction' in envelope) {
            parsed.actions.push(envelope.friendFeedAction);
            delete envelope.friendFeedAction;
            text = JSON.stringify(envelope);
        }
    } catch { /* ordinary chat text; partial JSON never executes */ }
    for (const action of [...parsed.actions, ...actions]) {
        if (!action || typeof action !== 'object' || (expectedId && (action as {requestId?: string}).requestId !== expectedId)) continue;
        try {await landFriendFeedEmotionAction(charId, action, 'main');}
        catch (error) {console.warn('[Friend feed] Main reply save failed; keeping pending job', error);}
    }
    return text === parsed.text ? extractFriendFeedReplyTags(raw).text : text;
}
