import type {FriendComment} from './friendFeed';

/** Replies stay flat in storage/context, and are grouped into one readable level in the UI. */
export function friendCommentThreads(comments:FriendComment[]) {
    const byId=new Map(comments.map(c=>[c.id,c]));
    const rootId=(comment:FriendComment)=>{
        let current=comment;const seen=new Set([comment.id]);
        while(current.localReply){
            const parent=byId.get(current.localReply.id);
            if(!parent)break;
            // Malformed imported cycles remain visible as independent comments.
            if(seen.has(parent.id))return comment.id;
            seen.add(parent.id);current=parent;
        }
        return current.id;
    };
    const groups=new Map<string,{root:FriendComment;replies:FriendComment[]}>();
    for(const comment of comments){const id=rootId(comment);let group=groups.get(id);
        if(!group){group={root:byId.get(id)!,replies:[]};groups.set(id,group);}
        if(comment.id!==id)group.replies.push(comment);
    }
    return [...groups.values()];
}
