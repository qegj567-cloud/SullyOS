import { SAR_EXPRESSIONS, type SARCastExpressions, type SARExpression } from '../sarArt';
import { familiarityScene } from './catalog';
import { dialogueSentences } from './dialogueText';
import type { FamiliarityNpc } from './types';
import { isSARExpressionReviewEnabled } from './devPreview';

export type ExpressionAddress = {
    sceneId: string;
    nodeId: string;
    line: number;
    sentence: number;
    npc: FamiliarityNpc;
};

export type ExpressionEdit = ExpressionAddress & {
    /** Authored strings, before user-name / scene-variable substitution. */
    text: string;
    sentenceText: string;
    before: SARExpression;
    after: SARExpression;
};

export type ExpressionSource = {
    text: string;
    sentenceText: string;
    sourcePath: string;
};

const buildBranch = () => typeof __BUILD_BRANCH__ === 'string' ? __BUILD_BRANCH__ : 'unknown';
const buildCommit = () => typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : 'unknown';
export const EXPRESSION_REVIEW_STORAGE_KEY = `sullyos.devDebug.sarExpressionReview.v1.${buildBranch().trim().replace(/[^a-z0-9._-]+/gi, '_') || 'unknown'}`;
const EXPRESSION_REVIEW_EVENT = 'sullyos-sar-expression-review-change';

/** A temporary local authoring tool; production debug-panel unlock does not enable it. */
export const isExpressionReviewAvailable = isSARExpressionReviewEnabled;

function assertAvailable(): void {
    if (!isExpressionReviewAvailable()) throw new Error('表情修改器仅在本地开发模式可用。');
}

function isAddress(value: unknown): value is ExpressionAddress {
    if (!value || typeof value !== 'object') return false;
    const a = value as ExpressionAddress;
    return typeof a.sceneId === 'string' && a.sceneId.length > 0
        && typeof a.nodeId === 'string' && a.nodeId.length > 0
        && Number.isSafeInteger(a.line) && a.line >= 0
        && Number.isSafeInteger(a.sentence) && a.sentence >= 0
        && (a.npc === 'caian' || a.npc === 'aiven');
}

function isAllowed(npc: FamiliarityNpc, expression: unknown): expression is SARExpression {
    return typeof expression === 'string' && (SAR_EXPRESSIONS[npc] as readonly string[]).includes(expression);
}

function isEdit(value: unknown): value is ExpressionEdit {
    if (!isAddress(value)) return false;
    const e = value as ExpressionEdit;
    return typeof e.text === 'string' && typeof e.sentenceText === 'string'
        && isAllowed(e.npc, e.before) && isAllowed(e.npc, e.after);
}

/** JSON tuples avoid collisions when a source node name contains punctuation. */
export const expressionEditKey = (address: ExpressionAddress): string =>
    JSON.stringify([address.sceneId, address.nodeId, address.line, address.sentence, address.npc]);

export const addressEquals = (a: ExpressionAddress, b: ExpressionAddress): boolean =>
    expressionEditKey(a) === expressionEditKey(b);

function sourcePath(sceneId: string): string {
    const npc = familiarityScene(sceneId)?.npc || (sceneId.startsWith('C') ? 'caian' : sceneId.startsWith('A') ? 'aiven' : null);
    return npc ? `utils/vrWorld/sarFamiliarity/${npc}.ts` : 'utils/vrWorld/sarFamiliarity/catalog.ts';
}

/** Resolve against original prose, never rendered text containing the user's name. */
export function expressionEditSource(address: ExpressionAddress): ExpressionSource | null {
    if (!isAddress(address)) return null;
    const scene = familiarityScene(address.sceneId);
    const node = scene && Object.prototype.hasOwnProperty.call(scene.nodes, address.nodeId) ? scene.nodes[address.nodeId] : undefined;
    const authoredLine = node?.lines[address.line];
    if (!authoredLine) return null;
    const sentenceText = dialogueSentences(authoredLine.text)[address.sentence];
    if (sentenceText === undefined) return null;
    return { text: authoredLine.text, sentenceText, sourcePath: sourcePath(address.sceneId) };
}

export function expressionEditStaleReason(edit: ExpressionEdit): string | null {
    if (!isEdit(edit)) return '修改记录的地址或表情无效。';
    const source = expressionEditSource(edit);
    if (!source) return '原稿中的场景、行或句子已不存在。';
    if (source.text !== edit.text) return '原稿台词已变化，需要人工核对。';
    if (source.sentenceText !== edit.sentenceText) return '原稿分句已变化，需要人工核对。';
    return null;
}

export const isExpressionEditStale = (edit: ExpressionEdit): boolean => expressionEditStaleReason(edit) !== null;

/** Explicit fields also keep unrelated caller properties out of persistence / exports. */
function copyEdit(e: ExpressionEdit): ExpressionEdit {
    return {
        sceneId: e.sceneId, nodeId: e.nodeId, line: e.line, sentence: e.sentence, npc: e.npc,
        text: e.text, sentenceText: e.sentenceText, before: e.before, after: e.after,
    };
}

