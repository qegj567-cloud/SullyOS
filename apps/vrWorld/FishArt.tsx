import React from 'react';
import { speciesById } from '../../utils/vrWorld/fishingMarket';
import { dinoDefinition } from '../../utils/vrWorld/dinosaurCatalog';
import { DinoIcon } from './dinosaur/DinoIcon';
import './fishing.css';
import './kanata-halloween.css';

// Lightweight collection silhouettes; the garden lazily loads the corresponding 3D model.
const PALETTES: Record<string, [string, string, string, string]> = {
    'glass-minnow': ['#d0efef', '#82b7be', '#325765', 'slim'],
    'cloud-carp': ['#ecd8b2', '#9cb6b7', '#63747b', 'carp'],
    'rain-drum': ['#a9c8e3', '#567b9d', '#294253', 'round'],
    sunneedle: ['#ffe4a2', '#d9a454', '#97673a', 'needle'],
    'moss-eel': ['#accc96', '#648978', '#294c4b', 'eel'],
    'thunder-ray': ['#bbc2f2', '#6576ad', '#38385e', 'ray'],
    'snow-lantern': ['#f1f5f6', '#b4d6e4', '#6797b5', 'round'],
    'moon-envelope': ['#e2d7f2', '#aca9d5', '#626286', 'angel'],
    'static-whale': ['#c2d4dd', '#8aa6ba', '#435d76', 'whale'],
};

export const FishArt: React.FC<{ speciesId: string; size?: number; silhouette?: boolean; animated?: boolean; halloweenHat?: boolean }> = ({ speciesId, size = 112, silhouette, animated = false, halloweenHat }) => {
    const f = speciesById(speciesId);
    const palette = PALETTES[speciesId];
    if (!palette) return (
        <span className="fish-clay" style={{ width:size,height:size*.65,display:'inline-flex',alignItems:'center',justifyContent:'center' }} role="img" aria-label={silhouette ? '尚未发现的橡皮泥藏品' : `${f?.name || dinoDefinition(speciesId)?.name || '恐龙'}橡皮泥模型`}>
            <DinoIcon species={speciesId} color={silhouette?(speciesId==='aiven-chimera'?'#a6a3ad':'#61716b'):dinoDefinition(speciesId)?.body||'#b9bb9d'}/>
        </span>
    );
    const [light, mid, dark, shape] = palette;
    return (
        <span role="img" aria-label={silhouette ? '尚未发现的鱼影' : f!.name}
            className={`fish-art fish-art--${shape} ${silhouette ? 'is-unknown' : ''} ${animated ? 'is-swimming' : ''}`}
            style={{ width: size, height: size * .65, '--fish-light': light, '--fish-mid': mid, '--fish-dark': dark } as React.CSSProperties}>
            <span className="fish-tail" /><span className="fish-dorsal" /><span className="fish-belly-fin" />
            <span className="fish-body"><span className="fish-scales" /><span className="fish-gill" /><span className="fish-side-fin" /><span className="fish-eye" /></span>
            {speciesId === 'snow-lantern' && <span className="fish-lantern" />}
            {halloweenHat && !silhouette && <svg className="kanata-fish-hat" viewBox="0 0 80 80" aria-label="万圣节帽子" role="img"><path d="M19 60 45 6 61 18 50 18 65 61Z" fill="#49415d" stroke="#292333" strokeWidth="3"/><path d="m24 50 36 1 5 10-46-1z" fill="#e6a25a"/><ellipse cx="41" cy="64" rx="36" ry="10" fill="#49415d" stroke="#292333" strokeWidth="3"/><rect x="38" y="50" width="12" height="10" rx="2" fill="none" stroke="#f4d582" strokeWidth="3"/></svg>}
        </span>
    );
};
