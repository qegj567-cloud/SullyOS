import React, { useMemo, useEffect, useLayoutEffect, useState, useRef } from 'react';
import { useOS } from '../context/OSContext';
import { INSTALLED_APPS, DOCK_APPS } from '../constants';
import { isDevDebugAvailable, subscribeDevDebugAvailability } from '../utils/devDebug';
import AppIcon from '../components/os/AppIcon';
import { DB } from '../utils/db';
import { CharacterProfile, Anniversary, AppID, DailySchedule } from '../types';
import { ScheduleHomeWidget, ScheduleFullscreenViewer } from '../components/schedule/ScheduleHomeWidget';
import NowPlayingSquareWidget from '../components/os/NowPlayingSquareWidget';

// --- Isolated Components to prevent full re-renders ---

// 1. Clock Component (Consumes virtualTime)
const DesktopClock = React.memo(() => {
    const { virtualTime, theme } = useOS();
    const contentColor = theme.contentColor || '#ffffff';

    const days = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const now = new Date();
    const dayName = days[now.getDay()];
    const monthName = months[now.getMonth()];
    const dateNum = now.getDate().toString().padStart(2, '0');
    const yearNum = now.getFullYear();

    // 简单问候（基于虚拟时间）
    const greeting = virtualTime.hours < 5 ? 'Good Night'
        : virtualTime.hours < 12 ? 'Good Morning'
        : virtualTime.hours < 18 ? 'Good Afternoon'
        : 'Good Evening';

    return (
        <div className="flex flex-col mb-4 mt-5 relative animate-fade-in" style={{ color: contentColor }}>
            {/* 顶部装饰 — 状态胶囊 + 细线 */}
            <div className="flex items-center gap-2 mb-3 opacity-90">
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full"
                    style={{
                        background: 'rgba(255,255,255,0.28)',
                        border: '1px solid rgba(255,255,255,0.18)',
                    }}>
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" style={{ boxShadow: '0 0 6px #4ade80' }} />
                    <span className="text-[9px] font-bold tracking-[0.2em] uppercase">System Online</span>
                </div>
                <div className="h-[1px] flex-1 bg-gradient-to-r from-current to-transparent opacity-30" />
                <span className="text-[9px] tracking-[0.2em] uppercase opacity-60">{yearNum}</span>
            </div>

            {/* 问候 */}
            <div className="text-[11px] tracking-[0.25em] uppercase opacity-55 font-semibold mb-1">
                {greeting}
            </div>

            {/* 主时钟 */}
            <div className="flex items-end gap-4">
                <div className="relative">
                    <div className="text-[6.25rem] leading-[0.82] font-black tracking-tighter drop-shadow-2xl"
                        style={{ fontFamily: `'Space Grotesk', 'SF Pro Display', sans-serif`, fontFeatureSettings: '"tnum"' }}>
                        <span>{virtualTime.hours.toString().padStart(2, '0')}</span>
                        <span className="opacity-35 font-thin mx-0.5 animate-pulse">:</span>
                        <span>{virtualTime.minutes.toString().padStart(2, '0')}</span>
                    </div>
                    {/* 细光斑 */}
                    <div className="absolute -top-2 -right-3 w-8 h-8 rounded-full pointer-events-none"
                        style={{ background: 'radial-gradient(circle, rgba(255,255,255,0.4), transparent 70%)' }} />
                </div>

                <div className="flex flex-col justify-end pb-2.5 gap-0.5">
                    <div className="text-[10px] font-bold tracking-[0.22em] opacity-85">{dayName}</div>
                    <div className="flex items-baseline gap-1">
                        <div className="text-2xl font-black leading-none" style={{ fontFamily: `'Space Grotesk', sans-serif` }}>{dateNum}</div>
                        <div className="text-[10px] font-bold tracking-[0.2em] opacity-70">{monthName}</div>
                    </div>
                </div>
            </div>
        </div>
    );
});

