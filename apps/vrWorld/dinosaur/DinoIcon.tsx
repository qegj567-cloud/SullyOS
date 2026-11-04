import React from 'react';
// Preserve the event collectible's impossible anatomy in its small silhouette.
const CHIMERA_SHAPE='M28 31c-4 1-7-1-8-3l-2 6h-5l1-7c-4-1-7-4-8-8l4 2-1-5 5 2 1-6 4 5 2-4 3 5c1-4 0-8 0-11l-3-3 4-1 1-4 3 4 3-3 1 4 4 1 2-2 1 4c3 0 4 2 2 4h-7c-3 4-1 10-3 13l4 4-3 2-4-3-1 7h-5z';
export function DinoIcon({species,color}:{species:string;color:string}){
    if (species === 'halloween-dinosaur') return <svg viewBox="0 -7 48 43" aria-hidden="true" style={{fill:color}}>
        <path d="M22 21C19 10 24 4 33 3c-2 4-1 7 3 9-5-1-6 2-5 6-4-3-7-2-9 3Z" opacity=".85"/>
        <path d="M7 10c-1-7 17-9 19 2l-3 6c4 9 12 11 18 1l3-6c1 13-9 19-20 15l-2 6h-6l2-10-4-7H8c-5 0-6-5-1-7Z"/>
        <path d="M24 23c1-11 10-15 19-12-4 2-5 5-3 8-4-2-7 0-7 4-3-3-6-2-9 0Z" fill="#766086"/>
        <path d="M24 23 35 14" fill="none" stroke="#42364f" strokeWidth="1.1" strokeLinecap="round"/>
        <circle cx="19" cy="10" r="1.3" fill="#211e29"/>
        <circle cx="18.7" cy="9.6" r=".4" fill="#fff3fa"/>
        <path d="M8 14q3 2 5 0" fill="none" stroke="#211e29" strokeWidth="1" strokeLinecap="round"/>
        <ellipse cx="17" cy="14" rx="1.8" ry=".9" fill="#bca0bc"/>
        <ellipse cx="17" cy="5" rx="11" ry="2.4" fill="#302637"/>
        <path d="m10 4 10-10 4 10Z" fill="#423449"/>
        <path d="m11 2 12 0 .7 2.5h-14Z" fill="#dfb756"/>
        <rect x="19" y="1.8" width="2.8" height="2.8" rx=".3" fill="#f4d780"/>
    </svg>;
    const shape=species==='aiven-chimera'?CHIMERA_SHAPE:species==='brachiosaurus'||species==='plesiosaur'?'M12 28V17c0-3-5-6-5-10S13 2 16 6s1 13 5 14c9-4 12 3 16 3l6-2-3 5-7 1v7h-5v-6h-9v6h-5z':species==='triceratops'?'M8 17 3 12l5-1 2-8 5 7 3-6 4 8c10-2 17 2 16 11l6 4-8 1v6h-5v-6H18v6h-5v-7L6 24z':species==='stegosaurus'||species==='spinosaurus'?'m8 20 2-6 6-4 3-6 5 5 5-5 5 9 3 8 8 5-10 1v7h-5v-6H16v6h-5v-8l-7-1v-5z':species==='ankylosaurus'?'M4 23c0-5 4-5 7-6l5-7 7 2 7-2 7 9 7-3 2 4-7 6-3 1v7h-5v-6H17v6h-5v-8z':species==='dinosaur-egg'?'M24 3C8 3 6 34 24 34S40 3 24 3':species==='pteranodon'?'m3 28 10-19 11 8 9-12 12 22-16-4-5 10-6-11z':'M7 10c-1-7 17-9 19 2l-3 6c4 9 12 11 18 1l3-6c1 13-9 19-20 15l-2 6h-6l2-10-4-7H8c-5 0-6-5-1-7z';return <svg viewBox="0 0 48 36" aria-hidden="true" style={{fill:color}}><path d={shape}/></svg>;}
