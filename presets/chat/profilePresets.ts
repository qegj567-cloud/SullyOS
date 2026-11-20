import moon from './profile-moon.svg?raw';
import rain from './profile-rain.svg?raw';
import letter from './profile-letter.svg?raw';

function illustratedPaper(svg: string) {
    // Inline the drawing so exported outfits keep their artwork offline.
    const data = btoa(Array.from(new TextEncoder().encode(svg.trim()), byte => String.fromCharCode(byte)).join(''));
    return `.chat-profile-sky { background: url("data:image/svg+xml;base64,${data}") center / 100% 100% no-repeat var(--paper); }
.chat-profile-sky i, .chat-profile-sky::before, .chat-profile-sky::after { display: none; }
.chat-profile-dialog:not([data-section="当前"]) .chat-profile-sky { opacity: .62; }`;
}
export const PROFILE_PRESETS = [
    {id:'silver', name:'月影银笺', customCss: `.chat-profile-dialog { --paper:#f2f0f8; --wash:#d4d3e2; --ink:#34334b; --muted:#55566c; --gold:#ccb68c; --tab-ink:#454559; }
${illustratedPaper(moon)}`},
    {id:'tea', name:'雨后青瓷', customCss: `.chat-profile-dialog { --paper:#eef4ed; --wash:#c5d8cd; --ink:#283e3b; --muted:#415c56; --gold:#cfbf8b; --tab-ink:#36534d; }
${illustratedPaper(rain)}`},
    {id:'linen', name:'杏茶手札', customCss: `.chat-profile-dialog { --paper:#fff6e9; --wash:#ead7c3; --ink:#4b3b34; --muted:#705a4c; --gold:#cba57e; --tab-ink:#745843; }
.chat-profile-identity { display:grid; grid-template-columns:52px minmax(0,1fr); align-content:center; align-items:center; gap:4px 14px; text-align:left; }
.chat-profile-identity .chat-profile-portrait { grid-row:span 2; width:48px; margin:0; border-radius:7px; }
.chat-profile-identity h2 { margin:0; align-self:end; }
.chat-profile-identity .chat-profile-remark { margin:0; align-self:start; }
.chat-profile-identity .chat-profile-divider { grid-column:1/-1; margin-top:15px; }
${illustratedPaper(letter)}`},
] as const;