// 2. Character Widget (Consumes Character Data & Messages)
const CharacterWidget = React.memo(({ 
    char, 
    unreadCount, 
    lastMessage, 
    onClick, 
    contentColor 
}: { 
    char: CharacterProfile | null, 
    unreadCount: number, 
    lastMessage: string, 
    onClick: () => void,
    contentColor: string
}) => {
    return (
        <div className="mb-3 group animate-fade-in">
             <div
                className="relative h-24 w-full overflow-hidden rounded-3xl cursor-pointer transition-transform duration-300 active:scale-[0.98]"
                onClick={onClick}
                style={{
                    background: 'rgba(255,255,255,0.08)',
                    backdropFilter: 'blur(24px) saturate(1.4)',
                    WebkitBackdropFilter: 'blur(24px) saturate(1.4)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    boxShadow: '0 8px 32px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.08)',
                }}
             >
                 {/* 背景虚化角色头像 */}
                 {char?.avatar && (
                     <div className="absolute inset-0 opacity-25 pointer-events-none"
                         style={{
                             backgroundImage: `url(${char.avatar})`,
                             backgroundSize: 'cover',
                             backgroundPosition: 'center',
                             filter: 'blur(30px) saturate(1.6)',
                             transform: 'scale(1.3)',
                         }} />
                 )}

                 <div className="relative flex items-center p-3 gap-3 h-full">
                     {/* 头像 */}
                     <div className="w-[68px] h-[68px] shrink-0 rounded-2xl overflow-hidden relative bg-slate-800"
                         style={{
                             border: '1.5px solid rgba(255,255,255,0.25)',
                             boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
                         }}>
                         {char ? (
                             <img src={char.avatar} className="w-full h-full object-cover" alt="char" loading="lazy" />
                         ) : <div className="w-full h-full bg-white/10 animate-pulse" />}
                         {unreadCount > 0 ? (
                            <div className="absolute bottom-0.5 right-0.5 min-w-[16px] h-[16px] px-1 bg-red-500 rounded-full border border-white/30 shadow-sm flex items-center justify-center text-[9px] font-bold text-white">
                                {unreadCount > 9 ? '9+' : unreadCount}
                            </div>
                         ) : (
                            <div className="absolute bottom-1 right-1 w-2.5 h-2.5 bg-emerald-400 rounded-full border-2 border-white/30" style={{ boxShadow: '0 0 6px #4ade80' }}></div>
                         )}
                     </div>

                     {/* 文本 */}
                     <div className="flex-1 min-w-0 flex flex-col justify-center gap-1" style={{ color: contentColor }}>
                         <div className="flex items-center gap-1.5">
                             <h3 className="text-[15px] font-bold tracking-wide drop-shadow-md truncate">
                                 {char?.name || 'NO SIGNAL'}
                             </h3>
                             {unreadCount > 0 ? (
                                 <div className="px-1.5 py-px rounded-full text-[8px] font-bold uppercase tracking-[0.15em]"
                                     style={{ background: 'rgba(239,68,68,0.9)', color: 'white' }}>NEW</div>
                             ) : (
                                 <div className="px-1.5 py-px rounded-full text-[8px] font-bold uppercase tracking-[0.15em]"
                                     style={{ background: 'rgba(255,255,255,0.18)' }}>Online</div>
                             )}
                         </div>
                         <div className="text-xs line-clamp-2 font-medium leading-relaxed opacity-85">
                            <span className="opacity-50 mr-1 text-[10px]">▶</span>
                            {lastMessage}
                         </div>
                     </div>
                 </div>
             </div>
        </div>
    );
});

// 3. Grid Page Component
const AppGridPage = React.memo(({
    apps,
    openApp
}: {
    apps: typeof INSTALLED_APPS,
    openApp: (id: AppID) => void
}) => {
    return (
        <div className="grid grid-cols-4 gap-y-6 gap-x-2 place-items-center animate-fade-in relative">
             {apps.map(app => (
                 <div
                    key={app.id}
                    className="relative transition-transform duration-200 active:scale-95"
                 >
                     <AppIcon
                        app={app}
                        onClick={() => openApp(app.id)}
                     />
                 </div>
             ))}
        </div>
    );
});

