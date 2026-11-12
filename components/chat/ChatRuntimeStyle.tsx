import React from 'react';
import css from './chatRuntime.generated.css?inline';
import noticeCompatCss from './ChatNoticeCompat.css?inline';

/** Travels with chat code: first-paint layout without another stylesheet request. */
export default function ChatRuntimeStyle() {
    return <style>{css + '\n' + noticeCompatCss}</style>;
}
