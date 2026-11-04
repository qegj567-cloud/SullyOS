import type {PhotoFrame} from './photoFrame';

export const photoFonts={
 classic:{label:'经典衬线',family:'Georgia, "Songti SC", SimSun, serif'},
 system:{label:'跟随系统 / 自定义字体',family:'system-ui, sans-serif'},
 rounded:{label:'圆润无衬线',family:'Quicksand, "Arial Rounded MT Bold", "Microsoft YaHei", sans-serif'},
 handwritten:{label:'楷体手写',family:'"Kaiti SC", KaiTi, STKaiti, cursive'},
} as const;
export interface PhotoLettering {title:string;footer:string;font:keyof typeof photoFonts}
export type PhotoLetteringLibrary=Partial<Record<PhotoFrame,PhotoLettering>>;
export const PHOTO_LETTERING_KEY='sully.home.photo-lettering.v1';
export function defaultPhotoLettering(format:PhotoFrame):PhotoLettering{
 return {title:format==='polaroid'?'a little moment':format==='collage'?'four little keepsakes':'you make me smile',footer:'S U L L Y  ·  H O M E',font:'classic'};
}
export function photoFontFamily(font:PhotoLettering['font']){
 return font==='system'?(getComputedStyle(document.documentElement).getPropertyValue('--app-font').trim()||photoFonts.system.family):photoFonts[font].family;
}
export async function loadPhotoFont(lettering:PhotoLettering){
 if(document.fonts)await document.fonts.load(`32px ${photoFontFamily(lettering.font)}`,lettering.title+lettering.footer||'照片');
}
export function readPhotoLettering():PhotoLetteringLibrary{
 try{
  const raw=JSON.parse(localStorage.getItem(PHOTO_LETTERING_KEY)||'{}'),result:PhotoLetteringLibrary={};
  for(const format of ['polaroid','sticker','collage'] as const){
   const value=raw?.[format];
   if(value&&typeof value.title==='string'&&typeof value.footer==='string'&&Object.hasOwn(photoFonts,value.font))
    result[format]={title:value.title.slice(0,40),footer:value.footer.slice(0,64),font:value.font};
  }
  return result;
 }catch{return {};}
}
export function writePhotoLettering(value:PhotoLetteringLibrary){localStorage.setItem(PHOTO_LETTERING_KEY,JSON.stringify(value));}