// 3b. Small 2x2 app grid for pinwheel cells
const AppQuadGrid = React.memo(({ apps, openApp }: { apps: typeof INSTALLED_APPS, openApp: (id: AppID) => void }) => {
    return (
        <div className="w-full h-full grid grid-cols-2 grid-rows-2 place-items-center gap-x-2 gap-y-3">
            {apps.map(app => (
                <div key={app.id} className="relative transition-transform duration-200 active:scale-95">
                    <AppIcon app={app} onClick={() => openApp(app.id)} />
                </div>
            ))}
        </div>
    );
});

// 3c. Square image slot for pinwheel (bottom-right)
const DesktopSquareImage = React.memo(({ image, contentColor, onClick }: {
    image?: string,
    contentColor: string,
    onClick: () => void,
}) => {
    return (
        <div
            onClick={onClick}
            className="relative w-full h-full rounded-[1.75rem] overflow-hidden cursor-pointer animate-fade-in transition-transform active:scale-[0.98]"
            style={{
                background: image ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.28)',
                border: '1px solid rgba(255,255,255,0.18)',
                boxShadow: '0 8px 30px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.07)',
                color: contentColor,
            }}
        >
            {image ? (
                <img src={image} alt="" className="w-full h-full object-cover" loading="lazy" />
            ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 text-center">
                    <div className="w-9 h-9 rounded-full flex items-center justify-center"
                        style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.16)' }}>
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.6} stroke="currentColor" className="w-4 h-4 opacity-70">
                            <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
                        </svg>
                    </div>
                    <div className="text-[8.5px] uppercase font-bold tracking-[0.22em] opacity-55">Add Image</div>
                    <div className="text-[8.5px] opacity-40 leading-tight">从 外观 · 启动器组件<br/>设置一张方图</div>
                </div>
            )}
        </div>
    );
});

const CALENDAR_WEEKDAYS = [
    { key: 'sun', label: 'S' },
    { key: 'mon', label: 'M' },
    { key: 'tue', label: 'T' },
    { key: 'wed', label: 'W' },
    { key: 'thu', label: 'T' },
    { key: 'fri', label: 'F' },
    { key: 'sat', label: 'S' },
] as const;

