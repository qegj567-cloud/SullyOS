import { loadCharacterContextMessages } from '../utils/chatContextRange';

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useOS } from '../context/OSContext';
import { AppID, CharacterProfile, CharacterExportData, UserImpression, MemoryFragment } from '../types';
import { SlidersHorizontal, SpeakerHigh, Books, BookOpen } from '@phosphor-icons/react';
import Modal from '../components/os/Modal';
import { processImage } from '../utils/file';
import { DB } from '../utils/db';
import { ContextBuilder } from '../utils/context';
import { buildSARMemoryBoundaryInstruction, formatMessageWithTime, formatMessageForPrompt } from '../utils/messageFormat';
import { DEFAULT_ARCHIVE_PROMPTS } from '../components/chat/ChatConstants';
import ImpressionPanel from '../components/character/ImpressionPanel';
import RoomPlatePanel from '../components/character/RoomPlatePanel';
import MemoryArchivist from '../components/character/MemoryArchivist';
import ChibiStudio, { ChibiShelfPanel } from '../components/character/ChibiStudio';
import TokenImg from '../components/os/TokenImg';
import { resolveBlobRefsDeep, migrateDataUrlToRef } from '../utils/blobRef';
import { characterLaunch } from '../utils/characterLaunch';
import { safeFetchJson, extractContent } from '../utils/safeApi';
import { fetchMiniMaxVoices, MiniMaxVoiceItem } from '../utils/minimaxVoice';
import { resolveMiniMaxApiKey } from '../utils/minimaxApiKey';
import { normalizeElevenLabsVoiceId, synthesizeSpeechElevenLabsDetailed } from '../utils/elevenLabsTts';
import { normalizeUserImpression } from '../utils/impression';
import { parseGeneratedImpression } from '../utils/impressionGeneration';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import { COMMON_TIMEZONES } from '../utils/timezone';
import { toMountedWorldbook } from '../utils/worldbook';
import { stripSensitiveCardFields } from '../utils/characterCard';
import { shareOrDownloadFile } from '../utils/shareExport';
import { readShareText } from '../utils/pngShare';
import { confirmExportSafety } from '../utils/exportGuard';
import { trackEvent } from '../utils/analytics';
import { sortCharacterGroups, GROUP_FILTER_UNGROUPED } from '../components/character/CharacterGroupFilter';
import {
    EXTERNAL_MEMORY_MAX_CHARS,
    extractExternalMemoryText,
    getExternalMemoryLengthInfo,
    getExternalMemoryOverLimitMessage,
} from '../utils/memoryPalace/externalMemory';

// ── 神经链接 · 列表页视觉件（淡紫留白风）────────────────────
// 之前的「星点 + 玻璃饰带 + 华丽头像框」看久了眼花、低端机也重绘卡。
// 改成留白为主的干净版：纯淡紫底、圆角方钮、朴素圆头像、素白卡片。
// 无常驻动画 / 无 filter / 无大模糊阴影，既清爽又省电。仅列表页，编辑页不动。

/** 顶栏圆角方钮（squircle）：白底细紫描边 + 线性图标 + 底部小字标签 */
const ToolButton: React.FC<{ label: string; title?: string; onClick: () => void; children: React.ReactNode }> = ({ label, title, onClick, children }) => (
    <button onClick={onClick} title={title} className="flex flex-col items-center gap-1.5 active:scale-90 transition-transform">
        <span className="w-12 h-12 flex items-center justify-center rounded-2xl bg-white border border-violet-200/80 text-violet-500 shadow-[0_2px_6px_rgba(140,120,200,0.10)]">
            {children}
        </span>
        <span className="text-[11px] text-violet-400/90 font-medium tracking-wider">{label}</span>
    </button>
);

const CharacterCard: React.FC<{
    char: CharacterProfile;
    /** 当前激活（正在聊）的角色走淡紫高亮 */
    active?: boolean;
    onClick: () => void;
    onDelete: (e: React.MouseEvent) => void;
}> = ({ char, active, onClick, onDelete }) => (
    <div
        onClick={onClick}
        className={`relative px-4 py-3.5 rounded-3xl border bg-white transition-colors cursor-pointer group shrink-0 shadow-[0_2px_10px_rgba(140,120,200,0.07)] ${
            active ? 'border-violet-300' : 'border-slate-100 hover:border-violet-200'
        }`}
    >
        <div className="flex items-center gap-4">
            <div className="w-14 h-14 shrink-0 rounded-full overflow-hidden border border-violet-100 bg-violet-50">
                <TokenImg value={char.avatar} className="w-full h-full object-cover" alt={char.name} />
            </div>
            <div className="flex-1 min-w-0 pr-6">
                <h3 className="text-lg font-bold truncate text-slate-800">
                    {char.name}
                </h3>
                <p className="text-xs truncate mt-0.5 text-violet-400/80">
                    {char.description || '暂无描述'}
                </p>
            </div>
        </div>
        <button
            onClick={onDelete}
            className="absolute top-1/2 -translate-y-1/2 right-4 w-7 h-7 flex items-center justify-center rounded-full bg-slate-50 border border-slate-100 text-slate-300 hover:text-violet-400 hover:border-violet-200 active:scale-90 transition-colors"
        >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3.5 h-3.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
        </button>
    </div>
);

