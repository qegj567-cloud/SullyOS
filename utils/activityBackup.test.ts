import { beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { readFileSync } from 'node:fs';
import { DB, openDB } from './db';
import { applyFriendFeedMedia, collectFriendFeedMedia, exportActivityTextAsset, isActivityTextAsset } from './activityBackup';
import { FRIEND_FEED_KEY, parseFriendFeed, type FriendFeedState } from './friendFeed';
import { stripBackupImages } from './backupExport';
import { streamBackupArrayStore } from './backupStoreStreaming';
import { assembleV2Backup, writeV2Backup } from './backupFormat';
import { collectBlobRefs, readBlobsIndex, restoreBlobsFromZip, writeBlobsToZip } from './backupBlobs';
import { deleteBlobRef, getBlobForRef, putImageBlob, restoreBlobRef } from './blobRef';
import { assignHalloweenCostume, finishHalloweenDialogue, giveHalloweenCandy } from './vrWorld/kanataHalloween';
import { addCatchToState, createFishingMarketState, readFishingMarketState, rollFishingCatch, saveFishingMarketState } from './vrWorld/fishingMarket';
import { ensureDinosaurGarden } from './vrWorld/dinosaurGarden';
import { collectSARLocalBackup, restoreSARLocalBackup } from './vrWorld/sarBackup';
import { sarCollectionEntries } from './vrWorld/sarCollection';
import {defaultFriendFeedSettings} from './friendFeedSettings';

const feed = (image = 'blobref:picture'): FriendFeedState => ({version:1, circles:[], posts:[{
    id:'post', authorId:'user', authorName:'我', text:'新的日常', createdAt:123,
    circleId:'circle', audienceIds:['char'], comments:[], images:[{url:image,thumbnail:image}],
    imageCards:[{caption:'文字配图',description:'一只戴帽子的黑紫色恐龙'}],
}]});
const currentFeed = async () => parseFriendFeed(await DB.getAsset(FRIEND_FEED_KEY));
async function clearAssets() {
    const db = await openDB();
    await new Promise<void>((resolve,reject) => {
        const tx = db.transaction('assets','readwrite'); tx.objectStore('assets').clear();
        tx.oncomplete=()=>resolve(); tx.onerror=()=>reject(tx.error);
    });
}
beforeEach(async () => { await clearAssets(); localStorage.clear(); });

async function archive(data: Record<string, unknown>, zip = new JSZip(), prewrittenStores = {}) {
    const refs = new Set<string>();
    await writeV2Backup(zip, data, {prewrittenStores,onSerialized:s=>collectBlobRefs(s,refs)});
    expect((await writeBlobsToZip(zip,refs,getBlobForRef)).missing).toEqual([]);
    const loaded = await JSZip.loadAsync(await zip.generateAsync({type:'uint8array'}));
    const restored = await assembleV2Backup(loaded,JSON.parse(await loaded.file('manifest.json')!.async('string')));
    // Simulate moving to a device without the original image bytes.
    for (const token of refs) { await deleteBlobRef(token); expect(await getBlobForRef(token)).toBeNull(); }
    await restoreBlobsFromZip(loaded,await readBlobsIndex(loaded),restoreBlobRef);
    return restored;
}

describe('October release: Settings backup categories', () => {
    it('preserves local covers in full and media archives while excluding them from text backups', async () => {
        const token=await putImageBlob(new Blob(['cover-pixels'],{type:'image/png'}));
        const original=feed(token);
        original.settings={...defaultFriendFeedSettings(),coverImages:{user:token}};
        expect(JSON.stringify(stripBackupImages(original))).not.toContain('blobref:');
        const restored=await archive({friendFeedMedia:collectFriendFeedMedia(original)});
        expect(await (await getBlobForRef(token))!.text()).toBe('cover-pixels');
        const current=feed(token);current.settings={...defaultFriendFeedSettings(),theme:'insta',userNickname:'新网名'};
        const merged=applyFriendFeedMedia(current,restored.friendFeedMedia as any);
        expect(merged.settings).toMatchObject({theme:'insta',userNickname:'新网名',coverImages:{user:token}});
        expect(applyFriendFeedMedia(merged,{version:1,posts:[]}).settings?.coverImages).toEqual({user:token});
        const full=await archive({friendFeed:original});
        expect((full.friendFeed as FriendFeedState).settings?.coverImages).toEqual({user:token});
        expect(await (await getBlobForRef(token))!.text()).toBe('cover-pixels');
        expect(()=>applyFriendFeedMedia(current,{version:1,posts:[],coverImages:{user:'https://invalid.test/cover'}})).toThrow('封面');
    });
    it('text archive preserves Bibi text/cards, API, requests, visits and secrets without local images', async () => {
        const records = [
            {id:'friend_feed_api',data:JSON.stringify({baseUrl:'https://example.test',apiKey:'test-key',model:'test'})},
            {id:'friend_feed_eval_v1_char',data:JSON.stringify({requests:[{id:'request',done:true}]})},
            {id:'home_visits_v1',data:JSON.stringify({version:1,visits:[{id:'visit',purpose:'来过万圣节'}]})},
            {id:'home_secrets_v1_char',data:JSON.stringify({requests:[],secrets:[{id:'secret',text:'一起做南瓜灯'}]})},
        ];
        for (const row of records) await DB.saveAsset(row.id,row.data);
        await DB.saveAsset('wallpaper','blobref:excluded-image');
        await DB.saveAsset(FRIEND_FEED_KEY,JSON.stringify(feed()));
        const zip = new JSZip();
        const textStore = await streamBackupArrayStore(zip,'assets','activityTextAssets',{transform:exportActivityTextAsset});
        const restored = await archive({collaborationBackupMode:'text_only',friendFeed:stripBackupImages(feed())},zip,{activityTextAssets:textStore});
        expect(JSON.stringify(restored)).not.toContain('blobref:');
        expect(restored).not.toHaveProperty('assets');
        await clearAssets();
        await DB.importFullData(restored as any);
        for (const row of records) expect(await DB.getAsset(row.id)).toBe(row.data);
        expect((await currentFeed()).posts[0]).toMatchObject({text:'新的日常',imageCards:feed().posts[0].imageCards,images:[{url:'',thumbnail:''}]});
        expect(await DB.getAsset('wallpaper')).toBeNull();
    });

    it('media ZIP restores Bibi image bytes without overwriting newer posts, comments, API or home records', async () => {
        const pixels = new Uint8Array([137,80,78,71]);
        const token = await putImageBlob(new Blob([pixels],{type:'image/png'}));
        const restored = await archive({collaborationBackupMode:'media_only',assets:[{id:'media-test',data:'new-image'}],friendFeedMedia:collectFriendFeedMedia(feed(token))});
        const current = stripBackupImages(feed()) as FriendFeedState;
        current.posts[0].text='导出之后改过的正文';
        current.posts[0].comments=[{id:'reply',authorId:'user',authorName:'我',text:'后来写的评论',createdAt:124}];
        current.posts.push({...current.posts[0],id:'new-post',text:'新帖子'});
        await DB.saveAsset(FRIEND_FEED_KEY,JSON.stringify(current));
        await DB.saveAsset('home_visits_v1','keep-visits');
        await DB.saveAsset('home_secrets_v1_char','keep-secrets');
        await DB.saveAsset('friend_feed_api','keep-api');
        await DB.saveAsset('unrelated-setting','keep-setting');
        await DB.importFullData(restored as any);
        expect(await currentFeed()).toEqual({...current,posts:[{...current.posts[0],images:[{url:token,thumbnail:token}]},current.posts[1]]});
        for(const [key,value] of [['home_visits_v1','keep-visits'],['home_secrets_v1_char','keep-secrets'],['friend_feed_api','keep-api'],['unrelated-setting','keep-setting']]) expect(await DB.getAsset(key)).toBe(value);
        expect(await DB.getAsset('media-test')).toBe('new-image');
        expect(new Uint8Array(await (await getBlobForRef(token))!.arrayBuffer())).toEqual(pixels);
    });

    it('old media archives with full feed records restore only matching post pictures', async () => {
        const current=feed('blobref:current'); current.posts[0].text='保留当前正文';
        await DB.saveAsset(FRIEND_FEED_KEY,JSON.stringify(current));
        await DB.saveAsset('friend_feed_api','current-api');
        await DB.importFullData({collaborationBackupMode:'media_only',assets:[
            {id:FRIEND_FEED_KEY,data:JSON.stringify(feed('blobref:old-photo'))},
            {id:'friend_feed_api',data:'old-api'},
        ]} as any);
        expect((await currentFeed()).posts[0]).toMatchObject({text:'保留当前正文',images:[{url:'blobref:old-photo',thumbnail:'blobref:old-photo'}]});
        expect(await DB.getAsset('friend_feed_api')).toBe('current-api');
    });

    it('empty activity text sections replace only their own records; unknown keys are rejected', async () => {
        await DB.saveAsset('home_visits_v1','old'); await DB.saveAsset('wallpaper','keep');
        await DB.importFullData({activityTextAssets:[]} as any);
        expect(await DB.getAsset('home_visits_v1')).toBeNull(); expect(await DB.getAsset('wallpaper')).toBe('keep');
        await expect(DB.importFullData({activityTextAssets:[{id:'wallpaper',data:'poison'}]} as any)).rejects.toThrow('活动文字');
        expect(await DB.getAsset('wallpaper')).toBe('keep');
        expect(()=>applyFriendFeedMedia(feed(),{version:1,posts:[{id:'post',images:[{url:'javascript:bad',thumbnail:'javascript:bad'}]}]})).toThrow();
        expect(isActivityTextAsset('some_other_asset')).toBe(false);
    });

    it('full ZIP restores the original feed with media and activity asset records', async () => {
        const token=await putImageBlob(new Blob(['test-photo'],{type:'image/png'}));
        const original=feed(token);
        await DB.saveAsset(FRIEND_FEED_KEY,JSON.stringify(original));
        await DB.saveAsset('home_visits_v1',JSON.stringify({version:1,visits:[]}));
        await DB.saveAsset('friend_feed_api',JSON.stringify({baseUrl:'https://example.test',apiKey:'test',model:'test'}));
        const assets=await DB.getRawStoreData('assets');
        const restored=await archive({collaborationBackupMode:'full',assets});
        await clearAssets(); await DB.importFullData(restored as any);
        expect(await currentFeed()).toEqual(original);
        expect(await DB.getRawStoreData('assets')).toEqual(assets);
        expect(await (await getBlobForRef(token))!.text()).toBe('test-photo');
    });

    it.each(['text_only','full'])('%s ZIP retains Halloween candy, costume removal, dialogue receipts, fish hats and the dinosaur garden', async mode => {
        const at=new Date(2026,9,29,12).getTime(),user={id:'user',name:'我',kind:'user' as const};
        let state=assignHalloweenCostume(createFishingMarketState(5),'char','initial',at,()=>0);
        state=assignHalloweenCostume(state,'char','remove',at);
        state=giveHalloweenCandy(state,at,()=>0).state;
        state=finishHalloweenDialogue(finishHalloweenDialogue(state,'aiven','我',false,at),'caian','我',false,at,()=>0);
        state=addCatchToState(state,rollFishingCatch(user,{kind:'clear',label:'晴',detail:'',source:'simulated'},()=>0,at));
        state=ensureDinosaurGarden(state,user,at);
        saveFishingMarketState(state);
        const expected=readFishingMarketState();
        const restored=await archive({collaborationBackupMode:mode,sarLocalState:collectSARLocalBackup()});
        localStorage.clear(); restoreSARLocalBackup(restored.sarLocalState as any,{replaceMissing:true});
        const actual=readFishingMarketState();
        expect(actual).toEqual(expected);
        expect(actual.kanataHalloween).toMatchObject({costumes:{char:null},completed:['aiven','caian'],candies:{'pumpkin-caramel':2}});
        expect(actual.inventory.some(c=>c.halloweenHat)).toBe(true);
        expect(Object.values(actual.dinosaurGarden!.toys).some(t=>t.speciesId==='halloween-dinosaur'&&t.paint.body==='#42364f')).toBe(true);
        expect(sarCollectionEntries(actual,'user')).toEqual(sarCollectionEntries(expected,'user'));
        expect(finishHalloweenDialogue(actual,'aiven','我',false,at)).toBe(actual);
        restoreSARLocalBackup(undefined,{replaceMissing:false}); expect(readFishingMarketState()).toEqual(actual);
    });

    it('Settings export uses the tested category filters and feed image split', () => {
        const source=readFileSync('context/OSContext.tsx','utf8');
        expect(source).toContain("friendFeed: mode === 'text_only' ? stripBackupImages(await readFriendFeed())");
        expect(source).toContain("friendFeedMedia: mode === 'media_only' ? collectFriendFeedMedia(await readFriendFeed())");
        expect(source).toContain("if (mode === 'text_only') return exportActivityTextAsset(item)");
        expect(source).toContain("mode === 'media_only' && typeof id === 'string' && isActivityTextAsset(id)");
    });
});
