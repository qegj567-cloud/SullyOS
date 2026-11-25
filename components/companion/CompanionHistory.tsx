import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CompanionDialog } from './CompanionDialog';
import type { CompanionLine } from '../../utils/companion/session';
import { companionHistoryAudio } from '../../utils/companion/historyAudio';
import { listVoiceFavorites, saveVoiceFavorite, removeVoiceFavorite } from '../../utils/voiceFavorites';
import { shareOrDownloadBlob } from '../../utils/shareExport';
import { playVoiceAudio, primeVoiceAudio, stopVoiceAudio, voicePlaybackErrorMessage } from '../../utils/voicePlayback';
import { voiceLanguageLabel } from '../../utils/voiceLanguage';
import { trackEvent } from '../../utils/analytics';

interface Props {
  lines: CompanionLine[]; charId: string; charName: string; userName: string;
  liveSpeaking: boolean; stopListening(): void; close(): void;
}

export function CompanionHistory({ lines, charId, charName, userName, liveSpeaking, stopListening, close }: Props) {
  const [message, setMessage] = useState('');
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [favoritesLoaded, setFavoritesLoaded] = useState(false);
  const [playing, setPlaying] = useState<number>();
  const [busy, setBusy] = useState<number>();
  const pending = useRef(false);
  const player = useRef<HTMLAudioElement>();
  const generation = useRef(0);
  const url = useRef('');
  const latest = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const nearEnd = useRef(true);
  const stopReplay = () => {
    generation.current++;
    if (player.current) { stopVoiceAudio(player.current); player.current.removeAttribute('src'); }
    if (url.current) { URL.revokeObjectURL(url.current); url.current = ''; }
    if (mounted.current) setPlaying(undefined);
  };
  useEffect(() => {
    mounted.current = true;
    let active = true;
    setFavoritesLoaded(false);
    void listVoiceFavorites().then(all => {
      if (active) setFavorites(new Set(all.filter(item => item.source === 'companion' && item.charId === charId).map(item => item.sourceKey)));
    }).catch(() => {}).finally(() => { if (active) setFavoritesLoaded(true); });
    const hidden = () => { if (document.hidden) stopReplay(); };
    document.addEventListener('visibilitychange', hidden);
    return () => { active = false; mounted.current = false; stopReplay(); document.removeEventListener('visibilitychange', hidden); };
  }, [charId]);
  useEffect(() => { if (liveSpeaking) stopReplay(); }, [liveSpeaking]);
  useLayoutEffect(() => {
    const scroll = latest.current?.closest<HTMLElement>('.companion-sheet-content');
    if (!scroll) return;
    const remember = () => { nearEnd.current = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 36; };
    scroll.addEventListener('scroll', remember);
    if (nearEnd.current) scroll.scrollTop = scroll.scrollHeight;
    return () => scroll.removeEventListener('scroll', remember);
  }, [lines.length]);
  const replay = async (line: CompanionLine) => {
    if (!line.audio || liveSpeaking) return;
    stopReplay();
    if (playing === line.id) return;
    stopListening();
    const audio = player.current ??= new Audio();
    primeVoiceAudio(audio);
    const ticket = generation.current;
    setPlaying(line.id); setMessage('');
    try {
      const blob = await companionHistoryAudio(line.audio);
      if (ticket !== generation.current) return;
      url.current = URL.createObjectURL(blob);
      await playVoiceAudio(audio, url.current, {
        onPlaying: () => trackEvent('重播一条通话语音'), onStopped: stopReplay,
        onError: error => setMessage(voicePlaybackErrorMessage(error, '重听')),
      });
    } catch { if (ticket === generation.current) { stopReplay(); setMessage('读取音频失败，请再试一次。'); } }
  };
  const keyFor = (line: CompanionLine) => charId + ':' + line.at + ':' + line.id;
  const save = async (line: CompanionLine, download: boolean) => {
    if (!line.audio || pending.current) return;
    pending.current = true; setBusy(line.id); setMessage('');
    const key = keyFor(line);
    try {
      if (!download && favorites.has(key)) {
        await removeVoiceFavorite('companion', key);
        if (mounted.current) setFavorites(prev => { const next = new Set(prev); next.delete(key); return next; });
      } else {
        const blob = await companionHistoryAudio(line.audio);
        if (!mounted.current) return;
        if (download) {
          const ext = blob.type.includes('wav') ? 'wav' : blob.type.includes('ogg') ? 'ogg' : 'mp3';
          const fileName = charName.replace(/[\\/:*?"<>|]/g, '_') + '_同行_' + line.at + '.' + ext;
          const result = await shareOrDownloadBlob({ blob, fileName, shareTitle: charName + '的同行语音', nativeChunked: true, preferDownloadOnWeb: true });
          if (result === 'cancelled') return;
          if (mounted.current) setMessage(result === 'shared' ? '已打开系统分享' : '已开始下载');
          trackEvent('下载一条通话语音');
        } else {
          await saveVoiceFavorite({ source: 'companion', sourceKey: key, charId, charName, sourceTimestamp: line.at,
            originalText: line.text, translation: line.translation, language: line.translation ? line.language : undefined, blob });
          if (mounted.current) { setFavorites(prev => new Set(prev).add(key)); setMessage('已加入语音收藏'); }
          trackEvent('收藏通话语音');
        }
      }
    } catch { if (mounted.current) setMessage(download ? '下载失败，请重试。' : '收藏未能保存，请检查本机存储后重试。'); }
    finally { pending.current = false; if (mounted.current) setBusy(undefined); }
  };
  return <CompanionDialog title="本次同行记录" close={close} floating>
    {!lines.length && <p>说过的话会留在这里。</p>}
    {lines.map(line => <article key={line.id} className="companion-log-line" data-role={line.role}>
      <small>{line.role === 'user' ? userName : charName}{line.status === 'interrupted' ? ' · 已打断' : ''}</small>
      <p>{line.text}</p>{line.translation && <p className="companion-log-translation" lang={line.language}>{line.translation}</p>}
      {line.role === 'assistant' && <div className="companion-log-actions">
        {line.audio?.length ? <>
          <button disabled={liveSpeaking} onClick={() => void replay(line)}>{playing === line.id ? '停止重听' : '重听'}</button>
          <button disabled={!favoritesLoaded || busy !== undefined} aria-pressed={favorites.has(keyFor(line))} onClick={() => void save(line, false)}>{favorites.has(keyFor(line)) ? '已收藏' : '收藏'}</button>
          <button disabled={busy !== undefined} onClick={() => void save(line, true)}>下载</button>
          {(line.voiceFailed || line.status === 'interrupted') && <small>已合成片段</small>}
        </> : <small>{line.status === 'speaking' ? '正在回复' : '本条无录音'}</small>}
        {line.language && !line.translation && <small>未收到{voiceLanguageLabel(line.language)}译文</small>}
      </div>}
    </article>)}
    <div ref={latest}/>{message && <p role="status">{message}</p>}
  </CompanionDialog>;
}
