// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});

afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
});

const Harness: React.FC<{
    portal?: boolean;
    onResult: (value: boolean) => void;
    chained?: boolean;
}> = ({ portal, onResult, chained }) => {
    const { requestConfirm, confirmDialog } = useConfirmDialog({ portal });
    const run = async () => {
        const first = await requestConfirm({
            title: '第一步确认',
            message: '确定执行吗？',
            confirmText: '确认第一步',
        });
        if (!chained || !first) {
            onResult(first);
            return;
        }
        const second = await requestConfirm({
            title: '第二步确认',
            message: '真的不可恢复，再点一次确认。',
            confirmText: '确认第二步',
        });
        onResult(second);
    };
    return React.createElement(
        'div',
        null,
        React.createElement('button', { type: 'button', onClick: () => void run() }, '触发'),
        confirmDialog,
    );
};

const findButton = (scope: ParentNode, text: string) =>
    Array.from(scope.querySelectorAll('button')).find(btn => btn.textContent?.trim() === text);

describe('useConfirmDialog', () => {
    it('resolves false on cancel and true on confirm', async () => {
        const results: boolean[] = [];
        await act(async () => {
            root.render(React.createElement(Harness, { onResult: v => results.push(v) }));
        });

        await act(async () => findButton(host, '触发')!.click());
        expect(host.querySelector('[role="dialog"]')?.textContent).toContain('第一步确认');
        await act(async () => findButton(host, '取消')!.click());
        expect(results).toEqual([false]);
        expect(host.querySelector('[role="dialog"]')).toBeNull();

        await act(async () => findButton(host, '触发')!.click());
        await act(async () => findButton(host, '确认第一步')!.click());
        expect(results).toEqual([false, true]);
    });

    it('supports chained two-step confirmations without dropping the second dialog', async () => {
        const results: boolean[] = [];
        await act(async () => {
            root.render(React.createElement(Harness, { chained: true, onResult: v => results.push(v) }));
        });

        await act(async () => findButton(host, '触发')!.click());
        await act(async () => findButton(host, '确认第一步')!.click());
        expect(host.querySelector('[role="dialog"]')?.textContent).toContain('第二步确认');

        await act(async () => findButton(host, '确认第二步')!.click());
        expect(results).toEqual([true]);
        expect(host.querySelector('[role="dialog"]')).toBeNull();
    });

    it('renders into document.body when portal is enabled', async () => {
        const results: boolean[] = [];
        await act(async () => {
            root.render(React.createElement(Harness, { portal: true, onResult: v => results.push(v) }));
        });

        await act(async () => findButton(host, '触发')!.click());
        expect(host.querySelector('[role="dialog"]')).toBeNull();
        expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('第一步确认');

        await act(async () => findButton(document.body, '确认第一步')!.click());
        expect(results).toEqual([true]);
    });

    it('stops click propagation from portal back to parent click handlers', async () => {
        const parentClick = vi.fn();
        const results: boolean[] = [];
        const Wrapped: React.FC = () =>
            React.createElement(
                'div',
                { onClick: parentClick },
                React.createElement(Harness, { portal: true, onResult: v => results.push(v) }),
            );
        await act(async () => {
            root.render(React.createElement(Wrapped));
        });

        await act(async () => findButton(host, '触发')!.click());
        parentClick.mockClear();

        await act(async () => findButton(document.body, '取消')!.click());
        expect(results).toEqual([false]);
        expect(parentClick).not.toHaveBeenCalled();
    });

    it('cancels on Escape and stops propagation to outer Escape listeners', async () => {
        const outerEscape = vi.fn();
        const onWindowEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') outerEscape();
        };
        window.addEventListener('keydown', onWindowEscape);
        try {
            const results: boolean[] = [];
            await act(async () => {
                root.render(React.createElement(Harness, { portal: true, onResult: v => results.push(v) }));
            });
            await act(async () => findButton(host, '触发')!.click());
            expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

            await act(async () => {
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            });
            expect(results).toEqual([false]);
            expect(outerEscape).not.toHaveBeenCalled();
        } finally {
            window.removeEventListener('keydown', onWindowEscape);
        }
    });

    it('lifts portal confirm into a native top-layer dialog when another modal dialog is open', async () => {
        const outerDialog = document.createElement('dialog');
        outerDialog.setAttribute('open', '');
        document.body.append(outerDialog);
        try {
            const results: boolean[] = [];
            await act(async () => {
                root.render(React.createElement(Harness, { portal: true, onResult: v => results.push(v) }));
            });
            await act(async () => findButton(host, '触发')!.click());
            const topWrapper = document.body.querySelector('dialog[data-sully-confirm-top-layer]');
            expect(topWrapper).not.toBeNull();
            expect(topWrapper?.querySelector('[role="dialog"]')?.textContent).toContain('第一步确认');

            await act(async () => findButton(document.body, '确认第一步')!.click());
            expect(results).toEqual([true]);
            expect(document.body.querySelector('dialog[data-sully-confirm-top-layer]')).toBeNull();
        } finally {
            outerDialog.remove();
        }
    });
});
