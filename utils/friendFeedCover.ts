import {mutateFriendFeed} from './friendFeed';
import {resolveFriendFeedSettings} from './friendFeedSettings';
import {isLocalFriendImage} from './friendFeedImages';

export async function saveFriendFeedCover(ownerId:string,image?:string) {
    if(image&&!isLocalFriendImage(image))throw new Error('请选择本地封面图片');
    await mutateFriendFeed((feed,characters)=>{
        if(ownerId!=='user'&&!characters.some(c=>c.id===ownerId))throw new Error('这个角色已不存在');
        const settings=resolveFriendFeedSettings(feed.settings),covers={...settings.coverImages};
        if(image)covers[ownerId]=image;else delete covers[ownerId];
        feed.settings={...settings,coverImages:covers};
    });
}
