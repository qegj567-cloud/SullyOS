
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useOS } from '../context/OSContext';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { safeResponseJson } from '../utils/safeApi';
import Modal from '../components/os/Modal';
import { NotionManager, FeishuManager } from '../utils/realtimeContext';
import { XhsMcpClient } from '../utils/xhsMcpClient';
import { getMcdToken, setMcdToken as saveMcdToken, isMcdEnabled, setMcdEnabled as saveMcdEnabled, testMcdConnection, resetMcdSession } from '../utils/mcdMcpClient';
import { Sun, Newspaper, NotePencil, Notebook, Book, ForkKnife } from '@phosphor-icons/react';
import { loadPushConfig, savePushConfig, registerScheduleOnWorker, startHeartbeat, stopHeartbeat, isPushConfigAvailable, ensureSubscribed, sendTestPush, getPushDiagnostics, resetSubscription, deepResetSubscription, type PushDiagnostics } from '../utils/proactivePushConfig';
import { ProactiveChat } from '../utils/proactiveChat';
import { InstantPushSettingsModal } from '../components/settings/InstantPushSettingsModal';
import { PushVapidSettingsModal } from '../components/settings/PushVapidSettingsModal';
import VersionInfo from '../components/settings/VersionInfo';
import { isPushVapidReady } from '../utils/pushVapid';
import ApiCallLogModal from '../components/settings/ApiCallLogModal';

// hot_news（orz.ai）可选热榜平台。key 必须与 API 的 ?platform= 完全一致。
const HOTNEWS_PLATFORM_OPTIONS: { key: string; label: string }[] = [
    { key: 'weibo', label: '微博' },
    { key: 'zhihu', label: '知乎' },
    { key: 'baidu', label: '百度' },
    { key: 'bilibili', label: 'B站' },
    { key: 'douyin', label: '抖音' },
    { key: 'jinritoutiao', label: '今日头条' },
    { key: 'tieba', label: '贴吧' },
    { key: 'hupu', label: '虎扑' },
    { key: 'douban', label: '豆瓣' },
    { key: 'tskr', label: '36氪' },
    { key: 'juejin', label: '掘金' },
    { key: 'sspai', label: '少数派' },
    { key: 'vtex', label: 'V2EX' },
    { key: 'github', label: 'GitHub' },
    { key: 'hackernews', label: 'Hacker News' },
    { key: 'sina_finance', label: '新浪财经' },
    { key: 'eastmoney', label: '东方财富' },
    { key: 'xueqiu', label: '雪球' },
    { key: 'cls', label: '财联社' },
    { key: 'tenxunwang', label: '腾讯网' },
];

// 「主动消息 Push 加速」面板入口开关。底层逻辑（心跳、订阅、诊断）全部保留，
// 这里设为 false 只是把设置页里的入口隐藏掉，想恢复改回 true 即可。
const SHOW_PROACTIVE_PUSH_ACCEL_UI = false;

const DiagRow: React.FC<{ label: string; value: string; bad?: boolean }> = ({ label, value, bad }) => (
    <div className="flex items-start justify-between gap-3">
        <span className="text-slate-500 shrink-0">{label}</span>
        <span className={`text-right ${bad ? 'text-rose-600 font-medium' : 'text-slate-700'}`}>{value}</span>
    </div>
);

