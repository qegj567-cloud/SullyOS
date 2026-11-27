import {afterEach, expect, it, vi} from 'vitest';
import JSZip from 'jszip';
import {DB} from './db';
import {dataUrlToBlob, getBlobForRef, restoreBlobRef, deleteBlobRef, resolveBlobRefsDeep} from './blobRef';
import {localizeCssImages, portableCssImages, resolveCssImageUrls} from './cssImageAssets';
import {decorationPatches, portableDecoration, snapshotDecoration, exportDecoration, type DecorationPreset} from './chatDecoration';
import {decorationSourceKey} from './beautyUsage';
import {saveLibraryDecoration, readLibraryDecorations, deleteLibraryDecoration, readDecorationOrigin} from './decorationLibrary';
import {collectBlobRefs, writeBlobsToZip, readBlobsIndex, restoreBlobsFromZip} from './backupBlobs';
import {runBlobGc} from './blobGc';
import {PRESET_THEMES} from '../components/chat/ChatConstants';

const image = 'data:image/webp;base64,UklGRgAAAABXRUJQ';
const css = `.sully-chat-avatar-wrap::after {background: url('${image}');mask:URL( ${image} );color:red}`;
const preset: DecorationPreset = {format:'sullyos-chat-decoration',version:1,name:'透明动画框',parts:{css}};
afterEach(() => vi.restoreAllMocks());

it('stores original bytes once, preserves quoting and identity, and exports portable CSS', async () => {
    const local = await localizeCssImages(css);
    const refs = new Set<string>(); collectBlobRefs(local, refs);
    expect(refs.size).toBe(1);
    expect(local).not.toContain('base64');
    const blob = await getBlobForRef([...refs][0]);
    expect(blob?.type).toBe('image/webp');
    expect(await blob?.arrayBuffer()).toEqual(await dataUrlToBlob(image).arrayBuffer());
    expect(await localizeCssImages(local)).toBe(local);
    expect(await portableCssImages(local)).toBe(css);
    expect(await decorationSourceKey({...preset,parts:{css:local}})).toBe(await decorationSourceKey(preset));
    const exported = await portableDecoration({...preset,parts:{css:local}});
    expect(exported).toEqual(preset);
    const character = {chromeCustomCss:local,avatar:[...refs][0]};
    await resolveBlobRefsDeep(character);
    expect(character).toEqual({chromeCustomCss:css,avatar:image});
});

it('ignores comments, string literals, remote images and malformed URLs; handles large embedded images linearly', async () => {
    const ignored = `/* url('${image}') */ .x{content:"url('${image}')";background:url(https://example.com/a.png)}`;
    expect(await localizeCssImages(ignored)).toBe(ignored);
    expect(await localizeCssImages('.x{background:url("unterminated')).toBe('.x{background:url("unterminated');
    const large = '.x{background:url("data:image/png;base64,' + 'AAAA'.repeat(500_000) + '")}';
    const local = await localizeCssImages(large);
    expect(local.length).toBeLessThan(150);
    expect((await portableCssImages(local)).length).toBe(large.length);
});

it('keeps CSS local through save, apply and editable snapshots; portable exports still contain the image', async () => {
    const id = await saveLibraryDecoration(preset,{kind:'self',credit:'作者'});
    const saved = (await readLibraryDecorations()).find(p => p._libraryId === id)!;
    expect(saved.parts.css).toContain('blobref:');
    expect(await readDecorationOrigin(id)).toMatchObject({kind:'self',credit:'作者'});
    const char:any = {id:'frame-char',name:'测试角色'}; const theme:any = {};
    const patches = await decorationPatches(saved,['css'],'character',char,theme);
    expect(patches.character.chromeCustomCss).toBe(saved.parts.css);
    const current = {...char,...patches.character};
    expect((await snapshotDecoration('当前搭配',theme,current,PRESET_THEMES.default)).parts.css).toBe(saved.parts.css);
    expect((await exportDecoration('分享搭配',theme,current,PRESET_THEMES.default)).parts.css).toBe(css);
    expect((await decorationPatches(preset,['css'],'global',char,theme)).theme.chatChromeCustomCss).toBe(saved.parts.css);
    await deleteLibraryDecoration(id);
});