function validateEdits(value: unknown): ExpressionEdit[] {
    if (!Array.isArray(value)) throw new Error('表情修改记录格式损坏，请先备份原记录再处理。');
    const keys = new Set<string>();
    return value.map(edit => {
        if (!isEdit(edit) || keys.has(expressionEditKey(edit))) {
            throw new Error('表情修改记录包含无效或重复条目，请先备份原记录再处理。');
        }
        keys.add(expressionEditKey(edit));
        return copyEdit(edit);
    });
}

export function readExpressionEdits(): ExpressionEdit[] {
    if (!isExpressionReviewAvailable()) return [];
    let raw: string | null;
    try { raw = localStorage.getItem(EXPRESSION_REVIEW_STORAGE_KEY); }
    catch { throw new Error('无法读取本地表情修改记录，请检查浏览器存储权限。'); }
    if (raw === null) return [];
    let saved: unknown;
    try { saved = JSON.parse(raw); }
    catch { throw new Error('表情修改记录格式损坏，请先备份原记录再处理。'); }
    if (!saved || typeof saved !== 'object' || (saved as { version?: unknown }).version !== 1) {
        throw new Error('表情修改记录版本无效，请先备份原记录再处理。');
    }
    // Stale but well-formed entries remain available for export and targeted reset.
    return validateEdits((saved as { edits?: unknown }).edits);
}

function persist(edits: ExpressionEdit[]): void {
    try { localStorage.setItem(EXPRESSION_REVIEW_STORAGE_KEY, JSON.stringify({ version: 1, edits })); }
    catch { throw new Error('表情修改保存失败，请检查浏览器存储权限或剩余空间。'); }
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(EXPRESSION_REVIEW_EVENT));
}

export function writeExpressionEdit(address: ExpressionAddress, before: SARExpression, after: SARExpression): void {
    assertAvailable();
    if (!isAddress(address)) throw new Error('表情修改的句子地址无效。');
    if (!isAllowed(address.npc, before) || !isAllowed(address.npc, after)) throw new Error('该角色没有这个表情。');
    const source = expressionEditSource(address);
    if (!source) throw new Error('原稿句子不存在，请重新打开回忆。');
    const edits = readExpressionEdits();
    const existing = edits.find(edit => addressEquals(edit, address));
    if (existing && isExpressionEditStale(existing)) throw new Error('此处的旧修改已过期，请先导出并撤回，再修改新原稿。');
    const original = existing?.before ?? before;
    const remaining = edits.filter(edit => !addressEquals(edit, address));
    if (after !== original) remaining.push(copyEdit({ ...address, text: source.text, sentenceText: source.sentenceText, before: original, after }));
    persist(remaining);
}

export function resetExpressionEdit(address: ExpressionAddress): void {
    assertAvailable();
    if (!isAddress(address)) throw new Error('表情修改的句子地址无效。');
    const edits = readExpressionEdits();
    const remaining = edits.filter(edit => !addressEquals(edit, address));
    if (remaining.length !== edits.length) persist(remaining);
}

export function subscribeExpressionEdits(listener: () => void): () => void {
    if (!isExpressionReviewAvailable() || typeof window === 'undefined') return () => {};
    const notify = () => { if (isExpressionReviewAvailable()) listener(); };
    const onStorage = (event: StorageEvent) => {
        if ((event.key === EXPRESSION_REVIEW_STORAGE_KEY || event.key === null)
            && (!event.storageArea || event.storageArea === localStorage)) notify();
    };
    window.addEventListener(EXPRESSION_REVIEW_EVENT, notify);
    window.addEventListener('storage', onStorage);
    return () => {
        window.removeEventListener(EXPRESSION_REVIEW_EVENT, notify);
        window.removeEventListener('storage', onStorage);
    };
}

export function expressionOverrides(
    edits: readonly ExpressionEdit[], sceneId: string, nodeId: string, line: number, sentence: number,
): Partial<SARCastExpressions> {
    if (!isExpressionReviewAvailable()) return {};
    const result: Partial<SARCastExpressions> = {};
    for (const edit of edits) {
        if (!isEdit(edit) || edit.sceneId !== sceneId || edit.nodeId !== nodeId
            || edit.line !== line || edit.sentence !== sentence || isExpressionEditStale(edit)) continue;
        if (edit.npc === 'caian') result.caian = edit.after as SARCastExpressions['caian'];
        else result.aiven = edit.after as SARCastExpressions['aiven'];
    }
    return result;
}

export function exportExpressionEdits(edits: readonly ExpressionEdit[]): string {
    assertAvailable();
    return JSON.stringify({
        version: 1,
        kind: 'sar-expression-review',
        build: { branch: buildBranch(), commit: buildCommit() },
        edits: validateEdits(edits).map(edit => {
            const staleReason = expressionEditStaleReason(edit);
            return { sourcePath: sourcePath(edit.sceneId), ...edit, stale: staleReason !== null, staleReason };
        }),
    }, null, 2);
}