// 4. Widget Page Component (Calendar + Events)
const WidgetsPage = React.memo(({ contentColor, openApp, anniversaries, characters }: any) => {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    const monthName = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][currentMonth];
    
    const getDaysInMonth = (year: number, month: number) => new Date(year, month + 1, 0).getDate();
    const getFirstDayOfMonth = (year: number, month: number) => new Date(year, month, 1).getDay();
    
    const totalDays = getDaysInMonth(currentYear, currentMonth);
    const startOffset = getFirstDayOfMonth(currentYear, currentMonth);
    
    const calendarDays = Array.from({ length: totalDays }, (_, i) => i + 1);
    const paddingDays = Array.from({ length: startOffset }, () => null);

    // --- Upcoming events: only today + future, soonest first (non-mutating), paginated ---
    const todayStr = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const upcomingEvents = useMemo(
        () => [...(anniversaries as any[])]
            .filter((a: any) => a.date >= todayStr)
            .sort((a: any, b: any) => a.date.localeCompare(b.date)),
        [anniversaries, todayStr]
    );
    const EVENTS_PER_PAGE = 4;
    const eventPageCount = Math.max(1, Math.ceil(upcomingEvents.length / EVENTS_PER_PAGE));
    const [eventPage, setEventPage] = useState(0);
    // Clamp the page if the list shrinks (e.g. an event passes / is removed)
    useEffect(() => {
        if (eventPage > eventPageCount - 1) setEventPage(eventPageCount - 1);
    }, [eventPageCount, eventPage]);
    const pagedEvents = upcomingEvents.slice(eventPage * EVENTS_PER_PAGE, eventPage * EVENTS_PER_PAGE + EVENTS_PER_PAGE);

    return (
        <div className="w-full flex-shrink-0 snap-center snap-always flex flex-col px-6 pt-24 pb-8 space-y-6 h-full overflow-y-auto no-scrollbar">
              <div className="bg-white/25 rounded-3xl p-6 border border-white/25 shadow-xl">
                  <div className="flex justify-between items-center mb-4" style={{ color: contentColor }}>
                      <h3 className="text-xl font-bold tracking-widest">{monthName} {currentYear}</h3>
                      <div onClick={() => openApp('schedule')} className="bg-white/20 p-2 rounded-full cursor-pointer hover:bg-white/40 transition-colors">
                          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                      </div>
                  </div>
                  
                  <div className="grid grid-cols-7 gap-y-3 gap-x-1 text-center mb-2">
                      {CALENDAR_WEEKDAYS.map(day => <div key={day.key} className="text-[10px] font-bold opacity-40" style={{ color: contentColor }}>{day.label}</div>)}
                  </div>
                  
                  <div className="grid grid-cols-7 gap-y-2 gap-x-1 text-center">
                      {paddingDays.map((_, i) => <div key={`pad-${i}`} />)}
                      {calendarDays.map(day => {
                          const dateStr = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                          const isToday = day === now.getDate();
                          const hasEvent = anniversaries.some((a: any) => a.date === dateStr);
                          
                          return (
                              <div key={day} className="flex flex-col items-center justify-center h-8 relative">
                                  <div 
                                    className={`w-8 h-8 flex items-center justify-center rounded-full text-sm font-medium ${isToday ? 'bg-white text-black font-bold shadow-lg' : 'opacity-80'}`}
                                    style={isToday ? {} : { color: contentColor }}
                                  >
                                      {day}
                                  </div>
                                  {hasEvent && <div className="w-1.5 h-1.5 bg-purple-400 rounded-full absolute bottom-0 shadow-sm border border-black/20"></div>}
                              </div>
                          );
                      })}
                  </div>
              </div>

              <div className="bg-white/25 rounded-3xl p-5 border border-white/25 shadow-xl flex flex-col flex-1 min-h-[200px]">
                  <div className="flex items-center justify-between mb-4">
                      <h3 className="text-xs font-bold opacity-60 uppercase tracking-widest flex items-center gap-2" style={{ color: contentColor }}>
                          <span className="w-2 h-2 bg-purple-400 rounded-full"></span> Upcoming Events
                      </h3>
                      {eventPageCount > 1 && (
                          <div className="flex items-center gap-2 shrink-0" style={{ color: contentColor }}>
                              <button
                                  onClick={(e) => { e.stopPropagation(); setEventPage(p => Math.max(0, p - 1)); }}
                                  disabled={eventPage === 0}
                                  className="w-6 h-6 rounded-full bg-white/15 flex items-center justify-center disabled:opacity-25 hover:bg-white/30 transition-colors active:scale-90"
                                  aria-label="Previous events"
                              >
                                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-3 h-3"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" /></svg>
                              </button>
                              <span className="text-[10px] font-mono opacity-60 tabular-nums">{eventPage + 1}/{eventPageCount}</span>
                              <button
                                  onClick={(e) => { e.stopPropagation(); setEventPage(p => Math.min(eventPageCount - 1, p + 1)); }}
                                  disabled={eventPage >= eventPageCount - 1}
                                  className="w-6 h-6 rounded-full bg-white/15 flex items-center justify-center disabled:opacity-25 hover:bg-white/30 transition-colors active:scale-90"
                                  aria-label="Next events"
                              >
                                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-3 h-3"><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
                              </button>
                          </div>
                      )}
                  </div>
                  <div className="space-y-3">
                      {upcomingEvents.length > 0 ? pagedEvents.map((anni: any) => (
                          <div key={anni.id} className="flex items-center gap-3 p-3 bg-white/5 rounded-xl border border-white/10">
                              <div className="w-10 h-10 shrink-0 bg-purple-500/20 rounded-lg flex flex-col items-center justify-center text-purple-200 border border-purple-500/30">
                                  <span className="text-[9px] opacity-70">{anni.date.split('-')[1]}</span>
                                  <span className="text-sm font-bold leading-none">{anni.date.split('-')[2]}</span>
                              </div>
                              <div className="flex-1 min-w-0">
                                  <div className="text-sm font-bold truncate" style={{ color: contentColor }}>{anni.title}</div>
                                  <div className="text-[10px] opacity-50 truncate" style={{ color: contentColor }}>{characters.find((c: any) => c.id === anni.charId)?.name || 'Unknown'}</div>
                              </div>
                          </div>
                      )) : (
                          <div className="text-center opacity-30 text-xs py-8" style={{ color: contentColor }}>No upcoming events</div>
                      )}
                  </div>
              </div>
        </div>
    );
});

