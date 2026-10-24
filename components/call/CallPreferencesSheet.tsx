import React from 'react';
import { ChatCircleDots, Gear, Microphone, Phone, SpeakerHigh, X } from '@phosphor-icons/react';
import type { CallPreferences } from '../../utils/callPreferences';
import type { APIConfig, SttProvider } from '../../types';
import { STT_PROVIDER_OPTIONS, isSttProviderConfigured, resolveSttProvider } from '../../utils/speechToText';

interface CallPreferencesSheetProps {
  incrementalVoice?: boolean;
  onIncrementalChange?: (enabled: boolean) => void;
  preferences: CallPreferences;
  apiConfig?: Partial<APIConfig>;
  onSttProviderChange?: (provider: SttProvider) => void;
  accentColor: string;
  lightTheme: boolean;
  onChange: (preferences: CallPreferences) => void;
  onOpenSystemSettings: () => void;
  onClose: () => void;
}

const CallPreferencesSheet: React.FC<CallPreferencesSheetProps> = ({
  preferences,
  incrementalVoice,
  onIncrementalChange,
  apiConfig,
  onSttProviderChange,
  accentColor,
  lightTheme,
  onChange,
  onOpenSystemSettings,
  onClose,
}) => {
  const activeSttProvider = resolveSttProvider(apiConfig);
  return (
    <div
      className="absolute inset-0 z-[80] flex items-end bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="call-preferences-title"
      data-testid="call-preferences-sheet"
      onClick={onClose}
    >
      <style>{`
        @keyframes sully-call-settings-in { from { opacity: 0; transform: translateY(18px) } to { opacity: 1; transform: translateY(0) } }
        .sully-call-settings-sheet { animation: sully-call-settings-in 220ms cubic-bezier(.2,.8,.2,1) both; }
        @media (prefers-reduced-motion: reduce) { .sully-call-settings-sheet { animation-duration: .01ms; } }
      `}</style>
      <section
        className={`sully-call-settings-sheet w-full rounded-t-[1.75rem] border-t px-5 pt-4 shadow-2xl ${lightTheme ? 'border-[#262239]/10 bg-[#f7f5fb]' : 'border-white/12 bg-[#120c22]'}`}
        style={{ paddingBottom: 'max(1.25rem, var(--safe-bottom, 0px))' }}
        onClick={event => event.stopPropagation()}
      >
        <div className={`mx-auto mb-4 h-1 w-10 rounded-full ${lightTheme ? 'bg-[#262239]/15' : 'bg-white/15'}`} aria-hidden />
        <header className="flex items-start justify-between gap-4">
          <div>
            <div className={`text-[9px] font-semibold tracking-[0.28em] ${lightTheme ? 'text-[#262239]/45' : 'text-white/35'}`}>CALL PREFERENCES</div>
            <h2 id="call-preferences-title" className={`mt-1 text-lg font-semibold ${lightTheme ? 'text-[#262239]' : 'text-white/90'}`}>通话偏好</h2>
            <p className={`mt-1 text-[11px] leading-5 ${lightTheme ? 'text-[#262239]/60' : 'text-white/40'}`}>只影响语音和视频通话，不改变聊天页的语音设置。</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition active:scale-90 ${lightTheme ? 'border-[#262239]/12 bg-[#262239]/[0.04] text-[#262239]/60' : 'border-white/12 bg-white/[0.04] text-white/55'}`}
            aria-label="关闭通话偏好"
          >
            <X size={15} weight="bold" />
          </button>
        </header>

        <div className={`mt-5 divide-y border-y ${lightTheme ? 'divide-[#262239]/10 border-[#262239]/10' : 'divide-white/10 border-white/10'}`}>
          <div className="py-3">
            <div className="flex items-center gap-3">
              <span
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border"
                style={{ color: accentColor, borderColor: `${accentColor}66`, background: `${accentColor}14` }}
              >
                <Phone size={17} weight="fill" />
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block text-[13px] font-medium ${lightTheme ? 'text-[#262239]/90' : 'text-white/85'}`}>谁先开口</span>
                <span className={`mt-0.5 block text-[10px] leading-4 ${lightTheme ? 'text-[#262239]/55' : 'text-white/38'}`}>选择电话接通后由谁先说第一句话。</span>
              </span>
            </div>
            <div className="ml-12 mt-3 grid grid-cols-2 gap-2" role="group" aria-label="谁先开口">
              {([
                { value: true, label: '对方先说' },
                { value: false, label: '我先说' },
              ]).map(option => {
                const selected = preferences.characterInitiative === option.value;
                return (
                  <button
                    key={option.label}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onChange({ ...preferences, characterInitiative: option.value })}
                    className={`rounded-xl border py-2 text-xs font-medium transition active:scale-[.98] ${lightTheme ? 'text-[#262239]/75' : 'text-white/70'}`}
                    style={selected
                      ? { color: accentColor, borderColor: `${accentColor}88`, background: `${accentColor}18`, boxShadow: `inset 0 0 12px ${accentColor}14` }
                      : { borderColor: lightTheme ? 'rgba(38,34,57,.12)' : 'rgba(255,255,255,.1)', background: lightTheme ? 'rgba(38,34,57,.025)' : 'rgba(255,255,255,.025)' }}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>

          {incrementalVoice !== undefined && <label className="flex items-center gap-3 py-3">
            <span className="min-w-0 flex-1">
              <span className={`block text-[13px] font-medium ${lightTheme ? 'text-[#262239]/90' : 'text-white/85'}`}>边想边说</span>
              <span className={`mt-0.5 block text-[10px] leading-4 ${lightTheme ? 'text-[#262239]/55' : 'text-white/38'}`}>写好一句就开始说。需要文字接口支持流式；高质量视频演出会先完成动作排练，再开始说话。</span>
            </span>
            <input type="checkbox" checked={incrementalVoice} onChange={event => onIncrementalChange?.(event.target.checked)} className="h-5 w-5" style={{ accentColor }} />
          </label>}

          <div className="flex min-h-[4.75rem] items-center gap-3 py-3">
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border"
              style={{ color: preferences.voiceAutoPlay ? accentColor : lightTheme ? 'rgba(38,34,57,.42)' : 'rgba(255,255,255,.38)', borderColor: preferences.voiceAutoPlay ? `${accentColor}66` : lightTheme ? 'rgba(38,34,57,.1)' : 'rgba(255,255,255,.1)', background: preferences.voiceAutoPlay ? `${accentColor}14` : lightTheme ? 'rgba(38,34,57,.025)' : 'rgba(255,255,255,.025)' }}
            >
              <SpeakerHigh size={17} weight="fill" />
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block text-[13px] font-medium ${lightTheme ? 'text-[#262239]/90' : 'text-white/85'}`}>自动播放语音</span>
              <span className={`mt-0.5 block text-[10px] leading-4 ${lightTheme ? 'text-[#262239]/55' : 'text-white/38'}`}>默认开启并沿用你的选择。关掉后，语音和视频通话都只在你点“播放语音”时才生成，避免额外消耗额度。</span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={preferences.voiceAutoPlay}
              aria-label="自动播放语音"
              onClick={() => onChange({ ...preferences, voiceAutoPlay: !preferences.voiceAutoPlay })}
              className="relative h-7 w-12 shrink-0 rounded-full border transition-all duration-200 active:scale-95"
              style={preferences.voiceAutoPlay
                ? { background: accentColor, borderColor: accentColor, boxShadow: `0 0 14px ${accentColor}44` }
                : { background: lightTheme ? 'rgba(38,34,57,.07)' : 'rgba(255,255,255,.06)', borderColor: lightTheme ? 'rgba(38,34,57,.14)' : 'rgba(255,255,255,.13)' }}
            >
              <span
                className="absolute top-[3px] h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200"
                style={{ left: 3, transform: preferences.voiceAutoPlay ? 'translateX(20px)' : 'translateX(0)' }}
              />
            </button>
          </div>

          <div className="flex min-h-[4.75rem] items-center gap-3 py-3">
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border"
              style={{ color: preferences.idleNudgeEnabled ? accentColor : lightTheme ? 'rgba(38,34,57,.42)' : 'rgba(255,255,255,.38)', borderColor: preferences.idleNudgeEnabled ? `${accentColor}66` : lightTheme ? 'rgba(38,34,57,.1)' : 'rgba(255,255,255,.1)', background: preferences.idleNudgeEnabled ? `${accentColor}14` : lightTheme ? 'rgba(38,34,57,.025)' : 'rgba(255,255,255,.025)' }}
            >
              <ChatCircleDots size={17} weight="fill" />
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block text-[13px] font-medium ${lightTheme ? 'text-[#262239]/90' : 'text-white/85'}`}>沉默后主动接话</span>
              <span className={`mt-0.5 block text-[10px] leading-4 ${lightTheme ? 'text-[#262239]/55' : 'text-white/38'}`}>按需开启。通话安静较久时，对方最多主动接话两次；默认关闭，不会自行发起请求。</span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={preferences.idleNudgeEnabled}
              aria-label="沉默后主动接话"
              onClick={() => onChange({ ...preferences, idleNudgeEnabled: !preferences.idleNudgeEnabled })}
              className="relative h-7 w-12 shrink-0 rounded-full border transition-all duration-200 active:scale-95"
              style={preferences.idleNudgeEnabled
                ? { background: accentColor, borderColor: accentColor, boxShadow: `0 0 14px ${accentColor}44` }
                : { background: lightTheme ? 'rgba(38,34,57,.07)' : 'rgba(255,255,255,.06)', borderColor: lightTheme ? 'rgba(38,34,57,.14)' : 'rgba(255,255,255,.13)' }}
            >
              <span
                className="absolute top-[3px] h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200"
                style={{ left: 3, transform: preferences.idleNudgeEnabled ? 'translateX(20px)' : 'translateX(0)' }}
              />
            </button>
          </div>

          {onSttProviderChange && (
            <div className="py-3">
              <div className="flex items-center gap-3">
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border"
                  style={{ color: accentColor, borderColor: `${accentColor}66`, background: `${accentColor}14` }}
                >
                  <Microphone size={17} weight="fill" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block text-[13px] font-medium ${lightTheme ? 'text-[#262239]/90' : 'text-white/85'}`}>语音转文字（麦克风输入）</span>
                  <span className={`mt-0.5 block text-[10px] leading-4 ${lightTheme ? 'text-[#262239]/55' : 'text-white/38'}`}>
                    选择你开口说话时走哪家识别，可与角色发声平台分开选；已填 Key 的平台才能切换。
                  </span>
                </span>
              </div>
              <div className="ml-12 mt-3 grid grid-cols-2 gap-2" role="group" aria-label="语音转文字平台">
                {STT_PROVIDER_OPTIONS.map(option => {
                  const selected = activeSttProvider === option.id;
                  const configured = isSttProviderConfigured(option.id, apiConfig);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => onSttProviderChange(option.id)}
                      className={`rounded-xl border px-2.5 py-2 text-xs font-medium transition active:scale-[.98] ${
                        lightTheme ? 'text-[#262239]/75' : 'text-white/70'
                      } ${!configured && !selected ? 'opacity-50' : ''}`}
                      style={selected
                        ? { color: accentColor, borderColor: `${accentColor}88`, background: `${accentColor}18`, boxShadow: `inset 0 0 12px ${accentColor}14` }
                        : { borderColor: lightTheme ? 'rgba(38,34,57,.12)' : 'rgba(255,255,255,.1)', background: lightTheme ? 'rgba(38,34,57,.025)' : 'rgba(255,255,255,.025)' }}
                    >
                      <span className="block truncate">{option.shortLabel}</span>
                      {!configured && (
                        <span className={`mt-0.5 block text-[9px] font-normal ${lightTheme ? 'text-[#262239]/45' : 'text-white/35'}`}>
                          未填 Key
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onOpenSystemSettings}
          className={`mt-3 flex w-full items-center justify-center gap-2 py-2 text-[11px] transition active:opacity-60 ${lightTheme ? 'text-[#262239]/55' : 'text-white/42'}`}
        >
          <Gear size={14} weight="fill" /> 更多语音与 API 设置
        </button>
      </section>
    </div>
  );
};

export default CallPreferencesSheet;
