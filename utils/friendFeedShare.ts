import {DB} from './db';
import {readFriendFeed} from './friendFeed';
import {syncedPostEnabled} from './friendFeedActivity';
import {readWeiboConnection,syncWeiboComments} from './friendFeedWeibo';
import {resolveFriendFeedSettings} from './friendFeedSettings';
import {isWeiboImageUrl} from './friendFeedSource';
import {FRIEND_SOURCE_COMMENT_LIMIT} from './friendFeedSourceComments';
import {getProxyWorkerUrl} from './proxyWorker';
import {putImageBlob, getBlobForRef} from './blobRef';
import {friendPostImages, isLocalFriendImage} from './friendFeedImages';
import {announceFriendFeedHistory} from './friendFeedNotes';
import {friendFeedShareContext,type FriendFeedShareSnapshot} from './friendFeedShareContext';
import {projectFriendPost,friendKnownIdentity,friendGraphStamp} from './friendFeedGraph';

async function downloadShareImage(url:string,proxy:string):Promise<Blob> {
    if(!isWeiboImageUrl(url))throw Error('不支持的配图来源');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
    try{
        const response=await fetch(proxy.replace(/\/+$/,'')+'/weibo-image?url='+encodeURIComponent(url),{
            credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal:controller.signal});
        const mime=(response.headers.get('content-type')||'').split(';')[0];
        if(!response.ok||!['image/jpeg','image/png','image/webp','image/gif','image/avif'].includes(mime))throw Error('配图无法读取');
        const reader=response.body?.getReader();if(!reader)throw Error('配图为空');
        const chunks:Uint8Array<ArrayBuffer>[]= [];let size=0;
        while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;
            if(size>6*1024*1024){await reader.cancel();throw Error('配图过大');}chunks.push(new Uint8Array(value));}
        if(!size)throw Error('配图为空');return new Blob(chunks,{type:mime});
    }finally{clearTimeout(timer);}
}

/** An explicit share grants this recipient the frozen post, without enabling ambient browsing. */
export async function shareFriendPost(postId:string,charId:string,deliveryId:string) {
    let feed=await readFriendFeed(),post=feed.posts.find(p=>p.id===postId);
    if(!post||!syncedPostEnabled(feed,post))throw Error('动态已删除或来源已关闭');
    if(!await DB.getCharacter(charId))throw Error('角色已不存在');
    const warnings:string[]=[];
    if(post.source?.platform==='weibo'&&readWeiboConnection()){
        try{await syncWeiboComments(postId);}catch{warnings.push('原评论未能刷新，分享当前缓存。');}
    }
    feed=await readFriendFeed();post=feed.posts.find(p=>p.id===postId);
    if(!post||!syncedPostEnabled(feed,post))throw Error('动态已删除或来源已关闭');
    const imagesEnabled=resolveFriendFeedSettings(feed.settings).shareImagesEnabled;
    const signature=JSON.stringify([post.authorId,post.text,post.source,post.images,post.imageCards]);
    const identityStamp=friendGraphStamp(feed);
    const proxy=getProxyWorkerUrl(),images=friendPostImages(post),imageRefs:string[]=[];
    if(imagesEnabled){
        let bytes=0;
        for(let start=0;start<images.length;start+=3){
            const batch=await Promise.allSettled(images.slice(start,start+3).map(async image=>{
                if(isLocalFriendImage(image.url)) {
                    const local = await getBlobForRef(image.url);
                    if (!local) throw Error('本地配图不存在');
                    bytes += local.size;
                    if(bytes>24*1024*1024)throw Error('配图总量过大');
                    return image.url;
                }
                const blob=await downloadShareImage(image.url,proxy);bytes+=blob.size;
                if(bytes>24*1024*1024)throw Error('配图总量过大');return putImageBlob(blob);
            }));
            for(const item of batch)if(item.status==='fulfilled')imageRefs.push(item.value);
        }
        if(imageRefs.length<images.length)warnings.push(`部分配图未能读取，本次附带 ${imageRefs.length}/${images.length} 张。`);
    }
    const latest=await readFriendFeed(),current=latest.posts.find(p=>p.id===postId);
    if(!current||!syncedPostEnabled(latest,current)||signature!==JSON.stringify([current.authorId,current.text,current.source,current.images,current.imageCards])
        ||identityStamp!==friendGraphStamp(latest)||getProxyWorkerUrl()!==proxy||resolveFriendFeedSettings(latest.settings).shareImagesEnabled!==imagesEnabled)throw Error('帖子或分享设置已变化，请重新分享');
    if(!await DB.getCharacter(charId))throw Error('角色已不存在');
    const characters=await DB.getAllCharacters();
    const projected=projectFriendPost(latest,charId,current);
    const share:FriendFeedShareSnapshot={version:1,postId,authorId:projected.authorId,authorName:current.authorName,text:current.text,
        identity:friendKnownIdentity(latest,charId,current,characters),
        ...(current.source?{source:structuredClone(current.source)}:{}),synced:current.synced,sharedAt:Date.now(),
        ...(current.images ? {images:structuredClone(current.images)} : {}),
        ...(current.imageCards?.length?{imageCards:structuredClone(current.imageCards)}:{}),
        comments:structuredClone(projected.comments),commentIdentities:Object.fromEntries(current.comments.map(c=>[c.id,friendKnownIdentity(latest,charId,c,characters)]).filter((pair):pair is [string,string]=>typeof pair[1]==='string')),
        originalComments:[...(current.weiboComments?.rows||[])].sort((a,b)=>b.createdAt-a.createdAt||b.id.localeCompare(a.id)).slice(0,FRIEND_SOURCE_COMMENT_LIMIT),
        imagesEnabled,imageRefs,imageCount:images.length,warning:warnings.join(' ')||undefined};
    const id=await DB.saveMessageOnce(`friend-share:${charId}:${deliveryId}`,{charId,role:'user',type:'friend_feed_share_card',
        content:friendFeedShareContext(share,charId),metadata:{friendFeedShare:share}});
    announceFriendFeedHistory([charId]);return {id,warning:share.warning};
}
