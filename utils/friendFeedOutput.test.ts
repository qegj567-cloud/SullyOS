import {expect,it} from 'vitest';
import {parseDedicatedFriendFeedAction} from './friendFeedOutput';
import {normalizeFriendFeedAction} from './friendFeedReplyFormat';

it('accepts a complete bare or fenced action and equivalent text fields without inventing identity',()=>{
    const action={request_id:'task',kind:' COMMENT ',post_id:'post',content:'多说一点也可以。',replyToCommentId:null,npcActions:[{kind:'COMMENT',name:'路人',post_id:'post',comment:'同意'}]};
    for(const raw of [JSON.stringify(action),'```json\n'+JSON.stringify({friendFeedAction:action})+'\n```'])
        expect(parseDedicatedFriendFeedAction(raw)).toMatchObject({requestId:'task',kind:'comment',postId:'post',comment:'多说一点也可以。',npcActions:[{kind:'comment',postId:'post',text:'同意'}]});
});
it('never completes a truncated action or changes a contradictory task ID',()=>{
    expect(parseDedicatedFriendFeedAction('{"requestId":"task","kind":"post","text":"半句')).toBeUndefined();
    expect(parseDedicatedFriendFeedAction('{"friendFeedAction":{"requestId":"task","kind":"post","text":"半句')).toBeUndefined();
    expect(normalizeFriendFeedAction({requestId:'one',request_id:'two',kind:'post',text:'内容'})).toBeNull();
    expect(parseDedicatedFriendFeedAction('{"friendFeedAction":{"requestId":"one","request_id":"two","kind":"none"}}')).toBeUndefined();
    expect(normalizeFriendFeedAction({kind:'post',text:'内容',authorId:'user'})).toHaveProperty('authorId','user');
    expect(parseDedicatedFriendFeedAction('{"friendFeedAction":null}')).toBeNull();
});

it('accepts a caption-only image post without inventing text, preserving cards for validation',()=>{
    expect(normalizeFriendFeedAction({requestId:'task',kind:'post',imageCards:[{caption:'晚霞',description:'窗外粉色的云'}]})).toMatchObject({text:'',imageCards:[{caption:'晚霞',description:'窗外粉色的云'}]});
});
