import React, { Component, ErrorInfo } from 'react';
import { isChunkLoadError, tryAutoReloadForChunkError } from '../../utils/chunkLoadRecovery';
import { trackEvent } from '../../utils/analytics';
import { INSTALLED_APPS, HIDDEN_APP_NAMES } from '../../constants';
import { AppID } from '../../types';

const ERROR_COPY_LABEL = '\u590d\u5236\u62a5\u9519\u4fe1\u606f';
const ERROR_COPIED_LABEL = '\u5df2\u590d\u5236';
const ERROR_MANUAL_COPY_LABEL = '\u8bf7\u624b\u52a8\u590d\u5236';
const ERROR_PROMPT_LABEL = '\u8bf7\u624b\u52a8\u590d\u5236\u62a5\u9519\u4fe1\u606f';
const ERROR_TITLE = '\u5e94\u7528\u8fd0\u884c\u9519\u8bef';
const ERROR_RETURN_LABEL = '\u8fd4\u56de\u684c\u9762';
const CHUNK_ERROR_TITLE = '\u8d44\u6e90\u52a0\u8f7d\u5931\u8d25';
const CHUNK_ERROR_HINT = '页面组件未能加载或解析，可能与网络中断或版本更新有关。可以刷新重试；如果仍然报错，请复制报错信息反馈。';
const CHUNK_ERROR_OFFLINE_HINT = '检测到网络已断开，已暂停自动刷新。请联网后点击「刷新重试」；如果仍然报错，请复制报错信息反馈。';
const CHUNK_ERROR_RELOADING = '\u6b63\u5728\u81ea\u52a8\u5237\u65b0\u6062\u590d\u2026';
const CHUNK_ERROR_RELOAD_LABEL = '\u5237\u65b0\u91cd\u8bd5';
const CHUNK_ERROR_RECOVERY_LABEL = '检查更新并修复';

type AppErrorBoundaryProps = {
    children: React.ReactNode;
    onCloseApp: () => void;
    resetKey: string;
};

type AppErrorBoundaryState = {
    hasError: boolean;
    error: Error | null;
    copyLabel: string;
    /** 懒加载 chunk 失败 (iOS Safari "Importing a module script failed." 等) — 走刷新恢复 UI */
    isChunkError: boolean;
    /** 已发起自动整页刷新, 页面即将重载 */
    autoReloading: boolean;
    /** 加载失败时明确离线，保留页面等待用户联网后手动重试 */
    offlineRecovery: boolean;
};

