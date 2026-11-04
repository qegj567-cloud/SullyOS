import React from 'react';
import BibiIcon from './BibiIcon';
import { AppID } from '../../types';

// 动森(NookPhone)风格 App 图标 —— 填充式多色 SVG：奶油底 + 暖棕圆头描边 + 单个强调色。
// 风格参照 animal-island-ui 仓库的 icon-chat / icon-variant（实心圆角几何 + 可爱表情）。
// 关键：每个图标传入自身包围盒 bbox，draw() 自动缩放居中到统一光学尺寸 —— 所有图标一样大。
const CREAM = '#FBF7EA';
const BROWN = '#5E483B';

// 统一目标：把图标内容缩放并居中，使其最长边占满 viewBox 的 TARGET（100 为满）。
const TARGET = 80;
const draw = (bbox: [number, number, number, number], children: React.ReactNode) => {
  const [x0, y0, x1, y1] = bbox;
  const w = x1 - x0, h = y1 - y0;
  const s = TARGET / Math.max(w, h);
  const tx = 50 - s * (x0 + w / 2);
  const ty = 50 - s * (y0 + h / 2);
  return (
    <svg viewBox="0 0 100 100" className="w-full h-full">
      <g transform={`translate(${tx} ${ty}) scale(${s})`}>{children}</g>
    </svg>
  );
};

const leaf = draw([25, 12, 75, 89], <>
  <path d="M50 12 C76 23 86 50 75 79 C71 89 58 93 50 89 C42 93 29 89 25 79 C14 50 24 23 50 12Z" fill={CREAM} />
  <path d="M50 22 V83" stroke={BROWN} strokeWidth="4.5" strokeLinecap="round" />
  <path d="M50 42 L68 33 M50 57 L32 48 M50 70 L64 63" stroke={BROWN} strokeWidth="4" strokeLinecap="round" />
</>);

const faceGlyph = <>
  <path d="M50 22 C58 15 68 19 65 28 C57 31 50 29 50 22Z" fill="#7CC36B" />
  <circle cx="50" cy="56" r="30" fill={CREAM} />
  <circle cx="40" cy="52" r="4.2" fill={BROWN} /><circle cx="60" cy="52" r="4.2" fill={BROWN} />
  <circle cx="32" cy="60" r="4.5" fill="#F6A8B8" /><circle cx="68" cy="60" r="4.5" fill="#F6A8B8" />
  <path d="M40 64 Q50 73 60 64" stroke={BROWN} strokeWidth="4.5" fill="none" strokeLinecap="round" />
</>;
const bookGlyph = <>
  <path d="M50 30 C42 24 28 24 21 28 V75 C28 71 42 71 50 77 C58 71 72 71 79 75 V28 C72 24 58 24 50 30Z" fill={CREAM} />
  <path d="M50 30 V77" stroke={BROWN} strokeWidth="3.5" />
</>;
const camGlyph = (lens: string) => <>
  <path d="M37 33 L43 25 H57 L63 33Z" fill={CREAM} />
  <rect x="17" y="33" width="66" height="46" rx="11" fill={CREAM} />
  <circle cx="50" cy="56" r="14" fill={lens} /><circle cx="50" cy="56" r="6.5" fill={CREAM} />
  <circle cx="71" cy="44" r="3.5" fill="#F7CD67" />
</>;
const musicGlyph = <>
  <rect x="56" y="22" width="6.5" height="44" rx="3.2" fill={CREAM} />
  <path d="M62 22 C74 24 80 31 77 42 C75 35 68 32 62 35Z" fill={CREAM} />
  <ellipse cx="48" cy="66" rx="13" ry="10" fill={CREAM} transform="rotate(-18 48 66)" />
