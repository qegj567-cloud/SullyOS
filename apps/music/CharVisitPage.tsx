/**
 * Char 拜访页 — 访问某个角色的网易云风格"小号主页"
 *
 * 思路：完全仿网易云个人主页排版，但数据全来自本地 CharMusicProfile。
 * 用户体验上就像 "去别人主页逛一圈"，不是 "切换账号"。
 *
 * 交互：
 * - 未初始化 → 显示"敲敲门"按钮，点一下调 LLM 生成 musicProfile。
 * - 已初始化 → 展示 bio / 曲风徽章 / 偏爱艺人 / 歌单 / 最近在听 / 评论。
 * - 点歌单进详情（若歌单空，可以一键让 char 搜歌填充）。
 * - 点任一首歌 → 用全局 MusicContext 播放 (沿用 user 的 cookie / 配额)。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { useMusic, musicApi, toHttps, Song } from '../../context/MusicContext';
import { CharacterProfile, CharPlaylist, CharPlaylistSong } from '../../types';
import { CharMusicPersona } from '../../utils/charMusicPersona';
import { computeCurrentListening } from '../../utils/charMusicSchedule';
import { removeSongsFromPlaylist } from '../../utils/charPlaylistEdit';
import { DB } from '../../utils/db';
import { C, Sparkle, MizuHeader, BokehBg, MiniPlayer } from './MusicUI';
import { ArrowLeft, MusicNote, Heart, Plus, MagnifyingGlass, Trash, Check } from '@phosphor-icons/react';
import { getDailyScheduleForChar } from '../../utils/dailySchedule';
import TokenImg from '../../components/os/TokenImg';
import { isBlobRef } from '../../utils/blobRef';
import { useLocalDateKey } from '../../hooks/useLocalDateKey';
import { resolveCharTimeZone } from '../../utils/timezone';
import { trackEvent } from '../../utils/analytics';

interface Props {
  charId: string;
  onBack: () => void;
  onOpenPlayer: () => void;
}

const gradientMap: Record<string, string> = {
  'gradient-01': `linear-gradient(135deg, ${C.primary}, ${C.accent})`,
  'gradient-02': `linear-gradient(135deg, ${C.sakura}, ${C.lavender})`,
  'gradient-03': `linear-gradient(135deg, ${C.accent}, ${C.glow})`,
  'gradient-04': `linear-gradient(135deg, ${C.lavender}, ${C.primary})`,
  'gradient-05': `linear-gradient(135deg, ${C.vip}, ${C.sakura})`,
  'gradient-06': `linear-gradient(135deg, ${C.glow}, ${C.lavender})`,
};
const gradientFor = (key?: string) => gradientMap[key || 'gradient-01'] || gradientMap['gradient-01'];

const songFromSearch = (s: any): Song => ({
  id: s.id,
  name: s.name,
  artists: (s.ar || s.artists || []).map((a: any) => a.name).join(' / '),
  album: s.al?.name || s.album?.name || '',
  albumPic: toHttps(s.al?.picUrl || s.album?.picUrl || ''),
  duration: (s.dt || s.duration || 0) / 1000,
  fee: s.fee ?? 0,
});

const toPlaylistSong = (s: Song): CharPlaylistSong => ({
  id: s.id, name: s.name, artists: s.artists, album: s.album,
  albumPic: s.albumPic, duration: s.duration, fee: s.fee,
});

function MusicBio({ bio }: { bio?: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!bio) return <p className="text-[10px] mt-0.5" style={{ color: C.muted }}>还没写音乐简介</p>;
  return <button type="button" aria-label={expanded ? '收起音乐简介' : '展开音乐简介'} aria-expanded={expanded}
    className="flex items-start gap-1 w-full py-1 text-left text-[11px]" style={{ color: C.muted }}
    onClick={() => { if (!expanded) trackEvent('展开角色音乐简介'); setExpanded(!expanded); }}>
    <span className={expanded ? 'min-w-0 whitespace-pre-wrap break-words' : 'min-w-0 truncate'}>{bio}</span>
    <span aria-hidden="true" className="shrink-0">{expanded ? '▴' : '▾'}</span>
  </button>;
}

const CharVisitPage: React.FC<Props> = ({ charId, onBack, onOpenPlayer }) => {
  const { characters, updateCharacter, userProfile, apiConfig, addToast } = useOS();
  const {
    cfg, playSong,
    current, playing, togglePlay, nextSong, prevSong,
  } = useMusic();
  const char = useMemo(() => characters.find(c => c.id === charId), [characters, charId]);
  const charDateKey = useLocalDateKey(resolveCharTimeZone(char));

  const [initializing, setInitializing] = useState(false);
  const [expandedPl, setExpandedPl] = useState<string | null>(null);
  const [fillingPl, setFillingPl] = useState<string | null>(null);

  // 选择模式：长按或点「选择」进入，可勾选多首歌一起删
  const [selectingPl, setSelectingPl] = useState<string | null>(null);
  const [selectedSongIds, setSelectedSongIds] = useState<Set<number>>(new Set());

  const enterSelectMode = (plId: string, songId?: number) => {
    setExpandedPl(plId);
    setSelectingPl(plId);
    setSelectedSongIds(songId != null ? new Set([songId]) : new Set());
  };
  const exitSelectMode = () => {
    setSelectingPl(null);
    setSelectedSongIds(new Set());
  };
  const toggleSelected = (songId: number) => {
    setSelectedSongIds(prev => {
      const next = new Set(prev);
      if (next.has(songId)) next.delete(songId); else next.add(songId);
      return next;
    });
  };

  // 长按检测：按住约 0.5s 触发；手指/鼠标移动超过阈值视为滚动，取消长按
  const lpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lpFired = useRef(false);
  const lpStart = useRef<{ x: number; y: number } | null>(null);
  const clearLongPress = () => {
    if (lpTimer.current) { clearTimeout(lpTimer.current); lpTimer.current = null; }
    lpStart.current = null;
  };
  // 组件卸载时清掉可能还挂着的长按定时器，别让 setTimeout 落到已卸载的组件上
  useEffect(() => () => { if (lpTimer.current) clearTimeout(lpTimer.current); }, []);
  const songPressHandlers = (pl: CharPlaylist, song: CharPlaylistSong) => ({
    onPointerDown: (e: React.PointerEvent) => {
      lpFired.current = false; // 每次按下先清零：上次长按若没收到 click，别让 true 卡住吞掉这次点击
      clearLongPress();        // 清掉上一次残留的定时器和起点坐标
      if (selectingPl) return; // 已在选择模式，不需要长按
      lpStart.current = { x: e.clientX, y: e.clientY };
      lpTimer.current = setTimeout(() => {
        lpFired.current = true;
        enterSelectMode(pl.id, song.id);
      }, 500);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!lpStart.current) return;
      if (Math.abs(e.clientX - lpStart.current.x) > 10 || Math.abs(e.clientY - lpStart.current.y) > 10) {
        clearLongPress();
      }
    },
    onPointerUp: clearLongPress,
    onPointerLeave: clearLongPress,
    onPointerCancel: clearLongPress,
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); }, // 移动端长按不弹系统菜单
  });

  const profile = char?.musicProfile;
  const initialized = !!(char && CharMusicPersona.isInitialized(char));

  // 拜访时刷新 char 此刻在听的歌（纯本地计算，零网络）
  // 只在 char.id / initialized 变化时刷新一次，避免每秒 tick
  useEffect(() => {
    if (!char || !initialized || !char.musicProfile) return;
    let cancelled = false;
    (async () => {
      try {
        const schedule = await getDailyScheduleForChar(char);
        if (cancelled) return;
        const cur = computeCurrentListening(char, schedule);
        const prev = char.musicProfile!.currentListening;
        const differ = (prev?.songId !== cur?.songId) || (prev?.startedAt !== cur?.startedAt);
        if (differ) {
          updateCharacter(char.id, {
            musicProfile: {
              ...char.musicProfile!,
              currentListening: cur || undefined,
              updatedAt: Date.now(),
            },
          });
        }
      } catch (e) {
        console.warn('[CharVisitPage] refresh currentListening failed:', e);
      }
    })();
    return () => { cancelled = true; };
  }, [char?.id, char?.customTimezoneEnabled, char?.customTimezone, initialized, charDateKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const doInitialize = useCallback(async () => {
    if (!char || initializing) return;
    setInitializing(true);
    try {
      const newProfile = await CharMusicPersona.initialize(char, userProfile, apiConfig);
      updateCharacter(char.id, { musicProfile: newProfile });
      addToast(`${char.name} 的音乐角落已开启`, 'success');
      trackEvent('生成角色的音乐人格');
    } catch (e: any) {
      addToast(`初始化失败：${e.message || '未知错误'}`, 'error');
    } finally {
      setInitializing(false);
    }
  }, [char, initializing, userProfile, apiConfig, updateCharacter, addToast]);

  /** 清掉旧档案重新走一次 LLM —— 给旧版保底生成的"告五人"账号用。 */
  const doRegenerate = useCallback(async () => {
    if (!char || initializing) return;
    const ok = typeof window !== 'undefined'
      ? window.confirm(`清空 ${char.name} 现有的音乐人格，重新让 LLM 生成？\n（歌单里已填的歌也会丢）`)
      : true;
    if (!ok) return;
    setInitializing(true);
    try {
      const newProfile = await CharMusicPersona.initialize(char, userProfile, apiConfig);
      updateCharacter(char.id, { musicProfile: newProfile });
      addToast(`${char.name} 的音乐人格已重新生成`, 'success');
      trackEvent('重新生成角色的音乐人格');
    } catch (e: any) {
      addToast(`重新生成失败：${e.message || '未知错误'}`, 'error');
    } finally {
      setInitializing(false);
    }
  }, [char, initializing, userProfile, apiConfig, updateCharacter, addToast]);

  const togglePlaylist = (plId: string) => {
    setExpandedPl(prev => (prev === plId ? null : plId));
    exitSelectMode(); // 收起或切到别的歌单时，退出选择模式
  };

  /** 把当前选中的歌从歌单里一起删掉（弹一次确认） */
  const deleteSelected = (pl: CharPlaylist) => {
    if (!char || !profile || selectedSongIds.size === 0) return;
    const n = selectedSongIds.size;
    const ok = typeof window !== 'undefined'
      ? window.confirm(`从《${pl.title}》移除选中的 ${n} 首歌？`)
      : true;
    if (!ok) return;
    const nextPlaylists = removeSongsFromPlaylist(profile.playlists, pl.id, selectedSongIds, Date.now());
    updateCharacter(char.id, {
      musicProfile: { ...profile, playlists: nextPlaylists, updatedAt: Date.now() },
    });
    addToast(`已移除 ${n} 首`, 'success');
    trackEvent('删除角色歌单里选中的歌');
    exitSelectMode();
  };

  /** 让 char 用偏爱艺人作为关键词去搜歌 → 自动填充空歌单
   *  关键：每个歌单走一组**不同**的关键词，否则三个歌单会搜出一模一样的歌。
   *  - 用歌单自己的 title / mood 作为主关键词（区别度最高）
   *  - 再按歌单 index 旋转 signatureArtists 取一段，保证不同歌单艺人不重叠
   *  - 还要去掉本角色其它歌单已经有的歌，避免跨歌单撞曲
   */
  const fillPlaylistFromTaste = useCallback(async (pl: CharPlaylist) => {
    if (!char || !profile || fillingPl) return;
    setFillingPl(pl.id);
    try {
      const moodKeywordMap: Record<string, string> = {
        happy: '快乐', sad: '悲伤', romantic: '浪漫', angry: '发泄',
        chill: '放松', epic: '史诗', nostalgic: '怀旧', dreamy: '氛围',
      };

      const plIndex = Math.max(0, profile.playlists.findIndex(p => p.id === pl.id));
      const allArtists = profile.signatureArtists.map(a => a.name).filter(Boolean);
      const allGenres = profile.genreTags.filter(Boolean);

      // 按歌单序号轮换艺人/曲风，让 A/B/C 三个歌单永远拿到不同切片
      const rotate = (arr: string[], offset: number, take: number): string[] => {
        if (arr.length === 0) return [];
        const out: string[] = [];
        for (let i = 0; i < take && i < arr.length; i++) {
          out.push(arr[(offset + i) % arr.length]);
        }
        return out;
      };

      const keywords: string[] = [];
      // 1) 歌单自己的 title 直接当关键词 — 这是最能拉开差异的一项
      const cleanTitle = (pl.title || '').trim();
      if (cleanTitle && !/^歌单\s*\d*$/.test(cleanTitle)) keywords.push(cleanTitle);
      // 2) mood → 中文搜索词
      if (pl.mood && moodKeywordMap[pl.mood]) keywords.push(moodKeywordMap[pl.mood]);
      // 3) 旋转后的艺人（每歌单 2 个，错开起点）
      keywords.push(...rotate(allArtists, plIndex * 2, 2));
      // 4) 没艺人就用旋转后的曲风兜底
      if (allArtists.length === 0) keywords.push(...rotate(allGenres, plIndex, 2));

      // 去重 + 去空
      const uniqKeywords = Array.from(new Set(keywords.map(k => k.trim()).filter(Boolean)));
      if (uniqKeywords.length === 0) {
        addToast('还没有足够的品味数据，先初始化一下吧', 'info');
        return;
      }

      // 跨歌单去重：本角色其它歌单已经有的歌不要再塞进来
      const usedInOthers = new Set<number>();
      for (const other of profile.playlists) {
        if (other.id === pl.id) continue;
        for (const s of other.songs) usedInOthers.add(s.id);
      }

      const picked: CharPlaylistSong[] = [];
      const seen = new Set<number>();
      for (const kw of uniqKeywords) {
        if (picked.length >= 8) break;
        try {
          const r = await musicApi.search(cfg, kw);
          const songs: Song[] = (r?.result?.songs || []).slice(0, 4).map(songFromSearch);
          for (const s of songs) {
            if (seen.has(s.id) || usedInOthers.has(s.id)) continue;
            seen.add(s.id);
            picked.push(toPlaylistSong(s));
            if (picked.length >= 8) break;
          }
        } catch { /* 单个关键词失败不阻塞 */ }
      }

      if (picked.length === 0) {
        addToast('没搜到合适的歌', 'error');
        return;
      }
      const updatedPl: CharPlaylist = {
        ...pl,
        songs: picked,
        coverStyle: pl.coverStyle,
        updatedAt: Date.now(),
      };
      const updatedProfile = {
        ...profile,
        playlists: profile.playlists.map(p => p.id === pl.id ? updatedPl : p),
        updatedAt: Date.now(),
      };
      updateCharacter(char.id, { musicProfile: updatedProfile });
      addToast(`已为《${pl.title}》填入 ${picked.length} 首歌`, 'success');
      trackEvent('让角色按品味挑歌填满歌单');
    } catch (e: any) {
      addToast(`填充失败：${e.message}`, 'error');
    } finally {
      setFillingPl(null);
    }
  }, [char, profile, cfg, fillingPl, updateCharacter, addToast]);

  const playPlaylistSong = (pl: CharPlaylist, song: CharPlaylistSong) => {
    // 用 char 歌单作为队列，点击的歌作为起点
    const queue: Song[] = pl.songs.map(s => ({ ...s }));
    const startIdx = queue.findIndex(s => s.id === song.id);
    playSong(queue[startIdx], { replaceQueue: queue, startIdx });
    onOpenPlayer();
    trackEvent('播放角色歌单里的一首歌');
  };

  if (!char) {
    return (
      <div className="flex flex-col h-full relative" style={{ background: C.bg }}>
        <MizuHeader title="拜访" onBack={onBack} />
        <div className="flex-1 flex items-center justify-center text-sm" style={{ color: C.muted }}>
          找不到这个角色。
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full relative"
      style={{ background: `linear-gradient(180deg, #ffffff 0%, ${C.bg} 50%, ${C.bgDeep} 100%)` }}>
      <BokehBg />
      <MizuHeader
        title={`拜访 · ${char.name}`}
        onBack={onBack}
      />

      <div className="flex-1 overflow-y-auto relative z-10 shizuku-scrollbar pb-20">
        {/* Banner + 拜访徽标 */}
        <div className="relative h-32 overflow-hidden">
          <div className="absolute inset-0"
            style={{ background: `linear-gradient(135deg, ${C.lavender}50, ${C.sakura}40, ${C.accent}40)` }} />
          <div className="absolute top-3 left-4 text-[10px] tracking-[0.35em] uppercase font-semibold"
            style={{ color: 'rgba(255,255,255,0.9)', textShadow: '0 1px 4px rgba(0,0,0,0.2)' }}>
            Visiting Another Soul
          </div>
          <div className="absolute inset-0" style={{ background: `linear-gradient(180deg, transparent 0%, ${C.bg}CC 100%)` }} />
        </div>

        {/* 角色卡 */}
        <div className="-mt-12 mx-4 rounded-3xl p-4 shizuku-glass-strong relative z-10"
          style={{ boxShadow: `0 10px 40px ${C.glow}15` }}>
          <div className="flex items-center gap-3">
            <div className="relative shrink-0">
              {/* 头像可能是 base64 / 图床直链 / blobref 令牌，三种都算图；其余当 emoji 或首字兜底。 */}
              {char.avatar && (char.avatar.startsWith('data:') || char.avatar.startsWith('http') || isBlobRef(char.avatar)) ? (
                <TokenImg value={char.avatar} alt="" className="w-16 h-16 rounded-2xl object-cover"
                  style={{ border: `2px solid ${C.glow}60`, boxShadow: `0 4px 20px ${C.glow}30` }} />
              ) : (
                <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-2xl"
                  style={{ background: gradientFor('gradient-04'), color: 'white' }}>
                  {char.avatar || char.name.slice(0, 1)}
                </div>
              )}
              <div className="absolute -bottom-1 -right-1">
                <Sparkle size={10} color={C.sakura} delay={0.3} />
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-base font-semibold truncate"
                style={{ color: C.text, fontFamily: `'Noto Serif', serif` }}>
                {char.name}
              </div>
              <MusicBio key={char.id} bio={profile?.bio} />
              <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                {(profile?.genreTags || []).slice(0, 4).map(tag => (
                  <span key={tag} className="text-[9px] px-2 py-0.5 rounded-full"
                    style={{ background: `${C.accent}22`, color: C.primary, border: `1px solid ${C.accent}30` }}>
                    #{tag}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* 统计行 */}
          <div className="grid grid-cols-3 gap-2 mt-3 text-center">
            <StatCell label="歌单" value={profile?.playlists.length || 0} />
            <StatCell label="喜欢" value={profile?.likedSongIds.length || 0} />
            <StatCell label="最近听" value={profile?.recentPlays.length || 0} />
          </div>
        </div>

        {/* 未初始化 CTA */}
        {!initialized && (
          <div className="mx-4 mt-4 rounded-2xl p-4 shizuku-glass text-center">
            <div className="text-xs mb-2" style={{ color: C.muted, fontFamily: `'Noto Serif', serif` }}>
              {char.name} 的音乐角落还是一片空白
            </div>
            <div className="text-[10px] mb-3 italic" style={{ color: C.faint }}>
              点开后会生成 ta 的曲风偏好、偏爱艺人和 3 个概念歌单（仅一次 LLM 调用）
            </div>
            <button
              onClick={doInitialize}
              disabled={initializing}
              className="w-full py-2.5 rounded-xl text-xs text-white tracking-wider transition-all disabled:opacity-60"
              style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})`, boxShadow: `0 3px 18px ${C.glow}30` }}
            >
              {initializing ? '敲门中…' : '敲敲门 · 生成音乐人格'}
            </button>
          </div>
        )}

        {/* 正在听 */}
        {initialized && profile?.currentListening && (
          <div className="mx-4 mt-4 rounded-2xl p-4 shizuku-glass"
            style={{ boxShadow: `0 4px 20px ${C.glow}15` }}>
            <div className="flex items-center gap-2 mb-2">
              <Sparkle size={8} color={C.sakura} delay={0} />
              <span className="text-[10px] tracking-[0.25em] uppercase" style={{ color: C.muted }}>此刻在听</span>
            </div>
            <div className="flex items-center gap-3">
              {profile.currentListening.albumPic ? (
                <TokenImg value={profile.currentListening.albumPic} className="w-12 h-12 rounded-xl object-cover" alt="" />
              ) : (
                <div className="w-12 h-12 rounded-xl flex items-center justify-center"
                  style={{ background: gradientFor('gradient-03'), color: 'white' }}>
                  <MusicNote size={20} weight="bold" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate" style={{ color: C.text }}>
                  {profile.currentListening.songName}
                </div>
                <div className="text-[10px] truncate" style={{ color: C.muted }}>
                  {profile.currentListening.artists}
                </div>
              </div>
            </div>
            {profile.currentListening.vibe && (
              <div className="text-[10px] mt-2 italic" style={{ color: C.faint }}>
                {profile.currentListening.vibe}
              </div>
            )}
          </div>
        )}

        {/* 偏爱艺人 */}
        {initialized && (profile?.signatureArtists?.length || 0) > 0 && (
          <div className="mx-4 mt-4">
            <SectionTitle>钟爱的人</SectionTitle>
            <div className="flex items-center gap-2 overflow-x-auto pb-2 shizuku-scrollbar">
              {profile!.signatureArtists.map((a, i) => (
                <div key={i} className="shrink-0 text-center">
                  <div className="w-14 h-14 rounded-full flex items-center justify-center text-white mx-auto"
                    style={{ background: gradientFor(`gradient-0${(i % 6) + 1}`) }}>
                    <span className="text-lg font-semibold" style={{ fontFamily: `'Noto Serif', serif` }}>
                      {a.name.slice(0, 1)}
                    </span>
                  </div>
                  <div className="text-[10px] mt-1 max-w-[60px] truncate" style={{ color: C.muted }}>{a.name}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 歌单 */}
        {initialized && (profile?.playlists?.length || 0) > 0 && (
          <div className="mx-4 mt-4">
            <SectionTitle>歌单 · {profile!.playlists.length}</SectionTitle>
            <div className="space-y-2">
              {profile!.playlists.map(pl => {
                const isExpanded = expandedPl === pl.id;
                const isFilling = fillingPl === pl.id;
                return (
                  <div key={pl.id} className="rounded-2xl shizuku-glass overflow-hidden">
                    <button
                      onClick={() => togglePlaylist(pl.id)}
                      className="w-full flex items-center gap-3 p-3 text-left"
                    >
                      <div className="w-12 h-12 rounded-xl shrink-0 flex items-center justify-center overflow-hidden"
                        style={{ background: gradientFor(pl.coverStyle) }}>
                        {pl.songs[0]?.albumPic ? (
                          <TokenImg value={pl.songs[0].albumPic} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <MusicNote size={20} weight="bold" color="white" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm font-medium ${isExpanded ? 'whitespace-normal break-words' : 'truncate'}`} style={{ color: C.text }}>{pl.title}</div>
                        <div className={`text-[10px] mt-0.5 ${isExpanded ? 'whitespace-pre-wrap break-words leading-relaxed' : 'truncate'}`} style={{ color: C.muted }}>
                          {pl.description || '—'}
                        </div>
                        <div className="text-[9px] mt-0.5" style={{ color: C.faint }}>
                          {pl.songs.length > 0 ? `${pl.songs.length} 首` : '（空歌单）'}
                          {pl.mood && ` · ${pl.mood}`}
                        </div>
                      </div>
                    </button>

                    {isExpanded && (
                      <div className="px-3 pb-3 border-t" style={{ borderColor: `${C.faint}30` }}>
                        {pl.songs.length === 0 ? (
                          <div className="text-center py-3">
                            <div className="text-[10px] italic mb-2" style={{ color: C.faint }}>
                              还空着。让 {char.name} 根据品味挑几首？
                            </div>
                            <button
                              onClick={() => fillPlaylistFromTaste(pl)}
                              disabled={isFilling}
                              className="text-[10px] px-3 py-1.5 rounded-full shizuku-glass disabled:opacity-60"
                              style={{ color: C.primary, border: `1px solid ${C.primary}30` }}
                            >
                              <MagnifyingGlass size={10} weight="bold" className="inline mr-1" />
                              {isFilling ? '正在挑…' : '让 ta 挑几首'}
                            </button>
                          </div>
                        ) : (
                          <div className="pt-2">
                            {/* 操作条：平时显示「选择」；选择模式下变成 取消 · 已选 N · 删除 */}
                            <div className="flex items-center justify-between px-2 pb-1.5">
                              {selectingPl === pl.id ? (
                                <>
                                  <button
                                    onClick={exitSelectMode}
                                    className="text-[11px] px-1 py-0.5"
                                    style={{ color: C.muted }}
                                  >
                                    取消
                                  </button>
                                  <span className="text-[10px]" style={{ color: C.faint }}>
                                    已选 {selectedSongIds.size} 首
                                  </span>
                                  <button
                                    onClick={() => deleteSelected(pl)}
                                    disabled={selectedSongIds.size === 0}
                                    className="text-[11px] px-1 py-0.5 flex items-center gap-1 disabled:opacity-40"
                                    style={{ color: C.vip }}
                                  >
                                    <Trash size={12} weight="bold" />
                                    删除
                                  </button>
                                </>
                              ) : (
                                <>
                                  <span className="text-[10px]" style={{ color: C.faint }}>{pl.songs.length} 首</span>
                                  <button
                                    onClick={() => enterSelectMode(pl.id)}
                                    className="text-[11px] px-1 py-0.5"
                                    style={{ color: C.primary }}
                                  >
                                    选择
                                  </button>
                                </>
                              )}
                            </div>
                            <div className="space-y-1">
                              {pl.songs.map((s, i) => {
                                const selecting = selectingPl === pl.id;
                                const checked = selectedSongIds.has(s.id);
                                return (
                                  <button
                                    key={s.id}
                                    onClick={() => {
                                      if (lpFired.current) { lpFired.current = false; return; } // 长按已触发，吞掉这次 click
                                      if (selecting) { toggleSelected(s.id); return; }
                                      playPlaylistSong(pl, s);
                                    }}
                                    {...songPressHandlers(pl, s)}
                                    className="w-full flex items-center gap-2 py-1.5 px-2 rounded-lg hover:bg-white/40 transition-colors text-left select-none"
                                    style={{ WebkitTouchCallout: 'none' }}
                                  >
                                    {selecting ? (
                                      <span
                                        className="w-4 h-4 shrink-0 rounded-full border flex items-center justify-center"
                                        style={{
                                          borderColor: checked ? C.primary : C.faint,
                                          background: checked ? C.primary : 'transparent',
                                        }}
                                      >
                                        {checked && <Check size={10} weight="bold" color="white" />}
                                      </span>
                                    ) : (
                                      <span className="text-[10px] w-4 shrink-0" style={{ color: C.faint }}>{i + 1}</span>
                                    )}
                                    <div className="flex-1 min-w-0">
                                      <div className="text-xs truncate" style={{ color: C.text }}>{s.name}</div>
                                      <div className="text-[9px] truncate" style={{ color: C.muted }}>{s.artists}</div>
                                    </div>
                                    {s.fee === 1 && !selecting && (
                                      <span className="text-[8px] px-1 rounded" style={{ color: C.vip, border: `1px solid ${C.vip}50` }}>VIP</span>
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 最近在听 */}
        {initialized && (profile?.recentPlays?.length || 0) > 0 && (
          <div className="mx-4 mt-4">
            <SectionTitle>最近常听</SectionTitle>
            <div className="space-y-1">
              {profile!.recentPlays.slice(0, 10).map((r, i) => (
                <div key={`${r.song.id}-${r.at}-${i}`} className="flex items-center gap-2 p-2 rounded-lg">
                  {r.song.albumPic ? (
                    <TokenImg value={r.song.albumPic} alt="" className="w-9 h-9 rounded-md object-cover" />
                  ) : (
                    <div className="w-9 h-9 rounded-md flex items-center justify-center"
                      style={{ background: gradientFor('gradient-02') }}>
                      <MusicNote size={14} weight="bold" color="white" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-xs truncate" style={{ color: C.text }}>{r.song.name}</div>
                    <div className="text-[9px] truncate" style={{ color: C.muted }}>
                      {r.song.artists} · {new Date(r.at).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                  {r.context && (
                    <div className="text-[9px] italic max-w-[40%] truncate" style={{ color: C.faint }}>
                      "{r.context}"
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 评论 */}
        {initialized && (profile?.reviews?.length || 0) > 0 && (
          <div className="mx-4 mt-4">
            <SectionTitle>写过的话</SectionTitle>
            <div className="space-y-2">
              {profile!.reviews!.slice(0, 10).map(rv => (
                <div key={rv.id} className="rounded-xl shizuku-glass p-3">
                  <div className="text-[10px] mb-1" style={{ color: C.muted }}>
                    对 <span className="font-medium" style={{ color: C.primary }}>{rv.targetTitle}</span>
                  </div>
                  <div className="text-xs leading-relaxed" style={{ color: C.text, fontFamily: `'Noto Serif', serif` }}>
                    {rv.content}
                  </div>
                  <div className="text-[9px] mt-1" style={{ color: C.faint }}>
                    {new Date(rv.createdAt).toLocaleDateString()}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 隐私开关 + 重新生成 */}
        {initialized && (
          <div className="mx-4 mt-6 mb-2 text-[10px] text-center space-y-2" style={{ color: C.faint }}>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={profile?.canReadUserMusic ?? true}
                onChange={e => {
                  if (!profile) return;
                  updateCharacter(char.id, {
                    musicProfile: { ...profile, canReadUserMusic: e.target.checked, updatedAt: Date.now() },
                  });
                }}
                className="w-3 h-3"
              />
              允许 {char.name} 翻阅你的网易云数据（最近在听 / 歌单）
            </label>
            <div>
              <button
                onClick={doRegenerate}
                disabled={initializing}
                className="inline-flex items-center gap-1 px-3 py-1 rounded-full transition-all disabled:opacity-50"
                style={{
                  color: C.primary,
                  background: `${C.sakura}14`,
                  border: `1px solid ${C.sakura}35`,
                }}
                title="清空后重新生成。"
              >
                {initializing ? '重新敲门中…' : '重新生成音乐人格'}
              </button>
            </div>
          </div>
        )}
      </div>

      {current && (
        <MiniPlayer
          name={current.name}
          artists={current.artists}
          albumPic={current.albumPic}
          playing={playing}
          onTap={onOpenPlayer}
          onPrev={prevSong}
          onToggle={togglePlay}
          onNext={nextSong}
        />
      )}
    </div>
  );
};

const StatCell: React.FC<{ label: string; value: number | string }> = ({ label, value }) => (
  <div className="flex flex-col items-center py-1">
    <div className="text-sm font-semibold" style={{ color: C.primary, fontFamily: `'Noto Serif', serif` }}>{value}</div>
    <div className="text-[9px] mt-0.5" style={{ color: C.muted }}>{label}</div>
  </div>
);

const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex items-center gap-2 mb-2 px-1">
    <div className="w-1 h-3 rounded-full" style={{ background: `linear-gradient(180deg, ${C.primary}, ${C.accent})` }} />
    <span className="text-[11px] tracking-wider font-medium"
      style={{ color: C.text, fontFamily: `'Noto Serif', serif` }}>
      {children}
    </span>
  </div>
);

export default CharVisitPage;
