import React, { useCallback, useEffect, useRef, useState } from 'react';
import ConfirmDialog from '../components/os/ConfirmDialog';

export interface ConfirmRequestOptions {
    title: string;
    message: React.ReactNode;
    confirmText?: string;
    cancelText?: string;
    variant?: 'danger' | 'warning' | 'info';
    confirmDelaySeconds?: number;
}

/**
 * 基于 Promise 的应用内二次确认 Hook。
 * 页面级组件可直接默认渲染（便于限定在家园小手机作用域及常规单测宿主节点内）；
 * 若调用方自身位于 <Modal> 或带 transform 的抽屉内部，请传 `{ portal: true }`。
 */
export function useConfirmDialog(options?: { portal?: boolean; zIndex?: number }): {
    requestConfirm: (req: ConfirmRequestOptions) => Promise<boolean>;
    confirmDialog: React.ReactNode;
} {
    const [pending, setPending] = useState<ConfirmRequestOptions | null>(null);
    const resolverRef = useRef<((confirmed: boolean) => void) | null>(null);

    // 必须在调用 resolve 前先清空 ref 和状态，否则确认后连续弹第二个确认框时会被旧 settle 清掉。
    const settle = useCallback((confirmed: boolean) => {
        const resolve = resolverRef.current;
        resolverRef.current = null;
        setPending(null);
        resolve?.(confirmed);
    }, []);

    const requestConfirm = useCallback((req: ConfirmRequestOptions): Promise<boolean> => {
        if (resolverRef.current) {
            const prevResolve = resolverRef.current;
            resolverRef.current = null;
            prevResolve(false);
        }
        return new Promise<boolean>((resolve) => {
            resolverRef.current = resolve;
            setPending(req);
        });
    }, []);

    useEffect(() => {
        return () => {
            const resolve = resolverRef.current;
            resolverRef.current = null;
            resolve?.(false);
        };
    }, []);

    const confirmDialog = (
        <ConfirmDialog
            isOpen={!!pending}
            title={pending?.title ?? ''}
            message={pending?.message ?? ''}
            confirmText={pending?.confirmText ?? '确认'}
            cancelText={pending?.cancelText ?? '取消'}
            variant={pending?.variant ?? 'danger'}
            confirmDelaySeconds={pending?.confirmDelaySeconds}
            portal={options?.portal}
            zIndex={options?.zIndex}
            onConfirm={() => settle(true)}
            onCancel={() => settle(false)}
        />
    );

    return { requestConfirm, confirmDialog };
}