</>;
const starGlyph = <path d="M50 14 L61 39 L88 41 L67 60 L74 87 L50 72 L26 87 L33 60 L12 41 L39 39Z" fill={CREAM} />;
const paletteGlyph = <>
  <path d="M50 20 C73 20 84 35 84 50 C84 62 74 64 68 64 C62 64 60 70 64 76 C66 80 62 84 54 84 C30 84 16 68 16 50 C16 33 30 20 50 20Z" fill={CREAM} />
  <circle cx="38" cy="42" r="5" fill="#FC736D" /><circle cx="55" cy="36" r="5" fill="#F7CD67" /><circle cx="66" cy="48" r="5" fill="#82D5BB" />
</>;

const ACNH_ICON_MAP: Partial<Record<AppID, React.ReactNode>> = {
  [AppID.FriendFeed]: <BibiIcon variant="island" className="w-full h-full"/>,
  [AppID.Chat]: draw([9, 24, 91, 72], <>
    <path d="M24 24 H76 a15 15 0 0 1 15 15 v13 a15 15 0 0 1 -15 15 H56 l-6 10 -6 -10 H24 a15 15 0 0 1 -15 -15 v-13 a15 15 0 0 1 15 -15Z" fill={CREAM} />
    <circle cx="32" cy="45.5" r="6" fill={BROWN} /><circle cx="50" cy="45.5" r="6" fill={BROWN} /><circle cx="68" cy="45.5" r="6" fill={BROWN} />
  </>),
  [AppID.Character]: draw([20, 15, 80, 86], faceGlyph),
  [AppID.LifeSim]: draw([20, 15, 80, 86], faceGlyph),
  [AppID.MemoryPalace]: draw([14, 18, 86, 84], <>
    <path d="M50 18 L86 46 H14 Z" fill={CREAM} />
    <rect x="24" y="46" width="52" height="38" rx="5" fill={CREAM} />
    <rect x="42" y="60" width="16" height="24" rx="3" fill={BROWN} />
    <rect x="30" y="52" width="9" height="9" rx="2" fill="#82D5BB" /><rect x="61" y="52" width="9" height="9" rx="2" fill="#82D5BB" />
  </>),
  [AppID.Call]: draw([23, 20, 82, 83],
    <path d="M30 20 C25 20 20 25 23 35 C30 60 42 73 67 80 C77 83 82 78 82 73 L73 60 C70 56 65 55 61 58 L56 61 C47 56 44 53 39 44 L42 39 C45 35 44 30 40 27 Z" fill={CREAM} />
  ),
  [AppID.Room]: draw([16, 22, 84, 80], <>
    <path d="M50 22 L84 80 H16 Z" fill={CREAM} />
    <path d="M50 42 L68 80 H32 Z" fill={BROWN} />
    <path d="M50 42 V80" stroke={CREAM} strokeWidth="3.5" />
  </>),
  [AppID.CheckPhone]: draw([31, 16, 69, 84], <>
    <rect x="31" y="16" width="38" height="68" rx="11" fill={CREAM} />
    <rect x="37" y="25" width="26" height="42" rx="4" fill="#82D5BB" />
    <circle cx="50" cy="75" r="3.6" fill={BROWN} />
  </>),
  [AppID.Date]: draw([14, 17, 86, 82],
    <path d="M50 82 C22 60 14 46 14 33 C14 23 22 17 31 17 C39 17 46 21 50 30 C54 21 61 17 69 17 C78 17 86 23 86 33 C86 46 78 60 50 82Z" fill={CREAM} />
  ),
  [AppID.User]: draw([25, 18, 75, 82], <>
    <rect x="25" y="18" width="50" height="64" rx="7" fill={CREAM} />
    <circle cx="50" cy="42" r="12" fill="#F7CD67" />
    <circle cx="46" cy="41" r="2.2" fill={BROWN} /><circle cx="54" cy="41" r="2.2" fill={BROWN} />
    <path d="M45 47 Q50 51 55 47" stroke={BROWN} strokeWidth="2.4" fill="none" strokeLinecap="round" />
    <rect x="34" y="62" width="32" height="5" rx="2.5" fill={BROWN} /><rect x="38" y="71" width="24" height="5" rx="2.5" fill="#B7A98C" />
  </>),
  [AppID.Bank]: draw([20, 27, 80, 87], <>
    <path d="M37 35 Q50 27 63 35 C77 46 80 67 69 79 C61 87 39 87 31 79 C20 67 23 46 37 35Z" fill={CREAM} />
    <path d="M41 31 L59 31 L55 40 L45 40Z" fill={BROWN} />
    <path d="M50 50 C43 50 39 56 39 63 H61 C61 56 57 50 50 50Z" fill="#F7CD67" />
    <rect x="46" y="63" width="8" height="3.5" fill={BROWN} /><circle cx="50" cy="70" r="3" fill={BROWN} />
  </>),
  [AppID.GroupChat]: draw([17, 31, 83, 73], <>
    <circle cx="64" cy="52" r="19" fill="#EFE6CF" /><circle cx="38" cy="52" r="21" fill={CREAM} />
    <circle cx="31" cy="50" r="3.4" fill={BROWN} /><circle cx="45" cy="50" r="3.4" fill={BROWN} />
    <path d="M31 58 Q38 64 45 58" stroke={BROWN} strokeWidth="3.4" fill="none" strokeLinecap="round" />
  </>),
  [AppID.Social]: draw([29, 16, 71, 86], <>
    <path d="M52 16 C60 33 76 38 71 59 C68 78 58 86 50 86 C41 86 29 79 29 60 C29 47 40 45 42 34 C47 43 49 39 52 16Z" fill={CREAM} />
    <path d="M51 46 C55 55 61 57 58 67 C56 75 53 79 50 79 C46 79 42 74 42 64 C42 57 47 55 48 50Z" fill="#F7CD67" />
  </>),
  [AppID.Settings]: draw([20, 28, 80, 78], <>
    <rect x="22" y="33" width="56" height="6" rx="3" fill={CREAM} /><circle cx="62" cy="36" r="8" fill={CREAM} stroke={BROWN} strokeWidth="3.5" />
    <rect x="22" y="50" width="56" height="6" rx="3" fill={CREAM} /><circle cx="38" cy="53" r="8" fill={CREAM} stroke={BROWN} strokeWidth="3.5" />
    <rect x="22" y="67" width="56" height="6" rx="3" fill={CREAM} /><circle cx="66" cy="70" r="8" fill={CREAM} stroke={BROWN} strokeWidth="3.5" />
  </>),
  [AppID.Gallery]: draw([17, 25, 83, 79], camGlyph('#82D5BB')),
  [AppID.XhsStock]: draw([17, 25, 83, 79], camGlyph('#FC736D')),
  [AppID.Music]: draw([35, 22, 80, 76], musicGlyph),
  [AppID.Songwriting]: draw([35, 22, 80, 76], musicGlyph),
  [AppID.Game]: draw([18, 40, 82, 70], <>
    <rect x="18" y="40" width="64" height="30" rx="15" fill={CREAM} />
    <rect x="30" y="52" width="14" height="5" rx="2.5" fill={BROWN} /><rect x="34.5" y="47.5" width="5" height="14" rx="2.5" fill={BROWN} />
    <circle cx="64" cy="50" r="4" fill="#FC736D" /><circle cx="72" cy="58" r="4" fill="#82D5BB" />
  </>),
  [AppID.Journal]: draw([21, 24, 79, 77], bookGlyph),
  [AppID.Novel]: draw([21, 24, 79, 77], bookGlyph),
  [AppID.Study]: draw([21, 24, 79, 77], bookGlyph),
  [AppID.Worldbook]: draw([21, 24, 79, 77], bookGlyph),
  [AppID.Guidebook]: draw([21, 24, 79, 77], bookGlyph),
  [AppID.Schedule]: draw([22, 20, 78, 80], <>
    <rect x="22" y="26" width="56" height="54" rx="8" fill={CREAM} />
    <rect x="22" y="26" width="56" height="16" rx="8" fill="#FC736D" />
    <rect x="33" y="20" width="6" height="14" rx="3" fill={BROWN} /><rect x="61" y="20" width="6" height="14" rx="3" fill={BROWN} />
    <circle cx="38" cy="56" r="4" fill={BROWN} /><circle cx="52" cy="56" r="4" fill={BROWN} /><circle cx="66" cy="56" r="4" fill="#B7A98C" />
    <circle cx="38" cy="69" r="4" fill="#B7A98C" /><circle cx="52" cy="69" r="4" fill={BROWN} />
  </>),
  [AppID.SpecialMoments]: draw([12, 14, 88, 87], starGlyph),
  [AppID.VRWorld]: draw([12, 14, 88, 87], starGlyph),
  [AppID.Appearance]: draw([16, 20, 84, 84], paletteGlyph),
  [AppID.ThemeMaker]: draw([16, 20, 84, 84], paletteGlyph),
  [AppID.HotNews]: draw([20, 26, 80, 76], <>
    <rect x="20" y="26" width="60" height="50" rx="6" fill={CREAM} />
    <rect x="27" y="34" width="22" height="16" rx="3" fill="#B7A98C" />
    <rect x="54" y="34" width="20" height="4" rx="2" fill={BROWN} /><rect x="54" y="43" width="20" height="4" rx="2" fill={BROWN} />
    <rect x="27" y="56" width="46" height="4" rx="2" fill={BROWN} /><rect x="27" y="64" width="36" height="4" rx="2" fill="#B7A98C" />
  </>),
};

