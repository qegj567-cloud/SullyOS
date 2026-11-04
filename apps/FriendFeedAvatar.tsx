import React, {useState} from 'react';
import {isImageValue, useBlobRefUrl} from '../utils/blobRef';
import {isWeiboImageUrl} from '../utils/friendFeedSource';
import {getProxyWorkerUrl} from '../utils/proxyWorker';

export default function FriendFeedAvatar({name, avatar}: {name: string; avatar?: string}) {
    const image = useBlobRefUrl(isImageValue(avatar) ? avatar : undefined);
    const [failed, setFailed] = useState<string>();
    const [relayFailed,setRelayFailed] = useState<string>();
    const relay=image&&failed===image&&isWeiboImageUrl(image)?getProxyWorkerUrl().replace(/\/+$/,'')+'/weibo-image?url='+encodeURIComponent(image):undefined;
    return <span className="friend-feed-avatar" aria-hidden="true">
        {image && failed !== image ? <img src={image} alt="" referrerPolicy="no-referrer" onError={() => setFailed(image)}/>
            :relay&&relayFailed!==relay?<img src={relay} alt="" referrerPolicy="no-referrer" onError={()=>setRelayFailed(relay)}/>
            : avatar && !isImageValue(avatar) ? avatar : Array.from(name || '友')[0]}
    </span>;
}