const Character: React.FC = () => {
  const { closeApp, openApp, characters, activeCharacterId, setActiveCharacterId, addCharacter, updateCharacter, deleteCharacter, characterGroups, createCharacterGroup, renameCharacterGroup, deleteCharacterGroup, apiConfig, addToast, userProfile, worldbooks, addWorldbook } = useOS();
  const launchIntent = characterLaunch.peek();
  const [view, setView] = useState<'list' | 'detail'>(() => launchIntent ? 'detail' : 'list');
  const [charPage, setCharPage] = useState(0); // 角色列表分页（每页 6 个，仅未建分组时）
  // 分组展开状态：存"已展开"的分组 id（未记录 = 收起）。跨会话记住，key 见下
  const [expandedGroups, setExpandedGroups] = useState<string[]>(() => {
      try {
          const raw = localStorage.getItem('os_char_groups_expanded');
          if (raw) {
              const arr = JSON.parse(raw);
              if (Array.isArray(arr)) return arr;
          }
      } catch {}
      return [GROUP_FILTER_UNGROUPED]; // 首次进入只展开「未分组」，命名分组默认收起
  });
  const toggleGroupExpanded = (id: string) => {
      setExpandedGroups(prev => {
          const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
          try { localStorage.setItem('os_char_groups_expanded', JSON.stringify(next)); } catch {}
          return next;
      });
  };
  const [detailTab, setDetailTab] = useState<'identity' | 'memory' | 'impression' | 'plates' | 'chibi'>(() => launchIntent?.openChibiStudio ? 'chibi' : 'identity');
  // QQ捏人工坊（手办柜）全屏覆盖层
  const [showChibiStudio, setShowChibiStudio] = useState(() => !!launchIntent?.openChibiStudio);
  const [editingId, setEditingId] = useState<string | null>(() => launchIntent?.charId || null);
  const [formData, setFormData] = useState<CharacterProfile | null>(null);
  const [expandedMountedBookIds, setExpandedMountedBookIds] = useState<Set<string>>(new Set());
  const [isCompressing, setIsCompressing] = useState(false);
  // 头像 URL 输入的 draft, 不逐字 commit 到 formData.avatar —— 否则每输入一个字符,
  // 所有引用 char.avatar 的 <img> 都会拿到不完整字符串当相对路径请求根目录,
  // 导致打字时疯狂 GET / 和满屏破图. 失焦 / 回车才校验 + commit.
  const [avatarUrlDraft, setAvatarUrlDraft] = useState('');
  // 生活记录被全局隐藏的模块（档案 App 长按页签隐藏）——对应的小开关行直接不显示
  const [hiddenLifeModules, setHiddenLifeModules] = useState<string[]>([]);
  useEffect(() => {
      DB.getLifeRecordSettings()
          .then(s => setHiddenLifeModules(s?.hiddenModules || []))
          .catch(() => {});
  }, []);
  useEffect(() => {
      characterLaunch.consume();
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cardImportRef = useRef<HTMLInputElement>(null);
  
  // Race Condition Guards
  const editingIdRef = useRef<string | null>(null);
  
  // Modals
  const [showImportModal, setShowImportModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showBatchModal, setShowBatchModal] = useState(false); 
  const [deleteConfirmTarget, setDeleteConfirmTarget] = useState<string | null>(null);
  // 云端 amsg2 任务没清干净、本地删除被拦下的角色 → 弹「重试 / 仍然删除」二次确认。
  const [cloudCleanupFailTarget, setCloudCleanupFailTarget] = useState<string | null>(null);
  // 删除要先 await 云端任务取消（名下有 amsg2 任务时），期间锁住按钮防连点。
  const [isDeleting, setIsDeleting] = useState(false);
  const [showWorldbookModal, setShowWorldbookModal] = useState(false); // New Modal
  // 挂载世界书弹窗：搜索词 + 当前展开的分组（分组默认折叠，避免全量条目一次性渲染卡爆）
  const [wbModalSearch, setWbModalSearch] = useState('');
  const [wbModalExpandedCategory, setWbModalExpandedCategory] = useState<string | null>(null);
  const [showGroupModal, setShowGroupModal] = useState(false); // 角色分组管理
  const [newGroupName, setNewGroupName] = useState('');
  // 编辑页「新建分组并指派」的内联输入
  const [detailGroupDraft, setDetailGroupDraft] = useState<string | null>(null);

  const [importText, setImportText] = useState('');
  const [exportText, setExportText] = useState('');
  const [isProcessingMemory, setIsProcessingMemory] = useState(false);
  const [importStatus, setImportStatus] = useState('');
  const importLengthInfo = useMemo(() => getExternalMemoryLengthInfo(importText), [importText]);

  // Batch Summarize State
  const [batchRange, setBatchRange] = useState({ start: '', end: '' });
  const [isBatchProcessing, setIsBatchProcessing] = useState(false);
  const [batchProgress, setBatchProgress] = useState('');

  // Archive Prompts State (shared with ChatApp)
  const [archivePrompts, setArchivePrompts] = useState<{id: string, name: string, content: string}[]>(DEFAULT_ARCHIVE_PROMPTS);
  const [selectedPromptId, setSelectedPromptId] = useState<string>('preset_rational');
  const [editingPrompt, setEditingPrompt] = useState<{id: string, name: string, content: string} | null>(null);
  const [showPromptEditor, setShowPromptEditor] = useState(false);

  // Impression State
  const [isGeneratingImpression, setIsGeneratingImpression] = useState(false);
  const [isLoadingVoices, setIsLoadingVoices] = useState(false);
  const [isTestingElevenLabsVoice, setIsTestingElevenLabsVoice] = useState(false);
  const [voiceOptions, setVoiceOptions] = useState<Record<'system' | 'voice_cloning' | 'voice_generation', MiniMaxVoiceItem[]>>({
      system: [],
      voice_cloning: [],
      voice_generation: [],
  });

  const handleLoadMiniMaxVoices = async () => {
      const minimaxApiKey = resolveMiniMaxApiKey(apiConfig);
      if (!minimaxApiKey) {
          addToast('请先在设置中填入 MiniMax API Key（未填写时会回退使用通用 API Key）', 'error');
          return;
      }

      setIsLoadingVoices(true);
      try {
          const result = await fetchMiniMaxVoices(minimaxApiKey, 'all');
          setVoiceOptions({
              system: result.system_voice,
              voice_cloning: result.voice_cloning,
              voice_generation: result.voice_generation,
          });
          addToast(`已拉取音色：系统 ${result.system_voice.length} / 复刻 ${result.voice_cloning.length} / 文生 ${result.voice_generation.length}`, 'success');
      } catch (e: any) {
          console.error('[MiniMax Voice] load failed', e);
          addToast(e?.message || '拉取 MiniMax 音色失败', 'error');
      } finally {
          setIsLoadingVoices(false);
      }
  };

  const applyVoiceToCharacter = (voice: MiniMaxVoiceItem, source: 'system' | 'voice_cloning' | 'voice_generation') => {
      if (!formData) return;
      handleChange('voiceProfile', {
          ...(formData.voiceProfile || {}),
          provider: 'minimax',
          voiceId: voice.voice_id,
          voiceName: voice.voice_name || '',
          source,
          model: formData.voiceProfile?.model || 'speech-2.8-hd',
          notes: formData.voiceProfile?.notes || '',
      });
      addToast(`已应用音色：${voice.voice_name || voice.voice_id}`, 'success');
      trackEvent('应用音色到角色', { source });
  };

  const handleTestElevenLabsVoice = async () => {
      if (!formData || isTestingElevenLabsVoice) return;
      const voiceId = normalizeElevenLabsVoiceId(formData.voiceProfile?.elevenLabsVoiceId);
      if (!voiceId) {
          addToast('请先填写 ElevenLabs Voice ID', 'info');
          return;
      }
      if (!apiConfig.elevenLabsApiKey?.trim()) {
          addToast('请先在设置 → 其他 API 保存 ElevenLabs Key', 'info');
          return;
      }
      setIsTestingElevenLabsVoice(true);
      let previewUrl = '';
      const releasePreviewUrl = () => {
          if (previewUrl.startsWith('blob:')) URL.revokeObjectURL(previewUrl);
          previewUrl = '';
      };
      try {
          const previewChar: CharacterProfile = {
              ...formData,
              voiceProfile: { ...(formData.voiceProfile || {}), elevenLabsVoiceId: voiceId },
          };
          const { url } = await synthesizeSpeechElevenLabsDetailed(
              `你好，我是${formData.name || '你的角色'}。现在能听见我的声音吗？`,
              previewChar,
              apiConfig,
          );
          previewUrl = url;
          const audio = new Audio(url);
          audio.onended = releasePreviewUrl;
          audio.onerror = releasePreviewUrl;
          await audio.play();
          addToast('ElevenLabs 试听已开始', 'success');
      } catch (error: any) {
          releasePreviewUrl();
          addToast(error?.message || 'ElevenLabs 试听失败', 'error');
      } finally {
          setIsTestingElevenLabsVoice(false);
      }
  };

  // Load archive prompts from localStorage (shared with ChatApp)
  useEffect(() => {
      const savedPrompts = localStorage.getItem('chat_archive_prompts');
      if (savedPrompts) {
          try {
              const parsed = JSON.parse(savedPrompts);
              const merged = [...DEFAULT_ARCHIVE_PROMPTS, ...parsed.filter((p: any) => !p.id.startsWith('preset_'))];
              setArchivePrompts(merged);
          } catch(e) {}
      }
      const savedId = localStorage.getItem('chat_active_archive_prompt_id');
      if (savedId) setSelectedPromptId(savedId);
  }, []);

  // Sync Ref with State
  useEffect(() => {
      editingIdRef.current = editingId;
  }, [editingId]);

  // CRITICAL FIX: Breaking the render loop.
  // We only sync from global 'characters' to local 'formData' when:
  // 1. We enter edit mode (view becomes detail)
  // 2. We switch character IDs
  useEffect(() => {
    if (editingId && view === 'detail') {
        // Only if formData is not set OR the ID doesn't match
        if (!formData || formData.id !== editingId) {
            const target = characters.find(c => c.id === editingId);
            if (target) setFormData(target);
        }
    }
  }, [editingId, view]);

  // 切换角色时把 URL draft 同步成该角色当前 https 头像 (若有), 否则清空.
  // 不监听 formData.avatar 的每次变化 —— 文件上传走 data URL 路径时 draft 应保持原样.
  useEffect(() => {
    if (!editingId) return;
    const target = characters.find(c => c.id === editingId);
    const av = target?.avatar || '';
    setAvatarUrlDraft(/^https?:\/\/.+/i.test(av) ? av : '');
  }, [editingId]);

  // EXTERNAL-UPDATE SYNC: pull in memories/refinedMemories written by other apps
  // (e.g. Chat archive calling updateCharacter) so stale formData doesn't overwrite them.
  useEffect(() => {
    if (!editingId || !formData || formData.id !== editingId) return;
    const latest = characters.find(c => c.id === editingId);
    if (!latest) return;
    const latestMemCount = latest.memories?.length ?? 0;
    const localMemCount = formData.memories?.length ?? 0;
    const latestRefKeys = Object.keys(latest.refinedMemories || {}).length;
    const localRefKeys = Object.keys(formData.refinedMemories || {}).length;
    if (latestMemCount > localMemCount || latestRefKeys > localRefKeys) {
        setFormData(prev => prev && prev.id === editingId
            ? { ...prev, memories: latest.memories, refinedMemories: latest.refinedMemories }
            : prev);
    }
  }, [characters, editingId]);

  // Auto-save Effect with Safety Guard
  useEffect(() => {
    if (formData && editingId) {
        // SAFETY GUARD: Only save if the formData ID matches the currently active editing ID.
        // This prevents overwriting Character B with Character A's data if a delayed async call updates formData.
        if (formData.id === editingId) {
            updateCharacter(editingId, formData);
        } else {
            console.warn(`Race condition prevented: Tried to save data for ${formData.id} into slot ${editingId}`);
        }
    }
  }, [formData]);

  const handleBack = () => {
      if (view === 'detail') {
          setView('list');
          setEditingId(null);
      } else closeApp();
  };

  const handleAddGroup = async () => {
      const name = newGroupName.trim();
      if (!name) return;
      if (characterGroups.some(g => g.name === name)) {
          addToast('已有同名分组', 'error');
          return;
      }
      await createCharacterGroup(name);
      setNewGroupName('');
  };

  // 新建角色：建完直接进「设定」编辑页（而非停在列表往未分组里塞一张空白卡，
  // 那样反直觉——用户点新建就是想马上填人设）。editingId 一设，下方 sync effect
  // 会从 characters 里找到这张新卡填进 formData。
  const handleAddCharacter = async () => {
      const created = await addCharacter();
      setEditingId(created.id);
      setFormData(created); // 直接填好，避免跳转瞬间 characters 还没同步导致详情页闪白
      setDetailTab('identity');
      setView('detail');
  };

  const handleChange = (field: keyof CharacterProfile, value: any) => {
      // Functional update to prevent stale state issues in simple closures
      setFormData(prev => {
          if (!prev) return null;
          return { ...prev, [field]: value };
      });
  };

  // Worldbook Logic
  const mountWorldbook = (bookId: string) => {
      if (!formData) return;
      const book = worldbooks.find(b => b.id === bookId);
      if (!book) return;

      const currentBooks = formData.mountedWorldbooks || [];
      if (currentBooks.some(b => b.id === book.id)) {
          addToast('已挂载该世界书', 'info');
          return;
      }

      // CACHE THE CONTENT, include category
      const newBookEntry = toMountedWorldbook(book);
      handleChange('mountedWorldbooks', [...currentBooks, newBookEntry]);
      setShowWorldbookModal(false);
      addToast(`已挂载: ${book.title}`, 'success');
      trackEvent('给角色挂载世界书');
  };

  // New: Mount entire category
  const mountCategory = (category: string) => {
      if (!formData) return;
      const booksToMount = worldbooks.filter(b => (b.category || '未分类设定 (General)') === category);
      if (booksToMount.length === 0) return;

      const currentBooks = formData.mountedWorldbooks || [];
      const newEntries = [];
      let addedCount = 0;

      for (const book of booksToMount) {
          if (!currentBooks.some(b => b.id === book.id)) {
              newEntries.push(toMountedWorldbook(book));
              addedCount++;
          }
      }

      if (addedCount > 0) {
          handleChange('mountedWorldbooks', [...currentBooks, ...newEntries]);
          addToast(`已批量挂载 ${addedCount} 本世界书`, 'success');
      } else {
          addToast('该组世界书已全部挂载', 'info');
      }
      setShowWorldbookModal(false);
  };

  const unmountWorldbook = (bookId: string) => {
      if (!formData) return;
      const currentBooks = formData.mountedWorldbooks || [];
      handleChange('mountedWorldbooks', currentBooks.filter(b => b.id !== bookId));
  };

  // 挂载弹窗的分组数据。必须 useMemo：之前这段 reduce 内联在 JSX 里，
  // 弹窗没打开时整个编辑表单每敲一个字都会重新分组一遍全部世界书。
  const wbModalGroups = useMemo(() => {
      const groups: Record<string, typeof worldbooks> = {};
      worldbooks.forEach(wb => {
          const cat = wb.category || '未分类设定 (General)';
          if (!groups[cat]) groups[cat] = [];
          groups[cat].push(wb);
      });
      return Object.entries(groups);
  }, [worldbooks]);

  // 搜索态：按标题/分组名过滤，最多展示前 60 条避免长列表卡顿。
  const WB_SEARCH_LIMIT = 60;
  const wbModalSearchResults = useMemo(() => {
      const query = wbModalSearch.trim().toLowerCase();
      if (!query) return null;
      const matched = worldbooks.filter(wb =>
          wb.title.toLowerCase().includes(query) ||
          (wb.category || '未分类设定 (General)').toLowerCase().includes(query)
      );
      return { books: matched.slice(0, WB_SEARCH_LIMIT), total: matched.length };
  }, [worldbooks, wbModalSearch]);

  const openWorldbookModal = () => {
      setWbModalSearch('');
      setWbModalExpandedCategory(null);
      setShowWorldbookModal(true);
      trackEvent('打开挂载世界书弹窗');
  };

  // ... (Other handlers unchanged)
  const handleToggleActiveMonth = (year: string, month: string) => {
      if (!formData) return;
      const key = `${year}-${month}`;
      const current = formData.activeMemoryMonths || [];
      const next = current.includes(key) ? current.filter(k => k !== key) : [...current, key];
      handleChange('activeMemoryMonths', next);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
          try {
              setIsCompressing(true);
              const processedBase64 = await processImage(file);
              // 头像存令牌，二进制单独躺在 blob_assets 里（省掉 base64 那 ~33% 的膨胀）。
              // 同一张图之前存过就复用它的令牌；转不动时原样还回这条 data URL，图不会丢。
              handleChange('avatar', await migrateDataUrlToRef(processedBase64));
              // 清空 URL draft, 否则用户之后再触发 URL input 的 onBlur 会用脏旧 URL
              // 把刚上传的 data URL 头像盖掉. 不走 effect 监听 avatar 的方案 —— 那会
              // 在用户正在打 URL 时吃掉 draft.
              setAvatarUrlDraft('');
              addToast('头像上传成功', 'success');
          } catch (error: any) { 
              addToast(error.message || '图片处理失败', 'error'); 
          } finally {
              setIsCompressing(false);
              if (fileInputRef.current) fileInputRef.current.value = '';
          }
      }
  };
  
  const handleRefineMonth = async (year: string, month: string, rawText: string, formattedPrompt?: string) => {
      if (!apiConfig.apiKey) { addToast('请先配置 API Key', 'error'); return; }
      if (!formData) return;

      const targetId = formData.id; // LOCK ID
      trackEvent('提炼当月核心记忆');

      // Build lightweight character identity context (no memories - we're generating those)
      let identityContext = `[角色身份]\n名字: ${formData.name}\n`;
      if (formData.systemPrompt) identityContext += `核心性格/指令:\n${formData.systemPrompt}\n`;
      if (formData.worldview?.trim()) identityContext += `世界观设定: ${formData.worldview}\n`;
      identityContext += `互动对象: ${userProfile.name}`;
      if (userProfile.bio) identityContext += ` (${userProfile.bio})`;
      identityContext += '\n\n';

      // Gemini 3.1 preview 对"人设堆 3000+ token → 迟到任务句"的 all-in-one user 消息
      // 会静默拒答（completion_tokens=0，代理回 "Token count: N" stub 污染记忆库）。
      // 两条对抗措施一起上：
      //   (A) 任务声明放最前，明确这是总结不是角色扮演
      //   (B) 拆 system+user：规则/身份/任务走 system，原始日记走 user，
      //       让模型看清哪段是指令、哪段是数据
      const taskPreamble = `### 任务（最优先，请先读此段再读后文）
你正在执行"月度记忆精炼"：把 user 消息里提供的【${year}-${month} 每日记忆碎片】压缩成一份简洁的月度核心记忆。
这是**总结写作任务**，不是角色扮演对话——不要进入聊天模式、不要等待对方发言、不要只输出空白或沉默，直接输出总结正文。`;
      const sarMemoryBoundary = buildSARMemoryBoundaryInstruction(rawText);

      const systemContent = formattedPrompt
          ? `${taskPreamble}${sarMemoryBoundary ? `\n\n${sarMemoryBoundary}` : ''}\n\n### 角色视角（仅供写作口吻参考）\n${identityContext}### 详细规则与输出格式\n${formattedPrompt}`
          : `${taskPreamble}${sarMemoryBoundary ? `\n\n${sarMemoryBoundary}` : ''}\n\n### 角色视角（仅供写作口吻参考）\n${identityContext}### 详细规则\n以该角色的第一人称写作，使用与日记相同的语言（中文），输出一段精简的月度核心记忆。`;
      const userContent = rawText;

      const refineUrl = `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`;
      const t0 = performance.now();
      try {
          const data = await safeFetchJson(refineUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
              body: JSON.stringify({
                  model: apiConfig.model,
                  messages: [
                      { role: 'system', content: systemContent },
                      { role: 'user', content: userContent },
                  ],
                  temperature: 0.3,
              })
          }, 0);
          const dt = Math.round(performance.now() - t0);
          const summary = extractContent(data);
          if (!summary) {
              // 失败时留一条诊断 warn：Gemini 3.1 preview 在某些 prompt 下会静默拒答
              // （completion_tokens=0，代理回 "Token count: N" stub），这些信息能帮
              // 之后快速确认是不是同一个坑复发
              const msg = data?.choices?.[0]?.message;
              const rawContent = typeof msg?.content === 'string' ? msg.content : '';
              const finishReason = data?.choices?.[0]?.finish_reason;
              console.warn(`🧠 [Refine ${year}-${month}] 模型返回空: dt=${dt}ms finish=${finishReason} content.length=${rawContent.length} preview=${rawContent.slice(0, 120)} usage=`, data?.usage);
              addToast(`精炼失败: 模型返回为空 (${dt}ms, finish=${finishReason || 'n/a'})，详情见控制台`, 'error');
              return;
          }
          const key = `${year}-${month}`;

          // CHECK IF USER SWITCHED
          if (editingIdRef.current === targetId) {
              // Still on same page
              handleChange('refinedMemories', { ...(formData.refinedMemories || {}), [key]: summary });
              addToast(`${year}年${month}月记忆精炼完成`, 'success');
          } else {
              // Switched page - Save to DB directly
              const currentRefined = characters.find(c => c.id === targetId)?.refinedMemories || {};
              updateCharacter(targetId, { refinedMemories: { ...currentRefined, [key]: summary } });
              addToast('后台任务完成：记忆已保存到原角色', 'success');
          }
      } catch (e: any) { addToast(`精炼失败: ${e.message}`, 'error'); }
  };

  const handleDeleteMemories = (ids: string[]) => { if (!formData) return; handleChange('memories', (formData.memories || []).filter(m => !ids.includes(m.id))); addToast(`已删除 ${ids.length} 条记忆`, 'success'); };
  const handleUpdateMemory = (id: string, newSummary: string) => { if (!formData) return; handleChange('memories', (formData.memories || []).map(m => m.id === id ? { ...m, summary: newSummary } : m)); addToast('记忆已更新', 'success'); };

  /**
   * 按指定日期强制重新总结：读原始聊天记录（忽略 hideBeforeMessageId），LLM 总结，
   * upsert 同日期的 'archive' MemoryFragment（'palace' 自动归档的不动，保持并存）。
   * 这是自动化的兜底路径：即使 4.5 已经被 palace 处理+隐藏+向量化，用户依然能让 AI
   * 重新阅读 4.5 原始聊天做一版手动总结。
   */
  /**
   * @param overridePromptId 用户在 MemoryArchivist 的重总结弹窗里现场选的模板 id；
   *                        没提供则退回到当前 selectedPromptId
   */
  const handleForceArchiveDate = async (dateStr: string, overridePromptId?: string): Promise<void> => {
      if (!apiConfig.apiKey || !formData) { addToast('请先配置 API Key', 'error'); return; }
      const targetId = formData.id;
      try {
          const allMsgs = await DB.getMessagesByCharId(targetId, true);
          // 忽略 hideBeforeMessageId —— 这是强制重总结的关键
          const dayMsgs = allMsgs.filter(m => {
              const d = new Date(m.timestamp);
              const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
              return key === dateStr;
          });
          if (dayMsgs.length === 0) { addToast(`${dateStr} 当天无消息可总结`, 'info'); return; }

          const timeFmt = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
          const rawLog = dayMsgs
              .map(m => formatMessageWithTime(m, formData.name, userProfile.name, timeFmt))
              .join('\n');

          // 模板优先级：override（弹窗现场选）→ 当前 state → 默认 preset
          const effectivePromptId = overridePromptId || selectedPromptId;
          const templateObj = archivePrompts.find(p => p.id === effectivePromptId) || DEFAULT_ARCHIVE_PROMPTS[0];
          const baseContext = ContextBuilder.buildCoreContext(formData, userProfile);
          let prompt = baseContext + '\n\n' + templateObj.content;
          const sarMemoryBoundary = buildSARMemoryBoundaryInstruction(rawLog);
          if (sarMemoryBoundary) prompt = `${sarMemoryBoundary}\n\n${prompt}`;
          prompt = prompt.replace(/\$\{dateStr\}/g, dateStr);
          prompt = prompt.replace(/\$\{char\.name\}/g, formData.name);
          prompt = prompt.replace(/\$\{userProfile\.name\}/g, userProfile.name);
          prompt = prompt.replace(/\$\{rawLog.*?\}/g, rawLog.substring(0, 200000));

          const data = await safeFetchJson(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
              body: JSON.stringify({ model: apiConfig.model, messages: [{ role: 'user', content: prompt }], temperature: 0.5, max_tokens: 8000, stream: false }),
          }, 0);
          let summary = extractContent(data).replace(/^["']|["']$/g, '');
          if (!summary) throw new Error('空响应');

          // upsert：同日期的 mood='archive' 替换；'palace' 自动归档不碰
          const existing = formData.memories || [];
          const kept = existing.filter(m => !(m.date === dateStr && (m.mood === 'archive' || !m.mood)));
          const newFrag: MemoryFragment = {
              id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              date: dateStr,
              summary,
              mood: 'archive',
          };

          if (editingIdRef.current === targetId) {
              handleChange('memories', [...kept, newFrag]);
          } else {
              // 用户切角色了 —— 直接写回目标角色
              const currentMems = characters.find(c => c.id === targetId)?.memories || [];
              const curKept = currentMems.filter(m => !(m.date === dateStr && (m.mood === 'archive' || !m.mood)));
              updateCharacter(targetId, { memories: [...curKept, newFrag] });
          }
          addToast(`${dateStr} 已强制重新总结`, 'success');
      } catch (e: any) {
          addToast(`重总结失败: ${e.message || '未知错误'}`, 'error');
      }
  };

  // NEW: Core Memory Handlers
  const handleUpdateRefinedMemory = (year: string, month: string, newContent: string) => {
      if (!formData) return;
      const key = `${year}-${month}`;
      handleChange('refinedMemories', { ...(formData.refinedMemories || {}), [key]: newContent });
      addToast('核心记忆已更新', 'success');
  };

  const handleDeleteRefinedMemory = (year: string, month: string) => {
      if (!formData || !formData.refinedMemories) return;
      const key = `${year}-${month}`;
      const newRefined = { ...formData.refinedMemories };
      delete newRefined[key];
      handleChange('refinedMemories', newRefined);
      addToast('核心记忆已删除', 'success');
  };

  const handleExportPreview = () => { if (!formData) return; const mems = formData.memories as any[]; if (!mems || mems.length === 0) { addToast('暂无记忆数据可导出', 'info'); return; } const sortedMemories = [...mems].sort((a, b) => a.date.localeCompare(b.date)); let text = `【角色档案】\nName: ${formData.name}\nExported: ${new Date().toLocaleString()}\n\n`; if (formData.refinedMemories) { text += `=== 核心记忆 ===\n`; Object.entries(formData.refinedMemories).sort().forEach(([k, v]) => { text += `[${k}]: ${v}\n`; }); text += `\n=== 详细日志 ===\n`; } let currentYear = '', currentMonth = ''; sortedMemories.forEach(mem => { const match = mem.date.match(/(\d{4})[-/年](\d{1,2})/); if (match) { const y = match[1], m = match[2]; if (y !== currentYear) { text += `\n[ ${y}年 ]\n`; currentYear = y; currentMonth = ''; } if (m !== currentMonth) { text += `\n-- ${parseInt(m)}月 --\n\n`; currentMonth = m; } } text += `${mem.date} ${mem.mood ? `(#${mem.mood})` : ''}\n${mem.summary}\n\n--------------------------\n\n`; }); setExportText(text); setShowExportModal(true); navigator.clipboard.writeText(text).then(() => addToast('内容已自动复制到剪贴板', 'info')).catch(() => {}); };
  const handleExportMemoryFile = async () => {
      if (!exportText) return;
      try {
          const result = await shareOrDownloadFile({
              content: exportText,
              fileName: `${formData?.name || 'character'}_memories.txt`,
              mimeType: 'text/plain;charset=utf-8',
              shareTitle: '记忆档案',
          });
          addToast(result === 'shared' ? '已打开记忆档案分享面板' : '记忆档案已导出', 'success');
      } catch (error) {
          console.error('Memory export failed', error);
          addToast('文件导出失败，请直接复制文本', 'error');
      }
  };
  
  const handleImportMemories = async () => { 
      if (!importText.trim() || !apiConfig.apiKey) { addToast('请检查输入内容或 API 设置', 'error'); return; } 
      if (!formData) return;
      if (importLengthInfo.overLimit) {
          const message = getExternalMemoryOverLimitMessage(importText);
          setImportStatus(message);
          addToast(`内容超过 5 万字，建议分 ${importLengthInfo.suggestedBatches} 批导入`, 'error');
          return;
      }
      
      const targetId = formData.id; // LOCK ID
      setIsProcessingMemory(true); 
      setImportStatus('准备清洗：只整理时间和结构，不压缩内容…');
      trackEvent('执行记忆导入清洗');
      
      try { 
          const result = await extractExternalMemoryText(
              importText,
              targetId,
              formData.name,
              userProfile.name,
              {
                  baseUrl: apiConfig.baseUrl,
                  apiKey: apiConfig.apiKey,
                  model: apiConfig.model,
              },
              stage => setImportStatus(stage),
          );
          const failedBatch = result.batches.find(batch => !batch.ok);
          if (failedBatch) {
              throw new Error(
                  `第 ${failedBatch.index}/${failedBatch.total} 批未能无损清洗：${failedBatch.error || '完整性校验失败'}。本次没有写入任何记忆`,
              );
          }
          if (result.memories.length === 0) {
              throw new Error('没有整理出可导入的记忆');
          }

          const pad2 = (value: number) => String(value).padStart(2, '0');
          const newMems: MemoryFragment[] = result.memories.map(memory => {
              const date = new Date(memory.createdAt);
              return {
                  id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  date: `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
                  // content 是保真清洗后的完整事件，不再二次概括成短 summary。
                  summary: memory.content,
                  mood: memory.mood || '记录',
              };
          });
          if (editingIdRef.current === targetId) {
              handleChange('memories', [...(formData.memories || []), ...newMems]);
              setShowImportModal(false);
              setImportText('');
              addToast(`成功导入 ${newMems.length} 条记忆`, 'success');
          } else {
              // Background update
              const currentMems = characters.find(c => c.id === targetId)?.memories || [];
              updateCharacter(targetId, { memories: [...currentMems, ...newMems] });
              addToast(`后台任务完成：已保存 ${newMems.length} 条导入记忆`, 'success');
          }
      } catch (e: any) { setImportStatus(`错误: ${e.message || '未知错误'}`); addToast('记忆清洗失败', 'error'); } finally { setIsProcessingMemory(false); } 
  };
  
  const handleBatchSummarize = async () => {
        if (!apiConfig.apiKey || !formData) return;
        
        const targetId = formData.id; // LOCK ID
        setIsBatchProcessing(true);
        setBatchProgress('Initializing...');
        trackEvent('执行批量记忆总结');
        
        try {
            const msgs = await DB.getMessagesByCharId(targetId, true);
            const validMsgs = msgs.filter(m => !formData.hideBeforeMessageId || m.id >= formData.hideBeforeMessageId);
            const msgsByDate: Record<string, any[]> = {};
            
            msgs.forEach(m => {
                const d = new Date(m.timestamp);
                const year = d.getFullYear();
                const month = String(d.getMonth() + 1).padStart(2, '0');
                const day = String(d.getDate()).padStart(2, '0');
                const dateStr = `${year}-${month}-${day}`;
                
                if (batchRange.start && dateStr < batchRange.start) return;
                if (batchRange.end && dateStr > batchRange.end) return;
                
                if (!msgsByDate[dateStr]) msgsByDate[dateStr] = [];
                msgsByDate[dateStr].push(m);
            });

            const dates = Object.keys(msgsByDate).sort();
            const newMemories: MemoryFragment[] = [];

            await injectMemoryPalace(formData);
            const baseContext = ContextBuilder.buildCoreContext(formData, userProfile);

            for (let i = 0; i < dates.length; i++) {
                const date = dates[i];
                setBatchProgress(`Processing ${date} (${i+1}/${dates.length})`);
                
                const dayMsgs = msgsByDate[date];
                const timeFmt = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
                const rawLog = dayMsgs
                    .map(m => formatMessageWithTime(m, formData.name, userProfile.name, timeFmt))
                    .join('\n');

                // Use selected template (same as ChatApp) with variable substitution
                const templateObj = archivePrompts.find(p => p.id === selectedPromptId) || DEFAULT_ARCHIVE_PROMPTS[0];
                let prompt = baseContext + '\n\n' + templateObj.content;
                const sarMemoryBoundary = buildSARMemoryBoundaryInstruction(rawLog);
                if (sarMemoryBoundary) prompt = `${sarMemoryBoundary}\n\n${prompt}`;
                prompt = prompt.replace(/\$\{dateStr\}/g, date);
                prompt = prompt.replace(/\$\{char\.name\}/g, formData.name);
                prompt = prompt.replace(/\$\{userProfile\.name\}/g, userProfile.name);
                prompt = prompt.replace(/\$\{rawLog.*?\}/g, rawLog.substring(0, 200000));

                let data: any = null;
                try {
                    data = await safeFetchJson(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                        body: JSON.stringify({
                            model: apiConfig.model,
                            messages: [{ role: "user", content: prompt }],
                            max_tokens: 8000,
                            temperature: 0.5
                        })
                    }, 0);
                } catch {
                    // 单天失败软跳过，继续后面的日期（与原 if(response.ok) 的语义一致）
                }

                if (data) {
                    let summary = extractContent(data);
                    summary = summary.replace(/^["']|["']$/g, '').trim();

                    if (summary) {
                        newMemories.push({
                            id: `mem-${Date.now()}-${Math.random()}`,
                            date: date,
                            summary: summary,
                            mood: 'auto'
                        });
                    }
                }
                await new Promise(r => setTimeout(r, 500));
            }

            const totalDays = dates.length;
            const okCount = newMemories.length;
            const toastLevel: 'success' | 'info' | 'error' =
                okCount === 0 ? 'error' : okCount < totalDays ? 'info' : 'success';
            const toastMsg = okCount === 0
                ? `批量总结失败：${totalDays} 天均未生成记忆（请检查 API/模型）`
                : okCount < totalDays
                    ? `批量总结完成：${okCount}/${totalDays} 天成功（部分失败）`
                    : `批量总结完成：已生成 ${okCount} 条记忆`;

            if (editingIdRef.current === targetId) {
                if (okCount > 0) handleChange('memories', [...(formData.memories || []), ...newMemories]);
                setBatchProgress('Done!');
                setTimeout(() => {
                    setIsBatchProcessing(false);
                    setShowBatchModal(false);
                    addToast(toastMsg, toastLevel);
                }, 1000);
            } else {
                // Background update
                if (okCount > 0) {
                    const currentMems = characters.find(c => c.id === targetId)?.memories || [];
                    updateCharacter(targetId, { memories: [...currentMems, ...newMemories] });
                }
                setIsBatchProcessing(false);
                setShowBatchModal(false);
                addToast(`${formData.name}：${toastMsg}`, toastLevel);
            }

        } catch (e: any) {
            setBatchProgress(`Error: ${e.message}`);
            setIsBatchProcessing(false);
            setShowBatchModal(false);
            addToast(`批量总结失败: ${e.message}`, 'error');
        }
    };

  const handleGenerateImpression = async (type: 'initial' | 'update') => {
      if (!formData || !apiConfig.apiKey) {
          addToast('请先配置 API Key', 'error');
          return;
      }
      
      const targetId = formData.id; // LOCK ID
      setIsGeneratingImpression(true);
      trackEvent('生成角色印象', { type });
      try {
          const charName = formData.name;
          const boundUser = userProfile;

          // 构建完整角色上下文（包含人设、世界观、用户档案、精炼记忆等宏观信息）
          await injectMemoryPalace(formData);
          const fullContext = ContextBuilder.buildCoreContext(formData, userProfile);

          let messagesToAnalyze = "";

          // 第一层：完整上下文 —— 宏观人格分析的基石
          messagesToAnalyze += `\n【完整角色上下文 (Full Context - 宏观分析的基石)】:\n${fullContext}\n`;

          // 第二层：最近聊天 —— 仅用于检测近期变化
          // 记忆部分已包含在 buildCoreContext 中（精炼月度总结 + 点亮月份的详细记忆），
          // 与聊天时角色能看到的记忆完全一致，不再额外抓取。
          // 重置模式下大幅减少近期聊天的数量，避免近因偏差
          const recentMsgs = await loadCharacterContextMessages(formData).then(messages => messages.slice(-(type === 'initial' ? 15 : 50)));
          const msgText = recentMsgs
              .map(m => formatMessageForPrompt(m, charName, boundUser.name))
              .join('\n');

          if (msgText) messagesToAnalyze += `\n【最近的聊天记录 (Recent Chats - 仅用于检测近期变化)】:\n${msgText}\n`;
          const sarMemoryBoundary = buildSARMemoryBoundaryInstruction(messagesToAnalyze);

          // 重置时不传旧印象，避免模型锚定在旧内容上
          const normalizedCurrentImpression = normalizeUserImpression(formData.impression);
          const currentProfileJSON = (type === 'initial') ? "null" : (normalizedCurrentImpression ? JSON.stringify(normalizedCurrentImpression, null, 2) : "null");
          const isInitialGeneration = type === 'initial' || !normalizedCurrentImpression;
          
          const summaryInstruction = isInitialGeneration 
              ? "用一段话（100字以内）概括你对TA的【宏观整体印象】。不要局限于最近的对话，而是定义TA本质上是个什么样的人，以及TA对你意味着什么。必须第一人称。"
              : "基于旧的总结，结合新发现，更新你对TA的【宏观整体印象】。请保持长期视角的连贯性，除非发生了重大转折，否则不要因为一两句闲聊就彻底推翻对TA的本质判断。必须第一人称。";
              
          const listInstruction = isInitialGeneration ? `"项目1", "项目2"` : `"保留旧项目", "新项目"`;
          const changesInstruction = isInitialGeneration ? "" : `"描述变化1", "描述变化2"`;

          const prompt = `
当前档案（你过去的观察）
\`\`\`json
${currentProfileJSON}
\`\`\`
${messagesToAnalyze}${sarMemoryBoundary ? `\n${sarMemoryBoundary}\n` : ''}

【重要：语气与视角】
你【就是】"${charName}"。这份档案是你写的【私人笔记】。
因此，所有总结性的字段（如 \`core_values\`, \`summary\`, \`emotion_summary\` 等），【必须】使用你的第一人称（"我"）视角来撰写。

【核心指令：数据层级与权重分配】
1. **完整角色上下文 (Full Context)**: 这是你【最重要的分析基础】。它包含了你的人设、世界观、用户档案、以及你的全部记忆（月度核心总结 + 激活月份的每日详细回忆）。你对TA的核心性格、核心价值观、互动模式、人格特质的判断，必须主要基于这些跨越完整时间线的宏观数据。你必须【平等对待】早期记忆和近期记忆，从整段关系的完整弧线中提炼人格特征。
2. **近期聊天 (Recent Chats)**: 这【仅仅】代表TA当下的状态切片。它的作用【严格限定】在更新 [behavior_profile.emotion_summary] 和 [observed_changes] 两个字段。除非发生了重大事件（如价值观冲突、人生转折），否则【绝对不要】因为最近几次聊天的情绪波动就改变对TA本质人格的判断。
${isInitialGeneration ? `
【重置模式特别指令 - CRITICAL】
这是一次【完全重置】，你需要从零开始，基于所有可用的宏观数据重新构建对TA的完整认知。
- 你的分析必须覆盖从最早记忆到最新记忆的【完整时间跨度】
- 早期记忆和近期记忆拥有【相同的权重】——不要因为某些记忆发生得更近就赋予它们更大的影响
- personality_core、value_map、emotion_schema 必须反映TA在【整段关系中】展现出的稳定特征，而非仅仅是近期状态
- 如果早期记忆和近期记忆中TA的表现有差异，请在 observed_changes 中记录这种演变，但 personality_core 应反映最持久稳定的特质
` : ''}
【反面教材 - 严禁出现】
- ❌ 仅根据最近聊天就总结"TA是一个喜欢讨论XX话题的人" —— 这是把近期话题当成了人格特质
- ❌ personality_core.summary 里出现"最近"、"这几天"等时间限定词 —— summary 应该是跨越所有记忆的宏观总结
- ✅ 正确做法：personality_core 基于完整上下文和长期记忆，observed_changes 基于近期聊天与长期印象的对比

分析指令：五维画像更新 (第一人称视角)
根据【强制对比协议】和你自己的视角，分析新消息，并${isInitialGeneration ? '【生成】' : '【增量更新】'}以下JSON结构。

输出JSON结构v3.0（严格遵守, 不要用markdown代码块包裹，直接返回JSON）
{
  "version": 3.0,
  "lastUpdated": ${Date.now()},
  "value_map": {
    "likes": [${listInstruction}],
    "dislikes": [${listInstruction}],
    "core_values": "..."
  },
  "behavior_profile": {
    "tone_style": "...",
    "emotion_summary": "...",
    "response_patterns": "..."
  },
  "emotion_schema": {
    "triggers": { 
        "positive": [${listInstruction}],
        "negative": [${listInstruction}]
    },
    "comfort_zone": "...",
    "stress_signals": [${listInstruction}]
  },
  "personality_core": {
    "observed_traits": [${listInstruction}],
    "interaction_style": "...",
    "summary": "..."
  },
  "mbti_analysis": {
    "type": "XXXX",
    "reasoning": "...",
    "dimensions": {
        "e_i": 50,
        "s_n": 50,
        "t_f": 50,
        "j_p": 50
    }
  },
  "observed_changes": [
    ${changesInstruction}
  ]
}
注意：observed_changes 的每一项必须是纯字符串（string），例如 ["最近变得更开朗了", "开始主动分享日常"]。严禁使用对象格式如 {"period": "...", "description": "..."}。`;

          const data = await safeFetchJson(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
              body: JSON.stringify({
                  model: apiConfig.model,
                  messages: [{ role: "user", content: prompt }],
                  max_tokens: 8000,
                  temperature: 0.5,
                  // 与「设置 → API → 流式输出」保持一致，不在印象功能里强制覆盖用户选择。
                  // 流式响应由 safeResponseJson 拼回完整对象，下游 extractContent 无需改动。
                  stream: apiConfig.stream === true
              })
          }, 0);
          const parsed = parseGeneratedImpression(data);

          if (editingIdRef.current === targetId) {
              handleChange('impression', parsed);
              addToast(isInitialGeneration ? '印象档案已生成' : '印象档案已更新', 'success');
          } else {
              updateCharacter(targetId, { impression: parsed });
              addToast('后台任务完成：印象已更新到原角色', 'success');
          }

      } catch (e: any) {
          console.error(e);
          addToast(`生成失败: ${e.message}`, 'error');
      } finally {
          setIsGeneratingImpression(false);
      }
  };

  // 真正执行删除。名下有 amsg2 任务的角色 deleteCharacter 会先 await 云端清理，
  // 清不掉返回 cloud-cleanup-failed 且本地未删 → 转进「重试 / 仍然删除」弹窗；
  // force=true 是用户在那个弹窗里选了「仍然删除」，放行本地删除。
  const runDeleteCharacter = async (targetId: string, force = false) => {
      setIsDeleting(true);
      try {
          const result = await deleteCharacter(targetId, force ? { force: true } : undefined);
          if (result.status === 'cloud-cleanup-failed') {
              setDeleteConfirmTarget(null);
              setCloudCleanupFailTarget(targetId);
              return;
          }
          setDeleteConfirmTarget(null);
          setCloudCleanupFailTarget(null);
          addToast('连接已断开', 'success');
      } finally {
          setIsDeleting(false);
      }
  };

  const confirmDeleteCharacter = () => {
      if (deleteConfirmTarget && !isDeleting) {
          void runDeleteCharacter(deleteConfirmTarget);
      }
  };

  const handleExportCard = async () => {
      if (!formData) return;
      
      const {
          id, memories, refinedMemories, activeMemoryMonths, impression, guidebookInsights,
          ...rest
      } = formData;

      // 只导出「角色」本身：凭据 / 美化 / 语言偏好 / 运行时状态一律剥离，
      // 绝不把发卡人的 API 密钥等私密字段打包进卡里。清单见 utils/characterCard.ts。
      const cardProps = stripSensitiveCardFields(rest);

      const exportData: CharacterExportData = {
          ...cardProps,
          version: 1,
          type: 'sully_character_card'
      };

      // 导出前明文密钥体检 + 二次确认：正常为「安全，可分享」；若意外检出密钥则中止并提示上报。
      if (!(await confirmExportSafety(exportData))) return;

      // 角色身上的图（Q 版形象 sprites、见面皮肤 dateSkinSets）存的是令牌，令牌只有本机认得，
      // 原样导出对方只会拿到一串死字符串、图全空。所以先在一份深拷贝上把令牌换回内嵌的 data URL
      // （resolveBlobRefsDeep 是原地改的，绝不能拿 formData 去喂，那等于把用户自己的角色图改没了）。
      const portableData: CharacterExportData =
          typeof structuredClone === 'function'
              ? structuredClone(exportData)
              : JSON.parse(JSON.stringify(exportData));
      try {
          await resolveBlobRefsDeep(portableData);
      } catch {
          addToast('导出失败：角色身上的图读取不出来', 'error');
          return;
      }

      trackEvent('导出角色卡');

      const json = JSON.stringify(portableData, null, 2);
      const fileName = `${formData.name || 'Character'}_Card.json`;

      try {
          const result = await shareOrDownloadFile({
              card: { kind: 'character', title: formData.name, previewUrl: /^(data:|blob:|https?:|\/)/.test(portableData.avatar || '') ? portableData.avatar : undefined },
              content: json,
              fileName,
              mimeType: 'application/json;charset=utf-8',
              shareTitle: '导出角色卡',
          });
          if (result === 'cancelled') return;
          addToast(result === 'shared' ? '已打开角色卡分享面板' : '角色卡已生成并导出', 'success');
      } catch (error: any) { addToast(error?.message || '角色卡导出失败', 'error'); }
  };

  const handleImportCard = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      try {
          const json = await readShareText(file, 'character');
          const data: CharacterExportData = JSON.parse(json);

          if (data.type !== 'sully_character_card') {
              throw new Error('无效的角色卡文件');
          }

          // 导入侧同样剥离凭据 / 美化 / 语言 / 运行时状态：即便对方给的是旧版
          // 角色卡（把 API 密钥等私密字段一起打包了），也不会被写进本地角色，
          // 不会用发卡人的 key / 主题 / 语言偏好覆盖你自己的。清单见 utils/characterCard.ts。
          const safeData = stripSensitiveCardFields(data);

          // Sync mounted worldbooks into the global worldbook app so they
          // appear under their original category (or the character's name
          // as a sensible fallback when the card has no category set).
          const incomingMounted = (data.mountedWorldbooks || []).map(wb => ({ ...wb }));
          const fallbackCategory = `${data.name || '导入角色'} 的世界书`;
          let importedWbCount = 0;
          for (const wb of incomingMounted) {
              if (!wb.id || worldbooks.some(existing => existing.id === wb.id)) continue;
              const category = wb.category && wb.category.trim() ? wb.category : fallbackCategory;
              wb.category = category;
              await addWorldbook({
                  ...wb,
                  id: wb.id,
                  title: wb.title || '未命名设定',
                  content: wb.content || '',
                  category,
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
              });
              importedWbCount++;
          }

          const newChar: CharacterProfile = {
              ...safeData,
              id: `char-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              memories: [],
              refinedMemories: {},
              activeMemoryMonths: [],
              mountedWorldbooks: incomingMounted,
          } as CharacterProfile;

          await DB.saveCharacter(newChar);
          trackEvent('导入角色卡');
          // 不要调用 addCharacter()——它不是"刷新"，而是真的新建一个空白
          // "New Character" 并写进 DB，reload 后就会多出一张空白卡。
          // 导入的角色已经存进了 DB（上一行），reload 时 OSContext 会从
          // DB 重新读全部角色，导入的角色自然会出现，无需手动刷新 state。
          setTimeout(() => window.location.reload(), 500);

          const wbToastSuffix = importedWbCount > 0 ? `，并同步 ${importedWbCount} 本世界书` : '';
          addToast(`角色 ${newChar.name} 导入成功${wbToastSuffix}`, 'success');

      } catch (err: any) {
          console.error(err);
          addToast(err.message || '导入失败', 'error');
      } finally {
          if (cardImportRef.current) cardImportRef.current.value = '';
      }
  };

  return (
    <div className="h-full w-full bg-slate-50/30 font-light relative">
       {view === 'list' ? (
           <div className="flex flex-col h-full animate-fade-in relative"
                style={{ background: 'linear-gradient(180deg, #f5f2fb 0%, #ece6f6 100%)' }}>
               {/* safe-area: pt 用 max(3.5rem, 刘海高度)，保呼吸感同时更高刘海设备不被挡 */}
               <div className="px-6 pb-4 shrink-0 flex items-start justify-between" style={{ paddingTop: 'max(3.5rem, var(--safe-top))' }}>
                   <div className="relative">
                       <span className="absolute -top-3 -left-2 text-violet-300 text-xs select-none">✦</span>
                       <span className="absolute -top-1 left-9 text-violet-200 text-[10px] select-none">✦</span>
                       <h1 className="text-[30px] font-serif font-bold tracking-wide leading-tight text-slate-800">神经链接</h1>
                       <p className="text-xs text-violet-400/90 mt-2">已建立 <span className="font-bold text-violet-500">{characters.length}</span> 个角色连接</p>
                   </div>
                   <div className="flex gap-3 pt-1">
                        <ToolButton label="分组" title="角色分组管理" onClick={() => { setShowGroupModal(true); trackEvent('打开角色分组管理弹窗'); }}>
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-5 h-5">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
                            </svg>
                        </ToolButton>
                        <ToolButton label="导入" title="导入角色卡" onClick={() => cardImportRef.current?.click()}>
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-5 h-5">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
                            </svg>
                        </ToolButton>
                        <ToolButton label="关闭" title="关闭" onClick={closeApp}>
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                        </ToolButton>
                        <input type="file" ref={cardImportRef} className="hidden" accept=".json,.png,application/json,image/png" onChange={handleImportCard} />
                   </div>
               </div>
               <div className="flex-1 overflow-y-auto px-5 pb-20 no-scrollbar flex flex-col gap-3">
                   {(() => {
                       // 建过分组 → 按组折叠展开（不再分页，分组本身就把列表变短了）；
                       // 没建过分组 → 维持原来的分页列表，零变化。
                       if (characterGroups.length > 0) {
                           const knownGroupIds = new Set(characterGroups.map(g => g.id));
                           const sections = [
                               ...sortCharacterGroups(characterGroups).map(g => ({
                                   id: g.id,
                                   name: g.name,
                                   chars: characters.filter(c => c.groupId === g.id),
                               })),
                               {
                                   id: GROUP_FILTER_UNGROUPED,
                                   name: '未分组',
                                   // groupId 指向已删分组的角色也归到未分组，不会凭空消失
                                   chars: characters.filter(c => !c.groupId || !knownGroupIds.has(c.groupId)),
                               },
                           ].filter(s => s.id !== GROUP_FILTER_UNGROUPED || s.chars.length > 0);
                           return (
                               <>
                                   {sections.map(section => {
                                       const expanded = expandedGroups.includes(section.id);
                                       return (
                                           <div key={section.id} className="shrink-0">
                                               {/* 分组条：干净的圆角白卡，左折叠箭头 + 组名 + 数量胶囊，右侧 ">" 指示可展开 */}
                                               <button onClick={() => toggleGroupExpanded(section.id)}
                                                   className={`w-full h-14 flex items-center gap-3 px-5 rounded-2xl bg-white border transition-colors active:scale-[0.99] ${expanded ? 'border-violet-200' : 'border-slate-100 hover:border-violet-200'} shadow-[0_2px_10px_rgba(140,120,200,0.07)]`}>
                                                   <svg viewBox="0 0 12 12" className={`w-3 h-3 text-violet-400 transition-transform ${expanded ? '' : '-rotate-90'}`}>
                                                       <path d="M2 4l4 5 4-5z" fill="currentColor" />
                                                   </svg>
                                                   <span className="text-base font-bold text-slate-700 tracking-wide truncate">{section.name}</span>
                                                   <span className="min-w-[26px] px-2 py-0.5 rounded-full bg-violet-100/70 text-[12px] text-violet-500 text-center font-medium tabular-nums">{section.chars.length}</span>
                                                   <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className={`w-4 h-4 ml-auto text-slate-300 transition-transform ${expanded ? 'rotate-90' : ''}`}><path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
                                               </button>
                                               {expanded && (
                                                   <div className="flex flex-col gap-3 mt-3">
                                                       {section.chars.map(char => (
                                                           <CharacterCard
                                                               key={char.id}
                                                               char={char}
                                                               active={char.id === activeCharacterId}
                                                               onClick={() => { setEditingId(char.id); setView('detail'); }}
                                                               onDelete={(e) => {
                                                                   e.stopPropagation();
                                                                   setDeleteConfirmTarget(char.id);
                                                               }}
                                                           />
                                                       ))}
                                                       {section.chars.length === 0 && (
                                                           <div className="text-xs text-violet-300 px-3 pb-1">空分组——在角色「设定」页里指派</div>
                                                       )}
                                                   </div>
                                               )}
                                           </div>
                                       );
                                   })}
                                   <button onClick={handleAddCharacter} className="w-full py-4 rounded-3xl border border-dashed border-violet-300/70 text-violet-400 text-sm bg-white/50 hover:bg-white transition-colors flex items-center justify-center gap-2 shrink-0">
                                       <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>新建链接
                                   </button>
                               </>
                           );
                       }
                       const PAGE_SIZE = 6;
                       const totalPages = Math.max(1, Math.ceil(characters.length / PAGE_SIZE));
                       const page = Math.min(charPage, totalPages - 1);
                       const pageChars = characters.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
                       return (
                           <>
                               {pageChars.map(char => (
                                   <CharacterCard
                                       key={char.id}
                                       char={char}
                                       active={char.id === activeCharacterId}
                                       onClick={() => { setEditingId(char.id); setView('detail'); }}
                                       onDelete={(e) => {
                                           e.stopPropagation();
                                           setDeleteConfirmTarget(char.id);
                                       }}
                                   />
                               ))}
                               <button onClick={handleAddCharacter} className="w-full py-4 rounded-3xl border border-dashed border-violet-300/70 text-violet-400 text-sm bg-white/50 hover:bg-white transition-colors flex items-center justify-center gap-2 shrink-0">
                                   <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>新建链接
                               </button>
                               {totalPages > 1 && (
                                   <div className="flex items-center justify-center gap-3 pt-2 shrink-0">
                                       <button onClick={() => setCharPage(Math.max(0, page - 1))} disabled={page === 0}
                                           className="w-9 h-9 rounded-full bg-white/70 border border-violet-100 shadow-sm flex items-center justify-center text-violet-400 disabled:opacity-30 active:scale-90 transition-all">
                                           <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                                       </button>
                                       <span className="text-sm text-violet-500 font-medium tabular-nums min-w-[40px] text-center">{page + 1}/{totalPages}</span>
                                       <button onClick={() => setCharPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1}
                                           className="w-9 h-9 rounded-full bg-white/70 border border-violet-100 shadow-sm flex items-center justify-center text-violet-400 disabled:opacity-30 active:scale-90 transition-all">
                                           <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
                                       </button>
                                   </div>
                               )}
                           </>
                       );
                   })()}
               </div>
           </div>
       ) : formData && (
           <div className="flex flex-col h-full animate-fade-in bg-slate-50/50 relative">
               {/* safe-area: OUTER 保留渐变背景 + 模糊 + sticky，刘海高度由 paddingTop 让位；
                   INNER 不再用 h-32 沉底——那是老的「做高栏 + 内容沉底」状态栏预留写法，会和 safe-top 叠加出一大块空白。
                   改为内容自然高度、直接贴在 safe-top 下方。 */}
               {/* 顶栏 paddingTop 用 max(2.75rem, safe-top) 保底：--safe-top 为 0 的环境
                   （无刘海/某些 WebView）下也留出状态栏高度，避免「列表/发消息」贴到状态栏。
                   与列表页及全项目 detail 顶栏惯例（max(rem, var(--safe-top))）一致。 */}
               <div className="bg-gradient-to-b from-white/90 to-transparent backdrop-blur-sm shrink-0 z-40 sticky top-0" style={{ paddingTop: 'max(2.75rem, var(--safe-top))' }}>
                 <div className="flex flex-col px-5 pt-2 pb-2">
                   <div className="flex justify-between items-center mb-3">
                       <button onClick={handleBack} className="p-2 -ml-2 rounded-full hover:bg-white/60 flex items-center gap-1 text-slate-600"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg><span className="text-sm font-medium">列表</span></button>
                       <button onClick={() => { setActiveCharacterId(formData.id); openApp(AppID.Chat); }} className="text-xs px-3 py-1.5 bg-primary text-white rounded-full font-bold shadow-sm shadow-primary/30 flex items-center gap-1 active:scale-95 transition-transform"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path d="M3.105 2.288a.75.75 0 0 0-.826.95l1.414 4.926H16.5a.75.75 0 0 1 0 1.5H3.693l-1.414 4.926a.75.75 0 0 0 .826.95 28.897 28.897 0 0 0 15.293-7.155.75.75 0 0 0 0-1.114A28.897 28.897 0 0 0 3.105 2.288Z" /></svg>发消息</button>
                   </div>
                   <div className="flex gap-6 text-sm font-medium text-slate-400 pl-1">
                       <button onClick={() => { setDetailTab('identity'); trackEvent('切换角色详情标签页', { tab: 'identity' }); }} className={`pb-2 transition-colors relative ${detailTab === 'identity' ? 'text-slate-800' : ''}`}>设定{detailTab === 'identity' && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-primary rounded-full"></div>}</button>
                       <button onClick={() => { setDetailTab('memory'); trackEvent('切换角色详情标签页', { tab: 'memory' }); }} className={`pb-2 transition-colors relative ${detailTab === 'memory' ? 'text-slate-800' : ''}`}>记忆 ({(formData.memories || []).length}){detailTab === 'memory' && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-primary rounded-full"></div>}</button>
                       <button onClick={() => { setDetailTab('impression'); trackEvent('切换角色详情标签页', { tab: 'impression' }); }} className={`pb-2 transition-colors relative ${detailTab === 'impression' ? 'text-slate-800' : ''}`}>印象{detailTab === 'impression' && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-primary rounded-full"></div>}</button>
                       <button onClick={() => { setDetailTab('plates'); trackEvent('切换角色详情标签页', { tab: 'plates' }); }} className={`pb-2 transition-colors relative ${detailTab === 'plates' ? 'text-slate-800' : ''}`}>门牌{detailTab === 'plates' && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-primary rounded-full"></div>}</button>
                       <button onClick={() => { setDetailTab('chibi'); trackEvent('切换角色详情标签页', { tab: 'chibi' }); }} className={`pb-2 transition-colors relative ${detailTab === 'chibi' ? 'text-slate-800' : ''}`}>手办{detailTab === 'chibi' && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-primary rounded-full"></div>}</button>
                   </div>
                 </div>
               </div>
               <div className="flex-1 overflow-y-auto p-5 no-scrollbar pb-10">
                   {detailTab === 'identity' && (
                       <div className="space-y-6 animate-fade-in">
                           <div className="flex items-center gap-5">
                               <div className="relative group cursor-pointer w-24 h-24 shrink-0" onClick={() => fileInputRef.current?.click()}>
                                   <div className="w-full h-full rounded-[2rem] shadow-md bg-white border-4 border-white overflow-hidden relative"><TokenImg value={formData.avatar} className={`w-full h-full object-cover ${isCompressing ? 'opacity-50 blur-sm' : ''}`} alt="A" /></div>
                                   <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleFileChange} />
                               </div>
                               <div className="flex-1 space-y-3">
                                   <input value={formData.name} onChange={(e) => handleChange('name', e.target.value)} className="w-full bg-transparent py-1 text-xl font-medium text-slate-800 border-b border-slate-200" placeholder="名称" />
                                   <input value={formData.description} onChange={(e) => handleChange('description', e.target.value)} className="w-full bg-transparent py-1 text-sm text-slate-500 border-b border-slate-200" placeholder="描述" />
                                   {/* 头像 URL 入口: 与左侧上传文件平级. 走 draft -> 失焦/回车 commit,
                                       避免逐字 commit 导致所有引用 char.avatar 的 <img> 在打字时疯狂
                                       请求不完整 URL. https URL 会作为 Instant Push 通知图标传到 worker;
                                       本地上传 (data URL) 仅本地显示, 不进 push payload (data: 被 0.6+ 拒). */}
                                   <input
                                       type="url"
                                       value={avatarUrlDraft}
                                       onChange={(e) => setAvatarUrlDraft(e.target.value)}
                                       onBlur={() => {
                                           const v = avatarUrlDraft.trim();
                                           // 空 draft 分两种情况:
                                           //  - 当前 avatar 是 https URL: 用户清空 = 想移除这个 URL, commit '' 让头像清空
                                           //  - 当前 avatar 是 data URL / emoji / 空: input 本就为空, 不动 (避免误清已上传的图)
                                           if (!v) {
                                               if (/^https?:\/\//i.test(formData.avatar || '')) {
                                                   handleChange('avatar', '');
                                                   addToast('头像 URL 已移除', 'info');
                                               }
                                               return;
                                           }
                                           try {
                                               const u = new URL(v);
                                               if (!/^https?:$/.test(u.protocol)) throw new Error();
                                           } catch {
                                               addToast('请填写有效的 http(s) 图片链接', 'error');
                                               return;
                                           }
                                           if (v !== formData.avatar) {
                                               handleChange('avatar', v);
                                               addToast('头像 URL 已保存', 'success');
                                           }
                                       }}
                                       onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                                       placeholder="或粘贴图片 URL（回车确认）"
                                       className="w-full bg-transparent py-1 text-xs text-slate-400 border-b border-slate-200 placeholder:text-slate-300"
                                   />
                               </div>
                           </div>

                           <div>
                               <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">分组</label>
                               <div className="flex gap-2 items-center">
                                   <select
                                       value={formData.groupId && characterGroups.some(g => g.id === formData.groupId) ? formData.groupId : ''}
                                       onChange={e => handleChange('groupId', e.target.value || undefined)}
                                       className="flex-1 bg-white rounded-2xl px-4 py-2.5 text-sm text-slate-700 shadow-sm focus:ring-1 focus:ring-primary/20 outline-none appearance-none"
                                   >
                                       <option value="">未分组</option>
                                       {sortCharacterGroups(characterGroups).map(g => (
                                           <option key={g.id} value={g.id}>{g.name}</option>
                                       ))}
                                   </select>
                                   {detailGroupDraft === null ? (
                                       <button onClick={() => setDetailGroupDraft('')} className="px-3 py-2.5 rounded-2xl bg-white text-xs text-slate-500 shadow-sm active:scale-95 transition-transform shrink-0">＋新建</button>
                                   ) : (
                                       <input
                                           autoFocus
                                           value={detailGroupDraft}
                                           onChange={e => setDetailGroupDraft(e.target.value)}
                                           onBlur={async () => {
                                               const name = detailGroupDraft.trim();
                                               setDetailGroupDraft(null);
                                               if (!name) return;
                                               const existing = characterGroups.find(g => g.name === name);
                                               // 同名分组直接指派进去，不重复创建
                                               const group = existing || await createCharacterGroup(name);
                                               if (group) handleChange('groupId', group.id);
                                           }}
                                           onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                                           placeholder="分组名，回车确认"
                                           className="w-36 px-3 py-2.5 rounded-2xl bg-white text-xs text-slate-700 shadow-sm outline-none focus:ring-1 focus:ring-primary/20 shrink-0"
                                       />
                                   )}
                               </div>
                           </div>

                           <div>
                               <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">核心指令 (System Prompt)</label>
                               <textarea value={formData.systemPrompt} onChange={(e) => handleChange('systemPrompt', e.target.value)} className="w-full h-40 bg-white rounded-3xl p-5 text-sm shadow-sm resize-none focus:ring-1 focus:ring-primary/20 transition-all vr-reader-scroll" placeholder="设定..." />
                           </div>

                           <div>
                               <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">世界观 / 设定补充 (Worldview & Lore)</label>
                               <textarea
                                    value={formData.worldview || ''}
                                    onChange={(e) => handleChange('worldview', e.target.value)}
                                    className="w-full h-24 bg-white rounded-3xl p-5 text-sm shadow-sm resize-none focus:ring-1 focus:ring-primary/20 transition-all vr-reader-scroll"
                                    placeholder="在这个世界里，魔法是存在的..."
                                />
                           </div>

                           {/* 时间感知 & 时区：三个独立开关，可任意组合（聊天时间感知 / 自定义时区 / 线下时间感知） */}
                           <div className="bg-white rounded-3xl p-4 shadow-sm border border-slate-100 space-y-4">
                               <div>
                                   <label className="text-[10px] font-bold text-indigo-500 uppercase tracking-widest block">时间感知 & 时区</label>
                                   <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">下面三个开关相互独立、可任意组合。改完即时生效（下一条回复起算）。</p>
                               </div>

                               {/* 1. 聊天 · 时间感知强化 */}
                               <div className="border-t border-slate-100 pt-3">
                                   <div className="flex items-center justify-between gap-3">
                                       <div className="min-w-0">
                                           <p className="text-xs font-bold text-slate-700">聊天 · 时间感知强化</p>
                                           <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">默认开。开启后角色会记得你们多久没聊、主动贴近真实时间；关掉后这种感觉会变弱。</p>
                                       </div>
                                       <button
                                           onClick={() => handleChange('timeAwarenessEnabled', formData.timeAwarenessEnabled === false)}
                                           className={`w-12 h-7 rounded-full transition-colors relative shrink-0 ${formData.timeAwarenessEnabled !== false ? 'bg-primary' : 'bg-slate-200'}`}
                                       >
                                           <div className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow-md transition-transform ${formData.timeAwarenessEnabled !== false ? 'translate-x-5' : 'translate-x-0.5'}`}></div>
                                       </button>
                                   </div>
                               </div>

                               {/* 2. 自定义时区（异国恋等） */}
                               <div className="border-t border-slate-100 pt-3">
                                   <div className="flex items-center justify-between gap-3">
                                       <div className="min-w-0">
                                           <p className="text-xs font-bold text-slate-700">自定义时区</p>
                                           <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">默认关（跟随本机）。开启后角色活在自己的时区里，按所选时区过日子，也知道和你有时差——适合异国恋、角色身处异国。</p>
                                       </div>
                                       <button
                                           onClick={() => handleChange('customTimezoneEnabled', !formData.customTimezoneEnabled)}
                                           className={`w-12 h-7 rounded-full transition-colors relative shrink-0 ${formData.customTimezoneEnabled ? 'bg-primary' : 'bg-slate-200'}`}
                                       >
                                           <div className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow-md transition-transform ${formData.customTimezoneEnabled ? 'translate-x-5' : 'translate-x-0.5'}`}></div>
                                       </button>
                                   </div>
                                   {formData.customTimezoneEnabled && (
                                       <select
                                           value={formData.customTimezone || ''}
                                           onChange={(e) => handleChange('customTimezone', e.target.value)}
                                           className="mt-3 w-full bg-slate-50 rounded-2xl px-3 py-2.5 text-xs border border-slate-200 outline-none focus:ring-1 focus:ring-primary/30"
                                       >
                                           <option value="">请选择角色所在时区…</option>
                                           {COMMON_TIMEZONES.map(tz => (
                                               <option key={tz.id} value={tz.id}>{tz.label}</option>
                                           ))}
                                       </select>
                                   )}
                               </div>

                               {/* 3. 线下时间感知（约会 / 见面 App） */}
                               <div className="border-t border-slate-100 pt-3">
                                   <div className="flex items-center justify-between gap-3">
                                       <div className="min-w-0">
                                           <p className="text-xs font-bold text-slate-700">线下时间感知（约会）</p>
                                           <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">默认开。见面时剧情会跟着现实时间走。关掉后剧情脱离现实时间线，更适合纯架空。</p>
                                       </div>
                                       <button
                                           onClick={() => handleChange('dateTimeAwarenessEnabled', formData.dateTimeAwarenessEnabled === false ? undefined : false)}
                                           className={`w-12 h-7 rounded-full transition-colors relative shrink-0 ${formData.dateTimeAwarenessEnabled !== false ? 'bg-primary' : 'bg-slate-200'}`}
                                       >
                                           <div className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow-md transition-transform ${formData.dateTimeAwarenessEnabled !== false ? 'translate-x-5' : 'translate-x-0.5'}`}></div>
                                       </button>
                                   </div>
                               </div>
                           </div>

                           {/* 生活记录注入：总开关 + 4 个模块小开关（数据在档案 App「生活记录」里维护） */}
                           <div className="bg-white rounded-3xl p-4 shadow-sm border border-slate-100 space-y-4">
                               <div>
                                   <label className="text-[10px] font-bold text-rose-500 uppercase tracking-widest block">生活记录注入</label>
                                   <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">把你在「档案 → 生活记录」里的生理期 / 药盒 / 记账 / 锻炼作为潜意识背景注入给该角色；你明确说出相关事实时，ta 还能帮你顺手记一笔（聊天里会出卡片，可确认 / 否决）。</p>
                               </div>

                               {/* 总开关 */}
                               <div className="border-t border-slate-100 pt-3">
                                   <div className="flex items-center justify-between gap-3">
                                       <div className="min-w-0">
                                           <p className="text-xs font-bold text-slate-700">总开关</p>
                                           <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">默认关。关闭时不注入任何生活记录内容，连代记指令的用法都不会教给角色。</p>
                                       </div>
                                       <button
                                           onClick={() => { handleChange('lifeRecordEnabled', !formData.lifeRecordEnabled); trackEvent('开启角色生活记录注入', { state: formData.lifeRecordEnabled ? 'off' : 'on' }); }}
                                           className={`w-12 h-7 rounded-full transition-colors relative shrink-0 ${formData.lifeRecordEnabled ? 'bg-primary' : 'bg-slate-200'}`}
                                       >
                                           <div className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow-md transition-transform ${formData.lifeRecordEnabled ? 'translate-x-5' : 'translate-x-0.5'}`}></div>
                                       </button>
                                   </div>
                               </div>

                               {/* 模块小开关（总开关关闭时整体置灰） */}
                               <div className={`border-t border-slate-100 pt-3 space-y-3 ${formData.lifeRecordEnabled ? '' : 'opacity-40 pointer-events-none'}`}>
                                   {([
                                       ['lifeRecordPeriodEnabled', 'period', '生理期', '经期状态 / 周期预测 + 代记「来了 / 结束了」'],
                                       ['lifeRecordMedEnabled', 'med', '药盒', '今日用药计划与打卡情况 + 代记「吃了 xx 药」'],
                                       ['lifeRecordExpenseEnabled', 'expense', '记账', '今日支出（与银行 App 打通）+ 代记「花了 xx 钱」'],
                                       ['lifeRecordExerciseEnabled', 'exercise', '锻炼', '今日 / 本周锻炼情况 + 代记「做了 xx 运动」'],
                                   ] as const).filter(([, moduleKey]) => !hiddenLifeModules.includes(moduleKey)).map(([field, , label, desc]) => (
                                       <div key={field} className="flex items-center justify-between gap-3">
                                           <div className="min-w-0">
                                               <p className="text-xs font-bold text-slate-700">{label}</p>
                                               <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">{desc}</p>
                                           </div>
                                           <button
                                               onClick={() => handleChange(field, formData[field] === false)}
                                               className={`w-12 h-7 rounded-full transition-colors relative shrink-0 ${formData[field] !== false ? 'bg-primary' : 'bg-slate-200'}`}
                                           >
                                               <div className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow-md transition-transform ${formData[field] !== false ? 'translate-x-5' : 'translate-x-0.5'}`}></div>
                                           </button>
                                       </div>
                                   ))}
                               </div>
                           </div>

                           <div className="bg-white rounded-3xl p-4 shadow-sm border border-slate-100 space-y-3">
                               <div className="flex items-center justify-between">
                                   <label className="text-[10px] font-bold text-emerald-600 uppercase tracking-widest flex items-center gap-1"><SpeakerHigh size={12} /> 角色语音音色</label>
                                   <div className="flex gap-1.5">
                                       <button
                                           onClick={() => { setActiveCharacterId(formData.id); openApp(AppID.VoiceDesigner); }}
                                           className="text-[10px] bg-violet-50 text-violet-700 px-2 py-1 rounded font-bold hover:bg-violet-100 flex items-center gap-0.5"
                                       >
                                           <SlidersHorizontal size={10} weight="bold" /> 捏声音
                                       </button>
                                       <button
                                           onClick={handleLoadMiniMaxVoices}
                                           className="text-[10px] bg-emerald-50 text-emerald-700 px-2 py-1 rounded font-bold hover:bg-emerald-100 disabled:opacity-60"
                                           disabled={isLoadingVoices}
                                       >
                                           {isLoadingVoices ? '拉取中...' : '拉取可用音色'}
                                       </button>
                                   </div>
                               </div>
                               <p className="text-[11px] text-slate-500">已有 voice_id 可直接填，不依赖查询。聊天角色配置后，后续接 TTS 可直接读取。</p>

                               <div className="rounded-2xl border border-violet-200/60 bg-violet-50/40 p-2.5 space-y-2">
                                   <div className="flex items-center justify-between gap-2">
                                       <span className="text-[10px] font-bold text-violet-600 uppercase tracking-widest">MiniMax 合成参数</span>
                                       <span className="text-[9px] text-slate-400">老角色默认经典</span>
                                   </div>
                                   <div className="grid grid-cols-2 gap-1 rounded-xl bg-white/80 p-1">
                                       {([
                                           ['legacy', '经典参数'],
                                           ['natural-v2', '新版自然参数'],
                                       ] as const).map(([version, label]) => {
                                           const activeVersion = formData.voiceProfile?.minimaxParamVersion === 'natural-v2' ? 'natural-v2' : 'legacy';
                                           return (
                                               <button
                                                   key={version}
                                                   type="button"
                                                   onClick={() => handleChange('voiceProfile', {
                                                       ...(formData.voiceProfile || {}),
                                                       minimaxParamVersion: version,
                                                   })}
                                                   className={`rounded-lg px-2 py-1.5 text-[10px] font-bold transition-colors ${activeVersion === version ? 'bg-violet-500 text-white shadow-sm' : 'text-slate-400'}`}
                                               >
                                                   {label}
                                               </button>
                                           );
                                       })}
                                   </div>
                                   <p className="text-[10px] text-slate-400 leading-relaxed">
                                       {formData.voiceProfile?.minimaxParamVersion === 'natural-v2'
                                           ? '对齐捏声音试听与聊天、见面、电话参数，保留模型原生韵律，不再自动给每个标点插停顿。'
                                           : '保留现有自动停顿、参数限幅和动态情感优先规则，历史效果不会改变。'}
                                   </p>
                               </div>

                               <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                   <input
                                       value={formData.voiceProfile?.voiceId || ''}
                                       onChange={(e) => handleChange('voiceProfile', {
                                           ...(formData.voiceProfile || {}),
                                           provider: 'minimax',
                                           voiceId: e.target.value,
                                           voiceName: formData.voiceProfile?.voiceName || '',
                                           source: formData.voiceProfile?.source || 'custom',
                                           model: formData.voiceProfile?.model || 'speech-2.8-hd',
                                           notes: formData.voiceProfile?.notes || '',
                                       })}
                                       className="w-full bg-slate-50 rounded-2xl px-3 py-2 text-xs border border-slate-200"
                                       placeholder="voice_id（可直接贴）"
                                   />
                                   <input
                                       value={formData.voiceProfile?.model || 'speech-2.8-hd'}
                                       onChange={(e) => handleChange('voiceProfile', {
                                           ...(formData.voiceProfile || {}),
                                           provider: 'minimax',
                                           voiceId: formData.voiceProfile?.voiceId || '',
                                           voiceName: formData.voiceProfile?.voiceName || '',
                                           source: formData.voiceProfile?.source || 'custom',
                                           model: e.target.value,
                                           notes: formData.voiceProfile?.notes || '',
                                       })}
                                       className="w-full bg-slate-50 rounded-2xl px-3 py-2 text-xs border border-slate-200"
                                       placeholder="TTS 模型（默认 speech-2.8-hd）"
                                   />
                               </div>

                               {/* 鱼声 Fish Audio 音色：仅当全局语音服务商切到鱼声时生效（设置 → 其他 API） */}
                               <div className="rounded-2xl border border-sky-200/60 bg-sky-50/40 p-2.5 space-y-1.5">
                                   <div className="text-[10px] font-bold text-sky-600 uppercase tracking-widest">鱼声 Fish 音色</div>
                                   <input
                                       value={formData.voiceProfile?.fishReferenceId || ''}
                                       onChange={(e) => handleChange('voiceProfile', {
                                           ...(formData.voiceProfile || {}),
                                           fishReferenceId: e.target.value,
                                       })}
                                       className="w-full bg-white rounded-2xl px-3 py-2 text-xs border border-slate-200"
                                       placeholder="粘贴 reference_id 或整条 fish.audio 链接"
                                   />
                                   <p className="text-[10px] text-slate-400">从 fish.audio 选好音色后，把那一页的链接（含 ?modelId=…）或 32 位 id 直接贴进来都行，会自动识别。设置里语音选「鱼声 Fish」后该角色就用它合成；与上面的 MiniMax voice_id 各存各的。</p>
                               </div>

                               {/* ElevenLabs 音色：角色独立保存，设置页只负责 Key / 模型。 */}
                               <div className="rounded-2xl border border-violet-200/60 bg-violet-50/40 p-2.5 space-y-1.5">
                                   <div className="flex items-center justify-between gap-2">
                                       <div className="text-[10px] font-bold text-violet-600 uppercase tracking-widest">ElevenLabs 音色</div>
                                       <button
                                           type="button"
                                           onClick={() => void handleTestElevenLabsVoice()}
                                           disabled={isTestingElevenLabsVoice}
                                           className="text-[10px] rounded-lg border border-violet-200 bg-white px-2 py-1 font-bold text-violet-600 disabled:opacity-50"
                                       >
                                           {isTestingElevenLabsVoice ? '试听中…' : '试听'}
                                       </button>
                                   </div>
                                   <input
                                       value={formData.voiceProfile?.elevenLabsVoiceId || ''}
                                       onChange={(e) => handleChange('voiceProfile', {
                                           ...(formData.voiceProfile || {}),
                                           elevenLabsVoiceId: e.target.value,
                                       })}
                                       className="w-full bg-white rounded-2xl px-3 py-2 text-xs border border-slate-200"
                                       placeholder="粘贴 Voice ID 或 ElevenLabs 音色页面链接"
                                   />
                                   <p className="text-[10px] text-slate-400">从 ElevenLabs Voices / Voice Library 复制 Voice ID；也可直接粘贴含 voiceId 的页面链接。设置里语音选 ElevenLabs 后使用，与 MiniMax、鱼声音色分别保存。</p>
                               </div>

                               {/* 语速：三家 TTS 共用 voiceProfile.speed */}
                               <div className="space-y-1 pt-1">
                                   <div className="flex items-center justify-between">
                                       <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">语速</label>
                                       <span className="text-[11px] font-mono text-slate-500">{(formData.voiceProfile?.speed ?? 1).toFixed(2)}×</span>
                                   </div>
                                   <input
                                       type="range"
                                       min={0.5}
                                       max={1.5}
                                       step={0.05}
                                       value={formData.voiceProfile?.speed ?? 1}
                                       onChange={(e) => handleChange('voiceProfile', {
                                           ...(formData.voiceProfile || {}),
                                           speed: parseFloat(e.target.value),
                                       })}
                                       className="w-full accent-primary"
                                   />
                                   <p className="text-[10px] text-slate-400">越小越慢、越像娓娓道来。1.0 正常；觉得“赶”就拉到 0.85–0.95。MiniMax、鱼声与 ElevenLabs 共用该角色的语速。</p>
                               </div>

                               {(voiceOptions.system.length + voiceOptions.voice_cloning.length + voiceOptions.voice_generation.length) > 0 && (
                                   <div className="space-y-2 pt-1">
                                       {([
                                           ['system', '系统音色'],
                                           ['voice_cloning', '复刻音色'],
                                           ['voice_generation', '文生音色'],
                                       ] as const).map(([source, label]) => {
                                           const list = voiceOptions[source];
                                           if (!list.length) return null;
                                           return (
                                               <div key={source}>
                                                   <div className="text-[10px] text-slate-400 mb-1">{label}</div>
                                                   <div className="max-h-28 overflow-y-auto space-y-1 pr-1">
                                                       {list.slice(0, 50).map((v) => (
                                                           <button
                                                               key={`${source}-${v.voice_id}`}
                                                               onClick={() => applyVoiceToCharacter(v, source)}
                                                               className="w-full text-left px-2 py-1 rounded-xl text-xs border border-slate-200 hover:border-emerald-200 hover:bg-emerald-50/40"
                                                           >
                                                               <div className="font-medium text-slate-700 truncate">{v.voice_name || '未命名音色'}</div>
                                                               <div className="text-[10px] text-slate-400 truncate">{v.voice_id}</div>
                                                           </button>
                                                       ))}
                                                   </div>
                                               </div>
                                           );
                                       })}
                                   </div>
                               )}
                           </div>

                           {/* Worldbook Section */}
                           <div>
                               <div className="flex justify-between items-center mb-2 px-1">
                                   <label className="text-[10px] font-bold text-indigo-500 uppercase tracking-widest block flex items-center gap-1"><Books size={12} /> 扩展设定 (Worldbooks)</label>
                                   <button onClick={openWorldbookModal} className="text-[10px] bg-indigo-50 text-indigo-600 px-2 py-1 rounded font-bold hover:bg-indigo-100">+ 挂载</button>
                                </div>
                                <div className="space-y-2">
                                   {formData.mountedWorldbooks && formData.mountedWorldbooks.length > 0 ? (
                                       [...formData.mountedWorldbooks.reduce((groups, book) => {
                                           const category = book.category || '未分类设定 (General)';
                                           groups.set(category, [...(groups.get(category) || []), book]);
                                           return groups;
                                       }, new Map<string, NonNullable<CharacterProfile['mountedWorldbooks']>>())].map(([category, books]) => (
                                           <details key={category} className="rounded-2xl border border-indigo-50 bg-white overflow-hidden" data-mounted-worldbook-group={category}>
                                               <summary className="cursor-pointer px-4 py-3 text-xs font-bold text-slate-700 break-words">{category} <span className="font-normal text-slate-400">· {books.length} 条</span></summary>
                                               <div className="px-4 pb-3">
                                                   <div className="mb-2 flex justify-end"><button type="button" onClick={() => {
                                                       const ids = new Set(books.map(book => book.id));
                                                       setFormData(prev => prev ? { ...prev, mountedWorldbooks: (prev.mountedWorldbooks || []).filter(book => !ids.has(book.id)) } : prev);
                                                   }} className="py-1 text-[11px] text-rose-400">整组取消挂载</button></div>
                                                   {books.map(wb => <div key={wb.id} className="flex items-start gap-2 border-t border-slate-100 py-2">
                                                       <details className="min-w-0 flex-1" onToggle={event => {
                                                           const open = event.currentTarget.open;
                                                           setExpandedMountedBookIds(prev => { const next = new Set(prev); if (open) next.add(wb.id); else next.delete(wb.id); return next; });
                                                       }}>
                                                           <summary className="cursor-pointer text-xs text-slate-600 break-words">{wb.title}</summary>
                                                           {expandedMountedBookIds.has(wb.id) && <p className="mt-2 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-slate-500">{wb.content}</p>}
                                                       </details>
                                                       <button type="button" aria-label={'取消挂载 ' + wb.title} onClick={() => unmountWorldbook(wb.id)} className="shrink-0 px-2 text-slate-400">×</button>
                                                   </div>)}
                                               </div>
                                           </details>
                                       ))
                                   ) : (
                                       <div className="text-center py-4 bg-slate-50 rounded-2xl border border-dashed border-slate-200 text-slate-400 text-xs">
                                           暂未挂载任何世界书
                                       </div>
                                   )}
                               </div>
                           </div>

                           {/* Export Card Button */}
                           <div className="pt-4">
                               <button
                                   onClick={handleExportCard}
                                   className="w-full py-4 bg-slate-800 text-white rounded-2xl text-xs font-bold shadow-lg flex items-center justify-center gap-2 hover:bg-slate-700 active:scale-95 transition-all"
                               >
                                   <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
                                       <path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z" />
                                   </svg>
                                   分享 / 导出角色卡
                               </button>
                               <p className="text-[10px] text-slate-400 text-center mt-2">导出内容不包含记忆库和聊天记录</p>
                           </div>
                       </div>
                   )}
                   
                   {detailTab === 'memory' && (
                       <div className="space-y-4 animate-fade-in">
                           <div className="flex justify-center gap-2 mb-4">
                               <button onClick={() => { setShowBatchModal(true); trackEvent('打开批量记忆总结弹窗'); }} className="px-4 py-2 bg-white rounded-full text-xs font-semibold text-slate-500 shadow-sm border border-slate-100">批量总结（可指定日期）</button>
                               <button onClick={() => setShowImportModal(true)} className="px-4 py-2 bg-white rounded-full text-xs font-semibold text-slate-500 shadow-sm border border-slate-100">导入/清洗</button>
                               <button onClick={handleExportPreview} className="px-4 py-2 bg-white rounded-full text-xs font-semibold text-slate-500 shadow-sm border border-slate-100">备份</button>
                           </div>
                           <MemoryArchivist
                               memories={formData.memories || []}
                               refinedMemories={formData.refinedMemories || {}}
                               activeMemoryMonths={formData.activeMemoryMonths || []}
                               charName={formData.name || ''}
                               userName={userProfile.name}
                               onRefine={handleRefineMonth}
                               onDeleteMemories={handleDeleteMemories}
                               onUpdateMemory={handleUpdateMemory}
                               onToggleActiveMonth={handleToggleActiveMonth}
                               onUpdateRefinedMemory={handleUpdateRefinedMemory}
                               onDeleteRefinedMemory={handleDeleteRefinedMemory}
                               onForceArchiveDate={handleForceArchiveDate}
                               forceArchiveTemplates={archivePrompts}
                               forceArchiveDefaultPromptId={selectedPromptId}
                           />
                       </div>
                   )}

                   {detailTab === 'impression' && (
                       <ImpressionPanel
                           impression={formData.impression}
                           isGenerating={isGeneratingImpression}
                           onGenerate={handleGenerateImpression}
                           onUpdateImpression={(newImp) => handleChange('impression', newImp)}
                           onDelete={() => handleChange('impression', undefined)}
                       />
                   )}

                   {detailTab === 'chibi' && formData.id && (
                       <ChibiShelfPanel charId={formData.id} onOpen={() => { setShowChibiStudio(true); trackEvent('打开QQ捏人工坊'); }} />
                   )}

                   {detailTab === 'plates' && formData.id && (
                       <RoomPlatePanel charId={formData.id} userName={userProfile.name} />
                   )}
               </div>
           </div>
       )}
       
       {/* QQ捏人工坊：直接写库（sprites / vrState / specialMomentRecords / chibiStudio），
           关闭时把最新角色数据拉回 formData——否则后续编辑会用旧副本 auto-save 盖掉工坊成果 */}
       {showChibiStudio && formData && (
           <ChibiStudio
               charId={formData.id}
               onClose={() => {
                   setShowChibiStudio(false);
                   const latest = characters.find(c => c.id === formData.id);
                   if (latest) setFormData(latest);
               }}
           />
       )}

       {/* Modals ... */}
       <Modal isOpen={showImportModal} title="记忆导入/清洗" onClose={() => setShowImportModal(false)} footer={<><button onClick={() => setShowImportModal(false)} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl">取消</button><button onClick={handleImportMemories} disabled={isProcessingMemory || importLengthInfo.overLimit} className={`flex-1 py-3 text-white font-bold rounded-2xl shadow-lg flex items-center justify-center gap-2 ${importLengthInfo.overLimit ? 'bg-slate-300 cursor-not-allowed shadow-none' : 'bg-primary shadow-primary/30'}`}>{isProcessingMemory && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>}{isProcessingMemory ? '处理中...' : importLengthInfo.overLimit ? '请先分批' : '开始执行'}</button></>}>
           <div className="space-y-3">
               <div className="text-xs text-slate-400 leading-relaxed bg-slate-50 p-3 rounded-xl border border-slate-100">
                   适合从其它应用“搬家”。最多 5 万字，字数只在本地统计；AI 只整理时间与事件结构，不摘要、不合并、不省略原有细节。5 万字以内会自动分批，无需手动切。
               </div>
               {importStatus && <div className="text-xs text-primary font-medium">{importStatus}</div>}
               <textarea
                   value={importText}
                   onChange={e => setImportText(e.target.value)}
                   placeholder="在此粘贴从别处带来的记忆文本…"
                   className="w-full h-40 bg-slate-100 border-none rounded-2xl px-4 py-3 text-sm text-slate-700 resize-none focus:ring-2 focus:ring-primary/20 transition-all"
               />
               {importLengthInfo.overLimit && (
                   <div className="text-xs leading-relaxed rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-700">
                       {getExternalMemoryOverLimitMessage(importText)}
                   </div>
               )}
               <div className={`text-right text-[10px] ${importLengthInfo.overLimit ? 'text-red-500 font-bold' : 'text-slate-400'}`}>
                   {importLengthInfo.count.toLocaleString()} / {EXTERNAL_MEMORY_MAX_CHARS.toLocaleString()} 字（本地统计）
               </div>
           </div>
       </Modal>

       <Modal isOpen={showBatchModal} title="批量记忆总结" onClose={() => { setShowBatchModal(false); setShowPromptEditor(false); }} footer={
           isBatchProcessing ?
           <div className="w-full py-3 bg-slate-100 text-primary font-bold rounded-2xl text-center flex items-center justify-center gap-2"><div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>{batchProgress}</div> :
           <button onClick={handleBatchSummarize} className="w-full py-3 bg-primary text-white font-bold rounded-2xl">开始生成</button>
       }>
           <div className="space-y-3">
               <p className="text-xs text-slate-400">将遍历所有聊天记录，按天使用所选提示词模板生成记忆总结。</p>
               {/* Prompt Selection */}
               <div className="bg-indigo-50 p-3 rounded-xl border border-indigo-100">
                   <label className="text-[10px] font-bold text-indigo-400 uppercase mb-2 block">选择提示词模板</label>
                   <div className="flex flex-col gap-2">
                       {archivePrompts.map(p => (
                           <div key={p.id} onClick={() => { setSelectedPromptId(p.id); localStorage.setItem('chat_active_archive_prompt_id', p.id); }} className={`p-2.5 rounded-lg border cursor-pointer flex items-center justify-between ${selectedPromptId === p.id ? 'bg-white border-indigo-500 shadow-sm ring-1 ring-indigo-500' : 'bg-white/50 border-indigo-200 hover:bg-white'}`}>
                               <span className={`text-xs font-bold ${selectedPromptId === p.id ? 'text-indigo-700' : 'text-slate-600'}`}>{p.name}</span>
                               <div className="flex gap-1.5">
                                   <button onClick={(e) => { e.stopPropagation(); setEditingPrompt(p); setShowPromptEditor(true); }} className="text-[10px] text-slate-400 hover:text-indigo-500 px-2 py-0.5 rounded bg-slate-100 hover:bg-indigo-50">查看</button>
                                   {!p.id.startsWith('preset_') && (
                                       <button onClick={(e) => { e.stopPropagation(); const next = archivePrompts.filter(ap => ap.id !== p.id); setArchivePrompts(next); localStorage.setItem('chat_archive_prompts', JSON.stringify(next.filter(ap => !ap.id.startsWith('preset_')))); if (selectedPromptId === p.id) setSelectedPromptId('preset_rational'); }} className="text-[10px] text-red-300 hover:text-red-500 px-1.5 py-0.5 rounded hover:bg-red-50">x</button>
                                   )}
                               </div>
                           </div>
                       ))}
                   </div>
                   <button onClick={() => { const newP = { id: `custom_${Date.now()}`, name: '新自定义模板', content: DEFAULT_ARCHIVE_PROMPTS[0].content }; setEditingPrompt(newP); setShowPromptEditor(true); }} className="mt-2 w-full py-1.5 text-xs font-bold text-indigo-500 border border-dashed border-indigo-300 rounded-lg hover:bg-indigo-100">+ 新建自定义提示词</button>
               </div>
               {/* Date Range */}
               <div className="flex gap-2">
                   <div className="flex-1"><label className="text-[10px] uppercase text-slate-400 font-bold">开始日期 (可选)</label><input type="date" value={batchRange.start} onChange={e => setBatchRange({...batchRange, start: e.target.value})} className="w-full bg-slate-100 rounded-xl px-3 py-2 text-xs" /></div>
                   <div className="flex-1"><label className="text-[10px] uppercase text-slate-400 font-bold">结束日期 (可选)</label><input type="date" value={batchRange.end} onChange={e => setBatchRange({...batchRange, end: e.target.value})} className="w-full bg-slate-100 rounded-xl px-3 py-2 text-xs" /></div>
               </div>
               <div className="text-[10px] text-slate-400 bg-slate-50 p-2.5 rounded-xl leading-relaxed">
                   支持变量: <code>{'${dateStr}'}</code>, <code>{'${char.name}'}</code>, <code>{'${userProfile.name}'}</code>, <code>{'${rawLog}'}</code>
               </div>
           </div>
       </Modal>

       {/* Prompt Editor Modal */}
       <Modal isOpen={showPromptEditor} title="编辑提示词" onClose={() => setShowPromptEditor(false)} footer={<button onClick={() => {
           if (!editingPrompt) return;
           const isNew = !archivePrompts.some(p => p.id === editingPrompt.id);
           const next = isNew ? [...archivePrompts, editingPrompt] : archivePrompts.map(p => p.id === editingPrompt.id ? editingPrompt : p);
           setArchivePrompts(next);
           setSelectedPromptId(editingPrompt.id);
           localStorage.setItem('chat_archive_prompts', JSON.stringify(next.filter(p => !p.id.startsWith('preset_'))));
           localStorage.setItem('chat_active_archive_prompt_id', editingPrompt.id);
           setShowPromptEditor(false);
           addToast('提示词已保存', 'success');
       }} className="w-full py-3 bg-primary text-white font-bold rounded-2xl">保存</button>}>
           <div className="space-y-3">
               <input
                   value={editingPrompt?.name || ''}
                   onChange={e => setEditingPrompt(prev => prev ? {...prev, name: e.target.value} : null)}
                   placeholder="预设名称"
                   className="w-full px-4 py-2 bg-slate-100 rounded-xl text-sm font-bold text-slate-700 outline-none focus:ring-2 focus:ring-primary/20"
                   readOnly={editingPrompt?.id.startsWith('preset_')}
               />
               <textarea
                   value={editingPrompt?.content || ''}
                   onChange={e => setEditingPrompt(prev => prev ? {...prev, content: e.target.value} : null)}
                   className="w-full h-64 bg-slate-100 rounded-xl p-3 text-xs font-mono resize-none focus:outline-none focus:ring-2 focus:ring-primary/20 leading-relaxed"
                   placeholder="输入提示词内容..."
                   readOnly={editingPrompt?.id.startsWith('preset_')}
               />
               {editingPrompt?.id.startsWith('preset_') && (
                   <p className="text-[10px] text-slate-400 text-center">预设模板不可编辑（仅查看）</p>
               )}
           </div>
       </Modal>

       <Modal isOpen={showExportModal} title="导出文本" onClose={() => setShowExportModal(false)} footer={<div className="flex gap-2 w-full"><button onClick={() => { navigator.clipboard.writeText(exportText); addToast('已复制', 'success'); }} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl">复制全文</button><button onClick={handleExportMemoryFile} className="flex-1 py-3 bg-slate-800 text-white font-bold rounded-2xl shadow-lg flex items-center justify-center gap-2"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z" /></svg>导出文件</button></div>}>
           <div className="bg-slate-50 rounded-2xl p-3 border border-slate-100 space-y-2"><div className="text-[10px] text-slate-400">已自动复制到剪贴板。如果分享失败，请直接手动复制。</div><textarea value={exportText} readOnly className="w-full h-40 bg-transparent border-none text-[10px] font-mono text-slate-600 resize-none focus:ring-0 leading-relaxed select-all" onClick={(e) => e.currentTarget.select()}/></div>
       </Modal>

        {/* Worldbook Select Modal */}
        <Modal 
            isOpen={showWorldbookModal} 
            title="挂载世界书" 
            onClose={() => setShowWorldbookModal(false)} 
        >
            <div className="max-h-[50vh] overflow-y-auto no-scrollbar space-y-3 p-1">
                {worldbooks.length === 0 ? (
                    <div className="text-center text-slate-400 text-xs py-8">
                        还没有世界书，请去桌面【世界书】App 创建。
                    </div>
                ) : (
                    <>
                        <input
                            value={wbModalSearch}
                            onChange={e => setWbModalSearch(e.target.value)}
                            placeholder="搜索世界书标题或分组..."
                            className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-700 outline-none focus:bg-white focus:border-indigo-300 transition-all"
                        />
                        {wbModalSearchResults ? (
                            // 搜索态：扁平结果列表
                            <div className="space-y-2">
                                {wbModalSearchResults.books.length === 0 ? (
                                    <div className="text-center text-slate-400 text-xs py-6">没有匹配的世界书。</div>
                                ) : (
                                    wbModalSearchResults.books.map(wb => {
                                        const isMounted = formData?.mountedWorldbooks?.some(m => m.id === wb.id);
                                        return (
                                            <button
                                                key={wb.id}
                                                onClick={() => !isMounted && mountWorldbook(wb.id)}
                                                disabled={isMounted}
                                                className={`w-full p-3 rounded-xl border text-left transition-all ${isMounted ? 'bg-slate-50 border-slate-200 opacity-50 cursor-not-allowed' : 'bg-white border-indigo-100 hover:border-indigo-300 shadow-sm active:scale-95'}`}
                                            >
                                                <div className="flex justify-between items-center gap-2">
                                                    <span className="font-bold text-slate-700 text-sm truncate">{wb.title}</span>
                                                    {isMounted && <span className="text-[10px] text-slate-400 shrink-0">已挂载</span>}
                                                </div>
                                                <div className="text-[10px] text-slate-400 truncate mt-0.5">{wb.category || '未分类设定 (General)'}</div>
                                            </button>
                                        );
                                    })
                                )}
                                {wbModalSearchResults.total > wbModalSearchResults.books.length && (
                                    <div className="text-center text-[10px] text-slate-400 py-1">
                                        共 {wbModalSearchResults.total} 条匹配，仅显示前 {wbModalSearchResults.books.length} 条，请继续输入缩小范围。
                                    </div>
                                )}
                            </div>
                        ) : (
                            // 默认态：分组手风琴，只渲染展开分组的条目
                            wbModalGroups.map(([category, books]) => {
                                const isExpanded = wbModalExpandedCategory === category;
                                return (
                                    <div key={category} className="rounded-xl border border-slate-100 bg-slate-50/50 overflow-hidden">
                                        <div
                                            onClick={() => setWbModalExpandedCategory(isExpanded ? null : category)}
                                            className="flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none"
                                        >
                                            <span className={`transition-transform duration-200 text-slate-400 ${isExpanded ? 'rotate-90' : ''}`}>
                                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" /></svg>
                                            </span>
                                            <h4 className="flex-1 min-w-0 text-xs font-bold text-slate-500 truncate">{category}</h4>
                                            <span className="text-[10px] text-slate-400 shrink-0">{books.length}</span>
                                            <button
                                                onClick={(e) => { e.stopPropagation(); mountCategory(category); }}
                                                className="text-[10px] bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded font-bold hover:bg-indigo-100 shrink-0"
                                            >
                                                挂载整组
                                            </button>
                                        </div>
                                        {isExpanded && (
                                            <div className="px-2 pb-2 space-y-2">
                                                {books.map(wb => {
                                                    const isMounted = formData?.mountedWorldbooks?.some(m => m.id === wb.id);
                                                    return (
                                                        <button
                                                            key={wb.id}
                                                            onClick={() => !isMounted && mountWorldbook(wb.id)}
                                                            disabled={isMounted}
                                                            className={`w-full p-3 rounded-xl border text-left transition-all ${isMounted ? 'bg-slate-50 border-slate-200 opacity-50 cursor-not-allowed' : 'bg-white border-indigo-100 hover:border-indigo-300 shadow-sm active:scale-95'}`}
                                                        >
                                                            <div className="flex justify-between items-center gap-2">
                                                                <span className="font-bold text-slate-700 text-sm truncate">{wb.title}</span>
                                                                {isMounted && <span className="text-[10px] text-slate-400 shrink-0">已挂载</span>}
                                                            </div>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                );
                            })
                        )}
                    </>
                )}
            </div>
        </Modal>

        {/* 角色分组管理 */}
        <Modal isOpen={showGroupModal} title="角色分组管理" onClose={() => { setShowGroupModal(false); setNewGroupName(''); }}>
            <div className="space-y-3">
                <div className="flex gap-2">
                    <input
                        value={newGroupName}
                        onChange={e => setNewGroupName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') handleAddGroup(); }}
                        placeholder="新分组名称"
                        className="flex-1 px-4 py-2.5 bg-slate-100 rounded-xl text-sm text-slate-700 outline-none focus:ring-2 focus:ring-primary/20"
                    />
                    <button onClick={handleAddGroup} className="px-4 py-2.5 bg-primary text-white text-sm font-bold rounded-xl shadow-sm shadow-primary/30 active:scale-95 transition-transform shrink-0">添加</button>
                </div>
                {characterGroups.length === 0 ? (
                    <div className="text-center text-xs text-slate-400 py-6">还没有分组。建一个试试——角色列表和各处选角色的地方都会按组展示。</div>
                ) : (
                    <div className="space-y-2 max-h-64 overflow-y-auto no-scrollbar">
                        {sortCharacterGroups(characterGroups).map(g => (
                            <div key={g.id} className="flex items-center gap-2 p-2.5 rounded-xl bg-slate-50 border border-slate-100">
                                <input
                                    defaultValue={g.name}
                                    onBlur={e => { const v = e.target.value.trim(); if (v && v !== g.name) renameCharacterGroup(g.id, v); else e.target.value = g.name; }}
                                    onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                                    className="flex-1 min-w-0 bg-transparent text-sm text-slate-700 outline-none border-b border-transparent focus:border-slate-300 py-0.5"
                                />
                                <span className="text-xs text-slate-400 tabular-nums shrink-0">{characters.filter(c => c.groupId === g.id).length} 个角色</span>
                                <button
                                    onClick={() => { deleteCharacterGroup(g.id); addToast(`分组「${g.name}」已删除，组内角色回到未分组`, 'info'); }}
                                    className="p-1.5 rounded-full text-slate-300 hover:bg-red-50 hover:text-red-400 transition-all shrink-0"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                                </button>
                            </div>
                        ))}
                    </div>
                )}
                <p className="text-[10px] text-slate-400 leading-relaxed bg-slate-50 p-2.5 rounded-xl">删除分组不会删除角色，组内角色会回到「未分组」。给角色指派分组：进入角色的「设定」页。</p>
            </div>
        </Modal>

        <Modal
            isOpen={!!deleteConfirmTarget}
            title="断开连接"
            onClose={() => setDeleteConfirmTarget(null)}
            footer={<div className="flex gap-2 w-full"><button onClick={() => setDeleteConfirmTarget(null)} className="flex-1 py-3 bg-slate-100 text-slate-500 rounded-2xl font-bold">保留</button><button onClick={confirmDeleteCharacter} disabled={isDeleting} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl shadow-lg shadow-red-200 disabled:opacity-50">{isDeleting ? '断开中...' : '确认断开'}</button></div>}
        >
            <div className="flex flex-col items-center gap-3 py-4">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-12 h-12 text-slate-300"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" /></svg>
                <p className="text-sm text-slate-600 text-center leading-relaxed">
                    确定要删除与该角色的所有连接吗？<br/>
                    <span className="text-xs text-red-400 font-bold">该操作不可恢复，记忆将被清空。</span><br/>
                    <span className="text-[10px] text-slate-400">仅对 ta 可见的专属表情分类也会一并删除。</span>
                </p>
            </div>
        </Modal>

        {/* 云端 amsg2 任务没清干净时删除会被拦下（不然已删角色的推送之后还会弹出来），
            在这里给出重试或强行放行的选择。 */}
        <Modal
            isOpen={!!cloudCleanupFailTarget}
            title="云端还有任务没清掉"
            onClose={() => setCloudCleanupFailTarget(null)}
            footer={<div className="flex gap-2 w-full">
                <button
                    onClick={() => { if (cloudCleanupFailTarget && !isDeleting) void runDeleteCharacter(cloudCleanupFailTarget); }}
                    disabled={isDeleting}
                    className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-2xl font-bold disabled:opacity-50"
                >{isDeleting ? '重试中...' : '重试'}</button>
                <button
                    onClick={() => { if (cloudCleanupFailTarget && !isDeleting) void runDeleteCharacter(cloudCleanupFailTarget, true); }}
                    disabled={isDeleting}
                    className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl shadow-lg shadow-red-200 disabled:opacity-50"
                >仍然删除</button>
            </div>}
        >
            <p className="text-sm text-slate-600 leading-relaxed py-2">
                ta 名下还有主动消息 2.0 任务没能在云端取消（可能是断网或 Worker 没响应），角色暂时没有删除。<br/>
                <span className="text-xs text-red-400 font-bold">选「仍然删除」的话，残留的任务之后可能仍会到点推送</span>
                <span className="text-xs text-slate-400">——届时可去设置里「清除云端状态」兜底。</span>
            </p>
        </Modal>
    </div>
  );
};
export default Character;
