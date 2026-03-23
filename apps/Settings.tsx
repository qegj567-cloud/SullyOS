
import React, { useState, useRef, useEffect } from 'react';
import { useOS } from '../context/OSContext';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { safeResponseJson } from '../utils/safeApi';
import Modal from '../components/os/Modal';
import ActiveMsgGlobalSettingsModal from '../components/settings/ActiveMsgGlobalSettingsModal';
import { NotionManager, FeishuManager } from '../utils/realtimeContext';
import { XhsMcpClient } from '../utils/xhsMcpClient';
import { Sun, Newspaper, NotePencil, Notebook, Book } from '@phosphor-icons/react';
import { loadPresets, savePresets, getActivePresetId, setActivePresetId, createDefaultPreset, getSystemBlockMetas } from '../utils/promptEngine';
import { PromptPreset, PromptBlock } from '../types';

const Settings: React.FC = () => {
  const {
      apiConfig, updateApiConfig, closeApp, availableModels, setAvailableModels,
      exportSystem, importSystem, addToast, resetSystem,
      apiPresets, addApiPreset, removeApiPreset,
      sysOperation, // Get progress state
      realtimeConfig, updateRealtimeConfig, // 实时感知配置
      embeddingConfig, updateEmbeddingConfig // Embedding API 配置
  } = useOS();
  
  const [localKey, setLocalKey] = useState(apiConfig.apiKey);
  const [localUrl, setLocalUrl] = useState(apiConfig.baseUrl);
  const [localModel, setLocalModel] = useState(apiConfig.model);
  const [localMiniMaxKey, setLocalMiniMaxKey] = useState(apiConfig.minimaxApiKey || '');
  const [localMiniMaxGroupId, setLocalMiniMaxGroupId] = useState(apiConfig.minimaxGroupId || '');
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  
  // Embedding API 本地状态
  const [embUrl, setEmbUrl] = useState(embeddingConfig.baseUrl);
  const [embKey, setEmbKey] = useState(embeddingConfig.apiKey);
  const [embModel, setEmbModel] = useState(embeddingConfig.model);
  const [embDims, setEmbDims] = useState(String(embeddingConfig.dimensions || 1024));
  const [embStatus, setEmbStatus] = useState('');
  const [embUseSameApi, setEmbUseSameApi] = useState(!embeddingConfig.baseUrl);

  // Embedding 动态预设
  const EMBEDDING_PRESETS = [
    { name: '硅基 bge-m3 (免费)', url: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3', dims: 1024, tag: '免费', tagColor: 'bg-emerald-100 text-emerald-600' },
    { name: '硅基 Qwen3-0.6B', url: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3-Embedding-0.6B', dims: 1024, tag: '¥0.01/M', tagColor: 'bg-blue-100 text-blue-600' },
    { name: '硅基 Qwen3-8B', url: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3-Embedding-8B', dims: 1024, tag: '最强', tagColor: 'bg-violet-100 text-violet-600' },
    { name: '阿里百炼 v4', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'text-embedding-v4', dims: 1024, tag: '¥0.5/M', tagColor: 'bg-orange-100 text-orange-600' },
    { name: '豆包', url: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-embedding', dims: 2560, tag: '¥0.5/M', tagColor: 'bg-sky-100 text-sky-600' },
    { name: 'OpenAI small', url: 'https://api.openai.com/v1', model: 'text-embedding-3-small', dims: 1536, tag: '$0.02/M', tagColor: 'bg-slate-100 text-slate-500' },
  ];

  const applyEmbeddingPreset = (preset: typeof EMBEDDING_PRESETS[number]) => {
    setEmbUrl(preset.url);
    setEmbModel(preset.model);
    setEmbDims(String(preset.dims));
    setEmbUseSameApi(false);
  };

  // Prompt 预设状态
  const [promptPresets, setPromptPresets] = useState<PromptPreset[]>(() => loadPresets());
  const [activePresetId, setActivePresetIdLocal] = useState(() => getActivePresetId());
  const [editingPreset, setEditingPreset] = useState<PromptPreset | null>(null);
  const [editingBlockIdx, setEditingBlockIdx] = useState<number | null>(null);
  const [showPromptPresetModal, setShowPromptPresetModal] = useState(false);

  const switchPreset = (id: string) => {
    setActivePresetIdLocal(id);
    setActivePresetId(id);
    addToast?.(`已切换预设: ${promptPresets.find(p => p.id === id)?.name || id}`);
  };

  const duplicatePreset = (source: PromptPreset) => {
    const now = Date.now();
    const newPreset: PromptPreset = {
      ...JSON.parse(JSON.stringify(source)),
      id: `custom_${now}`,
      name: `${source.name} (副本)`,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    };
    const next = [...promptPresets, newPreset];
    setPromptPresets(next);
    savePresets(next);
    setEditingPreset(newPreset);
    setShowPromptPresetModal(true);
  };

  const deletePreset = (id: string) => {
    if (id === 'default') return;
    const next = promptPresets.filter(p => p.id !== id);
    setPromptPresets(next);
    savePresets(next);
    if (activePresetId === id) switchPreset('default');
  };

  const saveEditingPreset = () => {
    if (!editingPreset) return;
    editingPreset.updatedAt = Date.now();
    const next = promptPresets.map(p => p.id === editingPreset.id ? editingPreset : p);
    setPromptPresets(next);
    savePresets(next);
    setEditingBlockIdx(null);
  };

  const moveBlock = (fromIdx: number, toIdx: number) => {
    if (!editingPreset) return;
    const blocks = [...editingPreset.blocks];
    const [moved] = blocks.splice(fromIdx, 1);
    blocks.splice(toIdx, 0, moved);
    setEditingPreset({ ...editingPreset, blocks });
  };

  const addCustomBlock = () => {
    if (!editingPreset) return;
    const newBlock: PromptBlock = {
      id: `custom_${Date.now()}`,
      type: 'custom',
      name: '自定义文本',
      enabled: true,
      content: '在这里写自定义 prompt 文本...\n支持 {{char}} 和 {{user}} 模板变量。',
      icon: '✏️',
      color: 'bg-yellow-100 text-yellow-700',
    };
    setEditingPreset({ ...editingPreset, blocks: [...editingPreset.blocks, newBlock] });
  };

  // UI States
  const [showModelModal, setShowModelModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false); // Used for completion now
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showPresetModal, setShowPresetModal] = useState(false);
  const [showRealtimeModal, setShowRealtimeModal] = useState(false);
  const [showActiveMsgModal, setShowActiveMsgModal] = useState(false);

  // 实时感知配置的本地状态
  const [rtWeatherEnabled, setRtWeatherEnabled] = useState(realtimeConfig.weatherEnabled);
  const [rtWeatherKey, setRtWeatherKey] = useState(realtimeConfig.weatherApiKey);
  const [rtWeatherCity, setRtWeatherCity] = useState(realtimeConfig.weatherCity);
  const [rtNewsEnabled, setRtNewsEnabled] = useState(realtimeConfig.newsEnabled);
  const [rtNewsApiKey, setRtNewsApiKey] = useState(realtimeConfig.newsApiKey || '');
  const [rtNotionEnabled, setRtNotionEnabled] = useState(realtimeConfig.notionEnabled);
  const [rtNotionKey, setRtNotionKey] = useState(realtimeConfig.notionApiKey);
  const [rtNotionDbId, setRtNotionDbId] = useState(realtimeConfig.notionDatabaseId);
  const [rtNotionNotesDbId, setRtNotionNotesDbId] = useState(realtimeConfig.notionNotesDatabaseId || '');
  const [rtFeishuEnabled, setRtFeishuEnabled] = useState(realtimeConfig.feishuEnabled);
  const [rtFeishuAppId, setRtFeishuAppId] = useState(realtimeConfig.feishuAppId);
  const [rtFeishuAppSecret, setRtFeishuAppSecret] = useState(realtimeConfig.feishuAppSecret);
  const [rtFeishuBaseId, setRtFeishuBaseId] = useState(realtimeConfig.feishuBaseId);
  const [rtFeishuTableId, setRtFeishuTableId] = useState(realtimeConfig.feishuTableId);
  const [rtXhsEnabled, setRtXhsEnabled] = useState(realtimeConfig.xhsEnabled);
  const [rtXhsMcpEnabled, setRtXhsMcpEnabled] = useState(realtimeConfig.xhsMcpConfig?.enabled || false);
  const [rtXhsMcpUrl, setRtXhsMcpUrl] = useState(realtimeConfig.xhsMcpConfig?.serverUrl || 'http://localhost:18060/mcp');
  const [rtXhsNickname, setRtXhsNickname] = useState(realtimeConfig.xhsMcpConfig?.loggedInNickname || '');
  const [rtXhsUserId, setRtXhsUserId] = useState(realtimeConfig.xhsMcpConfig?.loggedInUserId || '');
  const [rtTestStatus, setRtTestStatus] = useState('');
  
  // For web download link
  const [downloadUrl, setDownloadUrl] = useState<string>('');
  
  const [statusMsg, setStatusMsg] = useState('');
  const importInputRef = useRef<HTMLInputElement>(null);

  // Auto-save draft configs locally to prevent loss during typing
  useEffect(() => {
      setLocalUrl(apiConfig.baseUrl);
      setLocalKey(apiConfig.apiKey);
      setLocalModel(apiConfig.model);
      setLocalMiniMaxKey(apiConfig.minimaxApiKey || '');
      setLocalMiniMaxGroupId(apiConfig.minimaxGroupId || '');
  }, [apiConfig]);

  const loadPreset = (preset: typeof apiPresets[0]) => {
      setLocalUrl(preset.config.baseUrl);
      setLocalKey(preset.config.apiKey);
      setLocalModel(preset.config.model);
      // MiniMax settings are NOT overwritten by presets — typically one user has
      // only one MiniMax account regardless of which LLM API preset they use.
      addToast(`已加载配置: ${preset.name}`, 'info');
  };

  const handleSavePreset = () => {
      if (!newPresetName.trim()) {
          addToast('请输入预设名称', 'error');
          return;
      }
      addApiPreset(newPresetName, {
        baseUrl: localUrl,
        apiKey: localKey,
        model: localModel,
      });
      setNewPresetName('');
      setShowPresetModal(false);
      addToast('预设已保存', 'success');
  };

  const handleSaveApi = () => {
    updateApiConfig({ 
      apiKey: localKey, 
      minimaxApiKey: localMiniMaxKey,
      minimaxGroupId: localMiniMaxGroupId,
      baseUrl: localUrl, 
      model: localModel
    });
    setStatusMsg('配置已保存');
    setTimeout(() => setStatusMsg(''), 2000);
  };

  const handleSaveEmbeddingConfig = () => {
    if (embUseSameApi) {
      updateEmbeddingConfig({ baseUrl: '', apiKey: '', model: 'text-embedding-3-small', dimensions: 1024 });
      setEmbStatus('已设为使用主 API（自动回退）');
    } else {
      updateEmbeddingConfig({ baseUrl: embUrl, apiKey: embKey, model: embModel, dimensions: Number(embDims) || 1024 });
      setEmbStatus('Embedding 配置已保存');
    }
    setTimeout(() => setEmbStatus(''), 2000);
  };

  const testEmbeddingApi = async () => {
    const baseUrl = embUseSameApi ? apiConfig.baseUrl : embUrl;
    const apiKey = embUseSameApi ? apiConfig.apiKey : embKey;
    const model = embUseSameApi ? 'text-embedding-3-small' : embModel;
    if (!baseUrl || !apiKey) { setEmbStatus('请先填写 URL 和 Key'); return; }
    setEmbStatus('测试中...');
    try {
      const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input: ['测试向量化'], dimensions: Number(embDims) || 1024 }),
      });
      if (!resp.ok) { const d = await safeResponseJson(resp); throw new Error(d?.error?.message || `HTTP ${resp.status}`); }
      const data = await safeResponseJson(resp);
      const dim = data?.data?.[0]?.embedding?.length || 0;
      setEmbStatus(`成功! 维度=${dim}`);
    } catch (e: any) {
      setEmbStatus(`失败: ${e.message?.slice(0, 60)}`);
    }
  };

  const fetchModels = async () => {
    if (!localUrl) { setStatusMsg('请先填写 URL'); return; }
    setIsLoadingModels(true);
    setStatusMsg('正在连接...');
    try {
        const baseUrl = localUrl.replace(/\/+$/, '');
        const response = await fetch(`${baseUrl}/models`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${localKey}`, 'Content-Type': 'application/json' }
        });
        if (!response.ok) throw new Error(`Status ${response.status}`);
        const data = await safeResponseJson(response);
        // Support various API response formats
        const list = data.data || data.models || [];
        if (Array.isArray(list)) {
            const models = list.map((m: any) => m.id || m);
            setAvailableModels(models);
            if (models.length > 0 && !models.includes(localModel)) setLocalModel(models[0]);
            setStatusMsg(`获取到 ${models.length} 个模型`);
            setShowModelModal(true); // Open selector immediately
        } else { setStatusMsg('格式不兼容'); }
    } catch (error: any) {
        console.error(error);
        setStatusMsg('连接失败');
    } finally {
        setIsLoadingModels(false);
    }
  };

  const handleExport = async (mode: 'text_only' | 'media_only' | 'full') => {
      try {
          // Trigger export (Context handles loading state UI)
          const blob = await exportSystem(mode);
          
          if (Capacitor.isNativePlatform()) {
              // Convert Blob to Base64 for Native Write
              const reader = new FileReader();
              reader.readAsDataURL(blob);
              reader.onloadend = async () => {
                  const base64data = String(reader.result);
                  const fileName = `Sully_Backup_${mode}_${Date.now()}.zip`;
                  
                  try {
                      await Filesystem.writeFile({
                          path: fileName,
                          data: base64data, // Filesystem accepts data urls? Or need strip prefix
                          directory: Directory.Cache,
                      });
                      const uriResult = await Filesystem.getUri({
                          directory: Directory.Cache,
                          path: fileName,
                      });
                      await Share.share({
                          title: `Sully Backup`,
                          files: [uriResult.uri],
                      });
                  } catch (e) {
                      console.error("Native write failed", e);
                      addToast("保存文件失败", "error");
                  }
              };
          } else {
              // Web Download
              const url = URL.createObjectURL(blob);
              setDownloadUrl(url);
              setShowExportModal(true);
              
              // Auto click
              const a = document.createElement('a');
              a.href = url;
              a.download = `Sully_Backup_${mode}_${new Date().toISOString().slice(0,10)}.zip`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
          }
      } catch (e: any) {
          addToast(e.message, 'error');
      }
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // Pass the File object directly to importSystem
      importSystem(file).catch(err => {
          console.error(err);
          addToast(err.message || '恢复失败', 'error');
      });
      
      if (importInputRef.current) importInputRef.current.value = '';
  };

  const confirmReset = () => {
      resetSystem();
      setShowResetConfirm(false);
  };

  // 保存实时感知配置
  const handleSaveRealtimeConfig = () => {
      updateRealtimeConfig({
          weatherEnabled: rtWeatherEnabled,
          weatherApiKey: rtWeatherKey,
          weatherCity: rtWeatherCity,
          newsEnabled: rtNewsEnabled,
          newsApiKey: rtNewsApiKey,
          notionEnabled: rtNotionEnabled,
          notionApiKey: rtNotionKey,
          notionDatabaseId: rtNotionDbId,
          notionNotesDatabaseId: rtNotionNotesDbId || undefined,
          feishuEnabled: rtFeishuEnabled,
          feishuAppId: rtFeishuAppId,
          feishuAppSecret: rtFeishuAppSecret,
          feishuBaseId: rtFeishuBaseId,
          feishuTableId: rtFeishuTableId,
          xhsEnabled: rtXhsEnabled,
          xhsMcpConfig: {
              enabled: rtXhsMcpEnabled,
              serverUrl: rtXhsMcpUrl,
              loggedInNickname: rtXhsNickname || undefined,
              loggedInUserId: rtXhsUserId || undefined,
              userXsecToken: realtimeConfig.xhsMcpConfig?.userXsecToken, // 保留自动获取的 token
          }
      });
      addToast('实时感知配置已保存', 'success');
      setShowRealtimeModal(false);
  };

  // 测试天气API连接
  const testWeatherApi = async () => {
      if (!rtWeatherKey) {
          setRtTestStatus('请先填写 API Key');
          return;
      }
      setRtTestStatus('正在测试...');
      try {
          const url = `https://api.openweathermap.org/data/2.5/weather?q=${rtWeatherCity}&appid=${rtWeatherKey}&units=metric&lang=zh_cn`;
          const res = await fetch(url);
          if (res.ok) {
              const data = await safeResponseJson(res);
              setRtTestStatus(`连接成功！${data.name}: ${data.weather[0]?.description}, ${Math.round(data.main.temp)}°C`);
          } else {
              setRtTestStatus(`连接失败: HTTP ${res.status}`);
          }
      } catch (e: any) {
          setRtTestStatus(`网络错误: ${e.message}`);
      }
  };

  // 测试Notion连接
  const testNotionApi = async () => {
      if (!rtNotionKey || !rtNotionDbId) {
          setRtTestStatus('请填写 Notion API Key 和 Database ID');
          return;
      }
      setRtTestStatus('正在测试 Notion 连接...');
      try {
          const result = await NotionManager.testConnection(rtNotionKey, rtNotionDbId);
          setRtTestStatus(result.message);
      } catch (e: any) {
          setRtTestStatus(`网络错误: ${e.message}`);
      }
  };

  // 测试飞书连接
  const testFeishuApi = async () => {
      if (!rtFeishuAppId || !rtFeishuAppSecret || !rtFeishuBaseId || !rtFeishuTableId) {
          setRtTestStatus('请填写飞书 App ID、App Secret、多维表格 ID 和数据表 ID');
          return;
      }
      setRtTestStatus('正在测试飞书连接...');
      try {
          const result = await FeishuManager.testConnection(rtFeishuAppId, rtFeishuAppSecret, rtFeishuBaseId, rtFeishuTableId);
          setRtTestStatus(result.message);
      } catch (e: any) {
          setRtTestStatus(`网络错误: ${e.message}`);
      }
  };

  // 测试小红书 Bridge 连接
  const testXhsMcp = async () => {
      if (!rtXhsMcpUrl) {
          setRtTestStatus('请填写 Bridge Server URL');
          return;
      }
      setRtTestStatus('正在连接 MCP Server...');
      try {
          const result = await XhsMcpClient.testConnection(rtXhsMcpUrl);
          if (result.connected) {
              const toolCount = result.tools?.length || 0;
              const tokenInfo = result.xsecToken ? ' | xsecToken 已获取' : '';
              const loginInfo = result.loggedIn
                  ? ` | ${result.nickname ? `账号: ${result.nickname}` : '已登录'}${result.userId ? ` (ID: ${result.userId})` : ''}${tokenInfo}`
                  : ' | 未登录，请先在浏览器中登录小红书';
              setRtTestStatus(`连接成功! ${toolCount} 个功能可用${loginInfo}`);
              // 自动填充：只在用户未手动填写时覆盖
              if (result.nickname && !rtXhsNickname) setRtXhsNickname(result.nickname);
              if (result.userId && !rtXhsUserId) setRtXhsUserId(result.userId);
              updateRealtimeConfig({
                  xhsMcpConfig: {
                      enabled: rtXhsMcpEnabled,
                      serverUrl: rtXhsMcpUrl,
                      loggedInNickname: rtXhsNickname || result.nickname,
                      loggedInUserId: rtXhsUserId || result.userId,
                      userXsecToken: result.xsecToken,
                  }
              });
          } else {
              setRtTestStatus(`连接失败: ${result.error}`);
          }
      } catch (e: any) {
          setRtTestStatus(`网络错误: ${e.message}`);
      }
  };

  return (
    <div className="h-full w-full bg-slate-50/50 flex flex-col font-light relative">

      {/* GLOBAL PROGRESS OVERLAY */}
      {sysOperation.status === 'processing' && (
          <div className="absolute inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center animate-fade-in">
              <div className="bg-white p-6 rounded-3xl shadow-2xl flex flex-col items-center gap-4 w-64">
                  <div className="w-12 h-12 border-4 border-slate-200 border-t-primary rounded-full animate-spin"></div>
                  <div className="text-sm font-bold text-slate-700">{sysOperation.message}</div>
                  {sysOperation.progress > 0 && (
                      <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                          <div className="h-full bg-primary transition-all duration-300" style={{ width: `${sysOperation.progress}%` }}></div>
                      </div>
                  )}
              </div>
          </div>
      )}

      {/* Header */}
      <div className="h-20 bg-white/70 backdrop-blur-md flex items-end pb-3 px-4 border-b border-white/40 shrink-0 z-10 sticky top-0">
        <div className="flex items-center gap-2 w-full">
            <button onClick={closeApp} className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                </svg>
            </button>
            <h1 className="text-xl font-medium text-slate-700 tracking-wide">系统设置</h1>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-6 no-scrollbar pb-20">
        
        {/* 数据备份区域 */}
        <section className="bg-white/60 backdrop-blur-sm rounded-3xl p-5 shadow-sm border border-white/50">
            <div className="flex items-center gap-2 mb-4">
                <div className="p-2 bg-blue-100 rounded-xl text-blue-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" /></svg>
                </div>
                <h2 className="text-sm font-semibold text-slate-600 tracking-wider">备份与恢复 (ZIP)</h2>
            </div>
            
            <div className="mb-3">
                <button onClick={() => handleExport('full')} className="w-full py-4 bg-gradient-to-r from-violet-500 to-purple-600 border border-violet-300 rounded-xl text-xs font-bold text-white shadow-sm active:scale-95 transition-all flex flex-col items-center gap-2 relative overflow-hidden mb-3">
                    <div className="absolute top-0 right-0 px-1.5 py-0.5 bg-white/20 text-[9px] text-white rounded-bl-lg font-bold">完整</div>
                    <div className="p-2 bg-white/20 rounded-full"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0-3-3m3 3 3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg></div>
                    <span>整合导出 (文字+媒体)</span>
                </button>
            </div>

            <p className="text-[10px] text-slate-400 px-1 mb-3 text-center">以下为分步导出，适合低配设备分次备份</p>

            <div className="grid grid-cols-2 gap-3 mb-3">
                <button onClick={() => handleExport('text_only')} className="py-4 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600 shadow-sm active:scale-95 transition-all flex flex-col items-center gap-2 relative overflow-hidden">
                    <div className="p-2 bg-blue-50 rounded-full text-blue-500"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg></div>
                    <span>纯文字备份</span>
                </button>
                 <button onClick={() => handleExport('media_only')} className="py-4 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600 shadow-sm active:scale-95 transition-all flex flex-col items-center gap-2">
                    <div className="p-2 bg-pink-50 rounded-full text-pink-500"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" /></svg></div>
                    <span>媒体与美化素材</span>
                </button>
            </div>

            <div className="grid grid-cols-1 gap-3 mb-4">
                 <div onClick={() => importInputRef.current?.click()} className="py-4 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600 shadow-sm active:scale-95 transition-all flex flex-col items-center gap-2 cursor-pointer hover:bg-emerald-50 hover:border-emerald-200">
                    <div className="p-2 bg-emerald-100 rounded-full text-emerald-600"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg></div>
                    <span>导入备份 (.zip / .json)</span>
                </div>
                <input type="file" ref={importInputRef} className="hidden" accept=".json,.zip" onChange={handleImport} />
            </div>
            
            <p className="text-[10px] text-slate-400 px-1 mb-4 leading-relaxed">
                • <b>整合导出</b>: 一次性导出所有数据（文字+媒体），适合设备性能充足的用户。<br/>
                • <b>纯文字备份</b>: 包含所有聊天记录、角色设定、剧情数据。所有图片会被移除（减小体积）。<br/>
                • <b>媒体与美化素材</b>: 导出相册、表情包、聊天图片、头像、主题气泡、壁纸、图标等图片资源和外观配置。<br/>
                • 兼容旧版 JSON 备份文件的导入。
            </p>
            
            <button onClick={() => setShowResetConfirm(true)} className="w-full py-3 bg-red-50 border border-red-100 text-red-500 rounded-xl text-xs font-bold flex items-center justify-center gap-2">
                格式化系统 (出厂设置)
            </button>
        </section>

        {/* AI 连接设置区域 */}
        <section className="bg-white/60 backdrop-blur-sm rounded-3xl p-5 shadow-sm border border-white/50">
             <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                    <div className="p-2 bg-emerald-100/50 rounded-xl text-emerald-600">
                       <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
                        </svg>
                    </div>
                    <h2 className="text-sm font-semibold text-slate-600 tracking-wider">API 配置</h2>
                </div>
                <button onClick={() => setShowPresetModal(true)} className="text-[10px] bg-slate-100 text-slate-600 px-3 py-1.5 rounded-full font-bold shadow-sm active:scale-95 transition-transform">
                    保存为预设
                </button>
            </div>

            {/* Presets List */}
            {apiPresets.length > 0 && (
                <div className="mb-4">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block pl-1">我的预设 (Presets)</label>
                    <div className="flex gap-2 flex-wrap">
                        {apiPresets.map(preset => (
                            <div key={preset.id} className="flex items-center bg-white border border-slate-200 rounded-lg pl-3 pr-1 py-1 shadow-sm">
                                <span onClick={() => loadPreset(preset)} className="text-xs font-medium text-slate-600 cursor-pointer hover:text-primary mr-2">{preset.name}</span>
                                <button onClick={() => removeApiPreset(preset.id)} className="p-1 rounded-full text-slate-300 hover:bg-red-50 hover:text-red-400 transition-colors">
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            )}
            
            <div className="space-y-4">
                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">URL</label>
                    <input type="text" value={localUrl} onChange={(e) => setLocalUrl(e.target.value)} placeholder="https://..." className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                </div>

                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">Key</label>
                    <input type="password" value={localKey} onChange={(e) => setLocalKey(e.target.value)} placeholder="sk-..." className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                </div>

                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">MiniMax Key (可选)</label>
                    <input type="password" value={localMiniMaxKey} onChange={(e) => setLocalMiniMaxKey(e.target.value)} placeholder="MiniMax API Secret（留空则复用 Key）" className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">电话 / 音色查询优先使用这个 Key，空着时回退通用 Key。</p>
                </div>

                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">MiniMax Group ID (可选)</label>
                    <input type="text" value={localMiniMaxGroupId} onChange={(e) => setLocalMiniMaxGroupId(e.target.value)} placeholder="group_id（部分账号/模型需要）" className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">如控制台给了 group_id，请填这里；会透传到 TTS 请求体和代理日志。</p>
                </div>

                <div className="pt-2">
                     <div className="flex justify-between items-center mb-1.5 pl-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Model</label>
                        <button onClick={fetchModels} disabled={isLoadingModels} className="text-[10px] text-primary font-bold">{isLoadingModels ? 'Fetching...' : '刷新模型列表'}</button>
                    </div>
                    
                    <button 
                        onClick={() => setShowModelModal(true)}
                        className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-3 text-sm text-slate-700 flex justify-between items-center active:bg-white transition-all shadow-sm"
                    >
                        <span className="truncate font-mono">{localModel || 'Select Model...'}</span>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-slate-400"><path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" /></svg>
                    </button>
                </div>
                
                <button onClick={handleSaveApi} className="w-full py-3 rounded-2xl font-bold text-white shadow-lg shadow-primary/20 bg-primary active:scale-95 transition-all mt-2">
                    {statusMsg || '保存配置'}
                </button>
            </div>
        </section>

        {/* ====== Prompt 动态预设 ====== */}
        <section className="bg-white/60 backdrop-blur-sm rounded-3xl p-5 shadow-sm border border-white/50">
            <div className="flex items-center gap-2 mb-4">
                <div className="p-2 bg-violet-100/60 rounded-xl text-violet-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                    </svg>
                </div>
                <h2 className="text-sm font-semibold text-slate-600 tracking-wider">Prompt 预设</h2>
            </div>

            <p className="text-xs text-slate-500 mb-3 leading-relaxed">
                控制发送给 AI 的 System Prompt 结构。选择预设模板，或复制后自定义编辑。
            </p>

            {/* 预设选择 */}
            <div className="flex gap-2 flex-wrap mb-3">
                {promptPresets.map(p => (
                    <button key={p.id} onClick={() => switchPreset(p.id)}
                        className={`px-3 py-2 rounded-xl text-xs font-bold border transition-all active:scale-95 ${
                            activePresetId === p.id
                                ? 'bg-violet-500 text-white border-violet-500 shadow-md'
                                : 'bg-white border-slate-200 text-slate-600 hover:border-violet-300'
                        }`}>
                        {p.name}
                        {p.isDefault && <span className="ml-1 text-[8px] opacity-60">(内置)</span>}
                    </button>
                ))}
            </div>

            {/* 操作按钮 */}
            <div className="flex gap-2 mb-3">
                <button onClick={() => {
                    const active = promptPresets.find(p => p.id === activePresetId);
                    if (active) duplicatePreset(active);
                }} className="px-3 py-1.5 bg-violet-50 text-violet-600 rounded-lg text-[10px] font-bold hover:bg-violet-100 transition-colors">
                    复制当前预设
                </button>
                <button onClick={() => {
                    const active = promptPresets.find(p => p.id === activePresetId);
                    if (active) { setEditingPreset(JSON.parse(JSON.stringify(active))); setShowPromptPresetModal(true); }
                }} className="px-3 py-1.5 bg-slate-50 text-slate-600 rounded-lg text-[10px] font-bold hover:bg-slate-100 transition-colors">
                    编辑预设
                </button>
                {activePresetId !== 'default' && (
                    <button onClick={() => { if (confirm('确定删除该预设？')) deletePreset(activePresetId); }}
                        className="px-3 py-1.5 bg-red-50 text-red-500 rounded-lg text-[10px] font-bold hover:bg-red-100 transition-colors">
                        删除
                    </button>
                )}
            </div>

            {/* 当前预设的 block 预览 */}
            <div className="bg-slate-50/60 rounded-xl p-3">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">Block 列表预览</label>
                <div className="flex flex-wrap gap-1">
                    {(promptPresets.find(p => p.id === activePresetId)?.blocks || []).map(b => (
                        <span key={b.id} className={`px-2 py-0.5 rounded-md text-[9px] font-bold ${b.enabled ? (b.color || 'bg-slate-100 text-slate-600') : 'bg-gray-100 text-gray-400 line-through'}`}>
                            {b.icon} {b.name}
                        </span>
                    ))}
                </div>
            </div>
        </section>

        {/* ====== Prompt 预设编辑 Modal ====== */}
        {showPromptPresetModal && editingPreset && (
            <Modal title={`编辑预设: ${editingPreset.name}`} onClose={() => { saveEditingPreset(); setShowPromptPresetModal(false); setEditingPreset(null); }} size="large">
                <div className="space-y-3">
                    {/* 预设名称 */}
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 block">预设名称</label>
                        <input value={editingPreset.name} onChange={e => setEditingPreset({ ...editingPreset, name: e.target.value })}
                            className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm" />
                    </div>

                    {/* Block 列表（可拖拽排序） */}
                    <div>
                        <div className="flex items-center justify-between mb-2">
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Block 列表 (拖拽排序)</label>
                            <button onClick={addCustomBlock}
                                className="px-2 py-1 bg-yellow-50 text-yellow-700 rounded-lg text-[10px] font-bold hover:bg-yellow-100">
                                + 自定义 Block
                            </button>
                        </div>

                        <div className="space-y-1.5 max-h-[50vh] overflow-y-auto">
                            {editingPreset.blocks.map((block, idx) => (
                                <div key={block.id}
                                    draggable
                                    onDragStart={e => e.dataTransfer.setData('blockIdx', String(idx))}
                                    onDragOver={e => e.preventDefault()}
                                    onDrop={e => { const from = parseInt(e.dataTransfer.getData('blockIdx')); moveBlock(from, idx); }}
                                    className={`flex items-center gap-2 p-2.5 rounded-xl border transition-all cursor-grab active:cursor-grabbing ${
                                        editingBlockIdx === idx ? 'border-violet-400 bg-violet-50/50' : 'border-slate-200 bg-white hover:border-slate-300'
                                    } ${!block.enabled ? 'opacity-40' : ''}`}>

                                    {/* 拖拽手柄 */}
                                    <span className="text-slate-300 text-xs select-none">⋮⋮</span>

                                    {/* 开关 */}
                                    <button onClick={() => {
                                        const blocks = [...editingPreset.blocks];
                                        blocks[idx] = { ...blocks[idx], enabled: !blocks[idx].enabled };
                                        setEditingPreset({ ...editingPreset, blocks });
                                    }} className={`w-8 h-4 rounded-full transition-colors relative flex-shrink-0 ${block.enabled ? 'bg-violet-500' : 'bg-slate-300'}`}>
                                        <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full shadow transition-transform ${block.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                    </button>

                                    {/* 名称 + badge */}
                                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${block.color || 'bg-slate-100 text-slate-600'}`}>
                                        {block.icon} {block.name}
                                    </span>
                                    <span className="text-[9px] text-slate-400 flex-1 truncate">{block.type === 'system' ? '系统' : '自定义'}</span>

                                    {/* 编辑按钮（system block 可 override, custom block 可编辑） */}
                                    <button onClick={() => setEditingBlockIdx(editingBlockIdx === idx ? null : idx)}
                                        className="px-1.5 py-0.5 text-[9px] text-slate-400 hover:text-violet-500">
                                        {editingBlockIdx === idx ? '收起' : '编辑'}
                                    </button>

                                    {/* 删除（仅 custom block） */}
                                    {block.type === 'custom' && (
                                        <button onClick={() => {
                                            const blocks = editingPreset.blocks.filter((_, i) => i !== idx);
                                            setEditingPreset({ ...editingPreset, blocks });
                                            if (editingBlockIdx === idx) setEditingBlockIdx(null);
                                        }} className="px-1.5 py-0.5 text-[9px] text-red-400 hover:text-red-600">
                                            删除
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>

                        {/* 展开的编辑区 */}
                        {editingBlockIdx !== null && editingPreset.blocks[editingBlockIdx] && (
                            <div className="mt-3 p-3 bg-slate-50 rounded-xl border border-slate-200">
                                <div className="flex items-center justify-between mb-2">
                                    <label className="text-xs font-bold text-slate-600">
                                        {editingPreset.blocks[editingBlockIdx].icon} {editingPreset.blocks[editingBlockIdx].name}
                                        {editingPreset.blocks[editingBlockIdx].type === 'system' && (
                                            <span className="text-[9px] text-slate-400 font-normal ml-2">
                                                (留空 = 使用系统默认生成逻辑，填写内容 = 覆盖默认)
                                            </span>
                                        )}
                                    </label>
                                </div>
                                {editingPreset.blocks[editingBlockIdx].type === 'custom' && (
                                    <input value={editingPreset.blocks[editingBlockIdx].name}
                                        onChange={e => {
                                            const blocks = [...editingPreset.blocks];
                                            blocks[editingBlockIdx!] = { ...blocks[editingBlockIdx!], name: e.target.value };
                                            setEditingPreset({ ...editingPreset, blocks });
                                        }}
                                        className="w-full px-2 py-1 mb-2 bg-white border border-slate-200 rounded-lg text-xs"
                                        placeholder="Block 名称" />
                                )}
                                <textarea
                                    value={editingPreset.blocks[editingBlockIdx].content || ''}
                                    onChange={e => {
                                        const blocks = [...editingPreset.blocks];
                                        blocks[editingBlockIdx!] = { ...blocks[editingBlockIdx!], content: e.target.value };
                                        setEditingPreset({ ...editingPreset, blocks });
                                    }}
                                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-mono min-h-[120px] resize-y"
                                    placeholder={editingPreset.blocks[editingBlockIdx].type === 'system'
                                        ? '留空 = 使用系统默认生成。填入内容将覆盖默认。\n支持: {{char}} {{user}} 模板变量'
                                        : '输入自定义 prompt 文本...\n支持: {{char}} {{user}} 模板变量'
                                    }
                                />
                            </div>
                        )}
                    </div>

                    {/* 保存 */}
                    <div className="flex justify-end gap-2 pt-2">
                        <button onClick={() => { setShowPromptPresetModal(false); setEditingPreset(null); setEditingBlockIdx(null); }}
                            className="px-4 py-2 text-xs text-slate-500 hover:text-slate-700">取消</button>
                        <button onClick={() => { saveEditingPreset(); setShowPromptPresetModal(false); setEditingPreset(null); }}
                            className="px-4 py-2 bg-violet-500 text-white text-xs font-bold rounded-xl hover:bg-violet-600 transition-colors">
                            保存预设
                        </button>
                    </div>
                </div>
            </Modal>
        )}

        {/* 记忆宫殿 Embedding API 配置 */}
        <section className="bg-white/60 backdrop-blur-sm rounded-3xl p-5 shadow-sm border border-white/50">
            <div className="flex items-center gap-2 mb-4">
                <div className="p-2 bg-amber-100/60 rounded-xl text-amber-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25a2.25 2.25 0 0 1-2.25-2.25v-2.25Z" />
                    </svg>
                </div>
                <h2 className="text-sm font-semibold text-slate-600 tracking-wider">记忆宫殿 (Embedding)</h2>
            </div>

            <p className="text-xs text-slate-500 mb-3 leading-relaxed">
                记忆宫殿需要 Embedding API 来将记忆向量化。支持任何 OpenAI 兼容接口。
            </p>

            {/* 动态预设 */}
            <div className="mb-4">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block pl-1">一键预设 (填入 URL + Model，Key 需自己填)</label>
                <div className="flex gap-1.5 flex-wrap">
                    {EMBEDDING_PRESETS.map(p => (
                        <button key={p.model} onClick={() => applyEmbeddingPreset(p)}
                            className={`px-2.5 py-1.5 rounded-lg text-[10px] font-bold border transition-all active:scale-95 ${embModel === p.model && embUrl === p.url ? 'bg-amber-500 text-white border-amber-500' : 'bg-white border-slate-200 text-slate-600 hover:border-amber-300'}`}>
                            {p.name}
                            <span className={`ml-1 px-1 py-0.5 rounded text-[8px] ${embModel === p.model && embUrl === p.url ? 'bg-white/20 text-white' : p.tagColor}`}>{p.tag}</span>
                        </button>
                    ))}
                </div>
            </div>

            <div className="flex items-center gap-3 mb-4 p-3 bg-amber-50/80 rounded-xl">
                <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" checked={embUseSameApi} onChange={e => { setEmbUseSameApi(e.target.checked); }} className="sr-only peer" />
                    <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-amber-500"></div>
                </label>
                <span className="text-xs text-slate-600 font-medium">使用与主 API 相同的地址和 Key</span>
            </div>

            {!embUseSameApi && (
                <div className="space-y-3 mb-4">
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">Embedding URL</label>
                        <input type="text" value={embUrl} onChange={e => setEmbUrl(e.target.value)} placeholder="https://api.siliconflow.cn/v1" className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">Embedding Key</label>
                        <input type="password" value={embKey} onChange={e => setEmbKey(e.target.value)} placeholder="sk-..." className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">Embedding Model</label>
                        <input type="text" value={embModel} onChange={e => setEmbModel(e.target.value)} placeholder="BAAI/bge-m3 (硅基免费)" className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">维度 (Dimensions)</label>
                        <input type="number" value={embDims} onChange={e => setEmbDims(e.target.value)} placeholder="1024" className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                    </div>
                </div>
            )}

            <p className="text-[10px] text-slate-400 mb-3 px-1 leading-relaxed">
                硅基流动新用户送 14 元额度，bge-m3 免费无限用（有限速）。阿里百炼批量模式 5 折。
            </p>

            <div className="flex gap-2">
                <button onClick={testEmbeddingApi} className="flex-1 py-2.5 bg-amber-50 border border-amber-200 text-amber-700 rounded-xl text-xs font-bold active:scale-95 transition-transform">
                    测试连接
                </button>
                <button onClick={handleSaveEmbeddingConfig} className="flex-1 py-2.5 bg-amber-500 text-white rounded-xl text-xs font-bold shadow-lg shadow-amber-500/20 active:scale-95 transition-transform">
                    {embStatus || '保存'}
                </button>
            </div>
        </section>

        {/* 实时感知配置区域 */}
        <section className="bg-white/60 backdrop-blur-sm rounded-3xl p-5 shadow-sm border border-white/50">
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                    <div className="p-2 bg-violet-100/50 rounded-xl text-violet-600">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 0 1 3 12c0-1.605.42-3.113 1.157-4.418" />
                        </svg>
                    </div>
                    <h2 className="text-sm font-semibold text-slate-600 tracking-wider">实时感知</h2>
                </div>
                <button onClick={() => setShowRealtimeModal(true)} className="text-[10px] bg-violet-100 text-violet-600 px-3 py-1.5 rounded-full font-bold shadow-sm active:scale-95 transition-transform">
                    配置
                </button>
            </div>

            <p className="text-xs text-slate-500 mb-3 leading-relaxed">
                让AI角色感知真实世界：天气、新闻热点、当前时间。角色可以根据天气关心你、聊聊最近的热点话题。
            </p>

            <div className="grid grid-cols-5 gap-2 text-center">
                <div className={`py-3 rounded-xl text-xs font-bold ${rtWeatherEnabled ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-50 text-slate-400'}`}>
                    <div className="text-lg mb-1">{rtWeatherEnabled ? <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/2600.png" className="w-5 h-5 inline" alt="" /> : <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f32b.png" className="w-5 h-5 inline" alt="" />}</div>
                    天气
                </div>
                <div className={`py-3 rounded-xl text-xs font-bold ${rtNewsEnabled ? 'bg-blue-50 text-blue-600' : 'bg-slate-50 text-slate-400'}`}>
                    <div className="text-lg mb-1">{rtNewsEnabled ? <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4f0.png" className="w-5 h-5 inline" alt="" /> : <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4c4.png" className="w-5 h-5 inline" alt="" />}</div>
                    新闻
                </div>
                <div className={`py-3 rounded-xl text-xs font-bold ${rtNotionEnabled ? 'bg-orange-50 text-orange-600' : 'bg-slate-50 text-slate-400'}`}>
                    <div className="text-lg mb-1">{rtNotionEnabled ? <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4dd.png" className="w-5 h-5 inline" alt="" /> : <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4cb.png" className="w-5 h-5 inline" alt="" />}</div>
                    Notion
                </div>
                <div className={`py-3 rounded-xl text-xs font-bold ${rtFeishuEnabled ? 'bg-indigo-50 text-indigo-600' : 'bg-slate-50 text-slate-400'}`}>
                    <div className="text-lg mb-1">{rtFeishuEnabled ? <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4d2.png" className="w-5 h-5 inline" alt="" /> : <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4cb.png" className="w-5 h-5 inline" alt="" />}</div>
                    飞书
                </div>
                <div className={`py-3 rounded-xl text-xs font-bold ${rtXhsEnabled ? 'bg-red-50 text-red-600' : 'bg-slate-50 text-slate-400'}`}>
                    <div className="text-lg mb-1">{rtXhsEnabled ? <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4d5.png" className="w-5 h-5 inline" alt="" /> : <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4cb.png" className="w-5 h-5 inline" alt="" />}</div>
                    小红书
                </div>
            </div>
        </section>

        <section className="bg-white/60 backdrop-blur-sm rounded-3xl p-5 shadow-sm border border-white/50">
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                    <div className="p-2 bg-fuchsia-100/60 rounded-xl text-fuchsia-600">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 3.75h9A2.25 2.25 0 0 1 18.75 6v12a2.25 2.25 0 0 1-2.25 2.25h-9A2.25 2.25 0 0 1 5.25 18V6A2.25 2.25 0 0 1 7.5 3.75Zm0 0V2.25m9 1.5V2.25M8.25 8.25h7.5m-7.5 3h7.5m-7.5 3h4.5" />
                        </svg>
                    </div>
                    <h2 className="text-sm font-semibold text-slate-600 tracking-wider">主动消息 2.0</h2>
                </div>
                <button onClick={() => setShowActiveMsgModal(true)} className="text-[10px] bg-fuchsia-100 text-fuchsia-600 px-3 py-1.5 rounded-full font-bold shadow-sm active:scale-95 transition-transform">
                    配置
                </button>
            </div>

            <p className="text-xs text-slate-500 mb-3 leading-relaxed">
                新增一套云端调度 + Web Push 的主动消息标准实现。它不会替换掉你现在的本地主动消息，而是在原功能旁边增加一个 2.0 入口。
            </p>

            <button onClick={() => setShowActiveMsgModal(true)} className="w-full py-3 rounded-2xl font-bold text-white shadow-lg bg-fuchsia-500 active:scale-95 transition-all">
                打开主动消息 2.0 设置
            </button>
        </section>

        <div className="text-center text-[10px] text-slate-300 pb-8 font-mono tracking-widest uppercase">
            v2.2 (Realtime Awareness)
        </div>
      </div>

      {/* 模型选择 Modal */}
      <Modal isOpen={showModelModal} title="选择模型" onClose={() => setShowModelModal(false)}>
        <div className="max-h-[50vh] overflow-y-auto no-scrollbar space-y-2 p-1">
            {availableModels.length > 0 ? availableModels.map(m => (
                <button key={m} onClick={() => { setLocalModel(m); setShowModelModal(false); }} className={`w-full text-left px-4 py-3 rounded-xl text-sm font-mono flex justify-between items-center ${m === localModel ? 'bg-primary/10 text-primary font-bold ring-1 ring-primary/20' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'}`}>
                    <span className="truncate">{m}</span>
                    {m === localModel && <div className="w-2 h-2 rounded-full bg-primary"></div>}
                </button>
            )) : <div className="text-center text-slate-400 py-8 text-xs">列表为空，请先点击“刷新模型列表”</div>}
        </div>
      </Modal>

      {/* Preset Name Modal */}
      <Modal isOpen={showPresetModal} title="保存预设" onClose={() => setShowPresetModal(false)} footer={<button onClick={handleSavePreset} className="w-full py-3 bg-primary text-white font-bold rounded-2xl">保存</button>}>
          <div className="space-y-2">
              <label className="text-[10px] font-bold text-slate-400 uppercase">预设名称 (例如: DeepSeek)</label>
              <input value={newPresetName} onChange={e => setNewPresetName(e.target.value)} className="w-full bg-slate-100 rounded-xl px-4 py-3 text-sm focus:outline-primary" autoFocus placeholder="Name..." />
          </div>
      </Modal>

      {/* 强制导出 Modal */}
      <Modal isOpen={showExportModal} title="备份下载" onClose={() => setShowExportModal(false)} footer={
          <div className="flex gap-2 w-full">
               <button onClick={() => setShowExportModal(false)} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl">关闭</button>
          </div>
      }>
          <div className="space-y-4 text-center py-4">
              <div className="w-16 h-16 bg-green-100 text-green-500 rounded-full flex items-center justify-center mx-auto mb-2">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-8 h-8"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>
              </div>
              <p className="text-sm font-bold text-slate-700">备份文件已生成！</p>
              <p className="text-xs text-slate-500">如果浏览器没有自动下载，请点击下方链接。</p>
              {downloadUrl && <a href={downloadUrl} download="Sully_Backup.zip" className="text-primary text-sm underline block py-2">点击手动下载 .zip</a>}
          </div>
      </Modal>

      {/* 实时感知配置 Modal */}
      <Modal
          isOpen={showRealtimeModal}
          title="实时感知配置"
          onClose={() => setShowRealtimeModal(false)}
          footer={<button onClick={handleSaveRealtimeConfig} className="w-full py-3 bg-violet-500 text-white font-bold rounded-2xl shadow-lg">保存配置</button>}
      >
          <div className="space-y-5 max-h-[60vh] overflow-y-auto no-scrollbar">
              {/* 天气配置 */}
              <div className="bg-emerald-50/50 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <Sun size={20} weight="fill" />
                          <span className="text-sm font-bold text-emerald-700">天气感知</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={rtWeatherEnabled} onChange={e => setRtWeatherEnabled(e.target.checked)} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500"></div>
                      </label>
                  </div>
                  {rtWeatherEnabled && (
                      <div className="space-y-2">
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">OpenWeatherMap API Key</label>
                              <input type="password" value={rtWeatherKey} onChange={e => setRtWeatherKey(e.target.value)} className="w-full bg-white/80 border border-emerald-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="获取: openweathermap.org" />
                          </div>
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">城市 (英文)</label>
                              <input type="text" value={rtWeatherCity} onChange={e => setRtWeatherCity(e.target.value)} className="w-full bg-white/80 border border-emerald-200 rounded-xl px-3 py-2 text-sm" placeholder="Beijing, Shanghai, etc." />
                          </div>
                          <button onClick={testWeatherApi} className="w-full py-2 bg-emerald-100 text-emerald-600 text-xs font-bold rounded-xl active:scale-95 transition-transform">测试天气API</button>
                      </div>
                  )}
              </div>

              {/* 新闻配置 */}
              <div className="bg-blue-50/50 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <Newspaper size={20} weight="fill" />
                          <span className="text-sm font-bold text-blue-700">新闻热点</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={rtNewsEnabled} onChange={e => setRtNewsEnabled(e.target.checked)} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
                      </label>
                  </div>
                  {rtNewsEnabled && (
                      <div className="space-y-2">
                          <p className="text-xs text-blue-600/70">默认使用 Hacker News（英文科技新闻）。配置 Brave API 可获取中文新闻。</p>
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Brave Search API Key (推荐)</label>
                              <input type="password" value={rtNewsApiKey} onChange={e => setRtNewsApiKey(e.target.value)} className="w-full bg-white/80 border border-blue-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="获取: brave.com/search/api" />
                          </div>
                          <p className="text-[10px] text-blue-500/70">
                              免费2000次/月，支持中文新闻。<br/>
                              不配置则用 Hacker News（英文科技新闻）。
                          </p>
                      </div>
                  )}
              </div>

              {/* Notion 配置 */}
              <div className="bg-orange-50/50 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <NotePencil size={20} weight="fill" />
                          <span className="text-sm font-bold text-orange-700">Notion 日记</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={rtNotionEnabled} onChange={e => setRtNotionEnabled(e.target.checked)} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-orange-500"></div>
                      </label>
                  </div>
                  {rtNotionEnabled && (
                      <div className="space-y-2">
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Notion Integration Token</label>
                              <input type="password" value={rtNotionKey} onChange={e => setRtNotionKey(e.target.value)} className="w-full bg-white/80 border border-orange-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="secret_..." />
                          </div>
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Database ID</label>
                              <input type="text" value={rtNotionDbId} onChange={e => setRtNotionDbId(e.target.value)} className="w-full bg-white/80 border border-orange-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="从数据库URL复制" />
                          </div>
                          <button onClick={testNotionApi} className="w-full py-2 bg-orange-100 text-orange-600 text-xs font-bold rounded-xl active:scale-95 transition-transform">测试Notion连接</button>
                          <div className="border-t border-orange-200/50 pt-2 mt-2">
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">笔记数据库 ID（可选）</label>
                              <input type="text" value={rtNotionNotesDbId} onChange={e => setRtNotionNotesDbId(e.target.value)} className="w-full bg-white/80 border border-orange-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="用户日常笔记的数据库ID" />
                              <p className="text-[10px] text-orange-500/60 leading-relaxed mt-1">
                                  填写后角色可以偶尔看到你的笔记标题，温馨地提起你写的内容。留空则不启用。
                              </p>
                          </div>
                          <p className="text-[10px] text-orange-500/70 leading-relaxed">
                              1. 在 <a href="https://www.notion.so/my-integrations" target="_blank" className="underline">Notion开发者</a> 创建Integration<br/>
                              2. 创建一个日记数据库，添加"Name"(标题)和"Date"(日期)属性<br/>
                              3. 在数据库右上角菜单中 Connect 你的 Integration
                          </p>
                      </div>
                  )}
              </div>

              {/* 飞书配置 (中国区替代) */}
              <div className="bg-indigo-50/50 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <Notebook size={20} weight="fill" />
                          <span className="text-sm font-bold text-indigo-700">飞书日记</span>
                          <span className="text-[9px] bg-indigo-100 text-indigo-500 px-1.5 py-0.5 rounded-full">中国区</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={rtFeishuEnabled} onChange={e => setRtFeishuEnabled(e.target.checked)} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-500"></div>
                      </label>
                  </div>
                  <p className="text-[10px] text-indigo-500/70 leading-relaxed">
                      Notion 的中国区替代方案，无需翻墙。使用飞书多维表格存储日记。
                  </p>
                  {rtFeishuEnabled && (
                      <div className="space-y-2">
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">飞书 App ID</label>
                              <input type="text" value={rtFeishuAppId} onChange={e => setRtFeishuAppId(e.target.value)} className="w-full bg-white/80 border border-indigo-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="cli_xxxxxxxx" />
                          </div>
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">飞书 App Secret</label>
                              <input type="password" value={rtFeishuAppSecret} onChange={e => setRtFeishuAppSecret(e.target.value)} className="w-full bg-white/80 border border-indigo-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="xxxxxxxxxxxxxxxx" />
                          </div>
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">多维表格 App Token</label>
                              <input type="text" value={rtFeishuBaseId} onChange={e => setRtFeishuBaseId(e.target.value)} className="w-full bg-white/80 border border-indigo-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="从多维表格URL中获取" />
                          </div>
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">数据表 Table ID</label>
                              <input type="text" value={rtFeishuTableId} onChange={e => setRtFeishuTableId(e.target.value)} className="w-full bg-white/80 border border-indigo-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="tblxxxxxxxx" />
                          </div>
                          <button onClick={testFeishuApi} className="w-full py-2 bg-indigo-100 text-indigo-600 text-xs font-bold rounded-xl active:scale-95 transition-transform">测试飞书连接</button>
                          <p className="text-[10px] text-indigo-500/70 leading-relaxed">
                              1. 在 <a href="https://open.feishu.cn/app" target="_blank" className="underline">飞书开放平台</a> 创建企业自建应用，获取 App ID 和 Secret<br/>
                              2. 在应用权限中添加「多维表格」相关权限<br/>
                              3. 创建一个多维表格，添加字段: 标题(文本)、内容(文本)、日期(日期)、心情(文本)、角色(文本)<br/>
                              4. 从多维表格 URL 中获取 App Token 和 Table ID
                          </p>
                      </div>
                  )}
              </div>

              {/* 小红书自动化 */}
              <div className="bg-red-50/50 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <Book size={20} weight="fill" />
                          <span className="text-sm font-bold text-red-700">小红书</span>
                          <span className="text-[9px] bg-red-100 text-red-500 px-1.5 py-0.5 rounded-full">浏览器自动化</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={rtXhsMcpEnabled} onChange={e => { setRtXhsMcpEnabled(e.target.checked); setRtXhsEnabled(e.target.checked); }} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-red-500"></div>
                      </label>
                  </div>
                  <p className="text-[10px] text-red-500/70 leading-relaxed">
                      角色可以搜索、浏览、发帖、评论小红书。支持两种后端，根据 URL 自动切换。
                  </p>
                  {rtXhsMcpEnabled && (
                      <div className="space-y-2">
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">服务器 URL</label>
                              <input value={rtXhsMcpUrl} onChange={e => setRtXhsMcpUrl(e.target.value)} className="w-full bg-white/80 border border-red-200 rounded-xl px-3 py-2 text-[11px] font-mono" placeholder="http://localhost:18060/mcp" />
                          </div>
                          <button onClick={testXhsMcp} className="w-full py-2 bg-red-100 text-red-600 text-xs font-bold rounded-xl active:scale-95 transition-transform">测试连接</button>
                          <div className="grid grid-cols-2 gap-2">
                              <div>
                                  <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">小红书昵称</label>
                                  <input value={rtXhsNickname} onChange={e => setRtXhsNickname(e.target.value)} className="w-full bg-white/80 border border-red-200 rounded-xl px-3 py-2 text-[11px]" placeholder="手动填写" />
                              </div>
                              <div>
                                  <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">用户 ID</label>
                                  <input value={rtXhsUserId} onChange={e => setRtXhsUserId(e.target.value)} className="w-full bg-white/80 border border-red-200 rounded-xl px-3 py-2 text-[11px] font-mono" placeholder="可选，用于查看主页" />
                              </div>
                          </div>
                          <p className="text-[10px] text-red-500/70 leading-relaxed">
                              <b>MCP 模式（默认，推荐）:</b> 下载 xiaohongshu-mcp + 运行脚本即可<br/>
                              URL 填: http://localhost:18060/mcp（通过代理则 18061/mcp）<br/>
                              <br/>
                              <b>Skills 模式（高级）:</b> 额外支持视频发布、长文<br/>
                              URL 填: http://localhost:18061/api<br/>
                              需安装 Python + xiaohongshu-skills + 运行 xhs-bridge.mjs<br/>
                              <br/>
                              系统根据 URL 结尾自动判断模式（/mcp 或 /api）
                          </p>
                      </div>
                  )}
              </div>

              {/* 测试状态 */}
              {rtTestStatus && (
                  <div className={`p-3 rounded-xl text-xs font-medium text-center ${rtTestStatus.includes('成功') ? 'bg-emerald-100 text-emerald-700' : rtTestStatus.includes('失败') || rtTestStatus.includes('错误') ? 'bg-red-100 text-red-600' : 'bg-slate-100 text-slate-600'}`}>
                      {rtTestStatus}
                  </div>
              )}
          </div>
      </Modal>

      {/* 确认重置 Modal */}
      <ActiveMsgGlobalSettingsModal
          isOpen={showActiveMsgModal}
          onClose={() => setShowActiveMsgModal(false)}
          addToast={addToast}
      />

      <Modal
          isOpen={showResetConfirm}
          title="系统警告"
          onClose={() => setShowResetConfirm(false)}
          footer={
              <div className="flex gap-2 w-full">
                  <button onClick={() => setShowResetConfirm(false)} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl">取消</button>
                  <button onClick={confirmReset} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl shadow-lg shadow-red-200">确认格式化</button>
              </div>
          }
      >
          <div className="flex flex-col items-center gap-3 py-2">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-12 h-12 text-red-500"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" /></svg>
              <p className="text-center text-sm text-slate-600 font-medium">
                  这将<span className="text-red-500 font-bold">永久删除</span>所有角色、聊天记录和设置，且无法恢复！
              </p>
          </div>
      </Modal>

    </div>
  );
};

export default Settings;