it('resolves frame images after escaped generated selectors in the preview stylesheet', async () => {
    const prefix = String.raw`.before\:content-\[\'\'\]::before{content:''}.escaped\"quote{color:red}`;
    const local = await localizeCssImages(prefix + css);
    expect(local).not.toContain('base64');
    const create = vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:frame');
    vi.spyOn(URL,'revokeObjectURL').mockImplementation(() => {});
    const resolved = await resolveCssImageUrls(local);
    expect(resolved.css).toContain(prefix);
    expect(resolved.css).not.toContain('blobref:');
    expect(create).toHaveBeenCalledTimes(1);
    resolved.dispose();
    expect(await portableCssImages(local)).toBe(prefix + css);
});

it('backs up CSS references and protects images still used by a character after deleting the preset', async () => {
    const token = 'blobref:img_css_backup';
    await restoreBlobRef(token,dataUrlToBlob(image));
    const local = css.replaceAll(image,token);
    const id = await saveLibraryDecoration({...preset,parts:{css:local}},{kind:'self'});
    const refs = new Set<string>(); collectBlobRefs(JSON.stringify(await DB.exportFullData()),refs);
    expect(refs.has(token)).toBe(true);
    const zip = new JSZip(); await writeBlobsToZip(zip,new Set([token]),getBlobForRef);
    await deleteBlobRef(token);
    const archive = await JSZip.loadAsync(await zip.generateAsync({type:'uint8array'}));
    await restoreBlobsFromZip(archive,await readBlobsIndex(archive),restoreBlobRef);
    expect(await portableCssImages(local)).toBe(css);
    await DB.saveCharacter({id:'css-gc-character',name:'测试',chromeCustomCss:local} as any);
    await deleteLibraryDecoration(id);
    // 孤儿回收只在确认只有这一个页面开着时才做；测试进程里没有页面会话锁，这里补上这个前提
    vi.spyOn(navigator.locks, 'query').mockResolvedValue({ held: [{ name: 'sully-user-space-session:default', mode: 'shared', clientId: 'this-page' }], pending: [] });
    expect((await runBlobGc({minAgeMs:0})).aborted).toBe(false);
    expect(await getBlobForRef(token)).not.toBeNull();
});

it('deduplicates object URLs per consumer, releases them on failure, and refuses missing exports', async () => {
    const local = await localizeCssImages(css);
    const create = vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:frame');
    const revoke = vi.spyOn(URL,'revokeObjectURL').mockImplementation(() => {});
    const result = await resolveCssImageUrls(local);
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.css.match(/blob:frame/g)).toHaveLength(2);
    result.dispose(); result.dispose(); expect(revoke).toHaveBeenCalledTimes(1);
    const broken = local + '.missing{background:url("blobref:img_missing")}';
    await expect(resolveCssImageUrls(broken)).rejects.toThrow('丢失');
    expect(revoke).toHaveBeenCalledTimes(2);
    await expect(portableCssImages(broken)).rejects.toThrow('丢失');
    const partial = await resolveCssImageUrls(broken,true);
    expect(partial.css).toContain('.missing{background:url("")}');
    partial.dispose();
});

it('does not save a preset when its image cannot be persisted', async () => {
    const before = await readLibraryDecorations();
    vi.spyOn(DB,'putBlobAsset').mockRejectedValue(new Error('空间不足'));
    const newImage = 'data:image/png;base64,YW5vdGhlcg==';
    await expect(saveLibraryDecoration({...preset,parts:{css:css.replaceAll(image,newImage)}},{kind:'self'})).rejects.toThrow('空间不足');
    expect(await readLibraryDecorations()).toEqual(before);
});
