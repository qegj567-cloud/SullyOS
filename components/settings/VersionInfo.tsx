import React, { useEffect, useRef, useState } from 'react';
import { querySwVersion } from '../../utils/swVersion';
import { APP_VERSION, BUILD_LABEL } from '../../utils/buildInfo';
import { isDevDebugAvailable, subscribeDevDebugAvailability, unlockDevDebug } from '../../utils/devDebug';

/**
 * Settings 底部的版本信息脚注。
 *
 * 与右下角的 BuildBadge 不同：BuildBadge 只在 dev / fork 构建可见（正式版树摇掉），
 * 这里在**所有**构建（含正式版）里都低调显示，方便用户截图报障时附带版本上下文：
 *   - APP_VERSION：手工维护的产品版本名（之前硬编码的 v2.2）
 *   - build：vite.config 注入的 __BUILD_BRANCH__@__BUILD_COMMIT__
 *   - sw：运行时向 Service Worker 查询的 SW_VERSION
 *
 * 构建全局（__BUILD_BRANCH__ 等）由 vite define 始终注入，prod 也有值，
 * 所以无需任何 dev 条件判断。SW 未注册 / 未响应时 sw 显示 '?'。
 *
 * 彩蛋（dev 附加）：连点 APP_VERSION 5 下手动解锁 DevDebug 面板——正式版默认隐藏，
 * 这是在正式版上临时调出调试工具排障的入口（会话级，刷新即关；面板内有「关闭」按钮可随时强制关掉）。
 * 面板已可用时（非 prod / 已解锁）再点不计数。
 */

const UNLOCK_TAP_COUNT = 5;
const TAP_RESET_MS = 2000;

const VersionInfo: React.FC = () => {
    const [swVersion, setSwVersion] = useState<string>('…');
    // available = 面板当前是否可用（非 prod 默认 true；prod 解锁后 true；强制关闭后 false）。
    const [available, setAvailable] = useState<boolean>(() => isDevDebugAvailable());
    const [hint, setHint] = useState<string | null>(null);
    const tapCountRef = useRef(0);
    const tapTimerRef = useRef<number | null>(null);
    const hintTimerRef = useRef<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        querySwVersion().then((v) => { if (!cancelled) setSwVersion(v); });
        return () => { cancelled = true; };
    }, []);

    useEffect(() => subscribeDevDebugAvailability(setAvailable), []);

    // 卸载时清掉计时器，避免内存泄漏 / 卸载后 setState。
    useEffect(() => () => {
        if (tapTimerRef.current) window.clearTimeout(tapTimerRef.current);
        if (hintTimerRef.current) window.clearTimeout(hintTimerRef.current);
    }, []);

    const showHint = (text: string, ms: number) => {
        setHint(text);
        if (hintTimerRef.current) window.clearTimeout(hintTimerRef.current);
        hintTimerRef.current = window.setTimeout(() => setHint(null), ms);
    };

    const handleVersionTap = () => {
        if (available) return; // 面板已经开着（非 prod 或已解锁），不用再数
        if (tapTimerRef.current) window.clearTimeout(tapTimerRef.current);
        tapCountRef.current += 1;
        const remaining = UNLOCK_TAP_COUNT - tapCountRef.current;

        if (remaining <= 0) {
            tapCountRef.current = 0;
            unlockDevDebug();
            showHint('🔧 调试面板已解锁（刷新即关闭）', 2600);
            return;
        }
        if (remaining <= 2) showHint(`还差 ${remaining} 下…`, TAP_RESET_MS);
        // 间隔超过 TAP_RESET_MS 没继续点就重置计数。
        tapTimerRef.current = window.setTimeout(() => { tapCountRef.current = 0; }, TAP_RESET_MS);
    };

    return (
        <div className="flex flex-col items-center gap-1.5 pt-2 pb-8 select-none">
            <button
                type="button"
                onClick={handleVersionTap}
                className="text-[10px] text-slate-300 font-mono tracking-widest uppercase"
            >
                {APP_VERSION}
            </button>
            <div className="flex items-center gap-1.5 text-[9px] font-mono text-slate-400/80">
                <span className="px-1.5 py-0.5 rounded-md bg-slate-100 tracking-wide">
                    build&nbsp;<span className="text-slate-500">{BUILD_LABEL}</span>
                </span>
                <span className="px-1.5 py-0.5 rounded-md bg-slate-100 tracking-wide">
                    sw&nbsp;<span className="text-slate-500">{swVersion}</span>
                </span>
            </div>
            {hint && (
                <div className="text-[9px] font-mono text-amber-500/80 tracking-normal normal-case">
                    {hint}
                </div>
            )}
        </div>
    );
};

export default VersionInfo;
