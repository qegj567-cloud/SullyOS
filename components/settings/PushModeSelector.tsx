import React, { useId } from 'react';

export default function PushModeSelector({ nativeApp, thirdParty, disabled, onSelect }: {
  nativeApp: boolean;
  thirdParty: boolean;
  disabled: boolean;
  onSelect: (mode: 'web-push' | 'third-party') => void;
}) {
  // The guide and notification panel can both be mounted; each needs its own radio group.
  const id = useId();
  const options = [
    { value: 'web-push' as const, title: '系统推送', description: nativeApp ? '仅网页 / PWA 可用，当前 App 不适用' : '直接通过当前浏览器接收通知', selected: !thirdParty, unavailable: nativeApp },
    { value: 'third-party' as const, title: '第三方推送 App', description: '选择一个推送 App 来接收通知', selected: thirdParty, unavailable: false },
  ];
  return <fieldset className="amsg-push-choice" aria-describedby={`${id}-help`}>
    <legend>通知接收方式<span>二选一</span></legend>
    <p id={`${id}-help`} className="amsg-push-choice-help">选择一种即可，不需要两边都开启。</p>
    <div className="amsg-push-options">
      {options.map(option => <label key={option.value} className="amsg-push-option" data-selected={option.selected} data-disabled={disabled || option.unavailable}>
        <input type="radio" name={`${id}-push-mode`} value={option.value} checked={option.selected} disabled={disabled || option.unavailable}
          aria-label={option.title} aria-describedby={`${id}-${option.value}-description`} onChange={() => onSelect(option.value)} />
        <span className="amsg-push-option-copy"><strong>{option.title}</strong><small id={`${id}-${option.value}-description`}>{option.description}</small></span>
        {option.selected && <span className="amsg-push-selected" aria-hidden="true">已选择</span>}
      </label>)}
    </div>
  </fieldset>;
}
