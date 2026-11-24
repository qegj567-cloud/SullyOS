import React, { useState } from 'react';
import { useOS } from '../context/OSContext';
import { serializeSystemLogsExport } from '../utils/networkRequestSource';

/**
 * 设置页底部的系统错误记录回看与复制入口：
 * 顶部「查看报错」胶囊在点开关闭后本轮提醒即收起，后台旁路请求（天气、微博等）也只静默入库不弹胶囊；
 * 保留这个折叠入口，确保用户随时能回看或复制本会话已捕获的全部错误日志。
 */
export default function SystemErrorDiagnosticDetails() {
    const { systemLogs, clearLogs } = useOS();
    const [copyStatus, setCopyStatus] = useState('');
    const exportText = systemLogs.length
        ? serializeSystemLogsExport(systemLogs)
        : '当前会话暂无系统错误或接口异常记录。';

    return (
        <details className="mt-3 w-full text-left" onToggle={() => setCopyStatus('')}>
            <summary className="cursor-pointer">
                本次运行错误记录（{systemLogs.length} 条，不含聊天正文与密钥）
            </summary>
            <p className="mt-2 leading-relaxed">
                顶部报错胶囊关闭后仍可在此回看和复制本次打开期间的接口及运行错误记录。
            </p>
            <textarea
                aria-label="本次运行错误记录"
                readOnly
                value={exportText}
                className="mt-2 h-44 w-full select-text rounded-lg border border-slate-200 bg-white p-2 font-mono text-xs"
            />
            <div className="mt-2 flex gap-2">
                <button
                    type="button"
                    disabled={!systemLogs.length}
                    className="rounded-lg border border-slate-200 px-3 py-2 disabled:opacity-50"
                    onClick={async () => {
                        try {
                            await navigator.clipboard.writeText(exportText);
                            setCopyStatus('已复制，可发给开发者排查');
                        } catch {
                            const field = document.createElement('textarea');
                            field.value = exportText;
                            field.style.cssText = 'position:fixed;left:0;top:0;opacity:0';
                            document.body.appendChild(field);
                            try {
                                field.select();
                                setCopyStatus(document.execCommand('copy') ? '已复制，可发给开发者排查' : '请长按或选中上方文字复制');
                            } catch {
                                setCopyStatus('请长按或选中上方文字复制');
                            } finally {
                                field.remove();
                            }
                        }
                    }}
                >
                    复制错误记录
                </button>
                {systemLogs.length > 0 && (
                    <button
                        type="button"
                        className="rounded-lg border border-slate-200 px-3 py-2"
                        onClick={() => {
                            clearLogs();
                            setCopyStatus('已清空本次错误记录');
                        }}
                    >
                        清空
                    </button>
                )}
            </div>
            {copyStatus && <span role="status" className="mt-2 block">{copyStatus}</span>}
        </details>
    );
}