const Settings: React.FC = () => {
  const {
      apiConfig, updateApiConfig, closeApp, availableModels, setAvailableModels,
      exportSystem, importSystem, addToast, showError, resetSystem,
      apiPresets, addApiPreset, removeApiPreset,
      sysOperation, // Get progress state
      realtimeConfig, updateRealtimeConfig, // 实时感知配置
      cloudBackupConfig, updateCloudBackupConfig,
      cloudBackupToWebDAV, cloudRestoreFromWebDAV, listCloudBackups,
  } = useOS();
  
  const [localKey, setLocalKey] = useState(apiConfig.apiKey);
  const [localUrl, setLocalUrl] = useState(apiConfig.baseUrl);
  const [localModel, setLocalModel] = useState(apiConfig.model);
  const [localStream, setLocalStream] = useState<boolean>(apiConfig.stream === true);
  const [localTemperature, setLocalTemperature] = useState<number>(
    typeof apiConfig.temperature === 'number' ? apiConfig.temperature : 0.85
  );
  const [localMiniMaxKey, setLocalMiniMaxKey] = useState(apiConfig.minimaxApiKey || '');
  const [localMiniMaxGroupId, setLocalMiniMaxGroupId] = useState(apiConfig.minimaxGroupId || '');
  const [localMiniMaxRegion, setLocalMiniMaxRegion] = useState<'domestic' | 'overseas'>(
    apiConfig.minimaxRegion === 'overseas' ? 'overseas' : 'domestic'
  );
  const [localAceStepKey, setLocalAceStepKey] = useState(apiConfig.aceStepApiKey || '');
  const [showAceStepGuide, setShowAceStepGuide] = useState(false);
  const [otherStatusMsg, setOtherStatusMsg] = useState('');
  // 高级设置（流式/温度）默认折叠 — 大多数用户不需要碰
  const [showApiAdvanced, setShowApiAdvanced] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  
  // UI States
  const [showModelModal, setShowModelModal] = useState(false);
  const [modelFilter, setModelFilter] = useState('');
  const [showExportModal, setShowExportModal] = useState(false); // Used for completion now
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showPresetModal, setShowPresetModal] = useState(false);
  const [showApiCallLog, setShowApiCallLog] = useState(false);
  const [showRealtimeModal, setShowRealtimeModal] = useState(false);
  const [showCloudModal, setShowCloudModal] = useState(false);
  const [showGithubModal, setShowGithubModal] = useState(false);
  const [showCloudRestoreModal, setShowCloudRestoreModal] = useState(false);
  const [cloudBackupFiles, setCloudBackupFiles] = useState<import('../types').CloudBackupFile[]>([]);
  const [cloudTestResult, setCloudTestResult] = useState<string>('');
  const [cloudTesting, setCloudTesting] = useState(false);

  // Cloud backup local config state (WebDAV)
  const [cbUrl, setCbUrl] = useState(cloudBackupConfig.webdavUrl);
  const [cbUsername, setCbUsername] = useState(cloudBackupConfig.username);
  const [cbPassword, setCbPassword] = useState(cloudBackupConfig.password);
  const [cbPath, setCbPath] = useState(cloudBackupConfig.remotePath || '/SullyBackup/');

  // GitHub local state
  const [ghToken, setGhToken] = useState(cloudBackupConfig.githubToken || '');
  const [ghRepo, setGhRepo] = useState(cloudBackupConfig.githubRepo || 'sully-backup');
  // Default proxy ON — most users in mainland China can't reach github.com
  // directly. Only flip to false if the user has explicitly opted out before.
  const [ghUseProxy, setGhUseProxy] = useState(cloudBackupConfig.githubUseProxy !== false);
  const [ghShowAdvanced, setGhShowAdvanced] = useState(false);
  const [ghTesting, setGhTesting] = useState(false);
  const [ghTestResult, setGhTestResult] = useState<string>('');

  // 实时感知配置的本地状态
  const [rtWeatherEnabled, setRtWeatherEnabled] = useState(realtimeConfig.weatherEnabled);
  const [rtWeatherKey, setRtWeatherKey] = useState(realtimeConfig.weatherApiKey);
  const [rtWeatherCity, setRtWeatherCity] = useState(realtimeConfig.weatherCity);
  const [rtNewsEnabled, setRtNewsEnabled] = useState(realtimeConfig.newsEnabled);
  const [rtNewsApiKey, setRtNewsApiKey] = useState(realtimeConfig.newsApiKey || '');
  const [rtNewsPlatforms, setRtNewsPlatforms] = useState<string[]>(realtimeConfig.newsPlatforms || ['weibo', 'zhihu', 'baidu', 'bilibili', 'douyin']);
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
  const XHS_LITE_URL = 'https://sullymeow.ccwu.cc/api';
  const XHS_RISK_TEXT = '⚠️ 风险：本功能基于网页爬虫技术调用小红书，账号有被风控的概率。建议①用小号；②尽量别让角色主动发帖；③发出的笔记可能被屏蔽。';
  const XHS_COOKIE_GUIDE = [
    '【获取小红书 cookie 教程】',
    '1. 用电脑浏览器(Chrome/Edge)登录 www.xiaohongshu.com',
    '2. 按 F12 打开开发者工具，切到「Network/网络」标签',
    '3. 刷新页面，点列表最上面那条「explore」(document 类型，发给 www.xiaohongshu.com 的主请求)',
    '4. 右侧切到「Headers/标头」，往下滚到「Request Headers/请求标头」',
    '5. 找到 cookie: 开头那一行(很长一串)',
    '6. 复制它后面整段的值：可把 Request Headers 右边的「Raw」开关打开看纯文本更好选，或在值上右键 Copy value，或选中后 Ctrl+C',
    '7. 确认这串里有 a1= 和 web_session= 两个字段(最关键)，粘到「小红书 Lite」的 cookie 框',
    '注意：别用 Console 的 document.cookie，拿不到 web_session(httpOnly)。cookie 数天~数周会过期，失效重复制即可。',
  ].join('\n');
  const _xhsCfgUrl = realtimeConfig.xhsMcpConfig?.serverUrl || '';
  const [rtXhsMcpEnabled, setRtXhsMcpEnabled] = useState(realtimeConfig.xhsMcpConfig?.enabled || false);
  const [rtXhsMode, setRtXhsMode] = useState<'lite' | 'local'>(_xhsCfgUrl && _xhsCfgUrl !== XHS_LITE_URL ? 'local' : 'lite');
  const [rtXhsLocalUrl, setRtXhsLocalUrl] = useState(_xhsCfgUrl && _xhsCfgUrl !== XHS_LITE_URL ? _xhsCfgUrl : 'http://localhost:18060/mcp');
  const [rtXhsNickname, setRtXhsNickname] = useState(realtimeConfig.xhsMcpConfig?.loggedInNickname || '');
  const [rtXhsUserId, setRtXhsUserId] = useState(realtimeConfig.xhsMcpConfig?.loggedInUserId || '');
  const [rtXhsCookie, setRtXhsCookie] = useState(realtimeConfig.xhsMcpConfig?.cookie || '');
  const [rtXhsGuideOpen, setRtXhsGuideOpen] = useState(false);
  const [rtTestStatus, setRtTestStatus] = useState('');

  // 麦当劳 MCP (token / 启用态都直接存 localStorage, 不进 realtimeConfig)
  const [mcdToken, setMcdTokenState] = useState(() => getMcdToken());
  const [mcdEnabled, setMcdEnabledState] = useState(() => isMcdEnabled());
  const [mcdTestStatus, setMcdTestStatus] = useState('');
  const [mcdTesting, setMcdTesting] = useState(false);

  // Proactive Push 加速器（Worker URL / VAPID 公钥写死在 proactivePushConfig.ts 常量里）
  const initialPushCfg = loadPushConfig();
  const ppAvailable = isPushConfigAvailable();
  const [ppEnabled, setPpEnabled] = useState(initialPushCfg.enabled);
  const [ppStatus, setPpStatus] = useState<string>('');
  const [ppBusy, setPpBusy] = useState(false);
  const [showPpConfirm, setShowPpConfirm] = useState(false);
  const [ppDiag, setPpDiag] = useState<PushDiagnostics | null>(null);
  const [ppTestBusy, setPpTestBusy] = useState(false);
  const [ppResetBusy, setPpResetBusy] = useState(false);
  const [ppDeepResetBusy, setPpDeepResetBusy] = useState(false);
  // 连续 zombie 重置失败次数 — 累计 >= 3 时, "重置订阅" 按钮自动 morph 成
  // "深度重置". 不持久化, 刷新页面归零 (用户原话: "刷新页面正常消失").
  const [ppZombieStreak, setPpZombieStreak] = useState(0);
  const [showInstantModal, setShowInstantModal] = useState(false);
  const [showVapidModal, setShowVapidModal] = useState(false);
  const [vapidReadyTick, setVapidReadyTick] = useState(0); // 关闭 VAPID 弹窗后刷新顶层徽标

  // 模型选择 Modal 的过滤 + 公共前缀（memo 掉，避免每次 Settings 重渲染都重算）
  const modelPickerView = useMemo(() => {
      const q = modelFilter.trim().toLowerCase();
      const filtered = q ? availableModels.filter(m => m.toLowerCase().includes(q)) : availableModels;
      let commonPrefix = '';
      if (filtered.length >= 2) {
          let p = filtered[0];
          for (let i = 1; i < filtered.length; i++) {
              const s = filtered[i];
              let j = 0;
              while (j < p.length && j < s.length && p[j] === s[j]) j++;
              p = p.slice(0, j);
              if (!p) break;
          }
          const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('-'));
          if (cut > 3) p = p.slice(0, cut + 1);
          if (p.length >= 4) commonPrefix = p;
      }
      return { filtered, commonPrefix };
  }, [modelFilter, availableModels]);

  const refreshPpDiag = useCallback(async () => {
      try { setPpDiag(await getPushDiagnostics()); } catch { /* ignore */ }
  }, []);

  const doEnablePushAccelerator = async () => {
      if (ppBusy) return;
      setPpBusy(true);
      setPpStatus('正在连接 Worker…');
      try {
          const res = await fetch(`${initialPushCfg.workerUrl}/health`);
          if (!res.ok) { setPpStatus(`失败：Worker HTTP ${res.status}`); setPpBusy(false); return; }
      } catch (e: any) {
          setPpStatus(`失败：${e?.message || '网络错误'}`); setPpBusy(false); return;
      }

      // Step 1: ensure permission + subscription up front, regardless of schedules.
      // This is the fix for the old bug where toggle "succeeded" without ever
      // requesting permission when the user hadn't enabled any character timer yet.
      setPpStatus('正在请求通知权限并创建订阅…');
      const sub = await ensureSubscribed();
      if (!sub.ok) {
          setPpStatus(`失败：${sub.reason || '订阅创建失败'}`);
          setPpBusy(false);
          await refreshPpDiag();
          return;
      }

      // Step 2: persist enabled flag and start heartbeat.
      savePushConfig(true);
      setPpEnabled(true);
      startHeartbeat();

      // Step 3: register any existing per-character schedules.
      const schedules = ProactiveChat.getSchedules();
      let okCount = 0;
      for (const s of schedules) {
          if (await registerScheduleOnWorker(s.charId, s.intervalMs)) okCount++;
      }

      if (schedules.length === 0) {
          setPpStatus('已启用（订阅已建立。暂无主动消息定时，下次开启角色主动消息时会自动注册）');
      } else if (okCount < schedules.length) {
          setPpStatus(`已启用：${okCount}/${schedules.length} 个定时注册成功`);
      } else {
          setPpStatus(`已启用，${okCount} 个主动消息定时已注册`);
      }
      setPpBusy(false);
      await refreshPpDiag();
  };

  const doDisablePushAccelerator = async () => {
      savePushConfig(false);
      setPpEnabled(false);
      stopHeartbeat();
      setPpStatus('已关闭（主动消息退回本地计时器）');
      await refreshPpDiag();
  };

  const doSendTestPush = async () => {
      if (ppTestBusy) return;
      setPpTestBusy(true);
      setPpStatus('正在让 Worker 发一条测试推送…');
      const res = await sendTestPush();
      if (res.ok) {
          setPpStatus('测试推送已发出。如果 5 秒内系统通知里没出现"推送测试成功"，说明送达环节有问题——看下方诊断面板。');
      } else if (res.deadSubscription) {
          setPpStatus('订阅已被浏览器吊销（zombie endpoint）。请点下方"重置订阅"重建一次再测。');
      } else {
          setPpStatus(`测试失败：${res.reason || '未知错误'}${res.status ? `（HTTP ${res.status}）` : ''}`);
      }
      setPpTestBusy(false);
      await refreshPpDiag();
  };

  const doResetSubscription = async () => {
      if (ppResetBusy || ppDeepResetBusy) return;
      setPpResetBusy(true);
      setPpStatus('正在重置订阅…');
      const res = await resetSubscription();
      if (res.ok) {
          setPpZombieStreak(0);
          setPpStatus('订阅已重建。可以再点"发一条测试推送"试一下。');
      } else {
          const reason = res.reason || '';
          // 失败原因指向 zombie endpoint 时累计, 达到 3 次后按钮自动 morph 成深度重置
          if (/permanently-removed|zombie/i.test(reason)) {
              setPpZombieStreak(c => c + 1);
          }
          setPpStatus(`重置失败：${reason || '未知错误'}`);
      }
      setPpResetBusy(false);
      await refreshPpDiag();
  };

  const doDeepResetSubscription = async () => {
      if (ppDeepResetBusy || ppResetBusy) return;
      setPpDeepResetBusy(true);
      setPpStatus('正在深度重置…');
      const res = await deepResetSubscription();
      // 无论成败, 按钮都回归"重置订阅" — 下次出问题再次累计触发 morph
      setPpZombieStreak(0);
      if (res.ok) {
          // ProactiveChat.resume() 把所有 schedule 推回新 SW. deepResetSubscription 内部
          // 不调它是为了避免循环依赖 (ProactiveChat 反向依赖 proactivePushConfig).
          try { ProactiveChat.resume(); } catch (e) { console.warn('[Settings] ProactiveChat.resume failed', e); }
          setPpStatus('订阅已重建。可以再点"发一条测试推送"试一下。');
      } else {
          setPpStatus(`深度重置失败：${res.reason || '未知错误'}`);
      }
      setPpDeepResetBusy(false);
      await refreshPpDiag();
  };

  // Refresh diagnostics whenever the panel is mounted or the toggle changes.
  useEffect(() => {
      void refreshPpDiag();
  }, [refreshPpDiag, ppEnabled]);

  // For web download link
  const [downloadUrl, setDownloadUrl] = useState<string>('');
  
  const [statusMsg, setStatusMsg] = useState('');
  const [testingApi, setTestingApi] = useState(false);
  const [testApiResult, setTestApiResult] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  // Auto-save draft configs locally to prevent loss during typing
  useEffect(() => {
      setLocalUrl(apiConfig.baseUrl);
      setLocalKey(apiConfig.apiKey);
      setLocalModel(apiConfig.model);
      setLocalStream(apiConfig.stream === true);
      setLocalTemperature(typeof apiConfig.temperature === 'number' ? apiConfig.temperature : 0.85);
      setLocalMiniMaxKey(apiConfig.minimaxApiKey || '');
      setLocalMiniMaxGroupId(apiConfig.minimaxGroupId || '');
      setLocalMiniMaxRegion(apiConfig.minimaxRegion === 'overseas' ? 'overseas' : 'domestic');
      setLocalAceStepKey(apiConfig.aceStepApiKey || '');
  }, [apiConfig]);

  const loadPreset = (preset: typeof apiPresets[0]) => {
      setLocalUrl(preset.config.baseUrl);
      setLocalKey(preset.config.apiKey);
      setLocalModel(preset.config.model);
      setLocalStream(preset.config.stream === true);
      setLocalTemperature(typeof preset.config.temperature === 'number' ? preset.config.temperature : 0.85);
      // MiniMax / AceStep settings are NOT overwritten by presets — typically one user
      // has only one MiniMax / Replicate account regardless of which LLM preset they use.
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
        stream: localStream,
        temperature: localTemperature,
      });
      setNewPresetName('');
      setShowPresetModal(false);
      addToast('预设已保存', 'success');
  };

  const handleSaveApi = () => {
    updateApiConfig({
      apiKey: localKey,
      baseUrl: localUrl,
      model: localModel,
      stream: localStream,
      temperature: localTemperature,
    });
    setStatusMsg('配置已保存');
    setTimeout(() => setStatusMsg(''), 2000);
  };

  const handleSaveOtherApis = () => {
    updateApiConfig({
      minimaxApiKey: localMiniMaxKey,
      minimaxGroupId: localMiniMaxGroupId,
      minimaxRegion: localMiniMaxRegion,
      aceStepApiKey: localAceStepKey,
    });
    setOtherStatusMsg('已保存');
    setTimeout(() => setOtherStatusMsg(''), 2000);
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
          const details = err?.stack || err?.message || String(err || '未知错误');
          showError('导入失败', details);
          addToast('导入失败，错误信息已展开', 'error');
      });
      
      if (importInputRef.current) importInputRef.current.value = '';
  };

  // Cloud Backup Handlers
  const handleTestCloudConnection = async () => {
      setCloudTesting(true);
      setCloudTestResult('');
      try {
          const { testConnection } = await import('../utils/webdavClient');
          const tempConfig = { ...cloudBackupConfig, webdavUrl: cbUrl, username: cbUsername, password: cbPassword, remotePath: cbPath };
          const result = await testConnection(tempConfig);
          setCloudTestResult(result.ok ? `✓ ${result.message}` : `✗ ${result.message}`);
      } catch (e: any) {
          setCloudTestResult(`✗ ${e.message}`);
      }
      setCloudTesting(false);
  };

  const handleSaveCloudConfig = () => {
      updateCloudBackupConfig({
          enabled: true,
          provider: 'webdav',
          webdavUrl: cbUrl, username: cbUsername, password: cbPassword,
          remotePath: cbPath,
      });
      addToast('云端备份配置已保存', 'success');
      setShowCloudModal(false);
  };

  const handleCloudBackup = async (mode: 'text_only' | 'full') => {
      try { await cloudBackupToWebDAV(mode); } catch { /* toast handled in context */ }
  };

  const handleOpenCloudRestore = async () => {
      setShowCloudRestoreModal(true);
      setCloudBackupFiles([]);
      try {
          const files = await listCloudBackups();
          setCloudBackupFiles(files);
      } catch { addToast('获取云端备份列表失败', 'error'); }
  };

  const handleCloudRestore = async (file: import('../types').CloudBackupFile) => {
      setShowCloudRestoreModal(false);
      try {
          await cloudRestoreFromWebDAV(file);
      } catch (err: any) {
          const details = err?.stack || err?.message || String(err || '未知错误');
          showError('云端恢复失败', details);
      }
  };

  // GitHub backup handlers — single "测试并连接" button does verify-token +
  // ensure-repo, persists owner/login on success so users never type 'owner'.
  const handleTestGithub = async () => {
      if (!ghToken.trim()) { setGhTestResult('✗ 请先粘贴 Token'); return; }
      setGhTesting(true);
      setGhTestResult('');
      try {
          const { testConnection } = await import('../utils/githubClient');
          const result = await testConnection({
              ...cloudBackupConfig,
              githubToken: ghToken.trim(),
              githubRepo: ghRepo.trim() || 'sully-backup',
              githubUseProxy: ghUseProxy,
          });
          setGhTestResult(result.ok ? `✓ ${result.message}` : `✗ ${result.message}`);
          if (result.ok && result.login) {
              updateCloudBackupConfig({
                  enabled: true,
                  provider: 'github',
                  githubToken: ghToken.trim(),
                  githubOwner: result.login,
                  githubRepo: ghRepo.trim() || 'sully-backup',
                  githubUseProxy: ghUseProxy,
              });
          }
      } catch (e: any) {
          setGhTestResult(`✗ ${e?.message || '连接失败'}`);
      }
      setGhTesting(false);
  };

  const handleDisableCloud = () => {
      updateCloudBackupConfig({ enabled: false });
      setShowCloudModal(false);
      setShowGithubModal(false);
      addToast('云端备份已关闭', 'info');
  };

  // One-click provider switch — if the target provider was already configured
  // before, just flip the 'provider' field and show a toast. Otherwise open
  // the setup modal. Critically: switching does NOT touch the other side's
  // saved credentials, so old WebDAV users keep their old backups visible
  // when they switch back.
  const switchToGithub = () => {
      if (cloudBackupConfig.githubToken && cloudBackupConfig.githubOwner) {
          updateCloudBackupConfig({ provider: 'github' });
          addToast(`已切换到 GitHub @${cloudBackupConfig.githubOwner}`, 'success');
      } else {
          setShowGithubModal(true);
      }
  };
  const switchToWebDAV = () => {
      if (cloudBackupConfig.webdavUrl && cloudBackupConfig.username) {
          updateCloudBackupConfig({ provider: 'webdav' });
          addToast('已切换回 WebDAV，旧备份依旧在', 'success');
      } else {
          setShowCloudModal(true);
      }
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
          newsPlatforms: rtNewsPlatforms,
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
              serverUrl: rtXhsMode === 'lite' ? XHS_LITE_URL : rtXhsLocalUrl,
              cookie: rtXhsMode === 'lite' ? (rtXhsCookie.trim() || undefined) : undefined,
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
      const urlToUse = rtXhsMode === 'lite' ? XHS_LITE_URL : rtXhsLocalUrl;
      const cookieToUse = rtXhsMode === 'lite' ? (rtXhsCookie.trim() || undefined) : undefined;
      if (!urlToUse) {
          setRtTestStatus('请填写服务器 URL');
          return;
      }
      if (rtXhsMode === 'lite' && !cookieToUse) {
          setRtTestStatus('请先粘贴小红书 cookie');
          return;
      }
      setRtTestStatus('正在连接...');
      try {
          const result = await XhsMcpClient.testConnection(urlToUse, cookieToUse);
          if (result.connected) {
              const toolCount = result.tools?.length || 0;
              const tokenInfo = result.xsecToken ? ' | xsecToken 已获取' : '';
              const loginInfo = result.loggedIn
                  ? ` | ${result.nickname ? `账号: ${result.nickname}` : '已登录'}${result.userId ? ` (ID: ${result.userId})` : ''}${tokenInfo}`
                  : ' | 未登录，请检查 cookie 或登录小红书';
              setRtTestStatus(`连接成功! ${toolCount} 个功能可用${loginInfo}`);
              // 自动填充：只在用户未手动填写时覆盖
              if (result.nickname && !rtXhsNickname) setRtXhsNickname(result.nickname);
              if (result.userId && !rtXhsUserId) setRtXhsUserId(result.userId);
              updateRealtimeConfig({
                  xhsMcpConfig: {
                      enabled: rtXhsMcpEnabled,
                      serverUrl: urlToUse,
                      cookie: cookieToUse,
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

  // 麦当劳 MCP: 改 token / 启用态都即时落 localStorage; "测试连接"调 initialize+tools/list
  const handleMcdTokenChange = (v: string) => {
      setMcdTokenState(v);
      saveMcdToken(v);
      resetMcdSession();
      setMcdTestStatus('');
  };
  const handleMcdEnabledChange = (v: boolean) => {
      setMcdEnabledState(v);
      saveMcdEnabled(v);
      if (!v) resetMcdSession();
  };
  const testMcdApi = async () => {
      if (!mcdToken.trim()) { setMcdTestStatus('请先填写 MCP Token'); return; }
      setMcdTesting(true);
      setMcdTestStatus('正在连接麦当劳 MCP...');
      try {
          const r = await testMcdConnection();
          if (r.ok) {
              const names = (r.tools || []).map(t => t.name).slice(0, 6).join(', ');
              setMcdTestStatus(`✅ ${r.message}${names ? `\n工具: ${names}${(r.tools || []).length > 6 ? ' ...' : ''}` : ''}`);
          } else {
              setMcdTestStatus(`❌ ${r.message}`);
          }
      } catch (e: any) {
          setMcdTestStatus(`❌ ${e?.message || String(e)}`);
      } finally {
          setMcdTesting(false);
      }
  };

  return (
    <div className="h-full w-full bg-slate-50/50 flex flex-col font-light relative">

      {/* GLOBAL PROGRESS OVERLAY */}
      {sysOperation.status === 'processing' && (
          <div className="absolute inset-0 z-50 bg-black/60 flex items-center justify-center animate-fade-in">
              <div className="bg-white p-6 rounded-3xl shadow-2xl flex flex-col items-center gap-4 w-64">
                  <div className="w-12 h-12 border-4 border-slate-200 border-t-primary rounded-full animate-spin"></div>
                  <div className="text-sm font-bold text-slate-700 text-center leading-relaxed whitespace-pre-wrap break-words max-w-full">{sysOperation.message}</div>
                  {sysOperation.progress > 0 && (
                      <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                          <div className="h-full bg-primary transition-all duration-300" style={{ width: `${sysOperation.progress}%` }}></div>
                      </div>
                  )}
              </div>
          </div>
      )}

      {/* Header */}
      <div className="h-20 bg-white/85 flex items-end pb-3 px-4 border-b border-white/40 shrink-0 z-10 sticky top-0">
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
        <section className="bg-white/80 rounded-3xl p-5 shadow-sm border border-white/50">
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

        {/* 云端备份区域 */}
        <section className="bg-white/80 rounded-3xl p-5 shadow-sm border border-white/50">
            <div className="flex items-center gap-2 mb-4">
                <div className="p-2 bg-sky-100 rounded-xl text-sky-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z" /></svg>
                </div>
                <h2 className="text-sm font-semibold text-slate-600 tracking-wider">云端备份</h2>
            </div>

            {!cloudBackupConfig.enabled ? (
                <div className="space-y-3 py-2">
                    <p className="text-[11px] text-slate-400 leading-relaxed text-center">
                        把备份上传到你自己的云端，换设备、丢手机都不怕。<br/>
                        国内推荐 <b>GitHub</b>（不用梯子，2GB/份）。
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                        <button
                            onClick={() => setShowGithubModal(true)}
                            className="py-3 px-2 bg-gradient-to-br from-slate-800 to-slate-900 text-white rounded-xl text-xs font-bold shadow-sm active:scale-95 transition-all flex flex-col items-center gap-1.5 relative"
                        >
                            <span className="absolute top-1 right-1.5 text-[8px] bg-amber-300 text-slate-800 px-1.5 py-0.5 rounded-full font-bold">推荐</span>
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5"><path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.203 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0022 12.017C22 6.484 17.522 2 12 2z" /></svg>
                            <span>GitHub</span>
                            <span className="text-[9px] text-slate-300 font-normal">不用梯子 · 2GB</span>
                        </button>
                        <button
                            onClick={() => setShowCloudModal(true)}
                            className="py-3 px-2 bg-gradient-to-br from-sky-500 to-blue-600 text-white rounded-xl text-xs font-bold shadow-sm active:scale-95 transition-all flex flex-col items-center gap-1.5"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z" /></svg>
                            <span>WebDAV</span>
                            <span className="text-[9px] text-sky-100 font-normal">日本/NAS · 需梯子</span>
                        </button>
                    </div>
                </div>
            ) : (
                <div className="space-y-3">
                    <div className={`flex items-center justify-between rounded-xl px-3 py-2 ${cloudBackupConfig.provider === 'github' ? 'bg-slate-100' : 'bg-sky-50'}`}>
                        <div className="flex items-center gap-2">
                            <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                            <span className="text-[11px] text-slate-600 font-medium">
                                已连接 · {cloudBackupConfig.provider === 'github'
                                    ? `GitHub${cloudBackupConfig.githubOwner ? ` (@${cloudBackupConfig.githubOwner})` : ''}`
                                    : 'WebDAV'}
                            </span>
                        </div>
                        <button
                            onClick={() => cloudBackupConfig.provider === 'github' ? setShowGithubModal(true) : setShowCloudModal(true)}
                            className={`text-[10px] font-medium ${cloudBackupConfig.provider === 'github' ? 'text-slate-600' : 'text-sky-500'}`}
                        >
                            修改配置
                        </button>
                    </div>

                    {/* Quick link to the GitHub releases page so the user knows
                        where their backups physically live and can browse /
                        delete them on github.com directly if they want. */}
                    {cloudBackupConfig.provider === 'github' && cloudBackupConfig.githubOwner && (
                        <a
                            href={`https://github.com/${cloudBackupConfig.githubOwner}/${cloudBackupConfig.githubRepo || 'sully-backup'}/releases`}
                            target="_blank" rel="noopener noreferrer"
                            className="block text-center text-[10px] text-slate-500 hover:text-slate-800 underline-offset-2 hover:underline transition-colors"
                        >
                            🔗 在 GitHub 上查看备份 (github.com/{cloudBackupConfig.githubOwner}/{cloudBackupConfig.githubRepo || 'sully-backup'}/releases) ↗
                        </a>
                    )}

                    {/* Switch-provider hint — shown to existing users so the
                        new GitHub option is discoverable from the connected
                        state, not only on the first-time setup screen. If the
                        other provider was previously configured, the click is
                        a one-shot flip; old credentials and backups stay put. */}
                    {cloudBackupConfig.provider !== 'github' ? (
                        <>
                            <button
                                onClick={switchToGithub}
                                className="w-full py-2 bg-gradient-to-r from-slate-800 to-slate-900 text-white rounded-xl text-[11px] font-bold shadow-sm active:scale-95 transition-all flex items-center justify-center gap-2"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5"><path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.203 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0022 12.017C22 6.484 17.522 2 12 2z" /></svg>
                                <span>{cloudBackupConfig.githubToken ? '切换到 GitHub' : '试试 GitHub 备份（不用梯子 · 2GB/份）'}</span>
                            </button>
                            <p className="text-[10px] text-slate-400 text-center">
                                你 WebDAV 上的旧备份不会被动，可随时切回。
                            </p>
                        </>
                    ) : (
                        <button
                            onClick={switchToWebDAV}
                            className="w-full py-1.5 text-[10px] text-slate-400 hover:text-sky-500 transition-colors"
                        >
                            {cloudBackupConfig.webdavUrl ? '切换回 WebDAV →' : '改用 WebDAV 备份 →'}
                        </button>
                    )}
                    {cloudBackupConfig.lastBackupTime && (
                        <p className="text-[10px] text-slate-400 text-center">
                            上次备份: {new Date(cloudBackupConfig.lastBackupTime).toLocaleString('zh-CN')}
                            {cloudBackupConfig.lastBackupSize && ` (${(cloudBackupConfig.lastBackupSize / 1024 / 1024).toFixed(1)} MB)`}
                        </p>
                    )}

                    <div className="grid grid-cols-2 gap-2">
                        <button
                            onClick={() => handleCloudBackup('text_only')}
                            className="py-3 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600 shadow-sm active:scale-95 transition-all flex flex-col items-center gap-1"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 text-sky-500"><path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" /></svg>
                            <span>备份到云端</span>
                            <span className="text-[9px] text-slate-400">(纯文字)</span>
                        </button>
                        <button
                            onClick={() => handleCloudBackup('full')}
                            className="py-3 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600 shadow-sm active:scale-95 transition-all flex flex-col items-center gap-1"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 text-violet-500"><path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" /></svg>
                            <span>备份到云端</span>
                            <span className="text-[9px] text-slate-400">(完整)</span>
                        </button>
                    </div>

                    <button
                        onClick={handleOpenCloudRestore}
                        className="w-full py-3 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600 shadow-sm active:scale-95 transition-all flex items-center justify-center gap-2"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 text-emerald-500"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9.75v6.75m0 0l-3-3m3 3l3-3m-8.25 6a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" /></svg>
                        从云端恢复
                    </button>
                </div>
            )}

            <p className="text-[10px] text-slate-400 px-1 mt-3 leading-relaxed">
                数据存储在你自己的账号下，我们不保存任何凭据到服务器。
            </p>
        </section>

        {/* AI 连接设置区域 */}
        <section className="bg-white/80 rounded-3xl p-5 shadow-sm border border-white/50">
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

                {/* 高级（流式 / 温度）— 默认折叠，灰色低调，明确写"不建议修改" */}
                <div className="pt-1">
                    <button
                        type="button"
                        onClick={() => setShowApiAdvanced(v => !v)}
                        className="text-[10px] text-slate-300 hover:text-slate-400 transition-colors flex items-center gap-1 pl-1 active:scale-95"
                    >
                        <span>高级（不建议修改）</span>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={`w-2.5 h-2.5 transition-transform ${showApiAdvanced ? 'rotate-180' : ''}`}>
                            <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                        </svg>
                    </button>
                    {showApiAdvanced && (
                        <div className="mt-2 pl-2 border-l-2 border-slate-100 space-y-3 py-2">
                            <p className="text-[10px] text-slate-300 leading-relaxed">
                                这两项绝大多数用户保持默认即可。除非接口报错"only stream supported"或对回复风格有强需求，否则不建议改。
                            </p>
                            <div className="flex items-center justify-between">
                                <div>
                                    <span className="text-[10px] text-slate-400">流式输出 (Stream)</span>
                                    <p className="text-[9px] text-slate-300 mt-0.5">仅在你的 API 强制要求时打开</p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setLocalStream(v => !v)}
                                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${localStream ? 'bg-slate-400' : 'bg-slate-200'}`}
                                >
                                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${localStream ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                </button>
                            </div>
                            <div>
                                <div className="flex items-center justify-between">
                                    <span className="text-[10px] text-slate-400">温度 (Temperature)</span>
                                    <span className="text-[10px] font-mono text-slate-400">{localTemperature.toFixed(2)}</span>
                                </div>
                                <input
                                    type="range"
                                    min="0"
                                    max="2"
                                    step="0.05"
                                    value={localTemperature}
                                    onChange={(e) => setLocalTemperature(parseFloat(e.target.value))}
                                    className="w-full accent-slate-400 mt-1"
                                />
                                <p className="text-[9px] text-slate-300 mt-0.5">默认 0.85；只作用于聊天和约会的主回复</p>
                            </div>
                        </div>
                    )}
                </div>

                <div className="pt-2">
                     <div className="flex justify-between items-center mb-1.5 pl-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Model</label>
                        <button onClick={fetchModels} disabled={isLoadingModels} className="text-[10px] text-primary font-bold">{isLoadingModels ? 'Fetching...' : '刷新模型列表'}</button>
                    </div>
                    
                    <button
                        onClick={() => setShowModelModal(true)}
                        title={localModel || 'Select Model...'}
                        className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-3 text-sm text-slate-700 flex justify-between items-center gap-2 active:bg-white transition-all shadow-sm"
                    >
                        <span
                            className="font-mono overflow-hidden whitespace-nowrap min-w-0 flex-1 text-left"
                            style={{ direction: 'rtl', textOverflow: 'ellipsis' }}
                        >
                            <bdi style={{ direction: 'ltr' }}>{localModel || 'Select Model...'}</bdi>
                        </span>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-slate-400 flex-shrink-0"><path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" /></svg>
                    </button>
                </div>
                
                <button onClick={handleSaveApi} className="w-full py-3 rounded-2xl font-bold text-white shadow-lg shadow-primary/20 bg-primary active:scale-95 transition-all mt-2">
                    {statusMsg || '保存配置'}
                </button>

                <button
                    onClick={async () => {
                        if (!localUrl.trim() || !localKey.trim() || !localModel.trim()) return;
                        setTestingApi(true);
                        setTestApiResult(null);
                        try {
                            const res = await fetch(`${localUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localKey.trim()}` },
                                body: JSON.stringify({
                                    model: localModel.trim(),
                                    messages: [{ role: 'user', content: 'Hi' }],
                                    max_tokens: 5,
                                    stream: localStream,
                                }),
                            });
                            if (res.ok) {
                                // 走 safeResponseJson —— 它能透明把 SSE 流响应拼成普通 chat/completion 结构
                                const data = await safeResponseJson(res);
                                const reply = data.choices?.[0]?.message?.content || '';
                                setTestApiResult(`✅ 连接成功 — 模型回复: "${reply.slice(0, 30)}"`);
                            } else {
                                const text = await res.text().catch(() => '');
                                setTestApiResult(`❌ HTTP ${res.status}: ${text.slice(0, 100)}`);
                            }
                        } catch (err: any) {
                            setTestApiResult(`❌ 连接失败: ${err.message}`);
                        } finally {
                            setTestingApi(false);
                        }
                    }}
                    disabled={testingApi || !localUrl.trim() || !localKey.trim() || !localModel.trim()}
                    className={`w-full py-2.5 rounded-2xl font-bold text-sm border mt-2 active:scale-95 transition-all ${
                        testingApi || !localUrl.trim() || !localKey.trim() || !localModel.trim()
                            ? 'border-slate-200 text-slate-400 bg-slate-50'
                            : 'border-primary/30 text-primary bg-primary/5 hover:bg-primary/10'
                    }`}
                >
                    {testingApi ? '测试中...' : '🧪 测试连接'}
                </button>

                {testApiResult && (
                    <div className={`mt-2 text-xs px-3 py-2 rounded-xl ${
                        testApiResult.startsWith('✅') ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'
                    }`}>
                        {testApiResult}
                    </div>
                )}
            </div>
        </section>

        {/* API 调用记录入口 — 点开看最近 5 天各 App / 角色 / 用途的调用明细 */}
        <button
            type="button"
            onClick={() => setShowApiCallLog(true)}
            className="w-full bg-white/80 rounded-3xl p-5 shadow-sm border border-white/50 flex items-center gap-3 active:scale-[0.99] transition-transform text-left"
        >
            <div className="p-2 bg-sky-100/60 rounded-xl text-sky-600 shrink-0">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0V12a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 12V5.25" />
                </svg>
            </div>
            <div className="flex-1 min-w-0">
                <h2 className="text-sm font-semibold text-slate-600 tracking-wider">API 调用记录</h2>
                <p className="text-[11px] text-slate-400 mt-0.5">最近 5 天：时间 · 哪个 API · 哪个 App · 哪个角色 · 用途</p>
            </div>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-slate-300 shrink-0">
                <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z" clipRule="evenodd" />
            </svg>
        </button>

        {/* 其他 API 区域 — 非 LLM 类（语音、写歌等），不会跟随预设切换 */}
        <section className="bg-white/80 rounded-3xl p-5 shadow-sm border border-white/50">
            <div className="flex items-center gap-2 mb-4">
                <div className="p-2 bg-amber-100/50 rounded-xl text-amber-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9 3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5 5.25 5.25" />
                    </svg>
                </div>
                <h2 className="text-sm font-semibold text-slate-600 tracking-wider">其他 API</h2>
            </div>
            <p className="text-[11px] text-slate-400 mb-4 leading-relaxed pl-1">
                语音 / 写歌等非 LLM 类 API。这些设置 <span className="font-semibold text-slate-500">不会随预设切换</span>，通常只配置一次。
            </p>

            <div className="space-y-4">
                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">MiniMax 服务器</label>
                    <div className="flex bg-white/50 border border-slate-200/60 rounded-xl p-1 gap-1">
                        <button
                            type="button"
                            onClick={() => setLocalMiniMaxRegion('domestic')}
                            className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${localMiniMaxRegion === 'domestic' ? 'bg-primary text-white shadow-sm' : 'text-slate-600 active:bg-white/60'}`}
                        >
                            国服
                        </button>
                        <button
                            type="button"
                            onClick={() => setLocalMiniMaxRegion('overseas')}
                            className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${localMiniMaxRegion === 'overseas' ? 'bg-primary text-white shadow-sm' : 'text-slate-600 active:bg-white/60'}`}
                        >
                            海外
                        </button>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">
                        {localMiniMaxRegion === 'overseas'
                            ? '海外站（api.minimax.io）— 请使用海外账号签发的 Key。'
                            : '国服（api.minimaxi.com）— 默认，适配国内账号。'}
                    </p>
                </div>

                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">MiniMax Key (可选)</label>
                    <input type="password" name="minimax-api-secret" autoComplete="new-password" spellCheck={false} value={localMiniMaxKey} onChange={(e) => setLocalMiniMaxKey(e.target.value)} placeholder="MiniMax API Secret（留空则复用 Key）" className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">电话 / 音色查询优先使用这个 Key，空着时回退通用 Key。</p>
                </div>

                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">MiniMax Group ID (可选)</label>
                    <input type="text" value={localMiniMaxGroupId} onChange={(e) => setLocalMiniMaxGroupId(e.target.value)} placeholder="group_id（部分账号/模型需要）" className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">如控制台给了 group_id，请填这里；会透传到 TTS 请求体和代理日志。</p>
                </div>

                <div className="group">
                    <div className="flex items-center justify-between mb-1.5 pl-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">写歌 · Replicate Token (可选)</label>
                        <button
                            type="button"
                            onClick={() => setShowAceStepGuide(v => !v)}
                            className="text-[10px] font-semibold text-rose-500 hover:text-rose-600 active:scale-95 transition-all flex items-center gap-1"
                        >
                            {showAceStepGuide ? '收起' : '怎么拿？'}
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={`w-3 h-3 transition-transform ${showAceStepGuide ? 'rotate-180' : ''}`}>
                                <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                            </svg>
                        </button>
                    </div>
                    <input type="password" name="ace-step-api-token" autoComplete="new-password" spellCheck={false} value={localAceStepKey} onChange={(e) => setLocalAceStepKey(e.target.value)} placeholder="r8_xxx（写歌 App 调 ACE-Step 出整首歌用）" className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">填了之后写歌 App 的歌词页能一键调 ACE-Step 出真人声整首歌（约 ¥0.1/首，走 sfworker 代理免梯子）。</p>

                    {showAceStepGuide && (
                        <div className="mt-3 rounded-2xl overflow-hidden border border-rose-200/60 bg-gradient-to-br from-rose-50 via-orange-50 to-amber-50 shadow-sm animate-slide-down">
                            <div className="px-4 pt-3.5 pb-2 flex items-center gap-2 border-b border-rose-200/40">
                                <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-rose-500 to-orange-500 text-white flex items-center justify-center text-base shadow-sm shadow-rose-500/30">🎤</div>
                                <div className="flex-1">
                                    <div className="text-[12px] font-bold text-stone-700">3 步搞定 Replicate Token</div>
                                    <div className="text-[10px] text-stone-500">让 ACE-Step 帮你把歌唱出来</div>
                                </div>
                            </div>
                            <div className="px-4 py-3 space-y-2.5">
                                <div className="flex gap-2.5">
                                    <span className="shrink-0 w-5 h-5 rounded-full bg-rose-500 text-white text-[11px] font-bold flex items-center justify-center mt-0.5">1</span>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[12px] text-stone-700 font-medium">注册 Replicate 账号</div>
                                        <p className="text-[11px] text-stone-500 leading-relaxed mt-0.5">用 GitHub 一键登录最快。无需邮箱验证。</p>
                                        <a
                                            href="https://replicate.com/signin"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-1 mt-1.5 text-[11px] font-semibold text-rose-600 hover:text-rose-700 active:scale-95 transition-all px-2 py-1 rounded-lg bg-white/70 border border-rose-200/50"
                                        >
                                            打开注册页
                                        </a>
                                    </div>
                                </div>
                                <div className="flex gap-2.5">
                                    <span className="shrink-0 w-5 h-5 rounded-full bg-orange-500 text-white text-[11px] font-bold flex items-center justify-center mt-0.5">2</span>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[12px] text-stone-700 font-medium">复制 API Token</div>
                                        <p className="text-[11px] text-stone-500 leading-relaxed mt-0.5">登录后访问 Account → API Tokens，复制以 <span className="font-mono text-rose-600">r8_</span> 开头的那一串。</p>
                                        <a
                                            href="https://replicate.com/account/api-tokens"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-1 mt-1.5 text-[11px] font-semibold text-orange-600 hover:text-orange-700 active:scale-95 transition-all px-2 py-1 rounded-lg bg-white/70 border border-orange-200/50"
                                        >
                                            打开 Token 页
                                        </a>
                                    </div>
                                </div>
                                <div className="flex gap-2.5">
                                    <span className="shrink-0 w-5 h-5 rounded-full bg-amber-500 text-white text-[11px] font-bold flex items-center justify-center mt-0.5">3</span>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[12px] text-stone-700 font-medium">绑卡充值（必须）</div>
                                        <p className="text-[11px] text-stone-500 leading-relaxed mt-0.5">Replicate 没有免费试用额度，需先绑信用卡。<span className="text-rose-600 font-semibold">国内卡基本不行</span>，建议 Visa / MC 美区卡。最低充 $1（约 ¥7.3）≈ 50-100 首歌。</p>
                                    </div>
                                </div>
                                <div className="mt-2 pt-2.5 border-t border-rose-200/40 flex gap-2 items-start">
                                    <span className="text-rose-500 text-sm leading-none mt-0.5">💡</span>
                                    <p className="text-[11px] text-stone-500 leading-relaxed">
                                        粘贴到上面输入框 → 点保存配置 → 进写歌 App 打开任意一首歌的预览页 → 底部「AI 出歌」即可。
                                    </p>
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                <button onClick={handleSaveOtherApis} className="w-full py-3 rounded-2xl font-bold text-white shadow-lg shadow-amber-500/20 bg-amber-500 active:scale-95 transition-all mt-2">
                    {otherStatusMsg || '保存其他 API'}
                </button>
            </div>
        </section>

        {/* 实时感知配置区域 */}
        <section className="bg-white/80 rounded-3xl p-5 shadow-sm border border-white/50">
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

        {/* ───────── 推送凭据 (VAPID) ───────── */}
        {/* VAPID 公私钥, 与 Proactive / Instant Push 共用一份 — 独立成块, 避免再被当成 */}
        {/* Instant Push 的子配置, 也避免两边 key 不一致互相抢同一个 pushManager 订阅. */}
        {/* vapidReadyTick: VAPID 弹窗关闭后 +1, 让本节点 re-render 重读 isPushVapidReady(). */}
        <section data-vapid-tick={vapidReadyTick} className="bg-white/80 rounded-3xl p-5 shadow-sm border border-white/50">
            <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                    <div className="p-2 bg-violet-100/60 rounded-xl text-violet-600">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z" />
                        </svg>
                    </div>
                    <h2 className="text-sm font-semibold text-slate-600 tracking-wider">推送凭据 (VAPID)</h2>
                </div>
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${isPushVapidReady() ? 'bg-violet-100 text-violet-600' : 'bg-rose-100 text-rose-600'}`}>
                    {isPushVapidReady() ? '已配置' : '未配置'}
                </span>
            </div>
            <p className="text-xs text-slate-500 mb-3 leading-relaxed">
                Proactive Push 和 Instant Push <b>共用同一份 VAPID 密钥对</b>。两边 key 不一致时会反复 unsubscribe 抢同一个 pushManager 订阅 ——
                "推送成功但收不到"的常见原因。
            </p>
            <button
                type="button"
                onClick={() => setShowVapidModal(true)}
                className={`w-full py-2.5 rounded-xl text-xs font-bold ${isPushVapidReady() ? 'bg-white text-violet-700 border border-violet-200 hover:bg-violet-50' : 'bg-violet-500 text-white hover:bg-violet-600 shadow-md shadow-violet-200'}`}
            >
                {isPushVapidReady() ? '查看 / 重新生成' : '生成 VAPID 密钥对 →'}
            </button>
        </section>

        {/* ───────── 主动消息 Push 加速器（开关） ───────── */}
        {SHOW_PROACTIVE_PUSH_ACCEL_UI && ppAvailable && (
        <section className="bg-white/80 rounded-3xl p-5 shadow-sm border border-white/50">
            <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                    <div className="p-2 bg-teal-100/60 rounded-xl text-teal-600">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" />
                        </svg>
                    </div>
                    <h2 className="text-sm font-semibold text-slate-600 tracking-wider">主动消息 Push 加速</h2>
                </div>
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${ppEnabled ? 'bg-teal-100 text-teal-600' : 'bg-slate-100 text-slate-400'}`}>
                    {ppEnabled ? '已启用' : '未启用'}
                </span>
            </div>

            <p className="text-xs text-slate-500 mb-3 leading-relaxed">
                让主动消息在浏览器后台标签里也能准点触发。AI 仍在本地生成，云端只管"到点喊醒浏览器"。
                浏览器进程被完全关闭时无法唤醒——下次打开 app 会自动补跑漏掉的主动消息，
                你看到的就是"开 app 即有"，不会半路弹窗打扰你。
            </p>

            {ppStatus && (
                <div className={`mb-3 p-3 rounded-xl text-xs font-medium text-center ${ppStatus.includes('成功') || ppStatus.includes('已启用') || ppStatus.includes('OK') ? 'bg-emerald-100 text-emerald-700' : ppStatus.includes('失败') || ppStatus.includes('错误') || ppStatus.includes('拒绝') ? 'bg-red-100 text-red-600' : 'bg-slate-100 text-slate-600'}`}>
                    {ppStatus}
                </div>
            )}

            <div className="flex items-center justify-between bg-slate-50 rounded-xl px-3 py-2.5">
                <div>
                    <p className="text-[11px] text-slate-600 font-medium">启用 Push 加速</p>
                    <p className="text-[10px] text-slate-400">关闭则退回纯本地计时器</p>
                </div>
                <button
                    disabled={ppBusy}
                    onClick={() => {
                        if (ppBusy) return;
                        if (ppEnabled) {
                            void doDisablePushAccelerator();
                        } else {
                            setShowPpConfirm(true);
                        }
                    }}
                    className={`w-10 h-5 rounded-full transition-colors ${ppEnabled ? 'bg-teal-500' : 'bg-slate-300'} ${ppBusy ? 'opacity-60' : ''}`}
                >
                    <div className={`w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${ppEnabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
            </div>

            {/* ───── 诊断面板 ───── */}
            <div className="mt-4 bg-slate-50/70 rounded-2xl p-4 border border-slate-100">
                <div className="flex items-center justify-between mb-3">
                    <p className="text-xs font-semibold text-slate-600">Web Push 状态</p>
                    <button
                        onClick={() => void refreshPpDiag()}
                        className="text-[10px] px-2.5 py-1 rounded-full bg-white border border-slate-200 text-slate-500 hover:bg-slate-50"
                    >
                        刷新
                    </button>
                </div>

                {ppDiag ? (
                    <div className="space-y-1.5 text-[11px]">
                        <DiagRow
                            label="浏览器支持"
                            value={
                                ppDiag.capacitorNative ? '否（当前在 App 里运行）' :
                                ppDiag.supported ? '是' : '否（浏览器缺少推送相关 API）'
                            }
                            bad={!ppDiag.supported || ppDiag.capacitorNative}
                        />
                        <DiagRow
                            label="通知权限"
                            value={
                                ppDiag.permission === 'granted' ? '已授权' :
                                ppDiag.permission === 'denied' ? '已拒绝（请到浏览器站点设置手动开启）' :
                                ppDiag.permission === 'default' ? '未决定' :
                                '不可用'
                            }
                            bad={ppDiag.permission !== 'granted'}
                        />
                        <DiagRow
                            label="Service Worker"
                            value={
                                ppDiag.swState === 'activated' ? `已激活（scope: ${ppDiag.swScope || '?'}）` :
                                ppDiag.swState === 'none' ? '未注册' :
                                `${ppDiag.swState}（scope: ${ppDiag.swScope || '?'}）`
                            }
                            bad={ppDiag.swState !== 'activated'}
                        />
                        <DiagRow
                            label="订阅"
                            value={
                                !ppDiag.endpoint ? '不存在' :
                                ppDiag.endpointDead ? '已失效（zombie endpoint）' :
                                '已建立'
                            }
                            bad={!ppDiag.endpoint || ppDiag.endpointDead}
                        />
                        <DiagRow label="推送通道" value={ppDiag.channel} />
                        <DiagRow
                            label="最近一次唤醒"
                            value={
                                ppDiag.lastWakeAt
                                    ? `${new Date(ppDiag.lastWakeAt).toLocaleString()}${ppDiag.lastWakeChar ? `（${ppDiag.lastWakeChar}）` : ''}`
                                    : '从未'
                            }
                        />
                        {ppDiag.endpoint && (
                            <div className="pt-2 mt-2 border-t border-slate-200">
                                <p className="text-[10px] text-slate-400 mb-1">订阅端点（前 60 字符）</p>
                                <p className={`text-[10px] font-mono break-all leading-relaxed ${ppDiag.endpointDead ? 'text-rose-600' : 'text-slate-500'}`}>{ppDiag.endpoint.slice(0, 60)}…</p>
                            </div>
                        )}
                        {ppDiag.endpointDead && (
                            <div className="mt-2 p-2 bg-rose-50 border border-rose-200 rounded-lg text-[10px] text-rose-700 leading-relaxed">
                                订阅地址是 <code className="font-mono">permanently-removed.invalid</code>——浏览器已经把这个订阅吊销了
                                （常见原因：长期不访问、通知权限切换过、浏览器清理过站点数据）。<br/>
                                这个域名是 RFC 保留 TLD，全球永远不会解析；Worker 试图把 push 投递过去就会回 HTTP 530。<br/>
                                点下方<b>"重置订阅"</b>会清掉这条死订阅并重建一个新的。
                            </div>
                        )}
                        {ppDiag.iosNeedsPwa && (
                            <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded-lg text-[10px] text-amber-700 leading-relaxed">
                                检测到 iOS Safari，但当前不是已添加到主屏幕的 PWA。<br/>
                                iOS 的 Web Push 必须先把网站"添加到主屏幕"启动后才能用。
                            </div>
                        )}
                        {ppDiag.capacitorNative && (
                            <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded-lg text-[10px] text-amber-700 leading-relaxed">
                                你现在是在<b>打包好的 App</b>里运行（不是浏览器网页）。<br/>
                                这个"Push 加速器"只对网页版生效——App 里没有网页推送通道，但<b>不影响你正常用</b>：
                                主动消息会通过 App 的本地通知发出，App 在后台/锁屏也能收到。<br/>
                                下面的"测试推送 / 重置订阅"按钮在 App 里点了也没用，可以直接忽略这个面板。
                            </div>
                        )}
                    </div>
                ) : (
                    <p className="text-[10px] text-slate-400">加载中…</p>
                )}

                {(() => {
                    const inDeepMode = ppZombieStreak >= 3;
                    const resetLabel = inDeepMode
                        ? (ppDeepResetBusy ? '深度重置中…' : '深度重置')
                        : (ppResetBusy ? '重置中…' : '重置订阅');
                    const resetBusy = ppResetBusy || ppDeepResetBusy;
                    return (
                        <div className="mt-4 grid grid-cols-2 gap-2">
                            <button
                                disabled={ppTestBusy || resetBusy || !ppDiag?.endpoint || ppDiag?.endpointDead || ppDiag?.capacitorNative}
                                onClick={() => void doSendTestPush()}
                                className={`py-2 rounded-xl text-xs font-bold ${ppTestBusy || resetBusy || !ppDiag?.endpoint || ppDiag?.endpointDead || ppDiag?.capacitorNative ? 'bg-slate-200 text-slate-400' : 'bg-teal-500 text-white hover:bg-teal-600'}`}
                            >
                                {ppTestBusy ? '测试中…' : '发一条测试推送'}
                            </button>
                            <button
                                disabled={resetBusy || ppTestBusy || ppDiag?.capacitorNative}
                                onClick={() => inDeepMode ? void doDeepResetSubscription() : void doResetSubscription()}
                                className={`py-2 rounded-xl text-xs font-bold border ${resetBusy || ppTestBusy || ppDiag?.capacitorNative ? 'bg-slate-100 text-slate-400 border-slate-200' : inDeepMode || ppDiag?.endpointDead ? 'bg-rose-500 text-white border-rose-500 hover:bg-rose-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
                            >
                                {resetLabel}
                            </button>
                        </div>
                    );
                })()}
                <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
                    "测试推送"会让 Worker 立刻给你这台设备发一条 push，5 秒内系统通知里出现"推送测试成功"= 链路通。
                    "重置订阅"会清掉旧订阅再建一个，适合订阅失效或换浏览器后用。
                    {ppZombieStreak >= 3 && <><br/>连续几次都没成，已切到"深度重置"——点一下做一次更彻底的清理。</>}
                </p>
            </div>
        </section>
        )}

        {/* ───────── Instant Push ───────── */}
        <section className="bg-white/80 rounded-3xl p-5 shadow-sm border border-white/50">
            <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                    <div className="p-2 bg-indigo-100/60 rounded-xl text-indigo-600">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9.348 14.651a3.75 3.75 0 0 1 0-5.303m5.304 0a3.75 3.75 0 0 1 0 5.303m-7.425 2.122a6.75 6.75 0 0 1 0-9.546m9.546 0a6.75 6.75 0 0 1 0 9.546M5.106 18.894c-3.808-3.808-3.808-9.98 0-13.789m13.788 0c3.808 3.808 3.808 9.981 0 13.789M12 12h.008v.008H12V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
                        </svg>
                    </div>
                    <h2 className="text-sm font-semibold text-slate-600 tracking-wider">Instant Push</h2>
                </div>
                <button
                    onClick={() => setShowInstantModal(true)}
                    className="text-[10px] bg-indigo-100 text-indigo-600 px-3 py-1.5 rounded-full font-bold shadow-sm active:scale-95 transition-transform"
                >
                    配置
                </button>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">
                与上方 Push 加速器不同：前端发 prompt 到你自部署的 Worker，Worker 调你自己的 LLM 生成回复后分句逐条 Web Push。零数据库、零 cron。
            </p>
        </section>

        <VersionInfo />
      </div>

      {/* 主动消息 Push 加速 · 启用前确认 */}
      <Modal
          isOpen={showPpConfirm}
          title="启用 Push 加速？"
          onClose={() => setShowPpConfirm(false)}
          footer={
              <div className="flex gap-2 w-full">
                  <button
                      onClick={() => setShowPpConfirm(false)}
                      className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl"
                  >
                      取消
                  </button>
                  <button
                      onClick={() => {
                          setShowPpConfirm(false);
                          void doEnablePushAccelerator();
                      }}
                      className="flex-1 py-3 bg-teal-500 text-white font-bold rounded-2xl shadow-lg shadow-teal-200"
                  >
                      我知道了，启用
                  </button>
              </div>
          }
      >
          <div className="space-y-3 text-[12px] leading-relaxed text-slate-600">
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                  <p className="font-bold text-amber-800 mb-1">启用后会做三件事</p>
                  <ol className="list-decimal pl-4 space-y-1 text-amber-900">
                      <li>浏览器会弹 <b>"允许发送通知？"</b> 的系统对话框——请点"允许"，不然没法在后台唤醒</li>
                      <li>浏览器生成一个 <b>推送订阅凭证</b>（只是一个"门铃地址"，不含任何聊天内容），上传到 Cloudflare</li>
                      <li>开着本应用的标签页时，每 2 分钟给 Cloudflare 发一次心跳；关掉 5 分钟 Cloudflare 自动停止喊你</li>
                  </ol>
              </div>

              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3">
                  <p className="font-bold text-emerald-800 mb-1">谁能看到什么</p>
                  <div className="space-y-1.5 text-emerald-900">
                      <p><b>Cloudflare 能看到：</b>推送订阅凭证 + 角色 ID（一串随机字符串）+ 间隔分钟数。<b>看不到</b>聊天内容、角色人设、AI 回复、API Key、你是谁。</p>
                      <p><b>浏览器厂商的推送服务（Google / Mozilla / Apple）：</b>知道你某时刻收到一条 push，内容是加密的，他们读不到。</p>
                      <p><b>你的 AI 接口供应商：</b>和平时聊天一样，到点时浏览器在<b>本地</b>直接调你在"API 配置"里填的那个接口，走你自己的 key。Cloudflare 完全不碰这一步。</p>
                  </div>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                  <p className="font-bold text-slate-700 mb-1">一句话</p>
                  <p className="text-slate-700">聊天记录和 AI 请求只在你自己和 AI 提供商之间，和现在没开 Push 加速时完全一样。Cloudflare 只是一个"到点按门铃"的闹钟。</p>
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-xl p-3">
                  <p className="font-bold text-blue-800 mb-1">不会主动弹通知打扰你</p>
                  <p className="text-blue-900">浏览器后台标签 → 静默触发，进 app 就看到。浏览器整个关掉 → 下次打开 app 自动补跑，开 app 即有。中间不弹"有人想找你"那种窗口扰你。</p>
              </div>
          </div>
      </Modal>

      {/* Cloud Config Modal */}
      <Modal isOpen={showCloudModal} title="云端备份配置" onClose={() => setShowCloudModal(false)}>
          <div className="space-y-4 p-1">
              <div className="bg-rose-50 border border-rose-200 rounded-xl p-3">
                  <p className="text-[10px] text-rose-700 leading-relaxed">
                      <b>🪜 需要梯子</b><br/>
                      InfiniCloud 是日本的服务，国内直连通常打不开注册页、也无法同步备份。<b>注册和之后每次同步都需要保持梯子开启</b>，否则会连接失败或超时。
                  </p>
              </div>
              <div className="bg-sky-50 rounded-xl p-3">
                  <p className="text-[10px] text-sky-700 leading-relaxed">
                      <b>快速上手 (InfiniCloud, 免费 20GB):</b><br/>
                      1. 注册 <a href="https://infini-cloud.net/" target="_blank" rel="noopener noreferrer" className="text-sky-600 underline font-bold hover:text-sky-800">infini-cloud.net ↗</a>（邮箱验证）<br/>
                      2. 登录后 <b>My Page</b> 最底 → 勾选 <b>Turn on Apps Connection</b><br/>
                      3. 顶栏 <b>Apps</b> → 复制 <b>WebDAV URL</b> / <b>Connection ID</b> / <b>Apps Password</b><br/>
                      4. 用户名填 <b>Connection ID</b>（不是邮箱），密码填 <b>Apps Password</b>
                  </p>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                  <p className="text-[10px] text-amber-800 leading-relaxed">
                      <b>⚠️ Apps Password ≠ 登录密码</b><br/>
                      <b>Apps Password</b> 是 <b>Apps</b> 页面里显示在 <b>WebDAV URL</b>、<b>Connection ID</b> <b>下方</b>的一串<b>可复制</b>的应用专用密码，往下滚就能看到。直接把它复制粘贴到上面的"密码"框即可，用账号登录密码会 401。
                  </p>
              </div>
              <div>
                  <label className="text-[11px] text-slate-500 font-medium mb-1 block">WebDAV 地址</label>
                  <input type="url" value={cbUrl} onChange={(e) => setCbUrl(e.target.value)} placeholder="https://xxx.infini-cloud.net/dav/" className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 focus:border-sky-400 focus:ring-1 focus:ring-sky-200 outline-none" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                  <div>
                      <label className="text-[11px] text-slate-500 font-medium mb-1 block">用户名</label>
                      <input type="text" value={cbUsername} onChange={(e) => setCbUsername(e.target.value)} placeholder="邮箱或用户名" className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 focus:border-sky-400 focus:ring-1 focus:ring-sky-200 outline-none" />
                  </div>
                  <div>
                      <label className="text-[11px] text-slate-500 font-medium mb-1 block">密码</label>
                      <input type="password" value={cbPassword} onChange={(e) => setCbPassword(e.target.value)} placeholder="应用专用密码" className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 focus:border-sky-400 focus:ring-1 focus:ring-sky-200 outline-none" />
                  </div>
              </div>
              <div>
                  <label className="text-[11px] text-slate-500 font-medium mb-1 block">备份目录</label>
                  <input type="text" value={cbPath} onChange={(e) => setCbPath(e.target.value)} placeholder="/SullyBackup/" className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 focus:border-sky-400 focus:ring-1 focus:ring-sky-200 outline-none" />
              </div>
              <button onClick={handleTestCloudConnection} disabled={cloudTesting || !cbUrl || !cbUsername || !cbPassword} className="w-full py-2.5 bg-slate-100 border border-slate-200 rounded-xl text-xs font-bold text-slate-600 disabled:opacity-40">
                  {cloudTesting ? '测试中...' : '测试连接'}
              </button>
              {cloudTestResult && (
                  <p className={`text-[11px] text-center font-medium ${cloudTestResult.startsWith('✓') ? 'text-green-600' : 'text-red-500'}`}>{cloudTestResult}</p>
              )}
              <div className="grid grid-cols-2 gap-3 pt-2">
                  <button onClick={() => setShowCloudModal(false)} className="py-2.5 bg-slate-100 rounded-xl text-xs font-bold text-slate-500">取消</button>
                  <button onClick={handleSaveCloudConfig} disabled={!cbUrl || !cbUsername || !cbPassword} className="py-2.5 bg-sky-500 rounded-xl text-xs font-bold text-white disabled:opacity-40">保存配置</button>
              </div>
              {cloudBackupConfig.enabled && (
                  <button onClick={() => { updateCloudBackupConfig({ enabled: false }); setShowCloudModal(false); addToast('云端备份已关闭', 'info'); }} className="w-full py-2 text-[11px] text-red-400 font-medium">关闭云端备份</button>
              )}
          </div>
      </Modal>

      {/* GitHub Backup Modal — minimum-input flow: paste a token, we figure
          out owner via /user and auto-create a private 'sully-backup' repo. */}
      <Modal isOpen={showGithubModal} title="GitHub 备份" onClose={() => setShowGithubModal(false)}>
          <div className="space-y-4 p-1">
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                  <p className="text-[11px] text-slate-700 leading-relaxed">
                      <b>三步搞定，不用梯子：</b><br/>
                      ① 点下面按钮跳到 GitHub 创建 Token<br/>
                      ② 复制 token，回来粘到下面框里<br/>
                      ③ 点 <b>测试并连接</b> — 我们会自动帮你建好私有仓库 <code className="bg-white px-1 rounded">{ghRepo || 'sully-backup'}</code>
                  </p>
              </div>

              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                  <p className="text-[10px] text-amber-800 leading-relaxed">
                      <b>⚠️ 在 GitHub 那一页只改一处:</b><br/>
                      把 <b>Expiration</b>(有效期)下拉框 <b>从 90天 改成 No expiration</b>（永不过期）。
                      不改的话 90 天后 token 过期，备份会突然 401。<br/>
                      其它都别动 —— Note 已经填好「Sully 备份」，<b>repo</b> 权限已经勾上了，
                      直接拉到最底点绿色 <b>Generate token</b> 即可。
                  </p>
              </div>

              <a
                  href="https://github.com/settings/tokens/new?scopes=repo&description=Sully%20%E5%A4%87%E4%BB%BD"
                  target="_blank" rel="noopener noreferrer"
                  className="block w-full py-3 bg-gradient-to-br from-slate-800 to-slate-900 text-white rounded-xl text-xs font-bold text-center shadow-sm active:scale-95 transition-all"
              >
                  ① 去 GitHub 创建 Token ↗
              </a>

              <div>
                  <label className="text-[11px] text-slate-500 font-medium mb-1 block">② Personal Access Token</label>
                  <input
                      type="password"
                      value={ghToken}
                      onChange={(e) => setGhToken(e.target.value)}
                      placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                      className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 font-mono focus:border-slate-500 focus:ring-1 focus:ring-slate-300 outline-none"
                  />
                  <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">
                      Token 只存在你本机，永远不会发到我们服务器。
                  </p>
              </div>

              <button
                  onClick={handleTestGithub}
                  disabled={ghTesting || !ghToken.trim()}
                  className="w-full py-3 bg-gradient-to-r from-emerald-500 to-green-600 text-white rounded-xl text-xs font-bold shadow-sm active:scale-95 transition-all disabled:opacity-40"
              >
                  {ghTesting ? '连接中...' : '③ 测试并连接'}
              </button>
              {ghTestResult && (
                  <p className={`text-[11px] text-center font-medium ${ghTestResult.startsWith('✓') ? 'text-green-600' : 'text-red-500'}`}>
                      {ghTestResult}
                  </p>
              )}
              {ghTestResult.startsWith('✓') && cloudBackupConfig.githubOwner && (
                  <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 space-y-1.5">
                      <p className="text-[11px] text-emerald-800 font-medium">
                          🎉 备份会上传到这里:
                      </p>
                      <a
                          href={`https://github.com/${cloudBackupConfig.githubOwner}/${cloudBackupConfig.githubRepo || 'sully-backup'}/releases`}
                          target="_blank" rel="noopener noreferrer"
                          className="block text-[10px] text-emerald-700 font-mono break-all underline hover:text-emerald-900"
                      >
                          github.com/{cloudBackupConfig.githubOwner}/{cloudBackupConfig.githubRepo || 'sully-backup'}/releases ↗
                      </a>
                      <p className="text-[10px] text-emerald-700 leading-relaxed">
                          每次备份会创建一个新的 release（带时间戳）。想看 / 删除旧备份就去这个网址。
                      </p>
                  </div>
              )}

              <button
                  onClick={() => setGhShowAdvanced(v => !v)}
                  className="w-full text-[10px] text-slate-400 underline-offset-2 hover:underline"
              >
                  {ghShowAdvanced ? '收起高级选项 ▲' : '高级选项 ▼'}
              </button>
              {ghShowAdvanced && (
                  <div className="space-y-3 bg-slate-50 rounded-xl p-3">
                      <div>
                          <label className="text-[11px] text-slate-500 font-medium mb-1 block">备份仓库名</label>
                          <input
                              type="text"
                              value={ghRepo}
                              onChange={(e) => setGhRepo(e.target.value)}
                              placeholder="sully-backup"
                              className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 font-mono focus:border-slate-500 outline-none"
                          />
                          <p className="text-[10px] text-slate-400 mt-1">不存在会自动创建为私有仓库。</p>
                      </div>
                      <label className="flex items-center gap-2 text-[11px] text-slate-600 cursor-pointer">
                          <input
                              type="checkbox"
                              checked={ghUseProxy}
                              onChange={(e) => setGhUseProxy(e.target.checked)}
                              className="rounded"
                          />
                          <span>走 Cloudflare 代理（默认开，国内必需；能直连 GitHub 的可关掉提速）</span>
                      </label>
                      <p className="text-[10px] text-slate-400 leading-relaxed pl-5">
                          大于 80MB 的备份会自动切成多片上传，所以勾着也能传 1GB+ 的完整备份，恢复时自动拼回来。能直连 github.com 的可以关掉提速。
                      </p>
                  </div>
              )}

              <div className="grid grid-cols-2 gap-3 pt-2">
                  <button onClick={() => setShowGithubModal(false)} className="py-2.5 bg-slate-100 rounded-xl text-xs font-bold text-slate-500">关闭</button>
                  {cloudBackupConfig.enabled && cloudBackupConfig.provider === 'github' ? (
                      <button onClick={handleDisableCloud} className="py-2.5 bg-red-50 text-red-500 rounded-xl text-xs font-bold">断开 GitHub</button>
                  ) : (
                      <button
                          onClick={() => setShowGithubModal(false)}
                          disabled={!cloudBackupConfig.enabled || cloudBackupConfig.provider !== 'github'}
                          className="py-2.5 bg-slate-800 text-white rounded-xl text-xs font-bold disabled:opacity-30"
                      >
                          完成
                      </button>
                  )}
              </div>
          </div>
      </Modal>

      {/* Cloud Restore Modal */}
      <Modal isOpen={showCloudRestoreModal} title="从云端恢复" onClose={() => setShowCloudRestoreModal(false)}>
          <div className="space-y-2 p-1">
              {cloudBackupFiles.length === 0 ? (
                  <div className="text-center py-8"><p className="text-[11px] text-slate-400">正在加载云端备份列表...</p></div>
              ) : (
                  <>
                      <p className="text-[10px] text-slate-400 mb-2">选择要恢复的备份文件:</p>
                      <div className="max-h-[50vh] overflow-y-auto space-y-2">
                          {cloudBackupFiles.map((file, i) => (
                              <button key={i} onClick={() => handleCloudRestore(file)} className="w-full p-3 bg-white border border-slate-200 rounded-xl text-left hover:bg-sky-50 hover:border-sky-200 transition-colors active:scale-[0.98]">
                                  <p className="text-[11px] text-slate-700 font-medium truncate">{file.name}</p>
                                  <div className="flex items-center gap-3 mt-1">
                                      <span className="text-[10px] text-slate-400">{file.lastModified ? new Date(file.lastModified).toLocaleString('zh-CN') : '未知时间'}</span>
                                      <span className="text-[10px] text-slate-400">{file.size > 0 ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : ''}</span>
                                  </div>
                              </button>
                          ))}
                      </div>
                  </>
              )}
          </div>
      </Modal>

      {/* 模型选择 Modal */}
      <Modal isOpen={showModelModal} title="选择模型" onClose={() => setShowModelModal(false)}>
        {(() => {
            const { filtered, commonPrefix } = modelPickerView;
            return (
                <div className="space-y-3 p-1">
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={localModel}
                            onChange={(e) => setLocalModel(e.target.value)}
                            placeholder="手动输入模型名称..."
                            className="flex-1 bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:outline-primary focus:bg-white transition-all"
                        />
                        <button
                            onClick={() => setShowModelModal(false)}
                            className="px-4 py-2.5 bg-primary text-white text-sm font-bold rounded-xl active:scale-95 transition-all"
                        >
                            确定
                        </button>
                    </div>
                    {availableModels.length > 0 && (
                        <div className="relative">
                            <input
                                type="text"
                                value={modelFilter}
                                onChange={(e) => setModelFilter(e.target.value)}
                                placeholder={`🔍 搜索 ${availableModels.length} 个模型...`}
                                className="w-full bg-slate-50 border border-slate-200/60 rounded-xl px-4 py-2 text-xs focus:outline-primary focus:bg-white transition-all"
                            />
                            {modelFilter && (
                                <button
                                    onClick={() => setModelFilter('')}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs px-2"
                                >
                                    ×
                                </button>
                            )}
                        </div>
                    )}
                    {commonPrefix && (
                        <div className="text-[10px] text-slate-400 px-1 flex items-center gap-1 flex-wrap">
                            <span>共同前缀:</span>
                            <code className="font-mono bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded break-all">{commonPrefix}</code>
                            <span className="text-slate-300">(下方已弱化显示)</span>
                        </div>
                    )}
                    <div className="max-h-[40vh] overflow-y-auto no-scrollbar space-y-2">
                        {filtered.length > 0 ? filtered.map(m => {
                            const suffix = commonPrefix && m.startsWith(commonPrefix) ? m.slice(commonPrefix.length) : m;
                            const selected = m === localModel;
                            return (
                                <button
                                    key={m}
                                    onClick={() => { setLocalModel(m); setShowModelModal(false); }}
                                    title={m}
                                    className={`w-full text-left px-4 py-3 rounded-xl text-sm font-mono flex justify-between items-start gap-2 ${selected ? 'bg-primary/10 text-primary font-bold ring-1 ring-primary/20' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'}`}
                                >
                                    <span className="break-all min-w-0 flex-1 leading-relaxed">
                                        {commonPrefix && suffix !== m && (
                                            <span className={selected ? 'text-primary/40 font-normal' : 'text-slate-400 font-normal'}>{commonPrefix}</span>
                                        )}
                                        <span>{suffix}</span>
                                    </span>
                                    {selected && <div className="w-2 h-2 rounded-full bg-primary mt-1.5 flex-shrink-0"></div>}
                                </button>
                            );
                        }) : (
                            <div className="text-center text-slate-400 py-8 text-xs">
                                {availableModels.length === 0
                                    ? '列表为空，可手动输入或点击"刷新模型列表"拉取'
                                    : `没有匹配 "${modelFilter}" 的模型`}
                            </div>
                        )}
                    </div>
                </div>
            );
        })()}
      </Modal>

      {/* API 调用记录页面 */}
      <ApiCallLogModal isOpen={showApiCallLog} onClose={() => setShowApiCallLog(false)} />

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
                          <p className="text-xs text-blue-600/70">默认主源：中文多平台热榜（免鉴权，聊天时角色会自动捕捉热点）。选择要关注的平台：</p>
                          <div className="flex flex-wrap gap-1.5">
                              {HOTNEWS_PLATFORM_OPTIONS.map(p => {
                                  const active = rtNewsPlatforms.includes(p.key);
                                  return (
                                      <button
                                          key={p.key}
                                          type="button"
                                          onClick={() => setRtNewsPlatforms(prev => prev.includes(p.key) ? prev.filter(k => k !== p.key) : [...prev, p.key])}
                                          className={`text-[11px] px-2.5 py-1 rounded-full font-bold transition-colors active:scale-95 ${active ? 'bg-blue-500 text-white shadow-sm' : 'bg-white/80 text-slate-500 border border-blue-200'}`}
                                      >
                                          {p.label}
                                      </button>
                                  );
                              })}
                          </div>
                          {rtNewsPlatforms.length === 0 && (
                              <p className="text-[10px] text-rose-500/80">未选任何平台时会回落到 Brave / Hacker News。</p>
                          )}
                          <details className="border-t border-blue-200/50 pt-2 mt-1 group">
                              <summary className="text-[10px] font-bold text-slate-400 uppercase cursor-pointer select-none list-none flex items-center gap-1.5">
                                  <span className="transition-transform group-open:rotate-90">›</span>
                                  Brave Search（回落源 · <span className="text-rose-400">不建议配置</span>）
                              </summary>
                              <div className="mt-2 space-y-1.5">
                                  <p className="text-[10px] text-slate-400/90 leading-relaxed">
                                      上面的中文热榜在国内场景比 Brave 好用一万倍，<b className="text-slate-500">基本不需要配这个</b>。
                                      它只是热榜彻底拉不到时的英文回落，配了反而可能盖掉中文热点。除非你清楚自己在做什么，否则留空即可。
                                  </p>
                                  <input type="password" value={rtNewsApiKey} onChange={e => setRtNewsApiKey(e.target.value)} className="w-full bg-white/60 border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono text-slate-500" placeholder="（不建议）brave.com/search/api" />
                                  <p className="text-[10px] text-slate-400/70">仅当中文热榜拉取失败时才启用；都不可用时再兜底 Hacker News（英文）。</p>
                              </div>
                          </details>
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
                          <span className="text-sm font-bold text-red-700">小红书 · 本地</span>
                          <span className="text-[9px] bg-red-100 text-red-500 px-1.5 py-0.5 rounded-full">MCP / Skills</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={rtXhsMcpEnabled && rtXhsMode === 'local'} onChange={e => { if (e.target.checked) { setRtXhsMcpEnabled(true); setRtXhsEnabled(true); setRtXhsMode('local'); } else { setRtXhsMcpEnabled(false); setRtXhsEnabled(false); } }} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-red-500"></div>
                      </label>
                  </div>
                  <p className="text-[10px] text-red-500/70 leading-relaxed">
                      本地后端：需在电脑上跑 xiaohongshu-mcp 或 xhs-bridge。想免电脑请用下面的「小红书 Lite」。
                  </p>
                  {rtXhsMcpEnabled && rtXhsMode === 'local' && (
                      <div className="space-y-2">
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">服务器 URL</label>
                              <input value={rtXhsLocalUrl} onChange={e => setRtXhsLocalUrl(e.target.value)} className="w-full bg-white/80 border border-red-200 rounded-xl px-3 py-2 text-[11px] font-mono" placeholder="http://localhost:18060/mcp" />
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
                              <b>MCP 模式:</b> 下载 xiaohongshu-mcp + 运行脚本，URL 填 http://localhost:18060/mcp（代理则 18061/mcp）<br/>
                              <b>Skills 模式:</b> URL 填 http://localhost:18061/api（需 Python + xhs-bridge.mjs，额外支持视频/长文）<br/>
                              系统按 URL 结尾自动判断（/mcp 或 /api）。
                          </p>
                      </div>
                  )}
              </div>

              {/* 小红书 Lite (云端) */}
              <div className="bg-rose-50/60 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <Book size={20} weight="fill" />
                          <span className="text-sm font-bold text-rose-700">小红书 Lite</span>
                          <span className="text-[9px] bg-rose-100 text-rose-500 px-1.5 py-0.5 rounded-full">云端 · 推荐</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={rtXhsMcpEnabled && rtXhsMode === 'lite'} onChange={e => { if (e.target.checked) { if (!window.confirm(XHS_RISK_TEXT + '\n\n确定要开启吗？')) return; setRtXhsMcpEnabled(true); setRtXhsEnabled(true); setRtXhsMode('lite'); } else { setRtXhsMcpEnabled(false); setRtXhsEnabled(false); } }} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-rose-500"></div>
                      </label>
                  </div>
                  <p className="text-[10px] text-rose-500/70 leading-relaxed">
                      免电脑、免扫码：粘贴一次小红书 cookie，即可搜索/浏览/详情/点赞/收藏/评论/发帖(带图)。地址已内置，无需填写。
                  </p>
                  <p className="text-[10px] text-amber-700 leading-relaxed bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">{XHS_RISK_TEXT}</p>
                  {rtXhsMcpEnabled && rtXhsMode === 'lite' && (
                      <div className="space-y-2">
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">小红书 Cookie</label>
                              <textarea value={rtXhsCookie} onChange={e => setRtXhsCookie(e.target.value)} rows={2} className="w-full bg-white/80 border border-rose-200 rounded-xl px-3 py-2 text-[10px] font-mono resize-y" placeholder="a1=...; web_session=...; （从浏览器登录后复制完整 cookie）" />
                          </div>
                          <button onClick={testXhsMcp} className="w-full py-2 bg-rose-100 text-rose-600 text-xs font-bold rounded-xl active:scale-95 transition-transform">测试连接</button>
                          <div className="grid grid-cols-2 gap-2">
                              <div>
                                  <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">小红书昵称</label>
                                  <input value={rtXhsNickname} onChange={e => setRtXhsNickname(e.target.value)} className="w-full bg-white/80 border border-rose-200 rounded-xl px-3 py-2 text-[11px]" placeholder="测试连接后自动获取" />
                              </div>
                              <div>
                                  <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">用户 ID</label>
                                  <input value={rtXhsUserId} onChange={e => setRtXhsUserId(e.target.value)} className="w-full bg-white/80 border border-rose-200 rounded-xl px-3 py-2 text-[11px] font-mono" placeholder="自动获取" />
                              </div>
                          </div>
                          <div>
                              <button type="button" onClick={() => setRtXhsGuideOpen(v => !v)} className="text-[11px] font-bold text-rose-600 underline">📖 点击获取 cookie 教程 {rtXhsGuideOpen ? '▲' : '▼'}</button>
                              {rtXhsGuideOpen && (
                                  <div className="mt-1 bg-white/70 rounded-lg p-2 space-y-1.5">
                                      <pre className="text-[10px] text-slate-600 whitespace-pre-wrap font-sans leading-relaxed">{XHS_COOKIE_GUIDE}</pre>
                                      <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(XHS_COOKIE_GUIDE); addToast('教程已复制，可粘贴去问别的 AI', 'success'); } catch { addToast('复制失败，请长按手动选择', 'error'); } }} className="w-full py-1.5 bg-rose-100 text-rose-600 text-[11px] font-bold rounded-lg active:scale-95 transition-transform">复制教程</button>
                                  </div>
                              )}
                          </div>
                          <p className="text-[10px] text-slate-400 leading-relaxed bg-slate-100/60 rounded-lg px-2 py-1.5">
                              🔒 隐私：cookie 经 HTTPS 加密发到云端 Worker 仅用于请求签名，服务器<b>不保存、不记录</b>，运营方看不到。正常使用是安全的；但凡经第三方云服务都存在理论风险，介意可自行评估。
                          </p>
                      </div>
                  )}
              </div>

              {/* 麦当劳 MCP */}
              <div className="bg-yellow-50/60 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <ForkKnife size={20} weight="fill" className="text-yellow-600" />
                          <span className="text-sm font-bold text-yellow-700">麦当劳</span>
                          <span className="text-[9px] bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded-full">官方 MCP</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={mcdEnabled} onChange={e => handleMcdEnabledChange(e.target.checked)} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-yellow-500"></div>
                      </label>
                  </div>
                  <p className="text-[10px] text-yellow-700/70 leading-relaxed">
                      启用后，在聊天里点 + 号 → 第二页 → 麦当劳，发送"麦请求"激活，角色就能为你查菜单、查门店、点麦乐送/到店取餐/团餐、积分兑券、查活动。
                  </p>
                  {mcdEnabled && (
                      <div className="space-y-2">
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">MCP Token (个人)</label>
                              <input type="password" value={mcdToken} onChange={e => handleMcdTokenChange(e.target.value)} className="w-full bg-white/80 border border-yellow-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="去 open.mcd.cn/mcp 申请" />
                          </div>
                          <button onClick={testMcdApi} disabled={mcdTesting} className="w-full py-2 bg-yellow-100 text-yellow-700 text-xs font-bold rounded-xl active:scale-95 transition-transform disabled:opacity-60">
                              {mcdTesting ? '测试中…' : '测试连接'}
                          </button>
                          {mcdTestStatus && (
                              <div className={`p-2 rounded-lg text-[11px] whitespace-pre-line leading-relaxed ${mcdTestStatus.startsWith('✅') ? 'bg-emerald-50 text-emerald-700' : mcdTestStatus.startsWith('❌') ? 'bg-red-50 text-red-600' : 'bg-slate-50 text-slate-600'}`}>
                                  {mcdTestStatus}
                              </div>
                          )}
                          <p className="text-[10px] text-yellow-700/70 leading-relaxed">
                              1. 访问 <a href="https://open.mcd.cn/mcp" target="_blank" className="underline">open.mcd.cn/mcp</a> 用麦当劳账号登录申请 Token<br/>
                              2. 粘贴到上面的输入框（仅存本地，<b>不会上传服务器</b>）<br/>
                              3. 下单类操作涉及真实支付，角色会先复述清单等你确认再下单<br/>
                              4. 仅中国大陆 (不含港澳台)
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

      <InstantPushSettingsModal
        open={showInstantModal}
        onClose={() => setShowInstantModal(false)}
        onOpenVapid={() => { setShowInstantModal(false); setShowVapidModal(true); }}
      />
      <PushVapidSettingsModal
        open={showVapidModal}
        onClose={() => { setShowVapidModal(false); setVapidReadyTick((n) => n + 1); }}
      />

    </div>
  );
};

export default Settings;