export const getAcnhIcon = (appId: string): React.ReactNode =>
  ACNH_ICON_MAP[appId as AppID] ?? leaf;

// --- 聊天「+」面板动作图标（动森瓦片：彩色圆角方块 + 奶油 glyph）---
const bagGlyph = <>
  <path d="M37 35 Q50 27 63 35 C77 46 80 67 69 79 C61 87 39 87 31 79 C20 67 23 46 37 35Z" fill={CREAM} />
  <path d="M41 31 L59 31 L55 40 L45 40Z" fill={BROWN} />
  <path d="M50 50 C43 50 39 56 39 63 H61 C61 56 57 50 50 50Z" fill="#F7CD67" />
  <rect x="46" y="63" width="8" height="3.5" fill={BROWN} /><circle cx="50" cy="70" r="3" fill={BROWN} />
</>;
const chatGlyph = <>
  <path d="M24 24 H76 a15 15 0 0 1 15 15 v13 a15 15 0 0 1 -15 15 H56 l-6 10 -6 -10 H24 a15 15 0 0 1 -15 -15 v-13 a15 15 0 0 1 15 -15Z" fill={CREAM} />
  <circle cx="32" cy="45.5" r="6" fill={BROWN} /><circle cx="50" cy="45.5" r="6" fill={BROWN} /><circle cx="68" cy="45.5" r="6" fill={BROWN} />
