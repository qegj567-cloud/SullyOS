import type {ResidentExpression} from './chibi/residentExpression';
import type {ChibiVisitor} from './chibi/visitor';
import type {Home3DState,HomeRecord,HomeScene,HomeRecordSource} from './types';
export interface HomeEditor {beginHomeConversation?():(speakingSeconds?:number)=>void}
export interface HomeEditor {
 getState():Home3DState;
 getPresentResidents():Array<{id:string;name:string}>;
 getResidentScene(id:string):HomeScene;
 setSocialReplyBusy(value:boolean):void;
 isSocialReplyBusy():boolean;
 setJoinedResidentIds(ids:string[]):void;
 canPlaySocial(action:string,a:string,b?:string):boolean;
 setRomanticRelation(a:string,b:string,enabled:boolean):void;
 getGuestActions(id:string):HomeScene['actions'];
 performGuestAction(id:string,action:string):boolean;
 performResidentActions(id:string,ids:string[],replyTo?:string,signal?:AbortSignal):Promise<'completed'|'cancelled'|'unavailable'>;
}
export interface HomeEditor {performHomeActions?(ids:string[],replyTo?:string):Promise<'completed'|'cancelled'|'unavailable'>;finishAutonomousAction?():void;getHomeScene():HomeScene;updateRecords(records:HomeRecord[]):void;performHomeAction(id:string,source?:HomeRecordSource,replyTo?:string):'started'|'pending'|'unavailable';setAutonomy(value:boolean):void;openPanel(name:string):void}
export interface HomeEditor {setResidentExpression(id:string,settings:ResidentExpression):void}
export interface HomeEditor {setResidentRoom(roomId:string|null|undefined,force?:boolean):void}
export interface HomeEditor {setHomelyChatOpen?(open:boolean):void}
export interface HomeEditor {setHomelyMusic?(value:{playing:boolean;position:number}):void;startHomelyAttention?():boolean;cancelHomelyAttention?():void}
export interface HomeEditor {setViewMode(mode:'flat'|'free'):void}
export interface HomeEditor {setLightingMode(mode:'auto'|'morning'|'day'|'sunset'|'night'):void;setTimeZone(timeZone?:string):void}
export interface HomeEditor {setPrimaryResidentId(id:string,label?:string):void;setSocialResident(id:string,visitor:ChibiVisitor,label?:string):void;removeSocialResident(id:string):void;playSocial(action:string,a:string,b?:string,source?:HomeRecordSource,replyTo?:string):Promise<boolean>;cancelSocial():void}
export interface HomeEditor {dispose():void;setSuspended?(value:boolean):void;setVisitor?(visitor:ChibiVisitor|null,options?:{preservePose?:boolean}):void;inspect?():unknown;advanceTime?(ms:number):void}
export function mountHomeEditor(host:HTMLElement,options:{assetBase:string;firstPerson?:boolean;initialState?:Home3DState;onChange?:(state:Home3DState)=>void;onBack?:()=>void;onMenu?:(name:string,targetId?:string)=>void;storageKey?:string;signal?:AbortSignal;timeZone?:string;thumbnailExport?:(images:Record<string,string>)=>void|Promise<void>}):Promise<HomeEditor>;

export interface HomeEditor {getResidentAnchor?(id?:string):{x:number;y:number;width:number;height:number;headTopY?:number}|null}

export interface HomeEditor {greetOwner?():void;summonOwner?():boolean;getOwnerName?():string;getResidentPosture?(id:string):string;standResident?(id:string):boolean;setResidentBedMode?(id:string,mode:string):boolean;controlResident?(id:string):boolean}

export interface HomeEditor {setResidentPortraits(entries:Array<{id:string;label:string;avatar?:string}>):void}

export interface HomeEditor {openPets(id?:string):void}

export interface HomeEditor {playHomeResponse?(source?:'local'|'model',replyTo?:string,warmth?:number,motion?:'vrma-8bd33d84e90c0243'|'vrma-788371d87156b583'):boolean;getCompanionSnapshot?():import('../../utils/homeCompanion').CompanionSnapshot;performCompanionAction?(action:import('../../utils/homeCompanion').CompanionAction,warmth:number):boolean;cancelCompanionAction?():void;showHomeBubble?(id:string,text:string,kind?:'speech'|'reaction'):void;getHomeBubble?():{id:string;text:string;kind:string;roomId:string;at:number}|null}

export interface HomeEditor {playUserSpeech?(text:string):void}

export interface HomeEditor {setCompanionPreference(key:"directSpeech"|"speechFrequency"|"activityFrequency",value:boolean|string):void}

export interface HomeEditor {capturePhoto():Promise<Blob>}

export interface HomeEditor {setPhoneReply(active:boolean):boolean}
export interface HomeEditor {
 getPetPortrait(id:string):string;
 summonAll():void;setScheduleLabel(text:string):void;
 beginPhotoMode():Array<{id:string;label:string}>;endPhotoMode():void;
 setPhotoInteraction(id:string,a:string,b:string,time:number):Promise<void>;
 setPhotoCamera(values:{yaw?:number;pitch?:number;zoom?:number;height?:number;pan?:number}):void;
 setPhotoTogether(gap:number):void;setPhotoPose(id:string,motion:string,time:number):Promise<void>;setPhotoTurn(id:string,degrees:number):void;
 setPhotoFace(id:string,values:{expression?:'original'|'neutral'|'smile'|'happy'|'closed'|'surprised';lookCamera?:boolean}):void;
 subscribePhoto?(notify:()=>void):()=>void;
 renderPhoto(canvas:HTMLCanvasElement,look:import('./photoEffects').PhotoLook,options?:import('./photoFrame').PhotoRenderOptions):void;
}
