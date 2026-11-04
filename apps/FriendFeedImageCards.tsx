import React from 'react';
import {ImageSquare,ArrowDownRight} from '@phosphor-icons/react';
import type {FriendImageCard} from '../utils/friendFeedImages';
import './friendFeedImageCards.css';

/** Text stays text: no image URLs, generated pixels or vision requests. */
export default function FriendFeedImageCards({cards=[]}:{cards?:FriendImageCard[]}) {
    if(!cards.length)return null;
    return <div className="ff-image-cards" data-count={cards.length} aria-label="配图">{cards.map((card,i)=><details className="ff-image-card" key={i} onClick={e=>e.stopPropagation()}>
        <summary aria-label={`查看配图：${card.caption||`画面 ${i+1}`}`}>
            <span className="ff-image-card-top"><span><ImageSquare size={15} weight="light"/>配图</span><span className="ff-image-card-index">{String(i+1).padStart(2,'0')}<small> / {String(cards.length).padStart(2,'0')}</small></span></span>
            <span className="ff-image-card-frame"><strong>{card.caption||'这一刻'}</strong><span className="ff-image-card-excerpt">{card.description}</span></span>
            <span className="ff-image-card-bottom"><span>描述</span><span className="ff-image-card-more"><span className="ff-image-card-expand">展开</span><span className="ff-image-card-collapse">收起</span><ArrowDownRight size={15}/></span></span>
        </summary>
        <p className="ff-image-card-full">{card.description}</p>
    </details>)}</div>;
}
