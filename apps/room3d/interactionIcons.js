const paths={
 mirror:'<ellipse cx="16" cy="12" rx="9" ry="10"/><path d="M16 22v6m-7 1h14M11 8l4-3m-4 9 8-8"/>',
 bed:'<path d="M4 18V7m24 11V7M4 14h24v11H4zm0 11v3m24-3v3M7 14V9h8v5m2 0V9h8v5"/>',
 seat:'<path d="M8 17V6q8-4 16 0v11M5 13v9h22v-9M8 22v6m16-6v6M8 17h16"/>',
 water:'<path d="M7 14h13v12H7zm13 2 6-4 3 3-9 8M7 16C0 11 1 22 7 22M11 14V9h8"/><path d="m25 23-1 3m5-4-1 3"/>',
 game:'<path d="M8 11h16l5 13q0 5-5 2l-5-4h-6l-5 4q-5 3-5-2zM8 15v6m-3-3h6m11-2h.1m3 3h.1"/>',
 hug:'<path d="M9 8C3 1 1 12 7 13m16-5c6-7 8 4 2 5M8 11q8-8 16 0v9q-8 9-16 0zM12 15h.1m8 0h.1m-7 5q3 3 6 0M10 26l-4 3m16-3 4 3"/>',
 fridge:'<rect x="7" y="3" width="18" height="26" rx="3"/><path d="M7 13h18M11 7v3m0 7v5"/>',
 stand:'<circle cx="16" cy="6" r="3"/><path d="M16 10v10m-7-7 7-3 7 3M16 20l-5 9m5-9 5 9"/>',
 cook:'<path d="M6 12h20v12q-10 7-20 0zM3 13h3m20 0h3M5 9h22M13 6h6M10 3v2m12-2v2"/>',
 wash:'<circle cx="15" cy="19" r="10"/><circle cx="15" cy="19" r="6"/><path d="M20 3h7v7m-5 3v3m5-3v3"/>',
 rest:'<path d="M7 13h16v11H7zm16 2c8-2 8 8 0 6M6 28h19M11 5v4m6-6v6"/>',
 jelly:'<path d="M4 19C1 2 29 2 28 19q-3 3-6 0-3 3-6 0-3 3-6 0-3 3-6 0ZM8 21q-4 7 1 7m7-7v8m8-8q4 7-1 7"/><path d="M11 13h.1m10 0h.1"/>',
 furniture:'<path d="M5 5h22v22H5zm6 0v22m10-22v22M3 29h26"/>',
 building:'<path d="m8 6 22 0-6 20H2zm-6 20h22"/>',
 storage:'<path d="M5 10h22v17H5zm-1 0V5h24v5m-16 6h8"/>',
 expand:'<path d="M16 3v26M3 16h26m-13-13-3 4m3-4 3 4m-3 22-3-4m3 4 3-4M3 16l4-3m-4 3 4 3m22-3-4-3m4 3-4 3"/>',
 rooms:'<path d="m4 14 12-11 12 11v15H4zm-1 0h2m22 0h2"/>',
 style:'<path d="m16 3 4 3 5 1 1 5 3 4-3 4-1 5-5 1-4 3-4-3-5-1-1-5-3-4 3-4 1-5 5-1z"/>',
 quality:'<path d="m16 3 13 13-13 13L3 16z"/>',
};
export function interactionIcon(kind){return `<svg viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[kind]||paths.jelly}</svg>`;}
export function actionIcon(action,kind){if(action==='chibi-kitchen')return interactionIcon(kind==='coffee'?'rest':kind);return interactionIcon({'chibi-bath':'water','chibi-mirror':'mirror','chibi-bed':'bed','chibi-sit':'seat','chibi-water':'water','chibi-game':'game','chibi-kitchen':'rest','chibi-hug':'hug','plush-put-back':'hug','fridge-toggle':'fridge','chibi-stand':'stand','chibi-game-stop':'rest'}[action]);}
