import React, { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CharacterGroup, CharacterProfile } from '../../types';
import { isAmsg2EnabledForChar } from '../../utils/amsg2Tasks';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import { filterCharactersByGroup, GROUP_FILTER_ALL, GROUP_FILTER_UNGROUPED, sortCharacterGroups } from '../character/CharacterGroupFilter';
import { AmsgIcon } from './AmsgArtwork';

const PAGE_SIZE = 12;
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase();

const CharacterRow = React.memo(function CharacterRow({ id, name, scheduleEnabled, instantDisabled, descriptionId, onConfigure }: {
  id: string;
  name: string;
  scheduleEnabled: boolean;
  instantDisabled: boolean;
  descriptionId: string;
  onConfigure?: (id: string) => void;
}) {
  return <button type="button" aria-label={`配置 ${name} 的主动消息`} aria-describedby={descriptionId} disabled={!onConfigure} onClick={() => onConfigure?.(id)} className="amsg-overview-character">
    <span className="amsg-character-initial" aria-hidden="true">{Array.from(name)[0] || '·'}</span>
    <span className="amsg-character-copy"><strong>{name}</strong><span id={descriptionId} className="amsg-character-status"><span>主动消息：{scheduleEnabled ? '已启用' : '未启用'}</span><span>即时对话：{instantDisabled ? '单独关闭' : '跟随全局'}</span></span></span>
    <AmsgIcon name="chevron" className="amsg-character-chevron" />
  </button>;
});

function AmsgCharacterList({ characters, groups, active, onConfigure }: {
  characters: CharacterProfile[];
  groups: CharacterGroup[];
  active: boolean;
  onConfigure?: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const searching = query !== deferredQuery;
  const [group, setGroup] = useState(GROUP_FILTER_ALL);
  const [page, setPage] = useState(0);
  const prefix = useId();
  const search = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLDivElement>(null);
  const sortedGroups = useMemo(() => sortCharacterGroups(groups), [groups]);
  const knownGroups = useMemo(() => new Set(groups.map(item => item.id)), [groups]);
  const effectiveGroup = group === GROUP_FILTER_ALL || group === GROUP_FILTER_UNGROUPED || knownGroups.has(group) ? group : GROUP_FILTER_ALL;
  useEffect(() => {
    if (group !== effectiveGroup) { setGroup(effectiveGroup); setPage(0); }
  }, [group, effectiveGroup]);
  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const character of characters) {
      const key = character.groupId && knownGroups.has(character.groupId) ? character.groupId : GROUP_FILTER_UNGROUPED;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [characters, knownGroups]);
  // Normalize names once per character update, not for every typed letter.
  const names = useMemo(() => new Map(characters.map(character => [character.id, normalize(character.name)])), [characters]);
  const candidates = useMemo(() => filterCharactersByGroup(characters, groups, effectiveGroup), [characters, groups, effectiveGroup]);
  const filtered = useMemo(() => {
    const words = normalize(deferredQuery).trim().split(/\s+/).filter(Boolean);
    if (!words.length) return candidates;
    return candidates.filter(character => words.every(word => names.get(character.id)!.includes(word)));
  }, [candidates, names, deferredQuery]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  useEffect(() => { setPage(previous => Math.min(previous, pageCount - 1)); }, [pageCount]);
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const isFiltered = effectiveGroup !== GROUP_FILTER_ALL || Boolean(deferredQuery.trim());
  const pageOptions = useMemo(() => Array.from({ length: pageCount }, (_, index) => <option key={index} value={index}>第 {index + 1} / {pageCount} 页</option>), [pageCount]);
  useLocalBackHandler(() => {
    if (document.activeElement !== search.current) return false;
    search.current?.blur();
    return true;
  }, 40, active);
  const goToPage = (next: number) => {
    setPage(next);
    heading.current?.scrollIntoView?.({ block: 'start' });
  };

  return <section className="amsg-overview-characters" aria-label="角色设置">
    <div ref={heading} className="amsg-overview-list-heading"><h4>当前用户的角色</h4><span>{isFiltered ? `${filtered.length} / ${characters.length} 位` : `共 ${characters.length} 位`}</span></div>
    <p className="amsg-caption">与聊天中的角色设置同步。</p>
    {characters.length > 0 && <div className="amsg-character-filters">
      {groups.length > 0 && <select aria-label="角色分类" value={effectiveGroup} onChange={event => { setGroup(event.target.value); setPage(0); }}>
        <option value={GROUP_FILTER_ALL}>全部分类（{characters.length}）</option>
        {sortedGroups.map(item => <option key={item.id} value={item.id}>{item.name}（{groupCounts.get(item.id) ?? 0}）</option>)}
        <option value={GROUP_FILTER_UNGROUPED}>未分组（{groupCounts.get(GROUP_FILTER_UNGROUPED) ?? 0}）</option>
      </select>}
      <input ref={search} type="search" aria-label="搜索角色" placeholder="搜索角色" value={query}
        onChange={event => { setQuery(event.target.value); setPage(0); }}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur(); }} />
    </div>}
    <div className="amsg-overview-character-list" aria-busy={searching || undefined}>
      {visible.map(character => <CharacterRow key={character.id} id={character.id} name={character.name} scheduleEnabled={isAmsg2EnabledForChar(character)}
        instantDisabled={character.activeMsg2Config?.instantChatEnabled === false} descriptionId={`${prefix}-${character.id}`} onConfigure={onConfigure} />)}
    </div>
    {!visible.length && <p className="amsg-overview-empty">{characters.length ? '没有符合条件的角色。' : '当前用户还没有角色，添加后就能在这里分别配置。'}</p>}
    {pageCount > 1 && <nav className="amsg-character-pagination" aria-label="角色分页">
      <button type="button" disabled={searching || currentPage === 0} onClick={() => goToPage(currentPage - 1)} aria-label="上一页角色">‹</button>
      <label><span className="sr-only">角色页码</span><select aria-label="角色页码" disabled={searching} value={currentPage} onChange={event => goToPage(Number(event.target.value))}>
        {pageOptions}
      </select></label>
      <button type="button" disabled={searching || currentPage === pageCount - 1} onClick={() => goToPage(currentPage + 1)} aria-label="下一页角色">›</button>
    </nav>}
  </section>;
}

export default React.memo(AmsgCharacterList);
