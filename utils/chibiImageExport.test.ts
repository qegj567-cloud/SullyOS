// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CreatorIframe } from '../components/Like520Event';

const native = vi.hoisted(() => ({ enabled: false, write: vi.fn(), uri: vi.fn(), share: vi.fn() }));
vi.mock('@capacitor/core', async importOriginal => {
    const original = await importOriginal<typeof import('@capacitor/core')>();
    return { ...original, Capacitor: { ...original.Capacitor, isNativePlatform: () => native.enabled } };
});
vi.mock('@capacitor/filesystem', () => ({ Filesystem: { writeFile: native.write, getUri: native.uri }, Directory: { Cache: 'CACHE' }, Encoding: { UTF8: 'utf8' } }));
vi.mock('@capacitor/share', () => ({ Share: { share: native.share } }));
vi.mock('./creatorPartsBlob', () => ({ loadCreatorPartsForRender: async () => [], creatorPartToBlobRefs: vi.fn() }));

const html = readFileSync('public/like520/character_creator.html', 'utf8');
const exportCode = html.slice(html.indexOf('async function sharePng('), html.indexOf('function closeModal()'));
const exportData = { frame: 'data:image/png;base64,iVBORwD/', transparent: 'data:image/png;base64,iVBORwAA' };
const share = vi.fn();
let host: HTMLDivElement, root: Root;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
    vi.clearAllMocks();
    native.enabled = false;
    native.uri.mockResolvedValue({ uri: 'file:///cache/chibi.png' });
    native.share.mockResolvedValue({});
    share.mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { share, canShare: () => true });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function loadExport(embedded: boolean, frameWindow: any = { parent: { postMessage: vi.fn() } }) {
    const nodes: Record<string, any> = {
        modalImg: { classList: { toggle: vi.fn() } },
        btnDownload: { style: {}, disabled: false }, btnSavePng: { style: {}, disabled: false },
    };
    const anchor = { click: vi.fn(), remove: vi.fn() };
    const createElement = vi.fn(() => anchor), appendChild = vi.fn(), toast = vi.fn();
    const urls = { createObjectURL: vi.fn(() => 'blob:png'), revokeObjectURL: vi.fn() };
    const context = {
        window: frameWindow, navigator, document: { getElementById: (id: string) => nodes[id], createElement, body: { appendChild } },
        File, Uint8Array, atob, URL: urls, setTimeout: (fn: () => void) => fn(), console,
        exportData, IS_EMBEDDED: embedded, LIKE520_MODE: 'char', state: { selected: { skin: 'skin_01' } }, toast,
    };
    runInNewContext(exportCode + ';this.setMode = setExportMode;', context);
    return { ...(context as typeof context & { setMode: (mode: string) => void }), nodes, anchor, createElement, appendChild, urls };
}

async function mountCreator() {
    const onConfirm = vi.fn();
    await act(async () => root.render(createElement(CreatorIframe, { mode: 'char', onConfirm })));
    const iframe = host.querySelector('iframe')!;
    // ready 先于 load 时也必须连接宿主，素材尚未加载完不能挡住保存。
    await act(async () => window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { type: 'like520_ready' } })));
    expect(iframe.getAttribute('allow')).toBe('web-share');
    return { iframe, onConfirm };
}

it.each(['frame', 'transparent'] as const)('嵌入态 %s 图片立即调用文件分享，不下载也不确认形象', async mode => {
    const { iframe, onConfirm } = await mountCreator();
    const ui = loadExport(true, iframe.contentWindow);
    ui.setMode(mode);
    const pending = ui.nodes.btnSavePng.onclick();
    expect(share).toHaveBeenCalledOnce(); // 调用仍在点击的同步栈内，没有等待 postMessage/fetch。
    await pending;
    const file = share.mock.calls[0][0].files[0] as File;
    expect(file.type).toBe('image/png');
    expect(file.size).toBe(6);
    expect(file.name).toContain(mode === 'transparent' ? '无背景' : '520');
    expect(ui.createElement).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
});

