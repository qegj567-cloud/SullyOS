import {readFile,writeFile} from 'node:fs/promises';
const license='Scallop2 — CC0 / Public Domain. Source: https://freesvg.org/scallop2 ; supplied SVG preserved in scallop2-source.svg.';
const source=await readFile(new URL('./scallop2-source.svg',import.meta.url),'utf8');
const d=source.match(/\sd="([^"]+)"/)[1];
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="601.40625" height="65.03125" viewBox="128.6875 738.03125 601.40625 65.03125"><!-- ${license} --><path fill="#1c2036" d="${d}"/></svg>`;
await writeFile(new URL('./gothic-lace.svg',import.meta.url),svg);
await writeFile(new URL('./SCALLOP-LICENSE.txt',import.meta.url),license+'\nAdaptation: cropped upper solid band and recolored silver lavender.\n');
const path=new URL('./acid-orbit.css',import.meta.url);
const css=(await readFile(path,'utf8')).split('/* ACID GOTHIC LACE */')[0];
await writeFile(path,css+`/* ACID GOTHIC LACE */
/* Scallop2 adaptation. ${license} */
.sully-chat-inputbar {
  margin-top:20px !important;border-radius:0 !important;
  border-top:1px solid #cbb7ec80 !important;
  background:linear-gradient(120deg,#191728f5,#35334ded) !important;
}
.sully-chat-inputbar::before {
  content:"" !important;position:absolute;left:0;right:0;top:-20px;height:20px;
  background:url("data:image/svg+xml,${encodeURIComponent(svg)}") center bottom/185px 20px repeat-x;
  pointer-events:none;transform:scaleY(-1);filter:drop-shadow(0 1px 0 #b4a0d48c);
}
.sully-chat-input-wrap {border-color:#bda5db80 !important;background:#c1b0e00b !important;}
.sully-chat-header {
  width:100% !important;max-width:none !important;
  margin:0 !important;
  margin-bottom:24px !important;
  padding-top:calc(var(--chrome-top,var(--safe-top,0px)) + 10px) !important;
  border:0 !important;border-bottom:1px solid #c9bcf877 !important;
  border-radius:0 !important;overflow:visible !important;
  box-shadow:inset 0 -1px #e0d3ff33 !important;
}
.sully-chat-header .sully-chat-avatar {
  top:10px !important;right:44px !important;width:68px !important;height:58px !important;
  border-radius:8px !important;opacity:1 !important;z-index:0;
  mask-image:none !important;-webkit-mask-image:none !important;
  clip-path:polygon(14% 0,100% 0,86% 100%,0 100%);
  object-position:50% 30% !important;
}
.sully-chat-header {padding-right:122px !important;background:linear-gradient(105deg,#171e32f5,#333950ec 65%,#79729fbd) !important;}
.sully-chat-header::before {
  content:"" !important;position:absolute;top:8px;right:43px;left:auto;
  width:66px;height:62px;padding:0;border:1px solid #d9c5ff9c;border-radius:8px;
  transform:skewX(-9deg);background:#d3c2ff12;box-shadow:0 0 12px #c9b0ff24;
  pointer-events:none;
}
.sully-chat-header .sully-chat-trigger {
  top:25px !important;bottom:auto !important;right:7px !important;
  border-radius:8px !important;background:#cbb5ff12 !important;
}
.sully-chat-header .sully-chat-back {top:calc(var(--chrome-top,var(--safe-top,0px)) + 8px) !important;}
.sully-chat-header::after {
  content:"" !important;position:absolute;
  left:0 !important;right:0 !important;top:auto !important;bottom:-20px !important;
  width:auto !important;height:20px !important;
  transform:none !important;border:0 !important;box-shadow:none !important;
  background:url("data:image/svg+xml,${encodeURIComponent(svg)}") center bottom/185px 20px repeat-x !important;
  pointer-events:none;filter:drop-shadow(0 1px 0 #b4a0d48c);
}
.sully-chat-send-button {
  position:relative;border-radius:12px !important;
  background:linear-gradient(145deg,#e7dcfc,#b7a5d9) !important;
  border:1px solid #f2e8ffcc !important;color:#30283f !important;
  box-shadow:inset 0 1px #fff9,0 3px 8px #0f0d292e !important;
}
.sully-chat-send-button[aria-label="发送文字"] svg {visibility:hidden;}
.sully-chat-send-button[aria-label="发送文字"]::before {
  content:"";position:absolute;inset:10px;pointer-events:none;
  background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%23d9cbed' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 18L18 6M7 6h11v11'/%3E%3C/svg%3E") center/24px 24px no-repeat;
}

/* Compact celestial chrome: flush panel, arched portrait, silver edge light. */
.sully-chat-header {
  padding:12px 116px 12px 40px !important;
  padding-top:calc(var(--chrome-top,var(--safe-top,0px)) + 12px) !important;
  background:linear-gradient(110deg,#171b30,#1c2036 70%,#34324d) !important;
  border-top:1px solid #b9abd34d !important;
  border-bottom:1px solid #b9abd363 !important;
  box-shadow:inset 0 1px 0 #e4d9ff0d !important;
}
.sully-chat-header .sully-chat-avatar {
  top:calc(var(--chrome-top,var(--safe-top,0px)) + 9px) !important;right:43px !important;
  width:54px !important;height:60px !important;
  border-radius:50% 50% 44% 44% !important;clip-path:none !important;
  border:1px solid #c8b5df9c !important;
  box-shadow:0 0 10px #cbb3ed1f !important;object-position:50% 35% !important;
}
.sully-chat-header::before {
  top:calc(var(--chrome-top,var(--safe-top,0px)) + 5px) !important;right:39px !important;
  width:62px !important;height:68px !important;box-sizing:border-box;
  border:1px solid #b8a2d363 !important;border-radius:50% 50% 44% 44% !important;
  transform:none !important;background:none !important;box-shadow:none !important;
}
.sully-chat-header .sully-chat-trigger {
  top:calc(var(--chrome-top,var(--safe-top,0px)) + 26px) !important;
  border-radius:50% !important;background:transparent !important;
  border:1px solid #b8a2d34d !important;box-shadow:none !important;
}
.sully-chat-header .sully-chat-back {border:0 !important;background:none !important;box-shadow:none !important;}
.sully-chat-header .sully-chat-name {font-size:16px !important;letter-spacing:.08em !important;}
.sully-chat-inputbar {background:#1c2036 !important;border-top-color:#b9abd363 !important;}
.sully-chat-transfer-card {
  width:218px !important;max-width:100% !important;padding:12px !important;
  border-radius:16px !important;background:linear-gradient(125deg,#252a44,#39344f) !important;
  border:1px solid #bda5da80 !important;box-shadow:inset 0 1px #e8d7ff17,0 0 8px #c5a5ed17 !important;
}
.sully-chat-transfer-header {padding-bottom:6px !important;margin-bottom:6px !important;gap:8px !important;}
.sully-chat-transfer-card .sully-chat-transfer-icon {padding:4px !important;width:28px !important;height:28px !important;}
.sully-chat-transfer-card .sully-chat-transfer-amount {font-size:24px !important;line-height:1.2 !important;margin:8px 0 6px !important;}
.sully-chat-transfer-note {font-size:11px !important;padding:0 !important;margin:0 0 7px !important;}

/* Integrated character portrait: compact edge-to-edge nameplate. */
.sully-chat-header {
  padding:12px 112px 11px 42px !important;
  padding-top:calc(var(--chrome-top,var(--safe-top,0px)) + 12px) !important;
  background:#1c2036 !important;border-top:0 !important;
  border-bottom:1px solid #bca8dd4d !important;box-shadow:none !important;
}
.sully-chat-header .sully-chat-avatar {
  top:0 !important;bottom:0 !important;right:0 !important;
  width:38% !important;height:100% !important;
  border:0 !important;border-radius:0 !important;box-shadow:none !important;
  object-fit:cover !important;object-position:50% 38% !important;
  opacity:.58 !important;clip-path:none !important;
  mask-image:linear-gradient(90deg,transparent 0%,#000 65%,#000 100%) !important;
  -webkit-mask-image:linear-gradient(90deg,transparent 0%,#000 65%,#000 100%) !important;
}
.sully-chat-header::before {
  content:"✦" !important;top:calc(var(--chrome-top,var(--safe-top,0px)) + 12px) !important;
  right:111px !important;width:14px !important;height:14px !important;
  border:0 !important;border-radius:0 !important;transform:none !important;
  color:#d5c3edb3;font:14px/1 serif;background:none !important;box-shadow:none !important;
}
.sully-chat-header .sully-chat-name {
  font-family:"Noto Serif SC","Songti SC","SimSun",serif !important;
  font-size:18px !important;font-weight:600 !important;letter-spacing:.1em !important;
  line-height:1.3 !important;margin-bottom:3px !important;
}
.sully-chat-header .sully-chat-status {color:#c0b6d4 !important;gap:7px !important;}
.sully-chat-header .sully-chat-back {
  top:calc(var(--chrome-top,var(--safe-top,0px)) + 13px) !important;left:6px !important;
  color:#d4c6e6 !important;
}
.sully-chat-header .sully-chat-trigger {
  top:calc(50% + var(--chrome-top,var(--safe-top,0px)) / 2) !important;right:8px !important;bottom:auto !important;
  transform:translateY(-50%) !important;width:36px !important;height:36px !important;
  display:flex !important;align-items:center !important;justify-content:center !important;padding:8px !important;
  background:#1c2036c9 !important;border:1px solid #c3aed866 !important;
  border-radius:50% !important;z-index:2;
}
.sully-chat-header .sully-chat-buffs {margin-top:6px !important;}
.sully-chat-header .sully-chat-buffs button {font-size:9px !important;line-height:1.4 !important;}

/* Preserve component geometry: the theme edge must not add an outer box. */
.sully-chat-card[data-card-kind]:not([data-card-kind="transfer"]) {
  --sully-card-border:0 solid transparent;
  --sully-card-shadow:inset 0 0 0 1px #d5cbff80,inset 0 0 16px #dfd4ff26,0 0 10px #baacf01a;
}
.sully-chat-card[data-card-kind]:not([data-card-kind="transfer"]) .sully-chat-card-surface {
  border:0 !important;padding:0 !important;
}

/* Unframed send glyph and one-line character identity / token count. */
.sully-chat-send-button {
  border:0 !important;background:transparent !important;box-shadow:none !important;
  border-radius:0 !important;color:#d9cbed !important;
}
.sully-chat-send-button:hover {box-shadow:none !important;}
.sully-chat-header .sully-chat-buffs button {
  color:#d3c5e7 !important;
  filter:grayscale(1) sepia(.3) hue-rotate(205deg) saturate(.7);
}
.sully-chat-header .sully-chat-info {
  display:grid !important;grid-template-columns:minmax(0,max-content) auto;justify-content:start;
  align-items:center !important;column-gap:10px;row-gap:0;
}
.sully-chat-header .sully-chat-info > .sully-chat-name {
  grid-column:1;grid-row:1;margin:0 !important;
  min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.sully-chat-header .sully-chat-info > .sully-chat-status {
  grid-column:2;grid-row:1;gap:4px !important;justify-self:start;
}
.sully-chat-header .sully-chat-status > .sully-chat-online-status {display:none !important;}
.sully-chat-header .sully-chat-token {
  border:0 !important;border-left:1px solid #b7a3cc66 !important;
  border-radius:0 !important;background:none !important;box-shadow:none !important;
  padding:0 0 0 9px !important;font-size:11px !important;line-height:17px !important;
  letter-spacing:.04em;color:#bbaece !important;font-variant-numeric:tabular-nums;
}
.sully-chat-header .sully-chat-info > :not(.sully-chat-name):not(.sully-chat-status) {
  grid-column:1/-1;
}
.sully-chat-header .sully-chat-buffs {margin-top:5px !important;}

/* Compact collaboration attachment and bare utility icons. */
.sully-chat-card[data-card-kind="collaboration_file"] {--sully-card-radius:14px;}
.sully-chat-actions-button,
.sully-chat-header .sully-chat-trigger {
  background:transparent !important;border:0 !important;box-shadow:none !important;
}
.sully-chat-actions-button:hover,
.sully-chat-header .sully-chat-trigger:hover {background:transparent !important;box-shadow:none !important;}
.sully-collaboration-file {
  width:236px !important;max-width:100% !important;
  border-radius:14px !important;box-shadow:none !important;
}
.sully-collaboration-file > span:first-child {padding:10px !important;gap:8px !important;}
.sully-collaboration-file-icon {width:30px !important;height:36px !important;border-radius:8px !important;}
.sully-collaboration-file-icon > svg {width:20px !important;height:20px !important;}
.sully-collaboration-file-name {font-size:12px !important;line-height:1.35 !important;font-weight:500 !important;}
.sully-collaboration-file-detail {font-size:10px !important;margin-top:4px !important;}
.sully-collaboration-file-action {width:24px !important;height:28px !important;border:0 !important;background:none !important;}
.sully-collaboration-file > span:last-child {padding:5px 10px !important;font-size:9px !important;letter-spacing:.04em !important;}
.sully-psyche-status {color:#fff !important;opacity:1 !important;}
.sully-chat-header .sully-chat-selection-cancel,.sully-chat-header .sully-chat-selection-count {color:#f0edff !important;}
.sully-chat-header .sully-chat-extra-action {color:#f0edff !important;background:#dbceff14 !important;border-color:#d8cbff40 !important;}
.sully-chat-switch-item {background:#303249 !important;border-color:transparent !important;box-shadow:none !important;}
.sully-chat-switch-item[data-active="true"] {background:#3b3c56 !important;border-color:#bca8dd66 !important;}
.sully-chat-switch-name {color:#eee5f7 !important;}
.sully-chat-switch-title,.sully-chat-switch-description {color:#b9adc9 !important;}
/* Keep the original icon tile / caption layout, with no rectangular button slab. */
.sully-chat-panel [role="group"] > button {background:transparent !important;border:0 !important;box-shadow:none !important;}
.sully-chat-panel [role="group"] > button > div:first-child {
  background:#d3c3ff12 !important;border-color:#d3c3ff26 !important;box-shadow:none !important;
}
/* HTML and custom-art event cards own their presentation; do not frame them with the theme shell. */
.sully-chat-card:is([data-card-kind="html_card"], [data-card-variant="qixi_event_card"], [data-card-variant="like520_card"]) .sully-chat-card-surface {
  background:transparent !important;border:0 !important;box-shadow:none !important;overflow:visible !important;
}
`);
