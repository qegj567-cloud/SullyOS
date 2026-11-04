import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync('public/like520/character_creator.html', 'utf8');
const section = (start: string, end: string) => html.slice(html.indexOf(start), html.indexOf(end));
it('empty reset drafts fall through to saved state; real unfinished drafts remain recoverable', () => {
    const apply = vi.fn(() => true);
    const context = { IS_EMBEDDED: true, getDraftKey: () => 'draft', applyFullState: apply, localStorage: {getItem: () => JSON.stringify({selected:{skin:null,decor:[]}}), removeItem: vi.fn()}, console };
    const code = section('function tryLoadDraft()', 'function clearDraft()');
    expect(runInNewContext(code + ';tryLoadDraft()', context)).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    context.localStorage.getItem = () => JSON.stringify({selected:{skin:'skin_1'}});
    expect(runInNewContext(code + ';tryLoadDraft()', context)).toBe(true);
    expect(apply).toHaveBeenCalled();
});
it('restore button reapplies a full saved snapshot and never confirms or overwrites host data', () => {
    const button: any = {};
    const saved = {selected:{skin:'skin_1'}, tintColor:{skin:{color:'#f0d3bb'}}, flipped:{fronthair:true}};
    const apply = vi.fn(() => true), clear = vi.fn(), render = vi.fn();
    const code = section("document.getElementById('btnRestoreSaved').onclick", 'document.getElementById("btnSave").onclick');
    runInNewContext(code, {document:{getElementById:()=>button}, LIKE520_SAVED_STATE:saved, applyFullState:apply, clearDraft:clear, renderPanel:render, renderCharacter:render, toast:vi.fn()});
    button.onclick();
    expect(apply).toHaveBeenCalledWith(saved); expect(clear).toHaveBeenCalledOnce(); expect(render).toHaveBeenCalledTimes(2);
});