it('原生壳通过宿主缓存真实 PNG 并拉起系统分享', async () => {
    native.enabled = true;
    const { iframe } = await mountCreator();
    const ui = loadExport(true, iframe.contentWindow);
    ui.setMode('transparent'); await ui.nodes.btnSavePng.onclick();
    expect(native.write.mock.calls[0][0]).toMatchObject({ data: 'iVBORwAA', directory: 'CACHE' });
    expect(native.share).toHaveBeenCalledWith({ title: '保存 Chibi 图片', files: ['file:///cache/chibi.png'] });
    expect(share).not.toHaveBeenCalled();
    expect(ui.createElement).not.toHaveBeenCalled();
});

it('重载 iframe 后重新连接分享出口，确认仍只提交选中的形象', async () => {
    const { iframe } = await mountCreator();
    delete (iframe.contentWindow as any).sullySharePng;
    await act(async () => iframe.dispatchEvent(new Event('load')));
    expect(typeof (iframe.contentWindow as any).sullySharePng).toBe('function');
    const parent = { postMessage: vi.fn() };
    const ui = loadExport(true, { parent }); ui.setMode('transparent');
    ui.nodes.btnDownload.onclick();
    expect(parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'like520_result', payload: expect.objectContaining({ dataUrl: exportData.transparent, frameDataUrl: exportData.frame }) }), '*');
    expect(share).not.toHaveBeenCalled();
});

it.each([false, true])('取消分享不补下载、不报已保存（嵌入：%s）', async embedded => {
    share.mockRejectedValue(new DOMException('cancelled', 'AbortError'));
    const frameWindow = embedded ? (await mountCreator()).iframe.contentWindow : undefined;
    const ui = loadExport(embedded, frameWindow); ui.setMode('frame');
    const button = embedded ? ui.nodes.btnSavePng : ui.nodes.btnDownload;
    await button.onclick();
    expect(ui.createElement).not.toHaveBeenCalled();
    expect(ui.toast).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
});

it('独立页面也先分享 PNG，连续点击只打开一次面板', async () => {
    let finish!: () => void;
    share.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const ui = loadExport(false); ui.setMode('transparent');
    const first = ui.nodes.btnDownload.onclick();
    await ui.nodes.btnDownload.onclick();
    expect(share).toHaveBeenCalledOnce();
    expect(share.mock.calls[0][0].files[0]).toMatchObject({ type: 'image/png', size: 6 });
    expect(ui.createElement).not.toHaveBeenCalled();
    finish(); await first;
    expect(ui.nodes.btnDownload.disabled).toBe(false);
});

it('不支持文件分享时才提供下载兜底', async () => {
    vi.stubGlobal('navigator', { share, canShare: () => false });
    const ui = loadExport(false); ui.setMode('frame'); await ui.nodes.btnDownload.onclick();
    expect(share).not.toHaveBeenCalled();
    expect(ui.appendChild).toHaveBeenCalledWith(ui.anchor);
    expect(ui.anchor.click).toHaveBeenCalledOnce();
    expect(ui.urls.revokeObjectURL).toHaveBeenCalledWith('blob:png');
    expect(ui.toast).toHaveBeenCalledWith('已发起下载，也可长按图片保存');
});

it('系统分享失败保留重试，不伪报保存成功', async () => {
    native.enabled = true;
    native.write.mockRejectedValue(new Error('disk full'));
    vi.stubGlobal('navigator', {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { iframe } = await mountCreator();
    const ui = loadExport(true, iframe.contentWindow); ui.setMode('frame'); await ui.nodes.btnSavePng.onclick();
    expect(ui.createElement).not.toHaveBeenCalled();
    expect(ui.toast).toHaveBeenCalledWith('无法保存，请重试或长按图片保存');
    expect(ui.nodes.btnSavePng.disabled).toBe(false);
});
