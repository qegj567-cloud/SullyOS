import {describe, expect, it} from 'vitest';
import {validateCollaborationAppearance} from '../features/collaboration/appearance';
import {CollaborationStore} from '../features/collaboration/store';
import {DEFAULT_COLLABORATION_SETTINGS} from '../features/collaboration/types';
import {validateBeautyPackage} from './beautyShareContract';
import {normalizeBeautyPackage} from './beautyShareClient';
import {portableDecoration, validateDecoration} from './chatDecoration';
import {decorationCategories, belongsInBeautyLibrary} from './beautyCategories';
import {beautyShareContents} from './beautyShareContents';
import {saveLibraryDecoration, readLibraryDecorations, readDecorationOrigin} from './decorationLibrary';
import {cssImportPreset, stampBeautyCss} from './beautyCssAttribution';
import {makeWorkshopPreset, workshopCss} from './decorationWorkshop';
import {createWardrobeUsageReader} from './wardrobeUsage';
import {PRESET_THEMES} from '../components/chat/ChatConstants';
import {decorationPreviewScenes, decorationThumbnailPart} from './decorationPreviewScenes';
import {DB} from './db';

const appearance=validateCollaborationAppearance({uiTheme:'midnight',customCss:'.collab-ui-root { --collab-accent: #cba6f7; }',avatarMode:'character',avatarStyle:'rounded'});
const preset=()=>({...makeWorkshopPreset('collaboration'),name:'午夜协同',parts:{collaboration:{...appearance}}});

describe('collaboration beauty lifecycle',()=>{
  it('strips private settings at both client and Worker admission boundaries',()=>{
    const input={...preset(),parts:{collaboration:{...appearance,immersive:{apiKey:'SECRET'},focused:{baseUrl:'PRIVATE'},messages:['TASK'],files:['FILE'],recentChatContextCount:20}}};
    for(const result of [validateDecoration(input),validateBeautyPackage(input).data,normalizeBeautyPackage(input,'chat-decoration')]) {
      expect(result.parts).toEqual({collaboration:appearance});
      expect(JSON.stringify(result)).not.toMatch(/SECRET|PRIVATE|TASK|FILE/);
    }
    expect(decorationCategories(preset())).toEqual(['collaboration']);
    expect(belongsInBeautyLibrary(['collaboration'],'chat')).toBe(true);
    expect(belongsInBeautyLibrary(['collaboration'],'appearance')).toBe(false);
    expect(beautyShareContents(preset()).map(p=>p.key)).toEqual(['collaboration']);
  });
  it('rejects mixed packages, invalid themes and CSS outside the collaboration window',()=>{
    for(const parts of [{...preset().parts,css:'.sully-chat-root{color:red}'},{collaboration:{...appearance,uiTheme:'unknown'}},{collaboration:{...appearance,customCss:'body{display:none}'}}]) {
      const input={...preset(),parts};
      expect(()=>validateDecoration(input)).toThrow();
      expect(()=>validateBeautyPackage(input)).toThrow();
    }
  });
  it('supports multiple saved works and portable JSON without losing origin',async()=>{
    const id=await saveLibraryDecoration(preset(),{kind:'self',credit:'示例作者'});
    const second=await saveLibraryDecoration({...preset(),name:'另一个主题',parts:{collaboration:{...appearance,uiTheme:'charcoal'}}},{kind:'imported',allowRemix:false});
    const list=await readLibraryDecorations();
    expect(list.find(p=>p._libraryId===id)?.parts.collaboration).toEqual(appearance);
    expect(list.some(p=>p._libraryId===second)).toBe(true);
    expect(await readDecorationOrigin(second)).toMatchObject({kind:'imported',allowRemix:false});
    expect(validateDecoration(JSON.parse(JSON.stringify(await portableDecoration(list.find(p=>p._libraryId===id)!))))).toEqual(preset());
    const backup=await DB.exportFullData();
    expect(JSON.stringify(backup.assets)).toContain('午夜协同');
  });
  it('preserves attribution when copying CSS and imports the right category',()=>{
    const css=stampBeautyCss(appearance.customCss,{name:'协同 CSS',credit:'作者',category:'collaboration',allowRemix:false});
    const imported=cssImportPreset(css,'fallback');
    expect(workshopCss(imported.preset,'collaboration')).toBe(appearance.customCss);
    expect(imported.origin).toMatchObject({credit:'作者',allowRemix:false});
  });
  it('applies and switches only appearance; API, context and task records survive',async()=>{
    const settings={...DEFAULT_COLLABORATION_SETTINGS,immersive:{...DEFAULT_COLLABORATION_SETTINGS.immersive,apiKey:'keep-key'},recentChatContextCount:10 as const};
    await CollaborationStore.saveSettings(settings);
    const session={id:'beauty-test',charId:'beauty-test',title:'private task',mode:'immersive' as const,createdAt:1,updatedAt:1};
    await CollaborationStore.saveSession(session);
    await CollaborationStore.applyAppearance(appearance);
    let actual=await CollaborationStore.loadSettings();
    expect(actual).toMatchObject({...appearance,immersive:settings.immersive,recentChatContextCount:10});
    expect(await CollaborationStore.listSessions('beauty-test')).toContainEqual(session);
    const backup=await CollaborationStore.exportBackup(false,true);
    await CollaborationStore.applyAppearance(validateCollaborationAppearance({}));
    await CollaborationStore.importBackup(backup);
    actual=await CollaborationStore.loadSettings();
    expect(validateCollaborationAppearance(actual)).toEqual(appearance);
    expect(actual.immersive.apiKey).toBe('keep-key');
    const read=createWardrobeUsageReader({} as any,undefined,PRESET_THEMES.default,{},undefined,appearance);
    expect(await read(preset())).toBe('当前使用中');
    expect(await read(makeWorkshopPreset('collaboration'))).toBe('');
  });
  it('uses a collaboration-only preview and never chat scenes',()=>{
    expect(decorationThumbnailPart(preset())).toBe('collaboration');
    expect(decorationPreviewScenes(preset(),'all').map(s=>s.id)).toEqual(['collaboration']);
  });
});
