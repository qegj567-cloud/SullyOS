
import React from 'react';
import { AppConfig } from '../../types';
import { Icons } from '../../constants';
import { isPaperWallpaper, useOS } from '../../context/OSContext';
import { useBlobRefUrl } from '../../utils/blobRef';
import { getAcnhIcon } from './acnhIcons';
import { preloadApp } from './appPreload';
import { isReducedBlurActive } from '../../utils/blurPolicy';

interface AppIconProps {
  app: AppConfig;
  onClick: () => void;
  size?: 'sm' | 'md' | 'lg';
  hideLabel?: boolean;
  variant?: 'default' | 'minimal' | 'dock';
}

// 动森（NookPhone）风格瓦片配色 —— 直接用 animal-island-ui 的应用色板（精确 hex）。
const NOOK_TILE_COLORS: Record<string, string> = {
  indigo: '#889DF0', violet: '#B77DEE', purple: '#B77DEE', fuchsia: '#F8A6B2',
  pink: '#F8A6B2', rose: '#FC736D', red: '#FC736D', orange: '#E59266',
  amber: '#F7CD67', lime: '#D1DA49', green: '#8AC68A', emerald: '#82D5BB',
  cyan: '#82D5BB', blue: '#889DF0', slate: '#9A835A',
};

const AppIcon: React.FC<AppIconProps> = React.memo(({ app, onClick, size = 'md', hideLabel = false, variant = 'default' }) => {
  const { customIcons, theme } = useOS();
  const reducedBlur = isReducedBlurActive();
  const IconComponent = Icons[app.icon] || Icons.Settings;
  const customIconUrl = useBlobRefUrl(customIcons[app.id]);
  const isNook = theme.skin === 'animalcrossing';
  const isPaperDesktop = theme.skin !== 'animalcrossing' && theme.skin !== 'mobilegame' && theme.skin !== 'tamagotchi' && isPaperWallpaper(theme.wallpaper);
  const preserveCustomOutline = !!customIconUrl && theme.preserveCustomIconOutlines === true;
  // 动森皮肤下标签用深棕色，普通皮肤沿用主题 contentColor。
  const contentColor = isNook ? '#725d42' : (theme.contentColor || '#ffffff');

  // Standard sizes
  const sizeClasses =
    size === 'lg' ? 'w-[4.25rem] h-[4.25rem]' :
    size === 'sm' ? 'w-[2.75rem] h-[2.75rem]' :
    'w-[3.5rem] h-[3.5rem]';

  // 动森彩蛋模式：整机统一 NookPhone 外观，连用户自定义图标也一并盖掉。
  if (isNook) {
    const tileColor = NOOK_TILE_COLORS[app.color] || NOOK_TILE_COLORS.slate;
    return (
      <button
        onClick={onClick}
        onPointerDown={() => preloadApp(app.id)}
        className="flex flex-col items-center gap-1.5 group relative active:scale-95 transition-transform duration-200"
        style={{ WebkitTapHighlightColor: 'transparent' }}
      >
        {/* NookPhone 圆角方块瓦片：纯平面，无边框/无阴影/无高光（对齐参考图） */}
        <div
          className={`${sizeClasses} relative flex items-center justify-center overflow-hidden`}
          style={{ backgroundColor: tileColor, borderRadius: '34%' }}
        >
          <div className="w-[78%] h-[78%] relative">
            {getAcnhIcon(app.id)}
          </div>
        </div>
        {!hideLabel && (
          <span
            className={`${size === 'sm' ? 'text-[9px] tracking-wide' : 'text-[10.5px] tracking-wide'} font-bold max-w-full truncate ${variant === 'dock' ? 'hidden' : 'block'}`}
            style={{ color: contentColor }}
          >
            {app.name}
          </span>
        )}
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      onPointerDown={() => preloadApp(app.id)}
      className="flex flex-col items-center gap-1.5 group relative active:scale-95 transition-transform duration-200"
      style={{ WebkitTapHighlightColor: 'transparent' }}
    >
      {/* #409 的“保留透明图标原轮廓”改为可选；默认继续使用原来的系统圆角底框。 */}
      <div
        className={`${sizeClasses} relative flex items-center justify-center ${preserveCustomOutline ? '' : isPaperDesktop ? `
          rounded-[1.1rem] border
          transition-[transform,background-color,box-shadow] duration-200
          group-hover:-translate-y-0.5
        ` : `
        bg-white/40 rounded-[1.125rem]
        border border-white/35
        shadow-[0_4px_12px_rgba(0,0,0,0.16)]
        group-hover:bg-white/50 group-hover:border-white/50
      `}`}
        style={!preserveCustomOutline && isPaperDesktop ? {
          background: 'rgba(224,221,215,0.42)',
          borderColor: 'rgba(91,72,51,0.075)',
          boxShadow: '0 4px 12px rgba(91,72,51,0.055)',
        } : undefined}
      >

        {customIconUrl ? (
            <img
              src={customIconUrl}
              className={`w-full h-full ${preserveCustomOutline ? 'object-contain' : 'object-cover rounded-[1.2rem]'}`}
              alt={app.name}
              loading="lazy"
            />
        ) : (
            <div 
                className={isPaperDesktop
                  ? 'w-[47%] h-[47%] opacity-80'
                  : reducedBlur
                    ? 'w-[50%] h-[50%] opacity-90'
                    : 'w-[50%] h-[50%] drop-shadow-[0_2px_5px_rgba(0,0,0,0.3)] opacity-90'}
                style={{ color: contentColor }}
            >
                 <IconComponent className="w-full h-full" />
            </div>
        )}
      </div>
      
      {!hideLabel && (
        <span
            className={`${size === 'sm' ? 'text-[8.5px]' : 'text-[10px]'} ${isPaperDesktop ? 'tracking-[0.08em] font-semibold opacity-75' : 'tracking-widest font-bold uppercase opacity-80 text-shadow-md'} transition-opacity max-w-full truncate ${variant === 'dock' ? 'hidden' : 'block'}`}
            style={{ color: contentColor }}
        >
          {app.name}
        </span>
      )}
    </button>
  );
}, (prev, next) => {
    // Custom comparison to prevent re-render unless specific props change
    // We don't check 'onClick' deeply assuming it's stable or we want to ignore function ref changes
    return prev.app.id === next.app.id && 
           prev.size === next.size && 
           prev.hideLabel === next.hideLabel &&
           prev.variant === next.variant;
});

export default AppIcon;
