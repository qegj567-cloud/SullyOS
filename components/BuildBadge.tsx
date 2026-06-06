import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { querySwVersion } from '../utils/swVersion';
import { BUILD_LABEL } from '../utils/buildInfo';

/**
 * 构建版本指示器：右下角阶梯式堆三行
 *   sw@<SW_VERSION>
 *   <branch>@<shortHash>
 *   开发中内容，不代表最终效果
 *
 * - 右侧贴齐成竖直线；左侧每行根据实测宽度动态决定圆角（仅在"伸出邻行"一侧）。
 *   分支名长度可变，所以行宽顺序不固定，需要 useLayoutEffect 在 paint 前测量。
 * - 仅当 vite.config 注入的 __BUILD_BADGE_VISIBLE__ 为 true 时挂载
 *   （VITE_HIDE_BUILD_BADGE=1 时构建会把它编译成 false → 树摇掉）
 * - SW 版本通过 utils/swVersion 的 GET_SW_VERSION 协议查询；SW 未注册 /
 *   不响应时显示 sw@?
 * - pointer-events-none + select-none：不可点、不可选、不影响下层交互
 * - z-[2147483647]：保证盖在所有 modal / 动画 / 全屏覆盖层之上
 * - safe-area-inset：iOS PWA 底部 home indicator 区域避让
 *
 * 注：这是 dev / fork 专用的醒目角标。正式版（main/master）会被树摇掉，
 * 但构建 / SW 版本仍通过 Settings 底部的 VersionInfo 低调展示，方便用户报障。
 */
const BuildBadge: React.FC = () => {
    if (!__BUILD_BADGE_VISIBLE__) return null;

    const buildLabel = BUILD_LABEL;
    const [swVersion, setSwVersion] = useState<string>('…');
    const lineRefs = useRef<Array<HTMLSpanElement | null>>([]);
    const [widths, setWidths] = useState<number[] | null>(null);

    useEffect(() => {
        let cancelled = false;
        querySwVersion().then((v) => { if (!cancelled) setSwVersion(v); });
        return () => { cancelled = true; };
    }, []);

    // 右侧贴齐 (rounded-tr 仅顶行, rounded-br 仅末行)。
    // 左侧逐行测宽: 仅当当前行严格宽于上 / 下邻行时, 该侧伸出, 才给圆角;
    // 等宽 / 更窄时, 邻行会覆盖到当前行外侧, 圆角会形成凹缝, 所以给方角让它们贴上。
    const lines: Array<{ text: string; cls: string }> = [
        { text: `sw@${swVersion}`, cls: 'text-[9px] tracking-wider' },
        { text: buildLabel, cls: 'text-[9px] tracking-wider' },
        { text: '开发中内容，不代表最终效果', cls: 'text-[8px] tracking-normal text-white/35' },
    ];
    const lastIdx = lines.length - 1;

    useLayoutEffect(() => {
        setWidths(lineRefs.current.map((r) => r?.offsetWidth ?? 0));
    }, [swVersion, buildLabel]);

    const cornerClass = (i: number): string => {
        const w = widths?.[i];
        const wPrev = i > 0 ? widths?.[i - 1] : undefined;
        const wNext = i < lastIdx ? widths?.[i + 1] : undefined;
        const topLeft = widths === null || (w !== undefined && (wPrev === undefined || w > wPrev));
        const bottomLeft = widths === null || (w !== undefined && (wNext === undefined || w > wNext));
        return [
            topLeft && 'rounded-tl-md',
            bottomLeft && 'rounded-bl-md',
            i === 0 && 'rounded-tr-md',
            i === lastIdx && 'rounded-br-md',
        ].filter(Boolean).join(' ');
    };

    return (
        <div
            aria-hidden
            className="fixed pointer-events-none select-none"
            style={{
                bottom: 'calc(env(safe-area-inset-bottom, 0px) + 4px)',
                right: 'calc(env(safe-area-inset-right, 0px) + 6px)',
                zIndex: 2147483647,
                touchAction: 'none',
            }}
        >
            <div
                className="font-mono text-white/45 flex flex-col items-end leading-[1.25]"
                style={{ letterSpacing: '0.05em' }}
            >
                {lines.map((line, i) => (
                    <span
                        key={i}
                        ref={(el) => { lineRefs.current[i] = el; }}
                        className={`${line.cls} px-1.5 py-[1px] bg-black/35 backdrop-blur-sm shadow-sm ${cornerClass(i)}`}
                    >
                        {line.text}
                    </span>
                ))}
            </div>
        </div>
    );
};

export default BuildBadge;