class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
    private copyLabelTimer: number | null = null;

    constructor(props: AppErrorBoundaryProps) {
        super(props);
        this.state = {
            hasError: false,
            error: null,
            copyLabel: ERROR_COPY_LABEL,
            isChunkError: false,
            autoReloading: false,
            offlineRecovery: false,
        };
    }

    static getDerivedStateFromError(error: Error): Partial<AppErrorBoundaryState> {
        return { hasError: true, error, isChunkError: isChunkLoadError(error) };
    }

    /**
     * 当前是哪个 App 崩的。resetKey 形如 `${activeApp}:${角色id}` — 冒号后面那截是角色 id,
     * 一个字都不能上报, 这里只取前半段的 AppID, 再换成 constants 里写死的中文 App 名。
     * 名字查不到（比如桌面）就返回 undefined, 让这一项在事件里直接缺席。
     */
    private currentAppName(): string | undefined {
        const appId = this.props.resetKey.split(':')[0] as AppID;
        return INSTALLED_APPS.find(a => a.id === appId)?.name ?? HIDDEN_APP_NAMES[appId];
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error('App Crash:', error, errorInfo);
        // 使用统计: 只报「哪个 App 崩了 + 是哪一类崩」。报错文本留在 console, 不进上报。
        const appName = this.currentAppName();
        trackEvent('触发 App 崩溃兜底页', {
            错误类型: isChunkLoadError(error) ? '资源加载失败' : '运行错误',
            ...(appName ? { 所在App: appName } : {}),
        });
        // chunk 加载失败需要整页重试；明确离线时保留页面，不在联网后擅自刷新。
        if (isChunkLoadError(error)) {
            const result = tryAutoReloadForChunkError();
            trackEvent('自动刷新恢复资源加载失败', {
                恢复方式: result === 'reloading' ? '已自动刷新'
                    : result === 'offline' ? '离线不刷'
                    : result === 'storage-unavailable' ? '存储不可用不刷'
                    : '冷却期内不刷',
            });
            this.setState({ autoReloading: result === 'reloading', offlineRecovery: result === 'offline' });
        }
    }

    componentDidUpdate(prevProps: AppErrorBoundaryProps) {
        if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
            this.setState({
                hasError: false,
                error: null,
                copyLabel: ERROR_COPY_LABEL,
                isChunkError: false,
                autoReloading: false,
                offlineRecovery: false,
            });
        }
    }

    componentWillUnmount() {
        if (this.copyLabelTimer) {
            window.clearTimeout(this.copyLabelTimer);
        }
    }

    private updateCopyLabel = (label: string) => {
        if (this.copyLabelTimer) {
            window.clearTimeout(this.copyLabelTimer);
        }

        this.setState({ copyLabel: label });
        this.copyLabelTimer = window.setTimeout(() => {
            this.setState({ copyLabel: ERROR_COPY_LABEL });
            this.copyLabelTimer = null;
        }, 1800);
    };

    private handleCopy = async () => {
        const errText = this.state.error?.stack || this.state.error?.message || 'Unknown Error';

        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(errText);
                this.updateCopyLabel(ERROR_COPIED_LABEL);
                // 只报走了哪条复制路径, 报错文本本身一个字都不发。
                trackEvent('复制报错信息', { 复制结果: '剪贴板成功' });
                return;
            }
        } catch {
            // Fall back to the hidden textarea path below.
        }

        try {
            const textarea = document.createElement('textarea');
            textarea.value = errText;
            textarea.setAttribute('readonly', 'true');
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            textarea.style.pointerEvents = 'none';
            document.body.appendChild(textarea);
            textarea.focus();
            textarea.select();
            const copied = document.execCommand('copy');
            document.body.removeChild(textarea);

            if (copied) {
                this.updateCopyLabel(ERROR_COPIED_LABEL);
                trackEvent('复制报错信息', { 复制结果: 'execCommand 兜底成功' });
                return;
            }
        } catch {
            // Fall back to manual copy prompt.
        }

        window.prompt(ERROR_PROMPT_LABEL, errText);
        this.updateCopyLabel(ERROR_MANUAL_COPY_LABEL);
        trackEvent('复制报错信息', { 复制结果: '需手动复制' });
    };

    private handleClose = () => {
        trackEvent('从崩溃页返回桌面', {
            错误类型: this.state.isChunkError ? '资源加载失败' : '运行错误',
        });
        this.setState({
            hasError: false,
            error: null,
            copyLabel: ERROR_COPY_LABEL,
            isChunkError: false,
            autoReloading: false,
            offlineRecovery: false,
        });
        this.props.onCloseApp();
    };

    private handleReload = () => {
        trackEvent('点刷新重试（资源加载失败）');
        window.location.reload();
    };

    render() {
        if (!this.state.hasError) {
            return this.props.children;
        }

        if (this.state.isChunkError) {
            return (
                <div className="relative isolate z-[120] w-full h-full flex flex-col items-center justify-center bg-slate-900/95 text-white p-6 text-center space-y-4 pointer-events-auto">
                    <img
                        src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f635.png"
                        alt="error"
                        className="w-10 h-10"
                    />
                    <h2 className="text-lg font-bold">{CHUNK_ERROR_TITLE}</h2>
                    <p className="text-xs text-slate-300 max-w-xs leading-relaxed">
                        {this.state.offlineRecovery ? CHUNK_ERROR_OFFLINE_HINT : CHUNK_ERROR_HINT}
                        {!this.state.offlineRecovery && import.meta.env.MODE !== 'capacitor' && '刷新无效时，可点击「检查更新并修复」。'}
                    </p>
                    <p className="text-xs text-slate-300 font-mono bg-black/30 p-3 rounded-2xl max-w-full overflow-auto max-h-40 select-text break-all whitespace-pre-wrap">
                        {this.state.error?.message || 'Unknown Error'}
                    </p>
                    {this.state.autoReloading ? (
                        <p className="text-sm font-bold text-slate-200">{CHUNK_ERROR_RELOADING}</p>
                    ) : (
                        <div className="flex flex-col gap-3 w-full max-w-xs">
                            <button
                                type="button"
                                onClick={this.handleReload}
                                className="w-full px-6 py-3 bg-red-600 rounded-full font-bold text-sm shadow-lg active:scale-95 transition-transform"
                            >
                                {CHUNK_ERROR_RELOAD_LABEL}
                            </button>
                            {import.meta.env.MODE !== 'capacitor' && (
                                <a
                                    href={`${import.meta.env.BASE_URL}recover.html`}
                                    className="w-full px-4 py-2 bg-slate-700 rounded-full text-xs font-bold active:scale-95 transition-transform"
                                >
                                    {CHUNK_ERROR_RECOVERY_LABEL}
                                </a>
                            )}
                            <button
                                type="button"
                                onClick={this.handleCopy}
                                className="w-full px-4 py-2 bg-slate-700 rounded-full text-xs font-bold active:scale-95 transition-transform"
                            >
                                {this.state.copyLabel}
                            </button>
                            <button
                                type="button"
                                onClick={this.handleClose}
                                className="w-full px-4 py-2 bg-slate-700 rounded-full text-xs font-bold active:scale-95 transition-transform"
                            >
                                {ERROR_RETURN_LABEL}
                            </button>
                        </div>
                    )}
                </div>
            );
        }

        return (
            <div className="relative isolate z-[120] w-full h-full flex flex-col items-center justify-center bg-slate-900/95 text-white p-6 text-center space-y-4 pointer-events-auto">
                <img
                    src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f635.png"
                    alt="error"
                    className="w-10 h-10"
                />
                <h2 className="text-lg font-bold">{ERROR_TITLE}</h2>
                <p className="text-xs text-slate-300 font-mono bg-black/30 p-3 rounded-2xl max-w-full overflow-auto max-h-40 select-text break-all whitespace-pre-wrap">
                    {this.state.error?.message || 'Unknown Error'}
                </p>
                <div className="flex flex-col gap-3 w-full max-w-xs">
                    <button
                        type="button"
                        onClick={this.handleCopy}
                        className="w-full px-4 py-2 bg-slate-700 rounded-full text-xs font-bold active:scale-95 transition-transform"
                    >
                        {this.state.copyLabel}
                    </button>
                    <button
                        type="button"
                        onClick={this.handleClose}
                        className="w-full px-6 py-3 bg-red-600 rounded-full font-bold text-sm shadow-lg active:scale-95 transition-transform"
                    >
                        {ERROR_RETURN_LABEL}
                    </button>
                </div>
            </div>
        );
    }
}

export default AppErrorBoundary;