</>;
const calGlyph = <>
  <rect x="22" y="26" width="56" height="54" rx="8" fill={CREAM} />
  <rect x="22" y="26" width="56" height="16" rx="8" fill="#FC736D" />
  <rect x="33" y="20" width="6" height="14" rx="3" fill={BROWN} /><rect x="61" y="20" width="6" height="14" rx="3" fill={BROWN} />
  <circle cx="38" cy="56" r="4" fill={BROWN} /><circle cx="52" cy="56" r="4" fill={BROWN} /><circle cx="66" cy="56" r="4" fill="#B7A98C" />
</>;
const handGlyph = <>
  <circle cx="46" cy="62" r="22" fill={CREAM} />
  <rect x="38" y="22" width="15" height="40" rx="7.5" fill={CREAM} />
</>;
const refreshGlyph = <>
  <path d="M28 50 A22 22 0 1 1 38 69" fill="none" stroke={CREAM} strokeWidth="8" strokeLinecap="round" />
  <path d="M22 32 L34 32 L28 46Z" fill={CREAM} />
</>;
const slidersGlyph = <>
  <rect x="22" y="33" width="56" height="6" rx="3" fill={CREAM} /><circle cx="62" cy="36" r="8" fill={CREAM} stroke={BROWN} strokeWidth="3.5" />
  <rect x="22" y="50" width="56" height="6" rx="3" fill={CREAM} /><circle cx="38" cy="53" r="8" fill={CREAM} stroke={BROWN} strokeWidth="3.5" />
  <rect x="22" y="67" width="56" height="6" rx="3" fill={CREAM} /><circle cx="66" cy="70" r="8" fill={CREAM} stroke={BROWN} strokeWidth="3.5" />
