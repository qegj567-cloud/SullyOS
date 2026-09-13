import React, { useEffect, useRef } from 'react';
import { Flask, WarningCircle } from '@phosphor-icons/react';

interface VRoidBetaWarningProps {
  fileName: string;
  projectFile?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onContinue?: () => void;
}

const VRoidBetaWarning: React.FC<VRoidBetaWarningProps> = ({
  fileName,
  projectFile = false,
  busy = false,
  onCancel,
  onContinue,
}) => {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    dialogRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [busy, onCancel]);

  return (
    <div className="fixed inset-0 z-[260] flex items-end justify-center bg-[#05030b]/76 px-4 pb-[max(1rem,var(--safe-bottom))] pt-[max(1rem,var(--safe-top))] backdrop-blur-sm sm:items-center">
      <button
        type="button"
        aria-label="关闭 VRoid 测试版说明"
        className="absolute inset-0 cursor-default"
        disabled={busy}
        onClick={onCancel}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="vroid-beta-title"
        tabIndex={-1}
        className="relative w-full max-w-sm overflow-hidden rounded-[28px] border border-violet-200/20 bg-[#100c1b] text-white shadow-[0_28px_90px_rgba(0,0,0,.58)] outline-none"
      >
        <div className="h-1 bg-gradient-to-r from-violet-400 via-fuchsia-300 to-amber-200" />
        <div className="px-5 pb-5 pt-5">
          <div className="flex items-start gap-3.5">
            <div className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-violet-200/20 bg-violet-300/10 text-violet-200">
              {projectFile ? <WarningCircle size={23} weight="fill" /> : <Flask size={22} weight="fill" />}
            </div>
            <div className="min-w-0 flex-1">
              <span className="text-[10px] font-semibold tracking-[0.24em] text-violet-200/65">VRoid / VRM · TEST BUILD</span>
              <h2 id="vroid-beta-title" className="mt-1.5 text-[19px] font-semibold leading-tight text-white">
                {projectFile ? '这是 VRoid 工程文件' : '导入功能仍在测试中'}
              </h2>
              <p className="mt-2 break-all text-[11px] leading-relaxed text-white/42">{fileName}</p>
            </div>
          </div>

          <div className="mt-5 border-y border-white/10 py-4 text-[13px] leading-6 text-white/70">
            {projectFile ? (
              <>
                SullyOS·糯米机 目前不能直接读取 <strong className="font-semibold text-white">.vroid 工程</strong>。请先在 VRoid Studio 中导出 VRM，再回来选择导出的文件。
              </>
            ) : (
              <>
                VRoid / VRM 并不是本次版本的开发重点，当前只作为测试功能开放，<strong className="font-semibold text-amber-100">可能存在各种 Bug</strong>。
              </>
            )}
          </div>

          {!projectFile && (
            <p className="mt-3 text-[11px] leading-5 text-white/42">
              不同模型的骨骼、表情、材质和移动端显存占用差异很大；导入失败不会覆盖角色当前已绑定的模型。
            </p>
          )}

          <div className={`mt-5 grid gap-2.5 ${projectFile ? 'grid-cols-1' : 'grid-cols-2'}`}>
            <button
              type="button"
              disabled={busy}
              onClick={onCancel}
              className="min-h-11 rounded-2xl border border-white/12 bg-white/[0.035] px-4 text-[13px] font-medium text-white/64 transition active:scale-[0.98] disabled:opacity-45"
            >
              {projectFile ? '我知道了' : '暂不导入'}
            </button>
            {!projectFile && onContinue && (
              <button
                type="button"
                disabled={busy}
                onClick={onContinue}
                className="min-h-11 rounded-2xl border border-violet-200/25 bg-violet-400/18 px-4 text-[13px] font-semibold text-violet-50 transition active:scale-[0.98] disabled:opacity-55"
              >
                {busy ? '正在导入…' : '仍要测试'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default VRoidBetaWarning;