// --- Persist scroll page across remounts (e.g. returning from apps) ---
let _lastPageIndex = 0;

// --- Main Launcher ---

const Launcher: React.FC = () => {
  const { openApp, characters, activeCharacterId, theme, lastMsgTimestamp, isDataLoaded, unreadMessages } = useOS();

  // Local state for widget data to prevent context trashing
  const [widgetChar, setWidgetChar] = useState<CharacterProfile | null>(null);
  const [lastMessage, setLastMessage] = useState<string>('');
  const [anniversaries, setAnniversaries] = useState<Anniversary[]>([]);
  const [scheduleData, setScheduleData] = useState<DailySchedule | null>(null);
  const [scheduleCharId, setScheduleCharId] = useState<string | null>(null);
  const [scheduleViewerOpen, setScheduleViewerOpen] = useState(false);

  const [activePageIndex, setActivePageIndex] = useState(_lastPageIndex);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Mouse Drag Logic refs
  const isDragging = useRef(false);
  const startX = useRef(0);
  const scrollLeftRef = useRef(0);
  const dragMoved = useRef(0);

  // Pagination Logic
  // 跟随 DevDebug 可用性：prod 用户在设置页连点 5 下解锁后，CharCreatorDev 立刻出现；
  // 点「关闭」/ 刷新（prod 自动失效）也立刻消失。useMemo deps 没列 devDebugVisible
  // 会让它锁在 mount 时的初值。
  const [devDebugVisible, setDevDebugVisible] = useState(() => isDevDebugAvailable());
  useEffect(() => subscribeDevDebugAvailability(setDevDebugVisible), []);
  const gridApps = useMemo(() => {
    return INSTALLED_APPS.filter(app =>
      !DOCK_APPS.includes(app.id)
      // 「捏脸·开发」仅在开发模式（右下角开发徽标可见或手动解锁时）显示
      && (app.id !== AppID.CharCreatorDev || devDebugVisible)
    );
  }, [devDebugVisible]);

  const dockAppsConfig = useMemo(() => 
    DOCK_APPS.map(id => INSTALLED_APPS.find(app => app.id === id)).filter(Boolean) as typeof INSTALLED_APPS,
    []
  );

  // Split apps into pages of 8 (4 cols x 2 rows fit comfortably below widget)
  // Pages: 0 = clock+chat+music+grid (original), 1 = pinwheel, 2 = widget images + grid,
  //        3+ = plain grid. Pad to at least 3 slots so the pinwheel/widget pages always exist.
  const APPS_PER_PAGE = 8;
  const appPages = useMemo(() => {
      const pages: typeof INSTALLED_APPS[] = [];
      for (let i = 0; i < gridApps.length; i += APPS_PER_PAGE) {
          pages.push(gridApps.slice(i, i + APPS_PER_PAGE));
      }
      while (pages.length < 3) pages.push([]);
      return pages;
  }, [gridApps]);

  // Page 2 (pinwheel) uses appPages[1]: split into two 2x2 quads
  const page2Apps = appPages[1] || [];
  const page2QuadA = useMemo(() => page2Apps.slice(0, 4), [page2Apps]);
  const page2QuadB = useMemo(() => page2Apps.slice(4, 8), [page2Apps]);

  // Total pages = App Pages + 1 Widget Page
  const totalPages = appPages.length + 1;

  useEffect(() => {
      const loadData = async () => {
          // SAFEGUARD: If characters array is empty, reset widget char
          if (!characters || characters.length === 0) {
              setWidgetChar(null);
              setLastMessage('No Character Connected');
              setAnniversaries([]);
              return;
          }

          const targetChar = characters.find(c => c.id === activeCharacterId) || characters[0];
          setWidgetChar(targetChar);

          try {
              const [msgs, annis] = await Promise.all([
                  DB.getMessagesByCharId(targetChar.id),
                  DB.getAllAnniversaries()
              ]);
              
              if (msgs.length > 0) {
                  const visibleMsgs = msgs.filter(m => m.role !== 'system');
                  if (visibleMsgs.length > 0) {
                      const last = visibleMsgs[visibleMsgs.length - 1];
                      const cleanContent = last.content.replace(/\[.*?\]/g, '').trim();
                      setLastMessage(cleanContent || (last.type === 'image' ? '[图片]' : '[消息]'));
                  } else {
                      setLastMessage(targetChar.description || "System Ready.");
                  }
              } else {
                  setLastMessage(targetChar.description || "System Ready.");
              }
              setAnniversaries(annis);
          } catch (e) {
              console.error(e);
          }
      };
      
      if (isDataLoaded) {
          loadData();
      }
  }, [activeCharacterId, lastMsgTimestamp, isDataLoaded, characters]); // Trigger on characters change

  // Schedule widget data loading (shown below SpecialMoments icon)
  const scheduleChar = useMemo(() => {
      if (!characters || characters.length === 0) return null;
      if (scheduleCharId) return characters.find(c => c.id === scheduleCharId) || characters[0];
      return characters.find(c => c.id === activeCharacterId) || characters[0];
  }, [characters, scheduleCharId, activeCharacterId]);

  useEffect(() => {
      if (!scheduleChar || !isDataLoaded) return;
      const today = new Date().toISOString().split('T')[0];
      DB.getDailySchedule(scheduleChar.id, today).then(s => setScheduleData(s)).catch(() => {});
  }, [scheduleChar, isDataLoaded]);

  // Restore scroll position BEFORE paint to avoid visible flash/slide
  useLayoutEffect(() => {
      const el = scrollContainerRef.current;
      if (el && _lastPageIndex > 0) {
          // Temporarily disable smooth scroll so jump is instant
          el.style.scrollBehavior = 'auto';
          el.scrollLeft = el.clientWidth * _lastPageIndex;
          // Re-enable on next frame
          requestAnimationFrame(() => { el.style.scrollBehavior = 'smooth'; });
      }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleScroll = () => {
      if (scrollContainerRef.current) {
          const width = scrollContainerRef.current.clientWidth;
          const scrollLeft = scrollContainerRef.current.scrollLeft;
          const index = Math.round(scrollLeft / width);
          setActivePageIndex(index);
          _lastPageIndex = index; // Persist across remounts
      }
  };

  // --- Mouse Drag Handlers ---
  const handleMouseDown = (e: React.MouseEvent) => {
      if (!scrollContainerRef.current) return;
      isDragging.current = true;
      dragMoved.current = 0;
      startX.current = e.pageX - scrollContainerRef.current.offsetLeft;
      scrollLeftRef.current = scrollContainerRef.current.scrollLeft;
      
      // Disable snap and smooth scroll for direct control
      scrollContainerRef.current.style.scrollBehavior = 'auto';
      scrollContainerRef.current.style.scrollSnapType = 'none';
      scrollContainerRef.current.style.cursor = 'grabbing';
  };

  const handleMouseMove = (e: React.MouseEvent) => {
      if (!isDragging.current || !scrollContainerRef.current) return;
      e.preventDefault();
      const x = e.pageX - scrollContainerRef.current.offsetLeft;
      const walk = (x - startX.current);
      scrollContainerRef.current.scrollLeft = scrollLeftRef.current - walk;
      
      dragMoved.current = Math.abs(x - (startX.current + scrollContainerRef.current.offsetLeft)); 
  };

  const handleMouseUp = () => {
      if (!isDragging.current || !scrollContainerRef.current) return;
      isDragging.current = false;
      
      // Restore styles
      scrollContainerRef.current.style.scrollBehavior = 'smooth';
      scrollContainerRef.current.style.scrollSnapType = 'x mandatory';
      scrollContainerRef.current.style.cursor = 'grab';
  };

  const handleMouseLeave = () => {
      if (isDragging.current) handleMouseUp();
  };

  const handleClickCapture = (e: React.MouseEvent) => {
      if (dragMoved.current > 5) {
          e.stopPropagation();
          e.preventDefault();
      }
  };

  const contentColor = theme.contentColor || '#ffffff';
  const launcherBottomInset = 'calc(var(--safe-bottom) + 1.25rem)';
  
  const totalUnread = Object.values(unreadMessages).reduce((a, b) => a + b, 0);
  const widgetUnread = widgetChar && unreadMessages[widgetChar.id] ? unreadMessages[widgetChar.id] : 0;

  return (
    <div className="h-full w-full flex flex-col relative z-10 overflow-hidden font-sans select-none">
      
      {/* Visual Elements (Decorative Background - Static, low-cost gradients instead of blur) */}
      <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -top-20 -right-20 w-80 h-80 rounded-full" style={{ background: 'radial-gradient(circle, rgba(255,255,255,0.05) 0%, transparent 70%)' }}></div>
          <div className="absolute -bottom-20 -left-20 w-80 h-80 rounded-full" style={{ background: 'radial-gradient(circle, rgba(59,130,246,0.08) 0%, transparent 70%)' }}></div>
      </div>

      {/* Scrollable Content Layer */}
      {/* UPDATE: Added snap-always to children to ensure one-page-at-a-time scrolling on mobile swipe */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onClickCapture={handleClickCapture}
        className="flex-1 flex overflow-x-auto snap-x snap-mandatory no-scrollbar cursor-grab active:cursor-grabbing"
        style={{
            scrollBehavior: 'smooth',
            overscrollBehaviorX: 'contain',
            overscrollBehaviorY: 'none',
            touchAction: 'pan-x pan-y',
            willChange: 'scroll-position',
            contain: 'layout paint',
            transform: 'translateZ(0)',
            WebkitOverflowScrolling: 'touch',
        }}
      >
          {/* Render App Pages */}
          {appPages.map((pageApps, idx) => (
              <div
                key={idx}
                className="w-full flex-shrink-0 snap-center snap-always flex flex-col px-6 pt-12 pb-8 h-full"
                style={{ contentVisibility: 'auto', contain: 'layout paint', transform: 'translateZ(0)' }}
              >
                  {idx === 0 ? (
                      // Page 1 (original): Clock + Chat + 4x2 App Grid
                      <>
                        <DesktopClock />
                        <CharacterWidget
                            char={widgetChar}
                            unreadCount={widgetUnread}
                            lastMessage={lastMessage}
                            onClick={() => openApp(AppID.Chat)}
                            contentColor={contentColor}
                        />
                        <div className="flex-1">
                            <AppGridPage apps={pageApps} openApp={openApp} />
                        </div>
                      </>
                  ) : idx === 1 ? (
                      // Page 2: Schedule 4x2 widget on top + Pinwheel (Music / 2x2 icons / 2x2 icons / Image) below
                      <div className="flex-1 min-h-0 w-full flex flex-col gap-5 justify-center">
                          {scheduleChar && (
                              <ScheduleHomeWidget
                                  schedule={scheduleData}
                                  character={scheduleChar}
                                  contentColor={contentColor}
                                  onOpen={() => setScheduleViewerOpen(true)}
                              />
                          )}
                          <div className="grid grid-cols-2 gap-x-3 gap-y-5 w-full">
                              <div className="aspect-square min-w-0">
                                  <NowPlayingSquareWidget contentColor={contentColor} />
                              </div>
                              <div className="aspect-square min-w-0">
                                  <AppQuadGrid apps={page2QuadA} openApp={openApp} />
                              </div>
                              <div className="aspect-square min-w-0">
                                  <AppQuadGrid apps={page2QuadB} openApp={openApp} />
                              </div>
                              <div className="aspect-square min-w-0">
                                  <DesktopSquareImage
                                      image={theme.launcherWidgets?.['dsq']}
                                      contentColor={contentColor}
                                      onClick={() => openApp(AppID.Appearance)}
                                  />
                              </div>
                          </div>
                      </div>
                  ) : (
                      // Page 3+: Widget Images (idx===2 only) + Free Decorations + Apps
                      <div className="pt-10 flex-1 flex flex-col relative">
                          {idx === 2 && (() => {
                            const raw = theme.launcherWidgets || {};
                            const w = { ...raw };
                            const hasAny = w['tl'] || w['tr'] || w['wide'];
                            const hasTopRow = w['tl'] || w['tr'];
                            return (
                              <>
                                {hasAny && (
                                  <div className="mb-3 space-y-2 relative z-10">
                                    {hasTopRow && (
                                      <div className="flex gap-2">
                                        {['tl', 'tr'].map(key => w[key] ? (
                                          <div key={key} className="flex-1 aspect-square rounded-2xl overflow-hidden shadow-md border border-white/20">
                                            <img src={w[key]} className="w-full h-full object-cover" alt="" loading="lazy" />
                                          </div>
                                        ) : <div key={key} className="flex-1"></div>)}
                                      </div>
                                    )}
                                    {w['wide'] && (
                                      <div className="w-full h-32 rounded-2xl overflow-hidden shadow-md border border-white/20">
                                        <img src={w['wide']} className="w-full h-full object-cover" alt="" loading="lazy" />
                                      </div>
                                    )}
                                  </div>
                                )}
                                {/* Free-positioned Desktop Decorations (z-20 to float above widgets z-10) */}
                                {theme.desktopDecorations && theme.desktopDecorations.length > 0 && (
                                  <div className="absolute inset-0 pointer-events-none overflow-hidden z-20">
                                    {theme.desktopDecorations.map(deco => (
                                      <img
                                        key={deco.id}
                                        src={deco.content}
                                        alt=""
                                        loading="lazy"
                                        className="absolute w-16 h-16 object-contain select-none"
                                        style={{
                                          left: `${deco.x}%`,
                                          top: `${deco.y}%`,
                                          transform: `translate(-50%, -50%) scale(${deco.scale}) rotate(${deco.rotation}deg)${deco.flip ? ' scaleX(-1)' : ''}`,
                                          opacity: deco.opacity,
                                          zIndex: deco.zIndex,
                                          filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.15))',
                                        }}
                                      />
                                    ))}
                                  </div>
                                )}
                              </>
                            );
                          })()}

                          <AppGridPage
                                apps={pageApps}
                                openApp={openApp}
                          />
                          <div className="flex-1"></div>
                      </div>
                  )}
              </div>
          ))}

          {/* Final Page: Widgets */}
          <WidgetsPage
            contentColor={contentColor}
            openApp={openApp}
            anniversaries={anniversaries}
            characters={characters}
          />

      </div>

      {/* Page Indicators */}
      <div
          className="absolute left-0 w-full flex justify-center gap-2 pointer-events-none z-20"
          style={{ bottom: `calc(${launcherBottomInset} + 5.5rem)` }}
      >
          {Array.from({ length: totalPages }).map((_, i) => (
              <div 
                key={i}
                className={`h-1.5 rounded-full transition-all duration-300 ${activePageIndex === i ? 'w-4 opacity-100' : 'w-1.5 opacity-40'}`} 
                style={{ backgroundColor: contentColor }}
              ></div>
          ))}
      </div>

      {/* Floating Dock - Updated Margin and Safe Area handling */}
      <div
           className="mt-auto flex justify-center w-full px-4 relative z-30"
           style={{ paddingBottom: launcherBottomInset }}
      >
           <div className="bg-white/30 rounded-[1.75rem] border border-white/25 shadow-[0_8px_40px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.08)] px-4 py-3 flex gap-3 sm:gap-6 items-center mx-auto max-w-full justify-between overflow-x-auto no-scrollbar transform-gpu">
               {dockAppsConfig.map(app => (
                   <div key={app.id} className="relative">
                        <AppIcon app={app} onClick={() => openApp(app.id)} variant="dock" size="md" />
                        {app.id === 'chat' && totalUnread > 0 && (
                            <div className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 rounded-full text-white text-[9px] flex items-center justify-center border-2 border-white/20 shadow-sm font-bold pointer-events-none animate-pop-in">
                                {totalUnread > 9 ? '9+' : totalUnread}
                            </div>
                        )}
                   </div>
               ))}
           </div>
      </div>

      <ScheduleFullscreenViewer
          open={scheduleViewerOpen}
          onClose={() => setScheduleViewerOpen(false)}
          characters={characters}
          activeCharId={scheduleChar?.id || null}
          onSwitchCharacter={(id) => setScheduleCharId(id)}
          schedule={scheduleData}
          activeCharacter={scheduleChar}
          contentColor={contentColor}
      />

    </div>
  );
};

export default Launcher;
