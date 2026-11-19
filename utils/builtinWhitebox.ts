import dark from '../presets/chat/acid-orbit.json';
import lavender from '../presets/chat/acid-orbit-lavender.json';
import silverHalo from '../presets/chat/silver-halo';
import {validateDecoration} from './chatDecoration';

/** Bundled outfits stay local; read returns a fresh validated preset for editing/applying. */
export const BUILTIN_WHITEBOX_PRESETS = [
 {id:'builtin-acid-orbit',name:'星轨 · 深空',read:()=>validateDecoration(structuredClone(dark))},
 {id:'builtin-acid-orbit-lavender',name:'星轨 · 雾紫',read:()=>validateDecoration(structuredClone(lavender))},
 {id:'builtin-silver-halo',name:silverHalo.name,read:()=>validateDecoration(structuredClone(silverHalo))},
];