</>;
const bookGlyph2 = <>
  <path d="M50 30 C42 24 28 24 21 28 V75 C28 71 42 71 50 77 C58 71 72 71 79 75 V28 C72 24 58 24 50 30Z" fill={CREAM} />
  <path d="M50 30 V77" stroke={BROWN} strokeWidth="3.5" />
</>;

const burgerGlyph = <>
  <rect x="24" y="34" width="52" height="11" rx="5.5" fill={CREAM} />
  <rect x="26" y="47" width="48" height="6" rx="3" fill="#a06a30" />
  <rect x="24" y="55" width="52" height="11" rx="5.5" fill={CREAM} />
</>;
const codeGlyph = <>
  <path d="M40 36 L26 50 L40 64" stroke={CREAM} strokeWidth="7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  <path d="M60 36 L74 50 L60 64" stroke={CREAM} strokeWidth="7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  <line x1="55" y1="32" x2="45" y2="68" stroke={CREAM} strokeWidth="6" strokeLinecap="round" />
</>;
const leafGlyph = <>
  <path d="M50 14 C72 24 80 50 70 76 C66 84 56 87 50 84 C44 87 34 84 30 76 C20 50 28 24 50 14Z" fill={CREAM} />
  <path d="M50 22 V79" stroke={BROWN} strokeWidth="4" strokeLinecap="round" />
  <path d="M50 42 L65 34 M50 56 L35 48" stroke={BROWN} strokeWidth="3.5" strokeLinecap="round" />
</>;

const ACTION_TILES: Record<string, { color: string; bbox: [number, number, number, number]; glyph: React.ReactNode }> = {
  mcd: { color: '#F7CD67', bbox: [24, 34, 76, 66], glyph: burgerGlyph },
  html: { color: '#B77DEE', bbox: [24, 32, 74, 68], glyph: codeGlyph },
  thinking: { color: '#889DF0', bbox: [30, 14, 70, 84], glyph: leafGlyph },
  transfer: { color: '#F7CD67', bbox: [20, 27, 80, 87], glyph: bagGlyph },
  poke: { color: '#F8A6B2', bbox: [24, 22, 68, 84], glyph: handGlyph },
  archive: { color: '#B77DEE', bbox: [21, 24, 79, 77], glyph: bookGlyph2 },
  settings: { color: '#9A835A', bbox: [20, 28, 80, 78], glyph: slidersGlyph },
  image: { color: '#82D5BB', bbox: [17, 25, 83, 79], glyph: camGlyph('#FC736D') },
  regenerate: { color: '#889DF0', bbox: [22, 25, 76, 77], glyph: refreshGlyph },
  proactive: { color: '#8AC68A', bbox: [9, 24, 91, 72], glyph: chatGlyph },
  schedule: { color: '#FC736D', bbox: [22, 20, 78, 80], glyph: calGlyph },
};

export const AcnhActionTile: React.FC<{ kind: string }> = ({ kind }) => {
  const a = ACTION_TILES[kind];
  if (!a) return null;
  return (
    <div className="w-14 h-14 flex items-center justify-center overflow-hidden" style={{ background: a.color, borderRadius: '30%' }}>
      <div className="w-[66%] h-[66%]">{draw(a.bbox, a.glyph)}</div>
    </div>
  );
};
