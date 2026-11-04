import { describe, expect, it } from 'vitest';
import { MEETING_APPEARANCES, meetingAppearance, validateMeetingAppearance } from './meetingAppearance';
import { decorationPatches, portableDecoration, validateDecoration } from './chatDecoration';
import { BEAUTY_CATEGORIES, belongsInBeautyLibrary, decorationCategories } from './beautyCategories';
import { decorationPreviewScenes, decorationThumbnailPart } from './decorationPreviewScenes';
import { validateBeautyPackage } from './beautyShareContract';
import { makeWorkshopPreset, projectWorkshopPreset } from './decorationWorkshop';

describe('meeting appearance presets', () => {
    it.each(['date', 'story'] as const)('%s custom CSS survives sharing and application, while out-of-scope CSS is rejected', async part => {
        const css = '.meeting-reading { --meeting-paper: #fff0ed; --meeting-font-size: 19px; }';
        const pack = validateDecoration({format:'sullyos-chat-decoration',version:1,name:'自制书页',parts:{[part]:{preset:'novel',customCss:css}}});
        expect((validateBeautyPackage(pack).data.parts as any)[part].customCss).toBe(css);
        expect((await portableDecoration(pack)).parts[part]?.customCss).toBe(css);
        const patches = await decorationPatches(pack,[part],'character',{id:'c'} as any,{} as any);
        expect((part === 'date' ? patches.character.dateAppearance : patches.theme.storyAppearance)?.customCss).toBe(css);
        expect(() => validateMeetingAppearance({preset:'novel',customCss:'body {display:none}'})).toThrow();
    });
    it('two separate chat categories follow notification sounds', () => {
        const ids = BEAUTY_CATEGORIES.map(([id]) => id).filter(id => id !== 'collaboration');
        expect(ids.slice(ids.indexOf('sound') + 1, ids.indexOf('sound') + 3)).toEqual(['date', 'story']);
        expect(belongsInBeautyLibrary(['date'], 'chat')).toBe(true);
        expect(belongsInBeautyLibrary(['story'], 'appearance')).toBe(false);
    });
    it.each(['date', 'story'] as const)('%s roundtrips visual data only and applies to the correct scope', async part => {
        for (const style of MEETING_APPEARANCES) {
            const pack = validateDecoration({ format:'sullyos-chat-decoration', version:1, name:'我的书页', parts:{[part]:{preset:style.id,systemPrompt:'private',messages:['private']}} });
            expect(pack.parts[part]).toEqual({preset:style.id});
            expect(validateBeautyPackage(pack).kind).toBe('chat-decoration');
            expect(await portableDecoration(pack)).toEqual(pack);
            expect(decorationCategories(pack)).toEqual([part]);
            expect(decorationThumbnailPart(pack)).toBe(part);
            expect(decorationPreviewScenes(pack)[0].id).toBe(part+'-reading');
            const changes = await decorationPatches(pack,[part],'character',{id:'c'} as any,{} as any);
            if(part==='date') {
                expect(changes.character).toEqual({dateAppearance:{preset:style.id,name:'我的书页'}});
                expect(changes.theme).toEqual({});
            } else {
                expect(changes.character).toEqual({});
                expect(changes.theme).toEqual({storyAppearance:{preset:style.id,name:'我的书页'}});
            }
            expect(projectWorkshopPreset(pack,part)).toEqual(pack);
            expect(validateDecoration(makeWorkshopPreset(part)).parts[part]).toBeDefined();
        }
    });
    it('rejects invalid or mixed packs; none restores the unmodified surface', () => {
        expect(()=>validateMeetingAppearance({preset:'evil'})).toThrow();
        expect(()=>validateDecoration({format:'sullyos-chat-decoration',version:1,name:'bad',parts:{date:{preset:'novel'},css:'body{}'}})).toThrow();
        expect(meetingAppearance(undefined).name).toBe('无');
        expect(meetingAppearance({preset:'none',name:'旧书页'}).name).toBe('无');
        expect(meetingAppearance({preset:'novel',name:'自定义名字'}).name).toBe('自定义名字');
    });
});
