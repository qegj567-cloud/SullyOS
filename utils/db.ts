


import {
    CharacterProfile, ChatTheme, Message, UserProfile,
    Task, Anniversary, DiaryEntry, RoomTodo, RoomNote, DailySchedule,
    GalleryImage, FullBackupData, GroupProfile, SocialPost, StudyCourse, GameSession, Worldbook, NovelBook, Emoji, EmojiCategory,
    BankTransaction, SavingsGoal, BankFullState, DollhouseState, XhsStockImage, XhsActivityRecord, SongSheet, QuizSession, GuidebookSession,
    LifeSimState, HandbookEntry, Tracker, TrackerEntry, HotNewsSnapshot,
    LifeRecord, MedPlan, LifeRecordSettings, CharacterGroup,
    VRWorldNovel, VRNovelAnnotation, CustomCreatorPart, VRMusicRoomState, VRGuestbookState, VRScript, VRStagedPlay, VRLetter,
    WorldProfile, WorldEpisode
} from '../types';
import { exportPostOfficeLocal, importPostOfficeLocal } from './vrWorld/postOffice';
import { exportSignalLocal, importSignalLocal } from './vrWorld/signal';
import { exportLuckinLocal, importLuckinLocal } from './luckinMcpClient';
import { exportMcdLocal, importMcdLocal } from './mcdMcpClient';
import { exportWereadLocal, importWereadLocal } from './wereadMcpClient';
import { exportMcpLocal, importMcpLocal } from './mcpClient';
import { exportWorldHomeLocal, importWorldHomeLocal } from './worldHome/localBackup';
import { exportDesktopSkinLocal, importDesktopSkinLocal } from './desktopSkinBackup';

const DB_NAME = 'AetherOS_Data';
// v67：两条并行线各自用掉了 v65/v66（A线: blob_assets + 生活记录；B线: room_plates 门牌 + digest_reports 消化日志），
// 合并后统一推到 67——建表全部走幂等的 if(!contains)，任一侧的 v66 老库升级时都会补齐缺的那组表。
// v68：character_groups 角色分组（神经链接"文件夹"，见 types.ts CharacterGroup）。
const DB_VERSION = 68;

const STORE_CHARACTERS = 'characters';
const STORE_CHAR_GROUPS = 'character_groups'; // 角色分组定义（角色通过 groupId 指向；与群聊 groups 无关）
const STORE_MESSAGES = 'messages';
const STORE_EMOJIS = 'emojis';
const STORE_EMOJI_CATEGORIES = 'emoji_categories'; 
const STORE_THEMES = 'themes';
const STORE_ASSETS = 'assets';
const STORE_BLOB_ASSETS = 'blob_assets'; // 图片二进制 Blob 存储（key=生成 id，value={id, blob}）；壁纸/小屋等图片改存 Blob 而非 base64，省 ~33% 空间且不占 JS 堆。见 utils/blobRef.ts
const STORE_SCHEDULED = 'scheduled_messages'; 
const STORE_GALLERY = 'gallery';
const STORE_USER = 'user_profile'; 
const STORE_DIARIES = 'diaries';
const STORE_TASKS = 'tasks'; 
const STORE_ANNIVERSARIES = 'anniversaries';
const STORE_ROOM_TODOS = 'room_todos'; 
const STORE_ROOM_NOTES = 'room_notes'; 
const STORE_GROUPS = 'groups'; 
const STORE_JOURNAL_STICKERS = 'journal_stickers';
const STORE_SOCIAL_POSTS = 'social_posts';
const STORE_COURSES = 'courses';
const STORE_GAMES = 'games';
const STORE_WORLDBOOKS = 'worldbooks'; 
const STORE_NOVELS = 'novels'; 
const STORE_BANK_TX = 'bank_transactions';
const STORE_BANK_DATA = 'bank_data';
const STORE_XHS_STOCK = 'xhs_stock';
const STORE_XHS_ACTIVITIES = 'xhs_activities';
const STORE_SONGS = 'songs';
const STORE_QUIZZES = 'quizzes';
const STORE_GUIDEBOOK = 'guidebook';
const STORE_LIFE_SIM = 'life_sim';
const STORE_DAILY_SCHEDULE = 'daily_schedule';
const STORE_HANDBOOK = 'handbook'; // 跨角色聚合手账，每天一条 entry，id = 'YYYY-MM-DD'
const STORE_TRACKERS = 'trackers';                // 手账打卡 tracker 定义
const STORE_TRACKER_ENTRIES = 'tracker_entries';  // tracker 每日打卡数据
const STORE_HOTNEWS = 'hotnews_snapshots';        // 分时段热点快照（全角色共享，key=日期#时段）
const STORE_VR_NOVELS = 'vr_novels';              // 虚拟世界「彼方」全局小说库（所有角色共享原文）
const STORE_VR_ANNOTATIONS = 'vr_annotations';    // 虚拟世界小说批注（per-segment per-char，可互相吐槽）
const STORE_CC_PARTS = 'cc_custom_parts';         // 捏脸系统自定义部件（开发模式追加，注入捏人器）
const STORE_VR_MUSIC = 'vr_music';                // 听歌房共享状态（单例 nowPlaying + 循环队列）
const STORE_VR_GUESTBOOK = 'vr_guestbook';        // 留言簿共享版聊墙（单例 messages）
const STORE_VR_SCRIPTS = 'vr_scripts';            // 剧院·投稿剧本库（每份剧本一条）
const STORE_VR_PLAYS = 'vr_plays';                // 剧院·历史舞台剧（每场演出一条）
const STORE_VR_PRESETS = 'vr_presets';            // 剧院·用户自定义写作风格预设（key 为主键）
const STORE_VR_LETTERS = 'vr_letters';            // 邮局信件（本地存档 + 待寄出/待回复队列）
const STORE_VR_SETTINGS = 'vr_settings';          // 彼方设置单例：独立 API（id='api'）+ 调用记录（id='apilog'）
const STORE_API_CALL_LOG = 'api_call_log';        // 全局 API 调用记录单例（id='log'，保留近 5 天）
const STORE_WORLDS = 'worlds';                    // 家园·世界定义（成员/NPC/居住/关系/模式）
const STORE_WORLD_EPISODES = 'world_episodes';    // 家园·演绎历史（每轮一条，index worldId）
const STORE_LIFE_RECORDS = 'life_records';        // 生活记录：生理期/药盒打卡/锻炼（记账走 bank_transactions）
const STORE_MED_PLANS = 'med_plans';              // 药盒计划（每天几点吃什么药）
const STORE_LIFE_SETTINGS = 'life_record_settings'; // 生活记录设置单例（id='main'：周期长度等）

// API 调用记录：保留近 5 天，超期丢弃；再加一个硬上限防止异常情况撑爆
const API_CALL_LOG_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000;
const API_CALL_LOG_MAX_ENTRIES = 2000;

export interface ScheduledMessage {
    id: string;
    charId: string;
    content: string;
    dueAt: number;
    createdAt: number;
}

// Built-in Presets
const SULLY_CATEGORY_ID = 'cat_sully_exclusive';
const SULLY_PRESET_EMOJIS = [
    { name: 'Sully晚安', url: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/night.png', categoryId: SULLY_CATEGORY_ID },
    { name: 'Sully无语', url: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/w.png', categoryId: SULLY_CATEGORY_ID },
    { name: 'Sully偷看', url: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/see.png', categoryId: SULLY_CATEGORY_ID },
    { name: 'Sully打气', url: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/fight.png', categoryId: SULLY_CATEGORY_ID },
    { name: 'Sully生气', url: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/an.png', categoryId: SULLY_CATEGORY_ID },
    { name: 'Sully疑惑', url: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/sDN.png', categoryId: SULLY_CATEGORY_ID },
    { name: 'Sully道歉', url: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/sorry.png', categoryId: SULLY_CATEGORY_ID },
    { name: 'Sully等你消息', url: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/wait.png', categoryId: SULLY_CATEGORY_ID },
];

// 单例连接缓存。openDB 原本每次调用都新开一条 IDB 连接, 既不复用也不 close ——
// 在记忆管线 (hybridSearch / touchAccess 等) 并发读写下会瞬间堆出几十条 AetherOS_Data
// 连接, 撑爆 Chromium 底层 backing store; 一旦底层报错, 整个 origin 的 IndexedDB
// (含 Service Worker 的 dedupe / inbox 库) 可能跟着开不了或被强关, Instant Push 因此确认超时。
// 改成复用同一条连接, 并在连接被外部失效 (另一 tab 升级版本 / 浏览器强制关闭) 时
// 清掉缓存, 下次 openDB 自动重开 —— 一处改, 全部 ~165 个调用点受益。
let dbPromise: Promise<IDBDatabase> | null = null;

export const openDB = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise;

  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    // onblocked 不是终态: 它先 reject, 但底层 open request 还活着, 等占用方关闭后仍会
    // 触发 onsuccess。用 settled 标记 promise 已 settle, 让那条迟到的连接被 close 掉而
    // 不是泄漏成一条没人持有、却能 block 后续升级/删库的孤儿连接。
    // 清缓存一律先比对 dbPromise === promise: onclose/onerror 等都是异步回调, 期间若已
    // 重开并缓存了新 promise, 陈旧连接的回调不能误清新单例 (否则又凭空多开一条连接)。
    let settled = false;

    request.onerror = () => {
        const err = request.error;
        // 版本回退兜底: 浏览器里已存在「比当前 build 的 DB_VERSION 更高」的版本时
        // (用户先跑过更新的 build / 另一个 tab 升过级 / SW 缓存了更新的 bundle),
        // 带 DB_VERSION 打开会抛 VersionError("lower version than existing")。
        // 旧逻辑直接 reject → 整个 origin 的 IndexedDB 读写全挂: SYSTEM ERROR、
        // 美化(themes 存在库里)读不出来、线下(LifeSim)进不去。其实更高版本的 store
        // 只是当前 schema 的超集, 不带版本号打开就能连到现有版本、读写完全兼容,
        // 不需要也不能降级建表。所以这里回退到「不带版本号 open」一次而不是报死。
        if (err?.name === 'VersionError') {
            console.warn('[DB] open VersionError —— 现有版本高于当前 build, 回退到不带版本号打开');
            settled = true; // 原 request 已终结 (VersionError 后不会再 onsuccess), 标记以防迟到回调
            const fb = indexedDB.open(DB_NAME); // 不带版本号 = 连到现有(更高)版本, 不触发 upgrade
            fb.onsuccess = () => {
                const db = fb.result;
                // 与正常路径一致地挂上失效自愈回调 (另一 tab 升级 / 浏览器强关连接)。
                db.onversionchange = () => {
                    db.close();
                    if (dbPromise === promise) dbPromise = null;
                };
                db.onclose = () => {
                    if (dbPromise === promise) dbPromise = null;
                };
                resolve(db);
            };
            fb.onerror = () => {
                console.error("DB Open Error (versionless fallback):", fb.error);
                if (dbPromise === promise) dbPromise = null;
                reject(fb.error);
            };
            return;
        }
        console.error("DB Open Error:", err);
        if (dbPromise === promise) dbPromise = null; // 打开失败别把 rejected promise 缓存住
        settled = true;
        reject(err);
    };

    request.onsuccess = () => {
        const db = request.result;
        // 已经 reject 过 (onblocked / onerror): 这条迟到的连接没人接收, 直接 close,
        // 否则它开着会 block 后续的版本升级 / deleteDatabase。
        if (settled) {
            try { db.close(); } catch { /* ignore */ }
            return;
        }
        // 另一个 tab 触发版本升级时必须主动 close 让位, 否则对方 open 会被 block;
        // 顺手清缓存, 下次 openDB 重开到新版本。
        db.onversionchange = () => {
            db.close();
            if (dbPromise === promise) dbPromise = null;
        };
        // Chromium 因 backing store 出错等原因强制关闭连接时触发 —— 清缓存自愈,
        // 避免后续操作一直复用一条已死的连接。
        //
        // 已知残余 (有意不修): onclose 是异步派发的, 强关到回调跑之间, 命中这条 fast-path
        // 的调用方会拿到将死连接, 其 db.transaction() 同步抛 InvalidStateError —— 当次操作
        // 失败, 但下一次调用就自愈。主库这 ~165 个调用点全是记忆管线 / UI 读写, 失败是
        // 瞬时且会自然重试的 (不丢数据), 不值得为它给每个调用点铺事务级重试 (要全覆盖得上
        // 共享 runTx 层并迁移所有 DB.* 方法, 是独立大重构)。SW inbox 那条路径不一样: 同样
        // 的竞态会让 push 静默丢失 → 主线程超时, 所以那边 (worker/sw-keep-alive.ts 的
        // withInboxTx) 单独补了「InvalidStateError 清缓存重开一次」的事务级兜底。
        db.onclose = () => {
            if (dbPromise === promise) dbPromise = null;
        };
        resolve(db);
    };

    request.onblocked = () => {
        // 另一个 tab 仍持有旧版本连接, 升级被挡。清缓存 + reject, 别让调用方无限挂着;
        // 与 activeMsgStore / sw-keep-alive 的 openDB 一致, 对方 tab 关闭后下次调用可重试。
        console.warn('[DB] open blocked —— 另一个 tab 仍持有旧版本连接未关闭');
        if (dbPromise === promise) dbPromise = null;
        settled = true;
        reject(new Error('IndexedDB open blocked —— 关闭其它标签页后重试'));
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      const createStore = (name: string, options?: IDBObjectStoreParameters) => {
          if (!db.objectStoreNames.contains(name)) {
              db.createObjectStore(name, options);
          }
      };

      createStore(STORE_CHARACTERS, { keyPath: 'id' });
      createStore(STORE_CHAR_GROUPS, { keyPath: 'id' }); // v68: 角色分组

      if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
        const msgStore = db.createObjectStore(STORE_MESSAGES, { keyPath: 'id', autoIncrement: true });
        msgStore.createIndex('charId', 'charId', { unique: false });
        msgStore.createIndex('groupId', 'groupId', { unique: false }); 
      } else {
          const msgStore = (event.target as IDBOpenDBRequest).transaction?.objectStore(STORE_MESSAGES);
          if (msgStore && !msgStore.indexNames.contains(STORE_MESSAGES) && !msgStore.indexNames.contains('groupId')) {
              try {
                  msgStore.createIndex('groupId', 'groupId', { unique: false });
              } catch (e) { console.log('Index already exists'); }
          }
      }

      // v62: messages 加 [charId, type] 复合索引。彼方动态按 (charId, 'vr_card') 直取 vr_card，
      // 成本只跟 vr_card 条数相关，跟总消息量无关——上万条聊天的用户也不必把整段历史 getAll
      // 进内存再筛。没有 type 字段的老消息不会进此索引，正好不影响（我们只查 vr_card）。
      try {
          const msgStore = (event.target as IDBOpenDBRequest).transaction?.objectStore(STORE_MESSAGES);
          if (msgStore && !msgStore.indexNames.contains('charId_type')) {
              msgStore.createIndex('charId_type', ['charId', 'type'], { unique: false });
          }
      } catch (e) { console.log('charId_type index migration skipped', e); }

      createStore(STORE_EMOJIS, { keyPath: 'name' });
      createStore(STORE_EMOJI_CATEGORIES, { keyPath: 'id' });

      createStore(STORE_THEMES, { keyPath: 'id' });
      createStore(STORE_ASSETS, { keyPath: 'id' });
      createStore(STORE_BLOB_ASSETS, { keyPath: 'id' }); // v65: 图片二进制 Blob 存储
      
      if (!db.objectStoreNames.contains(STORE_SCHEDULED)) {
        const schedStore = db.createObjectStore(STORE_SCHEDULED, { keyPath: 'id' });
        schedStore.createIndex('charId', 'charId', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_GALLERY)) {
          const galleryStore = db.createObjectStore(STORE_GALLERY, { keyPath: 'id' });
          galleryStore.createIndex('charId', 'charId', { unique: false });
      }

      createStore(STORE_USER, { keyPath: 'id' });
      
      if (!db.objectStoreNames.contains(STORE_DIARIES)) {
          const diaryStore = db.createObjectStore(STORE_DIARIES, { keyPath: 'id' });
          diaryStore.createIndex('charId', 'charId', { unique: false });
      }
      
      createStore(STORE_TASKS, { keyPath: 'id' });
      createStore(STORE_ANNIVERSARIES, { keyPath: 'id' });

      if (!db.objectStoreNames.contains(STORE_ROOM_TODOS)) {
          db.createObjectStore(STORE_ROOM_TODOS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_ROOM_NOTES)) {
          const notesStore = db.createObjectStore(STORE_ROOM_NOTES, { keyPath: 'id' });
          notesStore.createIndex('charId', 'charId', { unique: false });
      }

      createStore(STORE_GROUPS, { keyPath: 'id' });
      createStore(STORE_JOURNAL_STICKERS, { keyPath: 'name' });
      createStore(STORE_SOCIAL_POSTS, { keyPath: 'id' });
      createStore(STORE_COURSES, { keyPath: 'id' });
      createStore(STORE_GAMES, { keyPath: 'id' }); 
      createStore(STORE_WORLDBOOKS, { keyPath: 'id' }); 
      createStore(STORE_NOVELS, { keyPath: 'id' });

      createStore(STORE_VR_NOVELS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_VR_ANNOTATIONS)) {
          const vrAnnStore = db.createObjectStore(STORE_VR_ANNOTATIONS, { keyPath: 'id' });
          vrAnnStore.createIndex('novelId', 'novelId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_CC_PARTS)) {
          const ccStore = db.createObjectStore(STORE_CC_PARTS, { keyPath: 'id' });
          ccStore.createIndex('categoryKey', 'categoryKey', { unique: false });
      }
      createStore(STORE_VR_MUSIC, { keyPath: 'id' });
      createStore(STORE_VR_GUESTBOOK, { keyPath: 'id' });
      createStore(STORE_VR_SCRIPTS, { keyPath: 'id' });
      createStore(STORE_VR_PLAYS, { keyPath: 'id' });
      createStore(STORE_VR_PRESETS, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STORE_VR_LETTERS)) {
          const ltStore = db.createObjectStore(STORE_VR_LETTERS, { keyPath: 'id' });
          ltStore.createIndex('box', 'box', { unique: false });
      }
      createStore(STORE_VR_SETTINGS, { keyPath: 'id' });
      createStore(STORE_API_CALL_LOG, { keyPath: 'id' });

      // v63: 家园（同世界观多角色大世界）
      createStore(STORE_WORLDS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_WORLD_EPISODES)) {
          const weStore = db.createObjectStore(STORE_WORLD_EPISODES, { keyPath: 'id' });
          weStore.createIndex('worldId', 'worldId', { unique: false });
      }

      createStore(STORE_BANK_TX, { keyPath: 'id' });
      createStore(STORE_BANK_DATA, { keyPath: 'id' });
      createStore(STORE_XHS_STOCK, { keyPath: 'id' });

      if (!db.objectStoreNames.contains(STORE_XHS_ACTIVITIES)) {
          const xhsActStore = db.createObjectStore(STORE_XHS_ACTIVITIES, { keyPath: 'id' });
          xhsActStore.createIndex('characterId', 'characterId', { unique: false });
      }

      createStore(STORE_SONGS, { keyPath: 'id' });
      createStore(STORE_QUIZZES, { keyPath: 'id' });
      createStore(STORE_GUIDEBOOK, { keyPath: 'id' });
      createStore(STORE_LIFE_SIM, { keyPath: 'id' });
      createStore(STORE_DAILY_SCHEDULE, { keyPath: 'id' });
      createStore(STORE_HANDBOOK, { keyPath: 'id' });

      createStore(STORE_TRACKERS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_TRACKER_ENTRIES)) {
          const teStore = db.createObjectStore(STORE_TRACKER_ENTRIES, { keyPath: 'id' });
          teStore.createIndex('trackerId', 'trackerId', { unique: false });
          teStore.createIndex('date', 'date', { unique: false });
      }

      // v65: 生活记录（档案 App）
      if (!db.objectStoreNames.contains(STORE_LIFE_RECORDS)) {
          const lrStore = db.createObjectStore(STORE_LIFE_RECORDS, { keyPath: 'id' });
          lrStore.createIndex('date', 'date', { unique: false });
          lrStore.createIndex('module', 'module', { unique: false });
      }
      createStore(STORE_MED_PLANS, { keyPath: 'id' });
      createStore(STORE_LIFE_SETTINGS, { keyPath: 'id' });

      createStore(STORE_HOTNEWS, { keyPath: 'id' });

      // ─── Memory Palace (记忆宫殿) stores ───
      if (!db.objectStoreNames.contains('memory_nodes')) {
          const mnStore = db.createObjectStore('memory_nodes', { keyPath: 'id' });
          mnStore.createIndex('charId', 'charId', { unique: false });
          mnStore.createIndex('room', 'room', { unique: false });
          mnStore.createIndex('embedded', 'embedded', { unique: false });
          mnStore.createIndex('boxId', 'boxId', { unique: false }); // deprecated，保留索引兼容旧数据
          mnStore.createIndex('eventBoxId', 'eventBoxId', { unique: false });
      } else {
          // Migration: 为已有 memory_nodes 表补建 eventBoxId 索引（v47 新增）
          const mnStore = (event.target as IDBOpenDBRequest).transaction?.objectStore('memory_nodes');
          if (mnStore && !mnStore.indexNames.contains('eventBoxId')) {
              try { mnStore.createIndex('eventBoxId', 'eventBoxId', { unique: false }); }
              catch (e) { console.log('memory_nodes eventBoxId index migration skipped'); }
          }
      }

      if (!db.objectStoreNames.contains('memory_vectors')) {
          const mvStore = db.createObjectStore('memory_vectors', { keyPath: 'memoryId' });
          mvStore.createIndex('charId', 'charId', { unique: false });
      } else {
          // Migration: add charId index to existing memory_vectors store
          const mvStore = (event.target as IDBOpenDBRequest).transaction?.objectStore('memory_vectors');
          if (mvStore && !mvStore.indexNames.contains('charId')) {
              try { mvStore.createIndex('charId', 'charId', { unique: false }); } catch (e) { console.log('memory_vectors charId index migration skipped'); }
          }
      }

      if (!db.objectStoreNames.contains('memory_links')) {
          const mlStore = db.createObjectStore('memory_links', { keyPath: 'id' });
          mlStore.createIndex('sourceId', 'sourceId', { unique: false });
          mlStore.createIndex('targetId', 'targetId', { unique: false });
      }

      if (!db.objectStoreNames.contains('memory_batches')) {
          const mbStore = db.createObjectStore('memory_batches', { keyPath: 'id' });
          mbStore.createIndex('charId', 'charId', { unique: false });
      }

      if (!db.objectStoreNames.contains('topic_boxes')) {
          const tbStore = db.createObjectStore('topic_boxes', { keyPath: 'id' });
          tbStore.createIndex('charId', 'charId', { unique: false });
          tbStore.createIndex('status', 'status', { unique: false });
      }

      if (!db.objectStoreNames.contains('anticipations')) {
          const antStore = db.createObjectStore('anticipations', { keyPath: 'id' });
          antStore.createIndex('charId', 'charId', { unique: false });
          antStore.createIndex('status', 'status', { unique: false });
      }

      // ─── EventBox（事件盒，v47 新增） ───────────────
      if (!db.objectStoreNames.contains('event_boxes')) {
          const ebStore = db.createObjectStore('event_boxes', { keyPath: 'id' });
          ebStore.createIndex('charId', 'charId', { unique: false });
      }

      // ─── 房间门牌（v65 新增，情景→语义固化层） ───────
      if (!db.objectStoreNames.contains('room_plates')) {
          const rpStore = db.createObjectStore('room_plates', { keyPath: 'id' });
          rpStore.createIndex('charId', 'charId', { unique: false });
      }

      // ─── 消化日志（v66 新增，认知消化可回看记录） ─────
      if (!db.objectStoreNames.contains('digest_reports')) {
          const drStore = db.createObjectStore('digest_reports', { keyPath: 'id' });
          drStore.createIndex('charId', 'charId', { unique: false });
      }

      // ─── v48 一次性强制清空记忆宫殿（EventBox 体系，旧 boxId 数据不兼容） ───
      //     oldVersion === 0 = 全新安装，没东西可清
      //     oldVersion >= 48 = 已经清过，跳过
      //     0 < oldVersion < 48 = 现有用户升级 → 清一次
      const oldVersion = event.oldVersion || 0;
      if (oldVersion > 0 && oldVersion < 48) {
          const upgradeTx = (event.target as IDBOpenDBRequest).transaction;
          const MP_STORES_TO_CLEAR = [
              'memory_nodes', 'memory_vectors', 'memory_links',
              'memory_batches', 'topic_boxes', 'anticipations', 'event_boxes',
          ];
          let cleared = 0;
          for (const name of MP_STORES_TO_CLEAR) {
              if (db.objectStoreNames.contains(name) && upgradeTx) {
                  try {
                      upgradeTx.objectStore(name).clear();
                      cleared++;
                  } catch (e) {
                      console.warn(`[DB v48 wipe] skip ${name}:`, e);
                  }
              }
          }
          // 同步清理 localStorage 里的高水位标记
          let hwmCleared = 0;
          try {
              const toRemove: string[] = [];
              for (let i = 0; i < localStorage.length; i++) {
                  const key = localStorage.key(i);
                  if (key && key.startsWith('mp_lastMsgId_')) toRemove.push(key);
              }
              for (const key of toRemove) { localStorage.removeItem(key); hwmCleared++; }
          } catch { /* ignore */ }
          console.log(`🗑️ [DB v48] 一次性清空完成：${cleared} 个 store，${hwmCleared} 个高水位（oldVersion=${oldVersion}）`);
      }

      // ─── Pixel Home（像素家园）stores ───────────────
      if (!db.objectStoreNames.contains('pixel_home_assets')) {
          const phaStore = db.createObjectStore('pixel_home_assets', { keyPath: 'id' });
          phaStore.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('pixel_home_layouts')) {
          const phlStore = db.createObjectStore('pixel_home_layouts', { keyPath: ['charId', 'roomId'] });
          phlStore.createIndex('charId', 'charId', { unique: false });
      }
    };
  });

  dbPromise = promise;
  return promise;
};

/**
 * 家园关系条读时迁移：早期格式是无序对 {aId,bId}（双方共用一个数值），
 * 现为有向 {fromId,toId}（你对ta ≠ ta对你）。旧边拆成两条对称有向边，数值/关系名照抄，
 * 之后各自的演绎会让两边自然分化。
 */
const normalizeWorldRelationships = (world: WorldProfile): WorldProfile => {
    const rels = world.relationships || [];
    if (!rels.some((r: any) => r.aId !== undefined)) return world;
    const out: WorldProfile['relationships'] = [];
    const has = (fromId: string, toId: string) => out.some(r => r.fromId === fromId && r.toId === toId);
    for (const r of rels as any[]) {
        if (r.aId !== undefined && r.bId !== undefined) {
            if (!has(r.aId, r.bId)) out.push({ fromId: r.aId, toId: r.bId, label: r.label, value: r.value ?? 50 });
            if (!has(r.bId, r.aId)) out.push({ fromId: r.bId, toId: r.aId, label: r.label, value: r.value ?? 50 });
        } else if (r.fromId !== undefined && r.toId !== undefined && !has(r.fromId, r.toId)) {
            out.push(r);
        }
    }
    return { ...world, relationships: out };
};

export const DB = {
  deleteDB: async (): Promise<void> => {
      // 删库前先关掉单例连接, 否则这条还开着的连接会 block 掉 deleteDatabase。
      if (dbPromise) {
          try { (await dbPromise).close(); } catch { /* ignore */ }
          dbPromise = null;
      }
      return new Promise((resolve, reject) => {
          const req = indexedDB.deleteDatabase(DB_NAME);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
          req.onblocked = () => console.warn('Delete blocked');
      });
  },

  getAllCharacters: async (): Promise<CharacterProfile[]> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_CHARACTERS, 'readonly');
      const store = transaction.objectStore(STORE_CHARACTERS);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  },

  saveCharacter: async (character: CharacterProfile): Promise<void> => {
    const db = await openDB();
    // 等事务真正提交再 resolve —— 否则调用方 await 后立刻重读 DB 会拿到旧值 (情绪 buff 落库竞态根因).
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_CHARACTERS, 'readwrite');
      transaction.objectStore(STORE_CHARACTERS).put(character);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('saveCharacter aborted'));
    });
  },

  deleteCharacter: async (id: string): Promise<void> => {
    const db = await openDB();
    const transaction = db.transaction(STORE_CHARACTERS, 'readwrite');
    transaction.objectStore(STORE_CHARACTERS).delete(id);
  },

  // ---- 角色分组（神经链接"文件夹"，与群聊 groups 无关）----

  getCharacterGroups: async (): Promise<CharacterGroup[]> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      if (!db.objectStoreNames.contains(STORE_CHAR_GROUPS)) {
        resolve([]);
        return;
      }
      const transaction = db.transaction(STORE_CHAR_GROUPS, 'readonly');
      const request = transaction.objectStore(STORE_CHAR_GROUPS).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  },

  saveCharacterGroup: async (group: CharacterGroup): Promise<void> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_CHAR_GROUPS, 'readwrite');
      transaction.objectStore(STORE_CHAR_GROUPS).put(group);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('saveCharacterGroup aborted'));
    });
  },

  // 只删分组定义。组内角色的 groupId 回落由 OSContext.deleteCharacterGroup 负责
  // （角色 state 在 context 里，这里改了 DB 不改 state 会出现"删组后角色还挂在幽灵组里"）。
  deleteCharacterGroup: async (id: string): Promise<void> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_CHAR_GROUPS, 'readwrite');
      transaction.objectStore(STORE_CHAR_GROUPS).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  },

  /**
   * 获取角色的私聊消息。
   * @param includeProcessed 是否包含已被记忆宫殿处理的消息（默认 false，即自动过滤）。
   *                         记忆归档、批量总结等需要完整历史的场景应传 true。
   */
  getMessagesByCharId: async (charId: string, includeProcessed: boolean = false): Promise<Message[]> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_MESSAGES, 'readonly');
      const store = transaction.objectStore(STORE_MESSAGES);
      const index = store.index('charId');
      const request = index.getAll(IDBKeyRange.only(charId));
      request.onsuccess = () => {
          let results = (request.result || []).filter((m: Message) => !m.groupId);
          // 记忆宫殿：过滤已处理的消息（高水位标记之前的），用向量记忆替代
          if (!includeProcessed) {
              try {
                  const hwm = parseInt(localStorage.getItem(`mp_lastMsgId_${charId}`) || '0', 10);
                  if (hwm > 0) {
                      results = results.filter((m: Message) => m.id > hwm);
                  }
              } catch {}
          }
          resolve(results);
      };
      request.onerror = () => reject(request.error);
    });
  },

  // Performance: Load only the most recent N messages for a character
  getRecentMessagesByCharId: async (charId: string, limit: number, includeProcessed: boolean = false): Promise<Message[]> => {
    const db = await openDB();
    const hwm = includeProcessed ? 0 : (() => {
        try { return parseInt(localStorage.getItem(`mp_lastMsgId_${charId}`) || '0', 10) || 0; } catch { return 0; }
    })();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_MESSAGES, 'readonly');
      const store = transaction.objectStore(STORE_MESSAGES);
      const index = store.index('charId');
      const collected: Message[] = [];
      const cursorReq = index.openCursor(IDBKeyRange.only(charId), 'prev');
      cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor && collected.length < limit) {
              const m = cursor.value as Message;
              if (!m.groupId && (includeProcessed || m.id > hwm)) collected.push(m);
              cursor.continue();
          } else {
              resolve(collected.reverse());
          }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  },

  // 彼方动态专用：捞某角色全部 vr_card，不受"最近 N 条窗口"、记忆宫殿高水位
  // （mp_lastMsgId）、归档隐藏起点（char.hideBeforeMessageId）影响。
  // 这些机制只管「LLM 上下文能否看到」；彼方动态是用户自己的浏览界面，
  // 只要消息还在 IndexedDB 里就应当永远可见——哪怕它早被新聊天挤出聊天取数窗口、
  // 或被归档标记为「对 AI 隐藏」。（清空聊天会真删消息，删掉就没了——那是预期行为。）
  //
  // 性能：走 [charId, type] 复合索引直取 vr_card，成本只跟该角色 vr_card 条数相关，
  // 跟总消息量无关——上万条聊天的用户也不会把整段历史读进内存。
  getVRCardsByCharId: async (charId: string): Promise<Message[]> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_MESSAGES, 'readonly');
      const store = transaction.objectStore(STORE_MESSAGES);
      if (store.indexNames.contains('charId_type')) {
          const idx = store.index('charId_type');
          const req = idx.getAll(IDBKeyRange.only([charId, 'vr_card']));
          req.onsuccess = () => {
              const results = (req.result || []).filter((m: Message) => !m.groupId && (m as any).metadata?.vrCard);
              resolve(results);
          };
          req.onerror = () => reject(req.error);
          return;
      }
      // 兜底：复合索引尚未建好的极少数情况（如升级事务还没跑完），用倒序游标扫，
      // 凑够 80 条 vr_card 即停——避免 getAll 整段历史。
      const index = store.index('charId');
      const collected: Message[] = [];
      const cursorReq = index.openCursor(IDBKeyRange.only(charId), 'prev');
      cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor && collected.length < 80) {
              const m = cursor.value as Message;
              if (!m.groupId && m.type === 'vr_card' && (m as any).metadata?.vrCard) collected.push(m);
              cursor.continue();
          } else {
              resolve(collected);
          }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  },

  // Same as getRecentMessagesByCharId but also returns the total count (for UI display)
  getRecentMessagesWithCount: async (charId: string, limit: number): Promise<{ messages: Message[], totalCount: number }> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_MESSAGES, 'readonly');
      const store = transaction.objectStore(STORE_MESSAGES);
      const index = store.index('charId');
      const countReq = index.count(IDBKeyRange.only(charId));
      countReq.onsuccess = () => {
          const totalCount = countReq.result;
          // Use reverse cursor to only collect the last N messages
          const collected: Message[] = [];
          const cursorReq = index.openCursor(IDBKeyRange.only(charId), 'prev');
          cursorReq.onsuccess = () => {
              const cursor = cursorReq.result;
              if (cursor && collected.length < limit) {
                  const m = cursor.value as Message;
                  if (!m.groupId) collected.push(m);
                  cursor.continue();
              } else {
                  resolve({ messages: collected.reverse(), totalCount });
              }
          };
          cursorReq.onerror = () => reject(cursorReq.error);
      };
      countReq.onerror = () => reject(countReq.error);
    });
  },

  // Get all messages for a character from a given message ID onward (for hideBeforeMessageId)
  getMessagesFromId: async (charId: string, fromId: number): Promise<{ messages: Message[], totalCount: number }> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_MESSAGES, 'readonly');
      const store = transaction.objectStore(STORE_MESSAGES);
      const index = store.index('charId');
      const collected: Message[] = [];
      const cursorReq = index.openCursor(IDBKeyRange.only(charId));
      cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
              const m = cursor.value as Message;
              if (!m.groupId && m.id >= fromId) {
                  collected.push(m);
              }
              cursor.continue();
          } else {
              resolve({ messages: collected, totalCount: collected.length });
          }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  },

  saveMessage: async (msg: Omit<Message, 'id' | 'timestamp'> & { timestamp?: number }): Promise<number> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_MESSAGES, 'readwrite');
        const store = transaction.objectStore(STORE_MESSAGES);
        const timestamp = typeof msg.timestamp === 'number' ? msg.timestamp : Date.now();
        const { timestamp: _ignored, ...payload } = msg;
        const request = store.add({ ...payload, timestamp });
        request.onsuccess = () => {
            const newId = request.result as number;
            // 水位线自愈：新消息的自增 id 必然大于既有一切消息 id，也就必然大于水位线
            // （水位线本身是某条旧消息的 id）。出现 newId ≤ 水位线，只有一种可能——
            // IndexedDB 被浏览器清过、自增计数器归零，而 localStorage 里的记忆宫殿水位
            // 是清库前残留的。不清掉它，该角色所有新消息都会被 hwm 过滤挡在 AI 上下文
            // 之外（请求只剩 system → 上游 400）。此处直接移除失效水位。
            try {
                const staleKeys = [`mp_lastMsgId_${msg.charId}`];
                if (msg.groupId) staleKeys.push(`mp_lastMsgId_group_${msg.groupId}`);
                for (const key of staleKeys) {
                    const hwm = parseInt(localStorage.getItem(key) || '0', 10) || 0;
                    if (hwm >= newId) localStorage.removeItem(key);
                }
            } catch { /* localStorage 不可用时静默跳过 */ }
            resolve(newId);
        };
        request.onerror = () => reject(request.error);
    });
  },

  updateMessage: async (id: number, content: string): Promise<void> => {
    const db = await openDB();
    const transaction = db.transaction(STORE_MESSAGES, 'readwrite');
    const store = transaction.objectStore(STORE_MESSAGES);
    
    return new Promise((resolve, reject) => {
        const req = store.get(id);
        req.onsuccess = () => {
            const data = req.result as Message;
            if (data) {
                data.content = content;
                store.put(data);
                resolve();
            } else {
                reject(new Error('Message not found'));
            }
        };
        req.onerror = () => reject(req.error);
    });
  },

  updateMessageMetadata: async (id: number, updater: (prev: any) => any): Promise<void> => {
    const db = await openDB();
    const transaction = db.transaction(STORE_MESSAGES, 'readwrite');
    const store = transaction.objectStore(STORE_MESSAGES);

    return new Promise((resolve, reject) => {
        const req = store.get(id);
        req.onsuccess = () => {
            const data = req.result as Message | undefined;
            if (data) {
                (data as any).metadata = updater((data as any).metadata);
                store.put(data);
                resolve();
            } else {
                reject(new Error('Message not found'));
            }
        };
        req.onerror = () => reject(req.error);
    });
  },

  deleteMessage: async (id: number): Promise<void> => {
    const db = await openDB();
    const transaction = db.transaction(STORE_MESSAGES, 'readwrite');
    transaction.objectStore(STORE_MESSAGES).delete(id);
  },

  deleteMessages: async (ids: number[]): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_MESSAGES, 'readwrite');
      const store = transaction.objectStore(STORE_MESSAGES);
      ids.forEach(id => store.delete(id));
      return new Promise((resolve) => {
          transaction.oncomplete = () => resolve();
      });
  },

  clearMessages: async (charId: string): Promise<void> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_MESSAGES, 'readwrite');
      const store = transaction.objectStore(STORE_MESSAGES);
      const index = store.index('charId');
      const request = index.openCursor(IDBKeyRange.only(charId));

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
            const m = cursor.value as Message;
            if (!m.groupId) {
                store.delete(cursor.primaryKey);
            }
            cursor.continue();
        }
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('clearMessages aborted'));
    });
  },

  getGroups: async (): Promise<GroupProfile[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_GROUPS)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_GROUPS, 'readonly');
          const store = transaction.objectStore(STORE_GROUPS);
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveGroup: async (group: GroupProfile): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_GROUPS, 'readwrite');
      transaction.objectStore(STORE_GROUPS).put(group);
  },

  deleteGroup: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_GROUPS, 'readwrite');
      transaction.objectStore(STORE_GROUPS).delete(id);
  },

  getGroupMessages: async (groupId: string): Promise<Message[]> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_MESSAGES, 'readonly');
          const store = transaction.objectStore(STORE_MESSAGES);
          const index = store.index('groupId');
          const request = index.getAll(IDBKeyRange.only(groupId));
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  getRecentGroupMessagesWithCount: async (groupId: string, limit: number): Promise<{ messages: Message[], totalCount: number }> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_MESSAGES, 'readonly');
          const store = transaction.objectStore(STORE_MESSAGES);
          const index = store.index('groupId');
          const countReq = index.count(IDBKeyRange.only(groupId));
          countReq.onsuccess = () => {
              const totalCount = countReq.result;
              const collected: Message[] = [];
              const cursorReq = index.openCursor(IDBKeyRange.only(groupId), 'prev');
              cursorReq.onsuccess = () => {
                  const cursor = cursorReq.result;
                  if (cursor && collected.length < limit) {
                      collected.push(cursor.value as Message);
                      cursor.continue();
                  } else {
                      resolve({ messages: collected.reverse(), totalCount });
                  }
              };
              cursorReq.onerror = () => reject(cursorReq.error);
          };
          countReq.onerror = () => reject(countReq.error);
      });
  },

  getSocialPosts: async (): Promise<SocialPost[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_SOCIAL_POSTS)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_SOCIAL_POSTS, 'readonly');
          const store = transaction.objectStore(STORE_SOCIAL_POSTS);
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveSocialPost: async (post: SocialPost): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_SOCIAL_POSTS, 'readwrite');
      transaction.objectStore(STORE_SOCIAL_POSTS).put(post);
  },

  deleteSocialPost: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_SOCIAL_POSTS, 'readwrite');
      transaction.objectStore(STORE_SOCIAL_POSTS).delete(id);
  },

  clearSocialPosts: async (): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_SOCIAL_POSTS, 'readwrite');
      transaction.objectStore(STORE_SOCIAL_POSTS).clear();
  },

  getEmojis: async (): Promise<Emoji[]> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_EMOJIS, 'readonly');
      const store = transaction.objectStore(STORE_EMOJIS);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  },

  saveEmoji: async (name: string, url: string, categoryId?: string): Promise<void> => {
    const db = await openDB();
    const transaction = db.transaction(STORE_EMOJIS, 'readwrite');
    transaction.objectStore(STORE_EMOJIS).put({ name, url, categoryId });
  },

  deleteEmoji: async (name: string): Promise<void> => {
    const db = await openDB();
    const transaction = db.transaction(STORE_EMOJIS, 'readwrite');
    transaction.objectStore(STORE_EMOJIS).delete(name);
  },

  // 表情包重命名: name 是主键, 改名 = 删旧键 + 写新键 (保留 url / categoryId)。
  // 新名为空、与旧名相同、或已被占用都会抛错, 让调用方提示用户。
  renameEmoji: async (oldName: string, newName: string): Promise<void> => {
    const trimmed = newName.trim();
    if (!trimmed) throw new Error('表情包名称不能为空');
    if (trimmed === oldName) return;
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_EMOJIS, 'readwrite');
      const store = tx.objectStore(STORE_EMOJIS);
      const getReq = store.get(oldName);
      getReq.onsuccess = () => {
        const record = getReq.result as Emoji | undefined;
        if (!record) { reject(new Error('未找到要重命名的表情包')); return; }
        const dupReq = store.get(trimmed);
        dupReq.onsuccess = () => {
          if (dupReq.result) { reject(new Error('已存在同名表情包')); return; }
          store.delete(oldName);
          store.put({ ...record, name: trimmed });
        };
        dupReq.onerror = () => reject(dupReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },

  getEmojiCategories: async (): Promise<EmojiCategory[]> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          if (!db.objectStoreNames.contains(STORE_EMOJI_CATEGORIES)) {
              resolve([]);
              return;
          }
          const transaction = db.transaction(STORE_EMOJI_CATEGORIES, 'readonly');
          const store = transaction.objectStore(STORE_EMOJI_CATEGORIES);
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveEmojiCategory: async (category: EmojiCategory): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_EMOJI_CATEGORIES, 'readwrite');
      transaction.objectStore(STORE_EMOJI_CATEGORIES).put(category);
  },

  deleteEmojiCategory: async (id: string): Promise<void> => {
      const db = await openDB();
      const tx = db.transaction([STORE_EMOJI_CATEGORIES, STORE_EMOJIS], 'readwrite');
      tx.objectStore(STORE_EMOJI_CATEGORIES).delete(id);
      const emojiStore = tx.objectStore(STORE_EMOJIS);
      const request = emojiStore.getAll();
      request.onsuccess = () => {
          const allEmojis = request.result as Emoji[];
          allEmojis.forEach(e => {
              if (e.categoryId === id) {
                  emojiStore.delete(e.name);
              }
          });
      };
      return new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
      });
  },

  // 「幽灵表情包」清理：删角色不会级联清理表情分类，导致只对已删角色可见的
  // 专属分类在单聊面板里被过滤掉（看不到也删不掉），却仍会出现在群聊表情面板
  // 和 AI 提示词里。按「现存角色 id 白名单」做三件事：
  //   1. 分类绑定里指向已删角色的 id → 剔除（部分失效只修绑定，不动表情）
  //   2. 剔除后一个角色都不剩的非系统分类 → 整个删除，连同分类下所有表情
  //   3. categoryId 指向已不存在分类的表情 → 删除（无主表情）
  // dryRun=true 只扫描统计、不落库，供 UI 做「先扫描再确认」。
  cleanupEmojiResidue: async (
      validCharacterIds: string[],
      options: { dryRun?: boolean } = {}
  ): Promise<{
      removedCategories: { id: string; name: string }[];
      fixedCategories: { id: string; name: string }[];
      removedEmojiCount: number;
  }> => {
      const validIds = new Set(validCharacterIds);
      const [categories, emojis] = await Promise.all([DB.getEmojiCategories(), DB.getEmojis()]);

      const removedCategories: { id: string; name: string }[] = [];
      const fixedCategories: EmojiCategory[] = [];
      for (const cat of categories) {
          if (!cat.allowedCharacterIds || cat.allowedCharacterIds.length === 0) continue; // 全员可见，不动
          const alive = cat.allowedCharacterIds.filter(cid => validIds.has(cid));
          if (alive.length === cat.allowedCharacterIds.length) continue; // 绑定全部有效
          if (alive.length === 0 && !cat.isSystem) {
              removedCategories.push({ id: cat.id, name: cat.name });
          } else {
              // 系统分类绑定全失效时也走这里：清空绑定回落「全员可见」，绝不删系统分类
              fixedCategories.push({ ...cat, allowedCharacterIds: alive });
          }
      }

      const removedCatIds = new Set(removedCategories.map(c => c.id));
      const remainingCatIds = new Set(categories.map(c => c.id).filter(id => !removedCatIds.has(id)));
      const emojisToDelete = emojis.filter(e => e.categoryId && !remainingCatIds.has(e.categoryId));

      if (!options.dryRun && (removedCategories.length || fixedCategories.length || emojisToDelete.length)) {
          const db = await openDB();
          const tx = db.transaction([STORE_EMOJI_CATEGORIES, STORE_EMOJIS], 'readwrite');
          const catStore = tx.objectStore(STORE_EMOJI_CATEGORIES);
          const emojiStore = tx.objectStore(STORE_EMOJIS);
          removedCategories.forEach(c => catStore.delete(c.id));
          fixedCategories.forEach(c => catStore.put(c));
          emojisToDelete.forEach(e => emojiStore.delete(e.name));
          await new Promise<void>((resolve, reject) => {
              tx.oncomplete = () => resolve();
              tx.onerror = () => reject(tx.error);
              tx.onabort = () => reject(tx.error);
          });
      }

      return {
          removedCategories,
          fixedCategories: fixedCategories.map(c => ({ id: c.id, name: c.name })),
          removedEmojiCount: emojisToDelete.length,
      };
  },

  initializeEmojiData: async (): Promise<void> => {
      const cats = await DB.getEmojiCategories();
      // 巧妙利用 UI 强制保留 default 分类的特性：
      // 只要初始化过一次，cats.length 至少为 1（必然包含 default）。
      // 只有全量清空的首次安装，cats.length 才为 0。这样无需 localStorage 即可避免内置分类无限复活。
      if (cats.length === 0) {
          await DB.saveEmojiCategory({ id: 'default', name: '默认', isSystem: true });
          // 去掉 isSystem 标记，允许用户在 UI 里直接删除此分类
          await DB.saveEmojiCategory({ id: SULLY_CATEGORY_ID, name: 'Sully 专属', isSystem: false });
          const db = await openDB();
          const tx = db.transaction(STORE_EMOJIS, 'readwrite');
          const store = tx.objectStore(STORE_EMOJIS);
          SULLY_PRESET_EMOJIS.forEach(emoji => store.put(emoji));
          await new Promise(resolve => { tx.oncomplete = resolve; });
      }
  },

  getThemes: async (): Promise<ChatTheme[]> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_THEMES, 'readonly');
      const store = transaction.objectStore(STORE_THEMES);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  },

  saveTheme: async (theme: ChatTheme): Promise<void> => {
    const db = await openDB();
    const transaction = db.transaction(STORE_THEMES, 'readwrite');
    transaction.objectStore(STORE_THEMES).put(theme);
  },

  deleteTheme: async (id: string): Promise<void> => {
    const db = await openDB();
    const transaction = db.transaction(STORE_THEMES, 'readwrite');
    transaction.objectStore(STORE_THEMES).delete(id);
  },

  getAllAssets: async (): Promise<{id: string, data: string}[]> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_ASSETS, 'readonly');
      const store = transaction.objectStore(STORE_ASSETS);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  },

  getAsset: async (id: string): Promise<string | null> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_ASSETS, 'readonly');
          const store = transaction.objectStore(STORE_ASSETS);
          const request = store.get(id);
          request.onsuccess = () => resolve(request.result?.data || null);
          request.onerror = () => reject(request.error);
      });
  },

  saveAsset: async (id: string, data: string): Promise<void> => {
    const db = await openDB();
    // 等事务真正落盘并把失败抛出去：旧实现发完 put 就返回，配额不足（iOS Safari 常见）
    // 时写入静默丢失，调用方还以为保存成功了。
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_ASSETS, 'readwrite');
        transaction.objectStore(STORE_ASSETS).put({ id, data });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
    });
  },

  getAssetRaw: async (id: string): Promise<any | null> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_ASSETS, 'readonly');
          const store = transaction.objectStore(STORE_ASSETS);
          const request = store.get(id);
          request.onsuccess = () => resolve(request.result?.data ?? null);
          request.onerror = () => reject(request.error);
      });
  },

  saveAssetRaw: async (id: string, data: any): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_ASSETS, 'readwrite');
      transaction.objectStore(STORE_ASSETS).put({ id, data });
  },

  deleteAsset: async (id: string): Promise<void> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_ASSETS, 'readwrite');
      transaction.objectStore(STORE_ASSETS).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('deleteAsset aborted'));
    });
  },

  // ─── Blob 资源（图片二进制，见 utils/blobRef.ts）───────────────
  // IndexedDB 原生支持存 Blob（结构化克隆），比 base64 省 ~33% 空间、不占 JS 堆，
  // 读出后用 URL.createObjectURL 渲染即可。旧库（<v65）可能还没有此 store，读操作做空兜底。
  getBlobAsset: async (id: string): Promise<Blob | null> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_BLOB_ASSETS)) return null;
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_BLOB_ASSETS, 'readonly');
          const store = transaction.objectStore(STORE_BLOB_ASSETS);
          const request = store.get(id);
          request.onsuccess = () => resolve((request.result?.blob as Blob) ?? null);
          request.onerror = () => reject(request.error);
      });
  },

  putBlobAsset: async (id: string, blob: Blob): Promise<void> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_BLOB_ASSETS, 'readwrite');
          transaction.objectStore(STORE_BLOB_ASSETS).put({ id, blob });
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error || new Error('putBlobAsset aborted'));
      });
  },

  deleteBlobAsset: async (id: string): Promise<void> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_BLOB_ASSETS)) return;
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_BLOB_ASSETS, 'readwrite');
          transaction.objectStore(STORE_BLOB_ASSETS).delete(id);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error || new Error('deleteBlobAsset aborted'));
      });
  },

  getJournalStickers: async (): Promise<{name: string, url: string}[]> => {
    const db = await openDB();
    if (!db.objectStoreNames.contains(STORE_JOURNAL_STICKERS)) return [];
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_JOURNAL_STICKERS, 'readonly');
      const store = transaction.objectStore(STORE_JOURNAL_STICKERS);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  },

  saveJournalSticker: async (name: string, url: string): Promise<void> => {
    const db = await openDB();
    const transaction = db.transaction(STORE_JOURNAL_STICKERS, 'readwrite');
    transaction.objectStore(STORE_JOURNAL_STICKERS).put({ name, url });
  },

  deleteJournalSticker: async (name: string): Promise<void> => {
    const db = await openDB();
    const transaction = db.transaction(STORE_JOURNAL_STICKERS, 'readwrite');
    transaction.objectStore(STORE_JOURNAL_STICKERS).delete(name);
  },

  saveGalleryImage: async (img: GalleryImage): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_GALLERY, 'readwrite');
      transaction.objectStore(STORE_GALLERY).put(img);
  },

  getGalleryImages: async (charId?: string): Promise<GalleryImage[]> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_GALLERY, 'readonly');
          const store = transaction.objectStore(STORE_GALLERY);
          let request;
          if (charId) {
              const index = store.index('charId');
              request = index.getAll(IDBKeyRange.only(charId));
          } else {
              request = store.getAll();
          }
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  updateGalleryImageReview: async (id: string, review: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_GALLERY, 'readwrite');
      const store = transaction.objectStore(STORE_GALLERY);
      return new Promise((resolve, reject) => {
          const req = store.get(id);
          req.onsuccess = () => {
              const data = req.result as GalleryImage;
              if (data) {
                  data.review = review;
                  data.reviewTimestamp = Date.now();
                  store.put(data);
                  resolve();
              } else reject(new Error('Image not found'));
          };
          req.onerror = () => reject(req.error);
      });
  },

  deleteGalleryImage: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_GALLERY, 'readwrite');
      transaction.objectStore(STORE_GALLERY).delete(id);
  },

  // --- XHS Stock Images ---
  getXhsStockImages: async (): Promise<XhsStockImage[]> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_XHS_STOCK, 'readonly');
          const request = transaction.objectStore(STORE_XHS_STOCK).getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveXhsStockImage: async (img: XhsStockImage): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_XHS_STOCK, 'readwrite');
      transaction.objectStore(STORE_XHS_STOCK).put(img);
  },

  deleteXhsStockImage: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_XHS_STOCK, 'readwrite');
      transaction.objectStore(STORE_XHS_STOCK).delete(id);
  },

  updateXhsStockImageUsage: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_XHS_STOCK, 'readwrite');
      const store = transaction.objectStore(STORE_XHS_STOCK);
      return new Promise((resolve, reject) => {
          const req = store.get(id);
          req.onsuccess = () => {
              const data = req.result as XhsStockImage;
              if (data) {
                  data.usedCount = (data.usedCount || 0) + 1;
                  data.lastUsedAt = Date.now();
                  store.put(data);
                  resolve();
              } else reject(new Error('Stock image not found'));
          };
          req.onerror = () => reject(req.error);
      });
  },

  // --- XHS Activities (Free Roam) ---
  saveXhsActivity: async (activity: XhsActivityRecord): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_XHS_ACTIVITIES, 'readwrite');
      transaction.objectStore(STORE_XHS_ACTIVITIES).put(activity);
  },

  getXhsActivities: async (characterId: string, limit?: number): Promise<XhsActivityRecord[]> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_XHS_ACTIVITIES, 'readonly');
          const store = transaction.objectStore(STORE_XHS_ACTIVITIES);
          const index = store.index('characterId');
          const request = index.getAll(IDBKeyRange.only(characterId));
          request.onsuccess = () => {
              let results = (request.result || []) as XhsActivityRecord[];
              results.sort((a, b) => b.timestamp - a.timestamp);
              if (limit) results = results.slice(0, limit);
              resolve(results);
          };
          request.onerror = () => reject(request.error);
      });
  },

  getAllXhsActivities: async (): Promise<XhsActivityRecord[]> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_XHS_ACTIVITIES, 'readonly');
          const request = transaction.objectStore(STORE_XHS_ACTIVITIES).getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  deleteXhsActivity: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_XHS_ACTIVITIES, 'readwrite');
      transaction.objectStore(STORE_XHS_ACTIVITIES).delete(id);
  },

  clearXhsActivities: async (characterId: string): Promise<void> => {
      const activities = await DB.getXhsActivities(characterId);
      const db = await openDB();
      const transaction = db.transaction(STORE_XHS_ACTIVITIES, 'readwrite');
      const store = transaction.objectStore(STORE_XHS_ACTIVITIES);
      for (const a of activities) {
          store.delete(a.id);
      }
  },

  saveScheduledMessage: async (msg: ScheduledMessage): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_SCHEDULED, 'readwrite');
      transaction.objectStore(STORE_SCHEDULED).put(msg);
  },

  getDueScheduledMessages: async (charId: string): Promise<ScheduledMessage[]> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_SCHEDULED, 'readonly');
          const store = transaction.objectStore(STORE_SCHEDULED);
          const index = store.index('charId');
          const request = index.getAll(IDBKeyRange.only(charId));
          request.onsuccess = () => {
              const all = request.result as ScheduledMessage[];
              const now = Date.now();
              const due = all.filter(m => m.dueAt <= now);
              resolve(due);
          };
          request.onerror = () => reject(request.error);
      });
  },

  deleteScheduledMessage: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_SCHEDULED, 'readwrite');
      transaction.objectStore(STORE_SCHEDULED).delete(id);
  },

  saveUserProfile: async (profile: UserProfile): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_USER, 'readwrite');
      transaction.objectStore(STORE_USER).put({ ...profile, id: 'me' });
  },

  getUserProfile: async (): Promise<UserProfile | null> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_USER, 'readonly');
          const store = transaction.objectStore(STORE_USER);
          const request = store.get('me');
          request.onsuccess = () => {
              if (request.result) {
                  const { id, ...profile } = request.result;
                  resolve(profile as UserProfile);
              } else {
                  resolve(null);
              }
          };
          request.onerror = () => reject(request.error);
      });
  },

  getDiariesByCharId: async (charId: string): Promise<DiaryEntry[]> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_DIARIES, 'readonly');
          const store = transaction.objectStore(STORE_DIARIES);
          const index = store.index('charId');
          const request = index.getAll(IDBKeyRange.only(charId));
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveDiary: async (diary: DiaryEntry): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_DIARIES, 'readwrite');
      transaction.objectStore(STORE_DIARIES).put(diary);
  },

  deleteDiary: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_DIARIES, 'readwrite');
      transaction.objectStore(STORE_DIARIES).delete(id);
  },

  getAllTasks: async (): Promise<Task[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_TASKS)) return [];
      
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_TASKS, 'readonly');
          const store = transaction.objectStore(STORE_TASKS);
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveTask: async (task: Task): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_TASKS, 'readwrite');
      transaction.objectStore(STORE_TASKS).put(task);
  },

  deleteTask: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_TASKS, 'readwrite');
      transaction.objectStore(STORE_TASKS).delete(id);
  },

  getAllAnniversaries: async (): Promise<Anniversary[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_ANNIVERSARIES)) return [];

      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_ANNIVERSARIES, 'readonly');
          const store = transaction.objectStore(STORE_ANNIVERSARIES);
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveAnniversary: async (anniversary: Anniversary): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_ANNIVERSARIES, 'readwrite');
      transaction.objectStore(STORE_ANNIVERSARIES).put(anniversary);
  },

  deleteAnniversary: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_ANNIVERSARIES, 'readwrite');
      transaction.objectStore(STORE_ANNIVERSARIES).delete(id);
  },

  getRoomTodo: async (charId: string, date: string): Promise<RoomTodo | null> => {
      const db = await openDB();
      const id = `${charId}_${date}`;
      return new Promise((resolve, reject) => {
          if (!db.objectStoreNames.contains(STORE_ROOM_TODOS)) { resolve(null); return; }
          const transaction = db.transaction(STORE_ROOM_TODOS, 'readonly');
          const store = transaction.objectStore(STORE_ROOM_TODOS);
          const req = store.get(id);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
      });
  },

  saveRoomTodo: async (todo: RoomTodo): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_ROOM_TODOS, 'readwrite');
      transaction.objectStore(STORE_ROOM_TODOS).put(todo);
  },

  getRoomNotes: async (charId: string): Promise<RoomNote[]> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          if (!db.objectStoreNames.contains(STORE_ROOM_NOTES)) { resolve([]); return; }
          const transaction = db.transaction(STORE_ROOM_NOTES, 'readonly');
          const store = transaction.objectStore(STORE_ROOM_NOTES);
          const index = store.index('charId');
          const request = index.getAll(IDBKeyRange.only(charId));
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveRoomNote: async (note: RoomNote): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_ROOM_NOTES, 'readwrite');
      transaction.objectStore(STORE_ROOM_NOTES).put(note);
  },

  deleteRoomNote: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_ROOM_NOTES, 'readwrite');
      transaction.objectStore(STORE_ROOM_NOTES).delete(id);
  },

  // ─── Daily Schedule (角色日程表) ───
  getDailySchedule: async (charId: string, date: string): Promise<DailySchedule | null> => {
      const db = await openDB();
      const id = `${charId}_${date}`;
      return new Promise((resolve, reject) => {
          if (!db.objectStoreNames.contains(STORE_DAILY_SCHEDULE)) { resolve(null); return; }
          const transaction = db.transaction(STORE_DAILY_SCHEDULE, 'readonly');
          const store = transaction.objectStore(STORE_DAILY_SCHEDULE);
          const req = store.get(id);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
      });
  },

  saveDailySchedule: async (schedule: DailySchedule): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_DAILY_SCHEDULE, 'readwrite');
      transaction.objectStore(STORE_DAILY_SCHEDULE).put(schedule);
  },

  deleteDailySchedule: async (charId: string, date: string): Promise<void> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_DAILY_SCHEDULE)) return;
      const transaction = db.transaction(STORE_DAILY_SCHEDULE, 'readwrite');
      transaction.objectStore(STORE_DAILY_SCHEDULE).delete(`${charId}_${date}`);
  },

  // ─── 热点快照 (分时段，全角色共享) ───
  getHotNewsSnapshot: async (id: string): Promise<HotNewsSnapshot | null> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          if (!db.objectStoreNames.contains(STORE_HOTNEWS)) { resolve(null); return; }
          const transaction = db.transaction(STORE_HOTNEWS, 'readonly');
          const req = transaction.objectStore(STORE_HOTNEWS).get(id);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
      });
  },

  saveHotNewsSnapshot: async (snapshot: HotNewsSnapshot): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_HOTNEWS, 'readwrite');
      transaction.objectStore(STORE_HOTNEWS).put(snapshot);
  },

  // 拿最近一次快照（按 fetchedAt 倒序），失败兜底与 App 展示用
  getLatestHotNewsSnapshot: async (): Promise<HotNewsSnapshot | null> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          if (!db.objectStoreNames.contains(STORE_HOTNEWS)) { resolve(null); return; }
          const transaction = db.transaction(STORE_HOTNEWS, 'readonly');
          const req = transaction.objectStore(STORE_HOTNEWS).getAll();
          req.onsuccess = () => {
              const all = (req.result || []) as HotNewsSnapshot[];
              if (all.length === 0) { resolve(null); return; }
              all.sort((a, b) => b.fetchedAt - a.fetchedAt);
              resolve(all[0]);
          };
          req.onerror = () => reject(req.error);
      });
  },

  // 清理过期快照（保留最近 N 条），避免无限堆积
  pruneHotNewsSnapshots: async (keep = 12): Promise<void> => {
      const db = await openDB();
      return new Promise((resolve) => {
          if (!db.objectStoreNames.contains(STORE_HOTNEWS)) { resolve(); return; }
          const transaction = db.transaction(STORE_HOTNEWS, 'readwrite');
          const store = transaction.objectStore(STORE_HOTNEWS);
          const req = store.getAll();
          req.onsuccess = () => {
              const all = (req.result || []) as HotNewsSnapshot[];
              all.sort((a, b) => b.fetchedAt - a.fetchedAt);
              all.slice(keep).forEach(s => store.delete(s.id));
              resolve();
          };
          req.onerror = () => resolve();
      });
  },

  getScheduleCoverImage: async (charId: string): Promise<string | null> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          if (!db.objectStoreNames.contains(STORE_DAILY_SCHEDULE)) { resolve(null); return; }
          const transaction = db.transaction(STORE_DAILY_SCHEDULE, 'readonly');
          const store = transaction.objectStore(STORE_DAILY_SCHEDULE);
          const req = store.openCursor();
          req.onsuccess = () => {
              const cursor = req.result;
              if (cursor) {
                  const val = cursor.value as DailySchedule;
                  if (val.charId === charId && val.coverImage) {
                      resolve(val.coverImage);
                      return;
                  }
                  cursor.continue();
              } else {
                  resolve(null);
              }
          };
          req.onerror = () => reject(req.error);
      });
  },

  // ─── Handbook (手账) ───
  getHandbook: async (date: string): Promise<HandbookEntry | null> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          if (!db.objectStoreNames.contains(STORE_HANDBOOK)) { resolve(null); return; }
          const transaction = db.transaction(STORE_HANDBOOK, 'readonly');
          const store = transaction.objectStore(STORE_HANDBOOK);
          const req = store.get(date);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
      });
  },

  getAllHandbooks: async (): Promise<HandbookEntry[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_HANDBOOK)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_HANDBOOK, 'readonly');
          const store = transaction.objectStore(STORE_HANDBOOK);
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
      });
  },

  saveHandbook: async (entry: HandbookEntry): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_HANDBOOK, 'readwrite');
      transaction.objectStore(STORE_HANDBOOK).put(entry);
  },

  deleteHandbook: async (date: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_HANDBOOK, 'readwrite');
      transaction.objectStore(STORE_HANDBOOK).delete(date);
  },

  // ─── Trackers (手账打卡引擎) ───
  getAllTrackers: async (): Promise<Tracker[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_TRACKERS)) return [];
      return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_TRACKERS, 'readonly');
          const req = tx.objectStore(STORE_TRACKERS).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
      });
  },

  saveTracker: async (tracker: Tracker): Promise<void> => {
      const db = await openDB();
      const tx = db.transaction(STORE_TRACKERS, 'readwrite');
      tx.objectStore(STORE_TRACKERS).put(tracker);
  },

  deleteTracker: async (id: string): Promise<void> => {
      const db = await openDB();
      // 同时删掉该 tracker 的所有 entries
      const tx = db.transaction([STORE_TRACKERS, STORE_TRACKER_ENTRIES], 'readwrite');
      tx.objectStore(STORE_TRACKERS).delete(id);
      const teStore = tx.objectStore(STORE_TRACKER_ENTRIES);
      const idx = teStore.index('trackerId');
      const req = idx.openCursor(IDBKeyRange.only(id));
      req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) { cursor.delete(); cursor.continue(); }
      };
  },

  getTrackerEntriesByTracker: async (trackerId: string): Promise<TrackerEntry[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_TRACKER_ENTRIES)) return [];
      return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_TRACKER_ENTRIES, 'readonly');
          const idx = tx.objectStore(STORE_TRACKER_ENTRIES).index('trackerId');
          const req = idx.getAll(IDBKeyRange.only(trackerId));
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
      });
  },

  getTrackerEntry: async (trackerId: string, date: string): Promise<TrackerEntry | null> => {
      // 复合查询:用 tracker 索引,客户端再过滤 date(简单且足够快)
      const all = await DB.getTrackerEntriesByTracker(trackerId);
      return all.find(e => e.date === date) || null;
  },

  saveTrackerEntry: async (entry: TrackerEntry): Promise<void> => {
      const db = await openDB();
      const tx = db.transaction(STORE_TRACKER_ENTRIES, 'readwrite');
      tx.objectStore(STORE_TRACKER_ENTRIES).put(entry);
  },

  deleteTrackerEntry: async (id: string): Promise<void> => {
      const db = await openDB();
      const tx = db.transaction(STORE_TRACKER_ENTRIES, 'readwrite');
      tx.objectStore(STORE_TRACKER_ENTRIES).delete(id);
  },

  // ─── 生活记录（档案 App：生理期 / 药盒 / 锻炼；记账走 bank_transactions） ───
  getAllLifeRecords: async (): Promise<LifeRecord[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_LIFE_RECORDS)) return [];
      return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_LIFE_RECORDS, 'readonly');
          const req = tx.objectStore(STORE_LIFE_RECORDS).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
      });
  },

  getLifeRecordById: async (id: string): Promise<LifeRecord | null> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_LIFE_RECORDS)) return null;
      return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_LIFE_RECORDS, 'readonly');
          const req = tx.objectStore(STORE_LIFE_RECORDS).get(id);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
      });
  },

  saveLifeRecord: async (record: LifeRecord): Promise<void> => {
      const db = await openDB();
      const tx = db.transaction(STORE_LIFE_RECORDS, 'readwrite');
      tx.objectStore(STORE_LIFE_RECORDS).put(record);
  },

  deleteLifeRecord: async (id: string): Promise<void> => {
      const db = await openDB();
      const tx = db.transaction(STORE_LIFE_RECORDS, 'readwrite');
      tx.objectStore(STORE_LIFE_RECORDS).delete(id);
  },

  getAllMedPlans: async (): Promise<MedPlan[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_MED_PLANS)) return [];
      return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_MED_PLANS, 'readonly');
          const req = tx.objectStore(STORE_MED_PLANS).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
      });
  },

  saveMedPlan: async (plan: MedPlan): Promise<void> => {
      const db = await openDB();
      const tx = db.transaction(STORE_MED_PLANS, 'readwrite');
      tx.objectStore(STORE_MED_PLANS).put(plan);
  },

  deleteMedPlan: async (id: string): Promise<void> => {
      const db = await openDB();
      const tx = db.transaction(STORE_MED_PLANS, 'readwrite');
      tx.objectStore(STORE_MED_PLANS).delete(id);
  },

  getLifeRecordSettings: async (): Promise<LifeRecordSettings | null> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_LIFE_SETTINGS)) return null;
      return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_LIFE_SETTINGS, 'readonly');
          const req = tx.objectStore(STORE_LIFE_SETTINGS).get('main');
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
      });
  },

  saveLifeRecordSettings: async (settings: LifeRecordSettings): Promise<void> => {
      const db = await openDB();
      const tx = db.transaction(STORE_LIFE_SETTINGS, 'readwrite');
      tx.objectStore(STORE_LIFE_SETTINGS).put({ ...settings, id: 'main' });
  },

  getAllCourses: async (): Promise<StudyCourse[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_COURSES)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_COURSES, 'readonly');
          const store = transaction.objectStore(STORE_COURSES);
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveCourse: async (course: StudyCourse): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_COURSES, 'readwrite');
      transaction.objectStore(STORE_COURSES).put(course);
  },

  deleteCourse: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_COURSES, 'readwrite');
      transaction.objectStore(STORE_COURSES).delete(id);
  },

  // --- Quiz / Practice Book ---
  getAllQuizzes: async (): Promise<QuizSession[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_QUIZZES)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_QUIZZES, 'readonly');
          const store = transaction.objectStore(STORE_QUIZZES);
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveQuiz: async (quiz: QuizSession): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_QUIZZES, 'readwrite');
      transaction.objectStore(STORE_QUIZZES).put(quiz);
  },

  deleteQuiz: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_QUIZZES, 'readwrite');
      transaction.objectStore(STORE_QUIZZES).delete(id);
  },

  getAllGames: async (): Promise<GameSession[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_GAMES)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_GAMES, 'readonly');
          const store = transaction.objectStore(STORE_GAMES);
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveGame: async (game: GameSession): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_GAMES, 'readwrite');
      transaction.objectStore(STORE_GAMES).put(game);
  },

  deleteGame: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_GAMES, 'readwrite');
      transaction.objectStore(STORE_GAMES).delete(id);
  },

  getAllWorldbooks: async (): Promise<Worldbook[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_WORLDBOOKS)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_WORLDBOOKS, 'readonly');
          const store = transaction.objectStore(STORE_WORLDBOOKS);
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveWorldbook: async (book: Worldbook): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_WORLDBOOKS, 'readwrite');
      transaction.objectStore(STORE_WORLDBOOKS).put(book);
  },

  deleteWorldbook: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_WORLDBOOKS, 'readwrite');
      transaction.objectStore(STORE_WORLDBOOKS).delete(id);
  },

  getAllNovels: async (): Promise<NovelBook[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_NOVELS)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_NOVELS, 'readonly');
          const store = transaction.objectStore(STORE_NOVELS);
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveNovel: async (novel: NovelBook): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_NOVELS, 'readwrite');
      transaction.objectStore(STORE_NOVELS).put(novel);
  },

  deleteNovel: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_NOVELS, 'readwrite');
      transaction.objectStore(STORE_NOVELS).delete(id);
  },

  // --- VR World 「彼方」 全局小说库 ---
  getVRNovels: async (): Promise<VRWorldNovel[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_VR_NOVELS)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_VR_NOVELS, 'readonly');
          const request = transaction.objectStore(STORE_VR_NOVELS).getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveVRNovel: async (novel: VRWorldNovel): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_VR_NOVELS, 'readwrite');
      transaction.objectStore(STORE_VR_NOVELS).put(novel);
  },

  deleteVRNovel: async (id: string): Promise<void> => {
      const db = await openDB();
      // 删书时连带删掉这本书的全部批注
      const annIds: string[] = await new Promise((resolve) => {
          if (!db.objectStoreNames.contains(STORE_VR_ANNOTATIONS)) return resolve([]);
          const tx = db.transaction(STORE_VR_ANNOTATIONS, 'readonly');
          const idx = tx.objectStore(STORE_VR_ANNOTATIONS).index('novelId');
          const req = idx.getAll(id);
          req.onsuccess = () => resolve((req.result || []).map((a: VRNovelAnnotation) => a.id));
          req.onerror = () => resolve([]);
      });
      const tx = db.transaction([STORE_VR_NOVELS, STORE_VR_ANNOTATIONS], 'readwrite');
      tx.objectStore(STORE_VR_NOVELS).delete(id);
      const annStore = tx.objectStore(STORE_VR_ANNOTATIONS);
      for (const aid of annIds) annStore.delete(aid);
  },

  // --- VR World 小说批注 ---
  getVRAnnotations: async (novelId?: string): Promise<VRNovelAnnotation[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_VR_ANNOTATIONS)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_VR_ANNOTATIONS, 'readonly');
          const store = transaction.objectStore(STORE_VR_ANNOTATIONS);
          const request = novelId ? store.index('novelId').getAll(novelId) : store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveVRAnnotation: async (annotation: VRNovelAnnotation): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_VR_ANNOTATIONS, 'readwrite');
      transaction.objectStore(STORE_VR_ANNOTATIONS).put(annotation);
  },

  deleteVRAnnotation: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_VR_ANNOTATIONS, 'readwrite');
      transaction.objectStore(STORE_VR_ANNOTATIONS).delete(id);
  },

  // --- 捏脸系统自定义部件 ---
  getCustomCreatorParts: async (): Promise<CustomCreatorPart[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_CC_PARTS)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_CC_PARTS, 'readonly');
          const request = transaction.objectStore(STORE_CC_PARTS).getAll();
          request.onsuccess = () => resolve((request.result || []).sort((a: CustomCreatorPart, b: CustomCreatorPart) => a.createdAt - b.createdAt));
          request.onerror = () => reject(request.error);
      });
  },

  saveCustomCreatorPart: async (part: CustomCreatorPart): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_CC_PARTS, 'readwrite');
      transaction.objectStore(STORE_CC_PARTS).put(part);
  },

  deleteCustomCreatorPart: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_CC_PARTS, 'readwrite');
      transaction.objectStore(STORE_CC_PARTS).delete(id);
  },

  // --- 听歌房共享状态（单例 id='state'） ---
  getVRMusicRoom: async (): Promise<VRMusicRoomState | null> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_VR_MUSIC)) return null;
      return new Promise((resolve) => {
          const transaction = db.transaction(STORE_VR_MUSIC, 'readonly');
          const request = transaction.objectStore(STORE_VR_MUSIC).get('state');
          request.onsuccess = () => resolve(request.result || null);
          request.onerror = () => resolve(null);
      });
  },

  saveVRMusicRoom: async (state: VRMusicRoomState): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_VR_MUSIC, 'readwrite');
      transaction.objectStore(STORE_VR_MUSIC).put({ ...state, id: 'state' });
  },

  // --- 留言簿共享状态（单例 id='board'） ---
  getVRGuestbook: async (): Promise<VRGuestbookState | null> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_VR_GUESTBOOK)) return null;
      return new Promise((resolve) => {
          const transaction = db.transaction(STORE_VR_GUESTBOOK, 'readonly');
          const request = transaction.objectStore(STORE_VR_GUESTBOOK).get('board');
          request.onsuccess = () => resolve(request.result || null);
          request.onerror = () => resolve(null);
      });
  },

  saveVRGuestbook: async (state: VRGuestbookState): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_VR_GUESTBOOK, 'readwrite');
      // 不限存储条数：留言墙已支持每 50 条翻页，旧留言全部保留可翻看
      const messages = state.messages || [];
      transaction.objectStore(STORE_VR_GUESTBOOK).put({ ...state, id: 'board', messages });
  },

  clearVRGuestbook: async (): Promise<void> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_VR_GUESTBOOK)) return;
      const transaction = db.transaction(STORE_VR_GUESTBOOK, 'readwrite');
      transaction.objectStore(STORE_VR_GUESTBOOK).put({ id: 'board', messages: [], updatedAt: Date.now() });
  },

  // --- 剧院·投稿剧本库 ---
  getVRScripts: async (): Promise<VRScript[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_VR_SCRIPTS)) return [];
      return new Promise((resolve) => {
          const request = db.transaction(STORE_VR_SCRIPTS, 'readonly').objectStore(STORE_VR_SCRIPTS).getAll();
          request.onsuccess = () => resolve((request.result || []).sort((a: VRScript, b: VRScript) => b.createdAt - a.createdAt));
          request.onerror = () => resolve([]);
      });
  },
  saveVRScript: async (script: VRScript): Promise<void> => {
      const db = await openDB();
      db.transaction(STORE_VR_SCRIPTS, 'readwrite').objectStore(STORE_VR_SCRIPTS).put(script);
  },
  deleteVRScript: async (id: string): Promise<void> => {
      const db = await openDB();
      db.transaction(STORE_VR_SCRIPTS, 'readwrite').objectStore(STORE_VR_SCRIPTS).delete(id);
  },

  // --- 剧院·历史舞台剧 ---
  getVRStagedPlays: async (): Promise<VRStagedPlay[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_VR_PLAYS)) return [];
      return new Promise((resolve) => {
          const request = db.transaction(STORE_VR_PLAYS, 'readonly').objectStore(STORE_VR_PLAYS).getAll();
          request.onsuccess = () => resolve((request.result || []).sort((a: VRStagedPlay, b: VRStagedPlay) => b.createdAt - a.createdAt));
          request.onerror = () => resolve([]);
      });
  },
  saveVRStagedPlay: async (play: VRStagedPlay): Promise<void> => {
      const db = await openDB();
      db.transaction(STORE_VR_PLAYS, 'readwrite').objectStore(STORE_VR_PLAYS).put(play);
  },
  deleteVRStagedPlay: async (id: string): Promise<void> => {
      const db = await openDB();
      db.transaction(STORE_VR_PLAYS, 'readwrite').objectStore(STORE_VR_PLAYS).delete(id);
  },

  // --- 剧院·用户自定义写作风格预设 ---
  getVRPresets: async (): Promise<any[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_VR_PRESETS)) return [];
      return new Promise((resolve) => {
          const request = db.transaction(STORE_VR_PRESETS, 'readonly').objectStore(STORE_VR_PRESETS).getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => resolve([]);
      });
  },
  saveVRPreset: async (preset: { key: string; name: string; prompt: string; blurb?: string }): Promise<void> => {
      const db = await openDB();
      db.transaction(STORE_VR_PRESETS, 'readwrite').objectStore(STORE_VR_PRESETS).put(preset);
  },
  deleteVRPreset: async (key: string): Promise<void> => {
      const db = await openDB();
      db.transaction(STORE_VR_PRESETS, 'readwrite').objectStore(STORE_VR_PRESETS).delete(key);
  },

  // --- 邮局信件 ---
  getVRLetters: async (): Promise<VRLetter[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_VR_LETTERS)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_VR_LETTERS, 'readonly');
          const request = transaction.objectStore(STORE_VR_LETTERS).getAll();
          request.onsuccess = () => resolve((request.result || []).sort((a: VRLetter, b: VRLetter) => b.createdAt - a.createdAt));
          request.onerror = () => reject(request.error);
      });
  },

  saveVRLetter: async (letter: VRLetter): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_VR_LETTERS, 'readwrite');
      transaction.objectStore(STORE_VR_LETTERS).put(letter);
  },

  saveVRLetters: async (letters: VRLetter[]): Promise<void> => {
      if (letters.length === 0) return;
      const db = await openDB();
      const transaction = db.transaction(STORE_VR_LETTERS, 'readwrite');
      const store = transaction.objectStore(STORE_VR_LETTERS);
      for (const l of letters) store.put(l);
      return new Promise((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
      });
  },

  deleteVRLetter: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_VR_LETTERS, 'readwrite');
      transaction.objectStore(STORE_VR_LETTERS).delete(id);
  },

  // --- 家园（世界定义 + 演绎历史）---
  getWorlds: async (): Promise<WorldProfile[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_WORLDS)) return [];
      return new Promise((resolve, reject) => {
          const request = db.transaction(STORE_WORLDS, 'readonly').objectStore(STORE_WORLDS).getAll();
          request.onsuccess = () => resolve((request.result || []).map(normalizeWorldRelationships).sort((a: WorldProfile, b: WorldProfile) => b.updatedAt - a.updatedAt));
          request.onerror = () => reject(request.error);
      });
  },

  getWorld: async (id: string): Promise<WorldProfile | null> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_WORLDS)) return null;
      return new Promise((resolve, reject) => {
          const request = db.transaction(STORE_WORLDS, 'readonly').objectStore(STORE_WORLDS).get(id);
          request.onsuccess = () => resolve(request.result ? normalizeWorldRelationships(request.result) : null);
          request.onerror = () => reject(request.error);
      });
  },

  saveWorld: async (world: WorldProfile): Promise<void> => {
      const db = await openDB();
      const tx = db.transaction(STORE_WORLDS, 'readwrite');
      tx.objectStore(STORE_WORLDS).put(world);
      return new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
      });
  },

  deleteWorld: async (id: string): Promise<void> => {
      const db = await openDB();
      // 连带删掉该世界的全部演绎历史
      const tx = db.transaction([STORE_WORLDS, STORE_WORLD_EPISODES], 'readwrite');
      tx.objectStore(STORE_WORLDS).delete(id);
      const epStore = tx.objectStore(STORE_WORLD_EPISODES);
      const cursorReq = epStore.index('worldId').openCursor(IDBKeyRange.only(id));
      cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) { cursor.delete(); cursor.continue(); }
      };
      return new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
      });
  },

  getWorldEpisodes: async (worldId: string, limit: number = 30): Promise<WorldEpisode[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_WORLD_EPISODES)) return [];
      return new Promise((resolve, reject) => {
          const index = db.transaction(STORE_WORLD_EPISODES, 'readonly').objectStore(STORE_WORLD_EPISODES).index('worldId');
          const request = index.getAll(IDBKeyRange.only(worldId));
          request.onsuccess = () => {
              const all = (request.result || []).sort((a: WorldEpisode, b: WorldEpisode) => b.round - a.round);
              resolve(all.slice(0, limit));
          };
          request.onerror = () => reject(request.error);
      });
  },

  saveWorldEpisode: async (episode: WorldEpisode): Promise<void> => {
      const db = await openDB();
      const tx = db.transaction(STORE_WORLD_EPISODES, 'readwrite');
      tx.objectStore(STORE_WORLD_EPISODES).put(episode);
      return new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
      });
  },

  // --- 彼方独立 API + 调用记录（vr_settings 单例 store）---
  getVRApiConfig: async (): Promise<any | null> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_VR_SETTINGS)) return null;
      return new Promise((resolve) => {
          const tx = db.transaction(STORE_VR_SETTINGS, 'readonly');
          const req = tx.objectStore(STORE_VR_SETTINGS).get('api');
          req.onsuccess = () => resolve(req.result?.config ?? null);
          req.onerror = () => resolve(null);
      });
  },

  saveVRApiConfig: async (config: any | null): Promise<void> => {
      const db = await openDB();
      const tx = db.transaction(STORE_VR_SETTINGS, 'readwrite');
      tx.objectStore(STORE_VR_SETTINGS).put({ id: 'api', config: config ?? null });
  },

  getVRApiLog: async (): Promise<any[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_VR_SETTINGS)) return [];
      return new Promise((resolve) => {
          const tx = db.transaction(STORE_VR_SETTINGS, 'readonly');
          const req = tx.objectStore(STORE_VR_SETTINGS).get('apilog');
          req.onsuccess = () => resolve(req.result?.entries ?? []);
          req.onerror = () => resolve([]);
      });
  },

  setVRApiLog: async (entries: any[]): Promise<void> => {
      const db = await openDB();
      const tx = db.transaction(STORE_VR_SETTINGS, 'readwrite');
      tx.objectStore(STORE_VR_SETTINGS).put({ id: 'apilog', entries: (entries || []).slice(0, 120) });
  },

  appendVRApiLog: async (entry: any): Promise<void> => {
      const db = await openDB();
      const read = (): Promise<any[]> => new Promise((resolve) => {
          const tx = db.transaction(STORE_VR_SETTINGS, 'readonly');
          const req = tx.objectStore(STORE_VR_SETTINGS).get('apilog');
          req.onsuccess = () => resolve(req.result?.entries ?? []);
          req.onerror = () => resolve([]);
      });
      const cur = await read();
      cur.unshift(entry);
      const tx = db.transaction(STORE_VR_SETTINGS, 'readwrite');
      tx.objectStore(STORE_VR_SETTINGS).put({ id: 'apilog', entries: cur.slice(0, 120) });
  },

  clearVRApiLog: async (): Promise<void> => {
      const db = await openDB();
      const tx = db.transaction(STORE_VR_SETTINGS, 'readwrite');
      tx.objectStore(STORE_VR_SETTINGS).put({ id: 'apilog', entries: [] });
  },

  // --- 全局 API 调用记录（api_call_log 单例 store，id='log'）---
  // 只保留近 5 天的记录，超期在写入时丢弃。读出时再过滤一次兜底。
  getApiCallLog: async (): Promise<any[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_API_CALL_LOG)) return [];
      return new Promise((resolve) => {
          const tx = db.transaction(STORE_API_CALL_LOG, 'readonly');
          const req = tx.objectStore(STORE_API_CALL_LOG).get('log');
          req.onsuccess = () => {
              const entries: any[] = req.result?.entries ?? [];
              const cutoff = Date.now() - API_CALL_LOG_MAX_AGE_MS;
              resolve(entries.filter((e) => (e?.timestamp ?? 0) > cutoff));
          };
          req.onerror = () => resolve([]);
      });
  },

  appendApiCallLog: async (entry: any): Promise<void> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_API_CALL_LOG)) return;
      const read = (): Promise<any[]> => new Promise((resolve) => {
          const tx = db.transaction(STORE_API_CALL_LOG, 'readonly');
          const req = tx.objectStore(STORE_API_CALL_LOG).get('log');
          req.onsuccess = () => resolve(req.result?.entries ?? []);
          req.onerror = () => resolve([]);
      });
      const cur = await read();
      cur.unshift(entry);
      const cutoff = Date.now() - API_CALL_LOG_MAX_AGE_MS;
      const pruned = cur
          .filter((e) => (e?.timestamp ?? 0) > cutoff)
          .slice(0, API_CALL_LOG_MAX_ENTRIES);
      const tx = db.transaction(STORE_API_CALL_LOG, 'readwrite');
      tx.objectStore(STORE_API_CALL_LOG).put({ id: 'log', entries: pruned });
  },

  clearApiCallLog: async (): Promise<void> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_API_CALL_LOG)) return;
      const tx = db.transaction(STORE_API_CALL_LOG, 'readwrite');
      tx.objectStore(STORE_API_CALL_LOG).put({ id: 'log', entries: [] });
  },

  // 导入备份用：直接写回一条 vr_settings 原始记录（{id, ...}）。
  saveVRSettingRecord: async (record: any): Promise<void> => {
      if (!record || !record.id) return;
      const db = await openDB();
      const tx = db.transaction(STORE_VR_SETTINGS, 'readwrite');
      tx.objectStore(STORE_VR_SETTINGS).put(record);
  },

  // --- BANK / PET APP LOGIC ---
  getBankState: async (): Promise<BankFullState | null> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          if (!db.objectStoreNames.contains(STORE_BANK_DATA)) { resolve(null); return; }
          const transaction = db.transaction(STORE_BANK_DATA, 'readonly');
          const store = transaction.objectStore(STORE_BANK_DATA);
          const req = store.get('main_state');
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
      });
  },

  saveBankState: async (state: BankFullState): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_BANK_DATA, 'readwrite');
      // Strip dollhouse from the main state save (dollhouse is saved separately)
      const { dollhouse: _dh, ...shopWithoutDollhouse } = (state.shop || {}) as any;
      const cleanState = { ...state, shop: shopWithoutDollhouse };
      transaction.objectStore(STORE_BANK_DATA).put({ ...cleanState, id: 'main_state' });
      return new Promise((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
      });
  },

  // Dollhouse state saved separately (same pattern as RoomApp's per-character roomConfig)
  getBankDollhouse: async (): Promise<DollhouseState | null> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          if (!db.objectStoreNames.contains(STORE_BANK_DATA)) { resolve(null); return; }
          const transaction = db.transaction(STORE_BANK_DATA, 'readonly');
          const store = transaction.objectStore(STORE_BANK_DATA);
          const req = store.get('dollhouse_state');
          req.onsuccess = () => resolve(req.result?.data || null);
          req.onerror = () => reject(req.error);
      });
  },

  saveBankDollhouse: async (state: DollhouseState): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_BANK_DATA, 'readwrite');
      transaction.objectStore(STORE_BANK_DATA).put({ id: 'dollhouse_state', data: state });
      return new Promise((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
      });
  },

  getAllTransactions: async (): Promise<BankTransaction[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_BANK_TX)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_BANK_TX, 'readonly');
          const store = transaction.objectStore(STORE_BANK_TX);
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveTransaction: async (txData: BankTransaction): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_BANK_TX, 'readwrite');
      transaction.objectStore(STORE_BANK_TX).put(txData);
  },

  deleteTransaction: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_BANK_TX, 'readwrite');
      transaction.objectStore(STORE_BANK_TX).delete(id);
  },

  // --- Songs (Songwriting App) ---
  getAllSongs: async (): Promise<SongSheet[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_SONGS)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_SONGS, 'readonly');
          const store = transaction.objectStore(STORE_SONGS);
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveSong: async (song: SongSheet): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_SONGS, 'readwrite');
      transaction.objectStore(STORE_SONGS).put(song);
  },

  deleteSong: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_SONGS, 'readwrite');
      transaction.objectStore(STORE_SONGS).delete(id);
  },

  // --- Guidebook (攻略本) ---
  getAllGuidebookSessions: async (): Promise<GuidebookSession[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_GUIDEBOOK)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_GUIDEBOOK, 'readonly');
          const store = transaction.objectStore(STORE_GUIDEBOOK);
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveGuidebookSession: async (session: GuidebookSession): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_GUIDEBOOK, 'readwrite');
      transaction.objectStore(STORE_GUIDEBOOK).put(session);
  },

  deleteGuidebookSession: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_GUIDEBOOK, 'readwrite');
      transaction.objectStore(STORE_GUIDEBOOK).delete(id);
  },

  // ── LifeSim (模拟人生) ────────────────────────────────────
  getLifeSimState: async (): Promise<LifeSimState | null> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_LIFE_SIM)) return null;
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_LIFE_SIM, 'readonly');
          const request = transaction.objectStore(STORE_LIFE_SIM).get('main');
          request.onsuccess = () => resolve(request.result || null);
          request.onerror = () => reject(request.error);
      });
  },

  saveLifeSimState: async (state: LifeSimState): Promise<void> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_LIFE_SIM, 'readwrite');
          transaction.objectStore(STORE_LIFE_SIM).put({ ...state, id: 'main' });
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
      });
  },

  clearLifeSimState: async (): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_LIFE_SIM, 'readwrite');
      transaction.objectStore(STORE_LIFE_SIM).clear();
  },

  getRawStoreData: async (storeName: string): Promise<any[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(storeName)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(storeName, 'readonly');
          const store = transaction.objectStore(storeName);
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  /**
   * 游标分批读整表：每攒够 batchSize 条回调一次 onBatch(batch)，回调内消费完即释放，
   * 绝不像 getRawStoreData 那样把整表一次性 getAll 进内存。导出大 store 时用它，把读取
   * 峰值从「整个 store」降到「一个 batch」。
   *
   * 实现要点——每批一个独立 readonly 事务，按主键升序续读（顺序与 getAll 完全一致）：
   * IDB 事务在控制权回到事件循环、且没有挂起请求时会自动提交关闭。onBatch 可能是 async
   * （要 await 写分片 / 让出主线程），await 必然跨过这个提交点把事务关掉，之后再 cursor
   * .continue() 就会抛 TransactionInactiveError。所以这里先在一个事务内用游标攒满一批、
   * 让事务自然关闭，await onBatch 消费完，再用 lowerBound(lastKey, true) 开下一个事务从
   * 断点续读。这是 memoryPalace/db.ts 的 scanAndMigrateLegacy 同款分批事务做法。
   *
   * ⚠ 一致性语义（接进导出前必读）：分批跨多个事务 ≠ getAll 的单事务快照。store 静止时
   * 两者结果一致；但若批次之间有并发写入，key 大于断点的新记录会被带进来、已扫过 key 上的
   * 增删改会漏掉或读到陈旧值——拼出来的可能是内部不一致的 store。getRawStoreData 的单次
   * getAll 至少是「每个 store 自带一致快照」。所以把本函数接进备份导出时，必须先保证导出
   * 期间 store 静止（暂停写入 / 加导出锁），否则要接受「活动中导出 = 尽力而为快照」并补一条
   * 批间改动的回归测试。当前备份导出仍走 getRawStoreData，未用本函数，此约束留给后续接入时兑现。
   */
  getStoreDataChunked: async (
      storeName: string,
      onBatch: (batch: any[]) => void | Promise<void>,
      batchSize = 200,
  ): Promise<void> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(storeName)) return;

      let lastKey: IDBValidKey | null = null;
      for (;;) {
          const { batch, newLastKey, done } = await new Promise<{
              batch: any[]; newLastKey: IDBValidKey | null; done: boolean;
          }>((resolve, reject) => {
              const tx = db.transaction(storeName, 'readonly');
              const store = tx.objectStore(storeName);
              const range = lastKey !== null ? IDBKeyRange.lowerBound(lastKey, true) : undefined;
              const req = store.openCursor(range);
              const collected: any[] = [];
              let bLast: IDBValidKey | null = lastKey;
              let bDone = false;
              req.onsuccess = () => {
                  const cursor = req.result;
                  if (!cursor) { bDone = true; return; } // 走到末尾
                  if (collected.length >= batchSize) return; // 攒够这批，停 continue 等事务关闭
                  collected.push(cursor.value);
                  bLast = cursor.primaryKey;
                  cursor.continue();
              };
              req.onerror = () => reject(req.error);
              tx.oncomplete = () => resolve({ batch: collected, newLastKey: bLast, done: bDone });
              tx.onerror = () => reject(tx.error || new Error('getStoreDataChunked tx failed'));
              tx.onabort = () => reject(tx.error || new Error('getStoreDataChunked tx aborted'));
          });

          if (batch.length > 0) await onBatch(batch);
          lastKey = newLastKey;
          if (done) break;
      }
  },

  exportFullData: async (): Promise<Partial<FullBackupData>> => {
      const db = await openDB();
      
      const getAllFromStore = (storeName: string): Promise<any[]> => {
          if (!db.objectStoreNames.contains(storeName)) {
              return Promise.resolve([]);
          }
          return new Promise((resolve) => {
              const tx = db.transaction(storeName, 'readonly');
              const store = tx.objectStore(storeName);
              const req = store.getAll();
              req.onsuccess = () => resolve(req.result || []);
              req.onerror = () => resolve([]); 
          });
      };

      const [characters, characterGroups, messages, themes, emojis, emojiCategories, assets, galleryImages, userProfiles, diaries, tasks, anniversaries, roomTodos, roomNotes, groups, journalStickers, socialPosts, courses, games, worldbooks, novels, bankTx, bankData, xhsActivities, xhsStockImages, songs, quizzes, guidebookSessions, scheduledMessages, lifeSimStates, handbooks, trackers, trackerEntries, hotNewsSnapshots, vrNovels, vrAnnotations, customCreatorParts, vrMusic, vrGuestbook, vrScripts, vrStagedPlays, vrPresets, vrLetters, vrSettings, worlds, worldEpisodes, lifeRecords, medPlans, lifeRecordSettings] = await Promise.all([
          getAllFromStore(STORE_CHARACTERS),
          getAllFromStore(STORE_CHAR_GROUPS),
          getAllFromStore(STORE_MESSAGES),
          getAllFromStore(STORE_THEMES),
          getAllFromStore(STORE_EMOJIS),
          getAllFromStore(STORE_EMOJI_CATEGORIES),
          getAllFromStore(STORE_ASSETS),
          getAllFromStore(STORE_GALLERY),
          getAllFromStore(STORE_USER),
          getAllFromStore(STORE_DIARIES),
          getAllFromStore(STORE_TASKS),
          getAllFromStore(STORE_ANNIVERSARIES),
          getAllFromStore(STORE_ROOM_TODOS),
          getAllFromStore(STORE_ROOM_NOTES),
          getAllFromStore(STORE_GROUPS),
          getAllFromStore(STORE_JOURNAL_STICKERS),
          getAllFromStore(STORE_SOCIAL_POSTS),
          getAllFromStore(STORE_COURSES),
          getAllFromStore(STORE_GAMES),
          getAllFromStore(STORE_WORLDBOOKS),
          getAllFromStore(STORE_NOVELS),
          getAllFromStore(STORE_BANK_TX),
          getAllFromStore(STORE_BANK_DATA),
          getAllFromStore(STORE_XHS_ACTIVITIES),
          getAllFromStore(STORE_XHS_STOCK),
          getAllFromStore(STORE_SONGS),
          getAllFromStore(STORE_QUIZZES),
          getAllFromStore(STORE_GUIDEBOOK),
          getAllFromStore(STORE_SCHEDULED),
          getAllFromStore(STORE_LIFE_SIM),
          getAllFromStore(STORE_HANDBOOK),
          getAllFromStore(STORE_TRACKERS),
          getAllFromStore(STORE_TRACKER_ENTRIES),
          getAllFromStore(STORE_HOTNEWS),
          getAllFromStore(STORE_VR_NOVELS),
          getAllFromStore(STORE_VR_ANNOTATIONS),
          getAllFromStore(STORE_CC_PARTS),
          getAllFromStore(STORE_VR_MUSIC),
          getAllFromStore(STORE_VR_GUESTBOOK),
          getAllFromStore(STORE_VR_SCRIPTS),
          getAllFromStore(STORE_VR_PLAYS),
          getAllFromStore(STORE_VR_PRESETS),
          getAllFromStore(STORE_VR_LETTERS),
          getAllFromStore(STORE_VR_SETTINGS),
          getAllFromStore(STORE_WORLDS),
          getAllFromStore(STORE_WORLD_EPISODES),
          getAllFromStore(STORE_LIFE_RECORDS),
          getAllFromStore(STORE_MED_PLANS),
          getAllFromStore(STORE_LIFE_SETTINGS),
      ]);

      const userProfile = userProfiles.length > 0 ? {
          name: userProfiles[0].name,
          avatar: userProfiles[0].avatar,
          bio: userProfiles[0].bio
      } : undefined;

      const mainState = bankData.find((d: any) => d.id === 'main_state');
      const dollhouseRecord = bankData.find((d: any) => d.id === 'dollhouse_state');

      return {
          characters, characterGroups, messages, customThemes: themes, savedEmojis: emojis, emojiCategories, assets, galleryImages, userProfile, diaries, tasks, anniversaries, roomTodos, roomNotes, groups, savedJournalStickers: journalStickers, socialPosts, courses, games, worldbooks, novels,
          bankState: mainState ? { ...mainState, id: undefined } : undefined,
          bankDollhouse: dollhouseRecord?.data || undefined,
          bankTransactions: bankTx,
          xhsActivities,
          xhsStockImages,
          songs,
          quizSessions: quizzes,
          guidebookSessions,
          scheduledMessages,
          lifeSimState: lifeSimStates[0] || null,
          handbooks,
          trackers,
          trackerEntries,
          lifeRecords,
          medPlans,
          lifeRecordSettings,
          hotNewsSnapshots,
          vrNovels,
          vrAnnotations,
          customCreatorParts,
          vrMusicRoom: vrMusic && vrMusic.length ? vrMusic[0] : undefined,
          vrGuestbook: vrGuestbook && vrGuestbook.length ? vrGuestbook[0] : undefined,
          vrScripts,
          vrStagedPlays,
          vrPresets,
          vrLetters,
          vrSettings,
          vrPostOffice: exportPostOfficeLocal(), // 邮局本机配置（身份/后端地址，存 localStorage）
          vrSignal: exportSignalLocal(),         // 信号坠落处本机记录（句子归属「你·角色」+ 反复用清单，存 localStorage）
          worlds,
          worldEpisodes,
          worldHomeLocal: exportWorldHomeLocal(), // 家园本机配置：全局 API + 文风收藏（存 localStorage）
          luckinLocal: exportLuckinLocal(),       // 瑞幸 token + 启用状态（存 localStorage）
          mcdLocal: exportMcdLocal(),             // 麦当劳 token + 启用状态（存 localStorage）
          wereadLocal: exportWereadLocal(),       // 微信读书鉴权 + 启用状态（存 localStorage）
          mcpLocal: exportMcpLocal(),             // 通用 MCP 服务器配置（存 localStorage）
          desktopSkinLocal: await exportDesktopSkinLocal(), // 桌面皮肤：界面配色 + 看板 banner（看板图令牌解析为 data URL）
      };
  },

  importFullData: async (
      data: FullBackupData,
      options: {
          beforeWrite?: (root: any, label: string) => Promise<void>;
          onProgress?: (progress: {
              label: string;
              stage: 'start' | 'items' | 'done';
              sectionDone: number;
              sectionTotal: number;
              itemDone?: number;
              itemTotal?: number;
          }) => void;
      } = {}
  ): Promise<void> => {
      const db = await openDB();
      
      const availableStores = [
          STORE_CHARACTERS, STORE_CHAR_GROUPS, STORE_MESSAGES, STORE_THEMES, STORE_EMOJIS, STORE_EMOJI_CATEGORIES,
          STORE_ASSETS, STORE_GALLERY, STORE_USER, STORE_DIARIES,
          STORE_TASKS, STORE_ANNIVERSARIES, STORE_ROOM_TODOS, STORE_ROOM_NOTES,
          STORE_GROUPS, STORE_JOURNAL_STICKERS, STORE_SOCIAL_POSTS, STORE_COURSES, STORE_GAMES, STORE_WORLDBOOKS, STORE_NOVELS, STORE_SONGS,
          STORE_BANK_TX, STORE_BANK_DATA,
          STORE_XHS_ACTIVITIES, STORE_XHS_STOCK,
          STORE_QUIZZES,
          STORE_GUIDEBOOK,
          STORE_SCHEDULED,
          STORE_LIFE_SIM,
          STORE_DAILY_SCHEDULE,
          STORE_HANDBOOK,
          STORE_TRACKERS,
          STORE_TRACKER_ENTRIES,
          STORE_LIFE_RECORDS,
          STORE_MED_PLANS,
          STORE_LIFE_SETTINGS,
          STORE_HOTNEWS,
          STORE_VR_NOVELS, STORE_VR_ANNOTATIONS, STORE_CC_PARTS, STORE_VR_MUSIC, STORE_VR_GUESTBOOK, STORE_VR_SCRIPTS, STORE_VR_PLAYS, STORE_VR_PRESETS, STORE_VR_LETTERS, STORE_VR_SETTINGS,
          STORE_WORLDS, STORE_WORLD_EPISODES,
          'memory_nodes', 'memory_vectors', 'memory_links', 'topic_boxes', 'anticipations', 'event_boxes',
          'room_plates', 'digest_reports',
          'memory_batches', 'pixel_home_assets', 'pixel_home_layouts'
      ].filter(name => db.objectStoreNames.contains(name));

      const hasStore = (storeName: string) => availableStores.includes(storeName);

      const waitForTransaction = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
          tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      });

      const withStore = async (storeName: string, writer: (store: IDBObjectStore) => void): Promise<void> => {
          if (!hasStore(storeName)) return;
          const tx = db.transaction(storeName, 'readwrite');
          try {
              writer(tx.objectStore(storeName));
          } catch (err) {
              try { tx.abort(); } catch { /* ignore */ }
              throw err;
          }
          await waitForTransaction(tx);
      };

      const getAllFromStore = async <T,>(storeName: string): Promise<T[]> => {
          if (!hasStore(storeName)) return [];
          return new Promise((resolve, reject) => {
              const tx = db.transaction(storeName, 'readonly');
              const request = tx.objectStore(storeName).getAll();
              request.onsuccess = () => resolve(request.result as T[]);
              request.onerror = () => reject(request.error || tx.error);
              tx.onerror = () => reject(tx.error || new Error('IndexedDB read failed'));
              tx.onabort = () => reject(tx.error || new Error('IndexedDB read aborted'));
          });
      };

      const plannedSections = [
          data.characters !== undefined || data.mediaAssets !== undefined,
          data.characterGroups !== undefined,
          data.messages !== undefined,
          data.customThemes !== undefined,
          data.savedEmojis !== undefined,
          data.emojiCategories !== undefined,
          data.assets !== undefined,
          data.savedJournalStickers !== undefined,
          data.galleryImages !== undefined,
          data.diaries !== undefined,
          data.tasks !== undefined,
          data.anniversaries !== undefined,
          data.roomTodos !== undefined,
          data.roomNotes !== undefined,
          data.groups !== undefined,
          data.socialPosts !== undefined,
          data.courses !== undefined,
          data.games !== undefined,
          data.worldbooks !== undefined,
          data.novels !== undefined,
          data.songs !== undefined,
          data.quizSessions !== undefined,
          data.guidebookSessions !== undefined,
          data.scheduledMessages !== undefined,
          data.lifeSimState !== undefined,
          data.bankTransactions !== undefined,
          data.xhsActivities !== undefined,
          data.xhsStockImages !== undefined,
          data.memoryNodes !== undefined,
          data.memoryVectors !== undefined,
          data.memoryLinks !== undefined,
          data.topicBoxes !== undefined,
          data.anticipations !== undefined,
          data.eventBoxes !== undefined,
          data.roomPlates !== undefined,
          data.digestReports !== undefined,
          data.memoryBatches !== undefined,
          data.dailySchedules !== undefined,
          data.handbooks !== undefined,
          data.trackers !== undefined,
          data.trackerEntries !== undefined,
          data.lifeRecords !== undefined,
          data.medPlans !== undefined,
          data.lifeRecordSettings !== undefined,
          data.hotNewsSnapshots !== undefined,
          data.vrNovels !== undefined,
          data.vrAnnotations !== undefined,
          data.customCreatorParts !== undefined,
          data.vrMusicRoom !== undefined,
          data.vrGuestbook !== undefined,
          data.vrScripts !== undefined,
          data.vrStagedPlays !== undefined,
          data.vrPresets !== undefined,
          data.vrLetters !== undefined,
          (data as any).vrPostOffice !== undefined,
          data.worlds !== undefined,
          data.worldEpisodes !== undefined,
          (data as any).worldHomeLocal !== undefined,
          (data as any).luckinLocal !== undefined,
          (data as any).mcdLocal !== undefined,
          (data as any).wereadLocal !== undefined,
          (data as any).mcpLocal !== undefined,
          data.pixelHomeAssets !== undefined,
          data.pixelHomeLayouts !== undefined,
          data.userProfile !== undefined,
          data.bankState !== undefined || data.bankDollhouse !== undefined,
      ];
      const sectionTotal = Math.max(1, plannedSections.filter(Boolean).length);
      let sectionDone = 0;

      const report = (
          label: string,
          stage: 'start' | 'items' | 'done',
          itemDone?: number,
          itemTotal?: number
      ) => {
          options.onProgress?.({
              label,
              stage,
              sectionDone,
              sectionTotal,
              itemDone,
              itemTotal,
          });
      };

      const runSection = async (
          label: string,
          present: boolean,
          work: () => Promise<void>,
          itemTotal?: number
      ) => {
          if (!present) return;
          report(label, 'start', 0, itemTotal);
          await work();
          sectionDone += 1;
          report(label, 'done', itemTotal, itemTotal);
      };

      const beforeWrite = async (root: any, label: string, restoreAssets: boolean) => {
          if (!restoreAssets || root === undefined || root === null) return;
          if (!options.beforeWrite) return;
          await options.beforeWrite(root, label);
      };

      const clearStore = async (storeName: string) => {
          await withStore(storeName, store => {
              store.clear();
          });
      };

      const putItems = async (
          storeName: string,
          items: any[] | undefined | null,
          label: string,
          restoreAssets = true
      ) => {
          if (!hasStore(storeName) || !items || items.length === 0) return;

          const CHUNK_SIZE = 50;
          const total = items.length;
          for (let i = 0; i < total; i += CHUNK_SIZE) {
              const end = Math.min(i + CHUNK_SIZE, total);
              const chunk = items.slice(i, end).filter(Boolean);
              if (chunk.length === 0) {
                  report(label, 'items', end, total);
                  continue;
              }
              await beforeWrite(chunk, label, restoreAssets);
              await withStore(storeName, store => {
                  chunk.forEach(item => store.put(item));
              });
              for (let j = i; j < end; j++) {
                  (items as any[])[j] = undefined;
              }
              report(label, 'items', end, total);
          }
      };

      const clearAndAdd = async (
          storeName: string,
          items: any[] | undefined | null,
          label: string,
          restoreAssets = true
      ) => {
          if (!hasStore(storeName) || items === undefined || items === null) return;
          await clearStore(storeName);
          await putItems(storeName, items, label, restoreAssets);
      };

      const mergeStore = async (
          storeName: string,
          items: any[] | undefined | null,
          label: string,
          restoreAssets = true
      ) => {
          if (!hasStore(storeName) || !items || items.length === 0) return;
          await putItems(storeName, items, label, restoreAssets);
      };

      const applyMediaToChar = (c: CharacterProfile, media: NonNullable<FullBackupData['mediaAssets']>[number]): CharacterProfile => {
          return {
              ...c,
              avatar: media.avatar || c.avatar,
              sprites: media.sprites || c.sprites,
              dateSkinSets: media.dateSkinSets || c.dateSkinSets,
              activeSkinSetId: media.activeSkinSetId || c.activeSkinSetId,
              customDateSprites: media.customDateSprites || c.customDateSprites,
              spriteConfig: media.spriteConfig || c.spriteConfig,
              chatBackground: media.backgrounds?.chat || c.chatBackground,
              dateBackground: media.backgrounds?.date || c.dateBackground,
              roomConfig: c.roomConfig ? {
                  ...c.roomConfig,
                  wallImage: media.backgrounds?.roomWall || c.roomConfig.wallImage,
                  floorImage: media.backgrounds?.roomFloor || c.roomConfig.floorImage,
                  items: c.roomConfig.items.map(item => {
                      const img = media.roomItems?.[item.id];
                      return img ? { ...item, image: img } : item;
                  })
              } : c.roomConfig
          } as CharacterProfile;
      };

      const hasCharacterBackup = Array.isArray(data.characters);

      await runSection('角色资料', data.characters !== undefined || data.mediaAssets !== undefined, async () => {
          if (data.characters) {
              if (data.mediaAssets) {
                  await beforeWrite(data.mediaAssets, '角色媒体', true);
                  const mediaAssets = data.mediaAssets;
                  data.characters = data.characters.map(c => {
                      const media = mediaAssets.find(m => m.charId === c.id);
                      return media ? applyMediaToChar(c, media) : c;
                  });
              }
              await clearAndAdd(STORE_CHARACTERS, data.characters, '角色资料', true);
          } else if (data.mediaAssets && hasStore(STORE_CHARACTERS)) {
              await beforeWrite(data.mediaAssets, '角色媒体', true);
              const mediaAssets = data.mediaAssets;
              const existingChars = await getAllFromStore<CharacterProfile>(STORE_CHARACTERS);
              if (existingChars.length > 0) {
                  const updatedChars = existingChars.map(c => {
                      const media = mediaAssets.find(m => m.charId === c.id);
                      return media ? applyMediaToChar(c, media) : c;
                  });
                  await putItems(STORE_CHARACTERS, updatedChars, '角色资料', false);
              }
          }
          data.characters = undefined as any;
          data.mediaAssets = undefined as any;
      }, data.characters?.length || data.mediaAssets?.length || 0);

      await runSection('角色分组', data.characterGroups !== undefined, async () => {
          await mergeStore(STORE_CHAR_GROUPS, data.characterGroups, '角色分组', false);
          data.characterGroups = undefined as any;
      }, data.characterGroups?.length || 0);

      await runSection('聊天记录', data.messages !== undefined, async () => {
          if (!hasStore(STORE_MESSAGES)) return;
          const isPatchMode = !hasCharacterBackup;
          if (!isPatchMode) {
              await clearStore(STORE_MESSAGES);
          }
          await putItems(STORE_MESSAGES, data.messages || [], '聊天记录', true);
          data.messages = undefined as any;
      }, data.messages?.length || 0);

      await runSection('聊天主题', data.customThemes !== undefined, async () => {
          await mergeStore(STORE_THEMES, data.customThemes, '聊天主题', true);
          data.customThemes = undefined as any;
      }, data.customThemes?.length || 0);
      await runSection('表情包', data.savedEmojis !== undefined, async () => {
          await mergeStore(STORE_EMOJIS, data.savedEmojis, '表情包', true);
          data.savedEmojis = undefined as any;
      }, data.savedEmojis?.length || 0);
      await runSection('表情分类', data.emojiCategories !== undefined, async () => {
          await mergeStore(STORE_EMOJI_CATEGORIES, data.emojiCategories, '表情分类', false);
          data.emojiCategories = undefined as any;
      }, data.emojiCategories?.length || 0);
      await runSection('系统资源', data.assets !== undefined, async () => {
          await clearAndAdd(STORE_ASSETS, data.assets || [], '系统资源', true);
          data.assets = undefined as any;
      }, data.assets?.length || 0);
      await runSection('日记贴纸', data.savedJournalStickers !== undefined, async () => {
          await mergeStore(STORE_JOURNAL_STICKERS, data.savedJournalStickers, '日记贴纸', true);
          data.savedJournalStickers = undefined as any;
      }, data.savedJournalStickers?.length || 0);

      await runSection('相册图片', data.galleryImages !== undefined, async () => {
          await clearAndAdd(STORE_GALLERY, data.galleryImages, '相册图片', true);
          data.galleryImages = undefined as any;
      }, data.galleryImages?.length || 0);
      await runSection('日记', data.diaries !== undefined, async () => {
          await clearAndAdd(STORE_DIARIES, data.diaries, '日记', true);
          data.diaries = undefined as any;
      }, data.diaries?.length || 0);
      await runSection('任务', data.tasks !== undefined, async () => {
          await clearAndAdd(STORE_TASKS, data.tasks, '任务', false);
          data.tasks = undefined as any;
      }, data.tasks?.length || 0);
      await runSection('纪念日', data.anniversaries !== undefined, async () => {
          await clearAndAdd(STORE_ANNIVERSARIES, data.anniversaries, '纪念日', false);
          data.anniversaries = undefined as any;
      }, data.anniversaries?.length || 0);
      await runSection('房间待办', data.roomTodos !== undefined, async () => {
          await clearAndAdd(STORE_ROOM_TODOS, data.roomTodos, '房间待办', false);
          data.roomTodos = undefined as any;
      }, data.roomTodos?.length || 0);
      await runSection('房间便签', data.roomNotes !== undefined, async () => {
          await clearAndAdd(STORE_ROOM_NOTES, data.roomNotes, '房间便签', false);
          data.roomNotes = undefined as any;
      }, data.roomNotes?.length || 0);
      await runSection('群聊资料', data.groups !== undefined, async () => {
          await clearAndAdd(STORE_GROUPS, data.groups, '群聊资料', true);
          data.groups = undefined as any;
      }, data.groups?.length || 0);
      await runSection('动态帖子', data.socialPosts !== undefined, async () => {
          await clearAndAdd(STORE_SOCIAL_POSTS, data.socialPosts, '动态帖子', true);
          data.socialPosts = undefined as any;
      }, data.socialPosts?.length || 0);
      await runSection('学习课程', data.courses !== undefined, async () => {
          await clearAndAdd(STORE_COURSES, data.courses, '学习课程', false);
          data.courses = undefined as any;
      }, data.courses?.length || 0);
      await runSection('游戏记录', data.games !== undefined, async () => {
          await clearAndAdd(STORE_GAMES, data.games, '游戏记录', false);
          data.games = undefined as any;
      }, data.games?.length || 0);
      await runSection('世界书', data.worldbooks !== undefined, async () => {
          await clearAndAdd(STORE_WORLDBOOKS, data.worldbooks, '世界书', false);
          data.worldbooks = undefined as any;
      }, data.worldbooks?.length || 0);
      await runSection('小说', data.novels !== undefined, async () => {
          await clearAndAdd(STORE_NOVELS, data.novels, '小说', false);
          data.novels = undefined as any;
      }, data.novels?.length || 0);
      await runSection('彼方小说库', data.vrNovels !== undefined, async () => {
          await clearAndAdd(STORE_VR_NOVELS, data.vrNovels, '彼方小说库', false);
          data.vrNovels = undefined as any;
      }, data.vrNovels?.length || 0);
      await runSection('彼方批注', data.vrAnnotations !== undefined, async () => {
          await clearAndAdd(STORE_VR_ANNOTATIONS, data.vrAnnotations, '彼方批注', false);
          data.vrAnnotations = undefined as any;
      }, data.vrAnnotations?.length || 0);
      await runSection('捏脸自定义部件', data.customCreatorParts !== undefined, async () => {
          // restoreAssets=true：部件 src/shadowSrc 是 data:image，media/full 导出时被抽进 zip，
          // 导入必须经 beforeWrite 把 assets/*.png 路径还原回 base64，否则部件图裂成死链。
          await clearAndAdd(STORE_CC_PARTS, data.customCreatorParts, '捏脸自定义部件', true);
          data.customCreatorParts = undefined as any;
      }, data.customCreatorParts?.length || 0);
      await runSection('听歌房', data.vrMusicRoom !== undefined, async () => {
          if (hasStore(STORE_VR_MUSIC) && data.vrMusicRoom) await DB.saveVRMusicRoom(data.vrMusicRoom);
          data.vrMusicRoom = undefined as any;
      }, 1);
      await runSection('留言簿', data.vrGuestbook !== undefined, async () => {
          if (hasStore(STORE_VR_GUESTBOOK) && data.vrGuestbook) await DB.saveVRGuestbook(data.vrGuestbook);
          data.vrGuestbook = undefined as any;
      }, 1);
      await runSection('剧院剧本', data.vrScripts !== undefined, async () => {
          if (hasStore(STORE_VR_SCRIPTS) && Array.isArray(data.vrScripts)) for (const s of data.vrScripts) await DB.saveVRScript(s);
          data.vrScripts = undefined as any;
      }, data.vrScripts?.length || 0);
      await runSection('历史舞台剧', data.vrStagedPlays !== undefined, async () => {
          if (hasStore(STORE_VR_PLAYS) && Array.isArray(data.vrStagedPlays)) for (const p of data.vrStagedPlays) await DB.saveVRStagedPlay(p);
          data.vrStagedPlays = undefined as any;
      }, data.vrStagedPlays?.length || 0);
      await runSection('剧院预设', (data as any).vrPresets !== undefined, async () => {
          if (hasStore(STORE_VR_PRESETS) && Array.isArray((data as any).vrPresets)) for (const p of (data as any).vrPresets) await DB.saveVRPreset(p);
          (data as any).vrPresets = undefined as any;
      }, (data as any).vrPresets?.length || 0);
      await runSection('邮局信件', data.vrLetters !== undefined, async () => {
          await clearAndAdd(STORE_VR_LETTERS, data.vrLetters, '邮局信件', false);
          data.vrLetters = undefined as any;
      }, data.vrLetters?.length || 0);
      await runSection('彼方设置', data.vrSettings !== undefined, async () => {
          if (hasStore(STORE_VR_SETTINGS) && Array.isArray(data.vrSettings)) {
              for (const rec of data.vrSettings) await DB.saveVRSettingRecord(rec);
          }
          data.vrSettings = undefined as any;
      }, data.vrSettings?.length || 0);
      await runSection('邮局身份', (data as any).vrPostOffice !== undefined, async () => {
          importPostOfficeLocal((data as any).vrPostOffice);
          (data as any).vrPostOffice = undefined;
      }, 1);
      await runSection('信号坠落处', (data as any).vrSignal !== undefined, async () => {
          importSignalLocal((data as any).vrSignal);
          (data as any).vrSignal = undefined;
      }, 1);
      await runSection('家园世界', data.worlds !== undefined, async () => {
          await clearAndAdd(STORE_WORLDS, data.worlds, '家园世界', false);
          data.worlds = undefined as any;
      }, data.worlds?.length || 0);
      await runSection('家园演绎历史', data.worldEpisodes !== undefined, async () => {
          await clearAndAdd(STORE_WORLD_EPISODES, data.worldEpisodes, '家园演绎历史', false);
          data.worldEpisodes = undefined as any;
      }, data.worldEpisodes?.length || 0);
      await runSection('家园本机配置', (data as any).worldHomeLocal !== undefined, async () => {
          importWorldHomeLocal((data as any).worldHomeLocal); // 全局 API + 文风收藏
          (data as any).worldHomeLocal = undefined;
      }, 1);
      await runSection('瑞幸配置', (data as any).luckinLocal !== undefined, async () => {
          importLuckinLocal((data as any).luckinLocal); // token + 启用状态
          (data as any).luckinLocal = undefined;
      }, 1);
      await runSection('麦当劳配置', (data as any).mcdLocal !== undefined, async () => {
          importMcdLocal((data as any).mcdLocal); // token + 启用状态
          (data as any).mcdLocal = undefined;
      }, 1);
      await runSection('微信读书配置', (data as any).wereadLocal !== undefined, async () => {
          importWereadLocal((data as any).wereadLocal); // 鉴权 + 启用状态
          (data as any).wereadLocal = undefined;
      }, 1);
      await runSection('MCP 服务器配置', (data as any).mcpLocal !== undefined, async () => {
          importMcpLocal((data as any).mcpLocal); // 用户自配的 MCP 服务器列表
          (data as any).mcpLocal = undefined;
      }, 1);
      await runSection('桌面皮肤偏好', (data as any).desktopSkinLocal !== undefined, async () => {
          await importDesktopSkinLocal((data as any).desktopSkinLocal); // 界面配色 + 看板 banner（data URL→本机 blob）
          (data as any).desktopSkinLocal = undefined;
      }, 1);
      await runSection('歌曲', data.songs !== undefined, async () => {
          await clearAndAdd(STORE_SONGS, data.songs, '歌曲', false);
          data.songs = undefined as any;
      }, data.songs?.length || 0);
      await runSection('练习本', data.quizSessions !== undefined, async () => {
          await clearAndAdd(STORE_QUIZZES, data.quizSessions, '练习本', false);
          data.quizSessions = undefined as any;
      }, data.quizSessions?.length || 0);
      await runSection('攻略本', data.guidebookSessions !== undefined, async () => {
          await clearAndAdd(STORE_GUIDEBOOK, data.guidebookSessions, '攻略本', false);
          data.guidebookSessions = undefined as any;
      }, data.guidebookSessions?.length || 0);
      await runSection('定时消息', data.scheduledMessages !== undefined, async () => {
          await clearAndAdd(STORE_SCHEDULED, data.scheduledMessages || [], '定时消息', false);
          data.scheduledMessages = undefined as any;
      }, data.scheduledMessages?.length || 0);
      await runSection('人生模拟', data.lifeSimState !== undefined, async () => {
          if (!hasStore(STORE_LIFE_SIM)) return;
          await beforeWrite(data.lifeSimState, '人生模拟', true);
          await withStore(STORE_LIFE_SIM, store => {
              store.clear();
              if (data.lifeSimState) {
                  store.put({ ...data.lifeSimState, id: 'main' });
              }
          });
          data.lifeSimState = undefined as any;
      }, data.lifeSimState ? 1 : 0);
      await runSection('银行流水', data.bankTransactions !== undefined, async () => {
          await clearAndAdd(STORE_BANK_TX, data.bankTransactions, '银行流水', false);
          data.bankTransactions = undefined as any;
      }, data.bankTransactions?.length || 0);
      await runSection('小红书活动', data.xhsActivities !== undefined, async () => {
          await clearAndAdd(STORE_XHS_ACTIVITIES, data.xhsActivities, '小红书活动', false);
          data.xhsActivities = undefined as any;
      }, data.xhsActivities?.length || 0);
      await runSection('小红书图库', data.xhsStockImages !== undefined, async () => {
          await clearAndAdd(STORE_XHS_STOCK, data.xhsStockImages, '小红书图库', true);
          data.xhsStockImages = undefined as any;
      }, data.xhsStockImages?.length || 0);

      // Memory Palace (记忆宫殿)
      await runSection('记忆节点', data.memoryNodes !== undefined, async () => {
          await clearAndAdd('memory_nodes', data.memoryNodes, '记忆节点', false);
          data.memoryNodes = undefined as any;
      }, data.memoryNodes?.length || 0);
      await runSection('记忆向量', data.memoryVectors !== undefined, async () => {
          if (!data.memoryVectors || !hasStore('memory_vectors')) {
              data.memoryVectors = undefined as any;
              return;
          }
          await clearStore('memory_vectors');
          const CHUNK_SIZE = 50;
          const total = data.memoryVectors.length;
          for (let i = 0; i < total; i += CHUNK_SIZE) {
              const end = Math.min(i + CHUNK_SIZE, total);
              const chunk = data.memoryVectors.slice(i, end).filter(Boolean).map((v: any) => {
                  if (!v || !v.vector || !Array.isArray(v.vector)) return v;
                  const f32 = new Float32Array(v.vector);
                  return { ...v, vector: new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength) };
              });
              await withStore('memory_vectors', store => {
                  chunk.forEach((item: any) => store.put(item));
              });
              for (let j = i; j < end; j++) {
                  (data.memoryVectors as any[])[j] = undefined;
              }
              report('记忆向量', 'items', end, total);
          }
          data.memoryVectors = undefined as any;
      }, data.memoryVectors?.length || 0);
      await runSection('记忆关系', data.memoryLinks !== undefined, async () => {
          await clearAndAdd('memory_links', data.memoryLinks, '记忆关系', false);
          data.memoryLinks = undefined as any;
      }, data.memoryLinks?.length || 0);
      await runSection('话题盒', data.topicBoxes !== undefined, async () => {
          await clearAndAdd('topic_boxes', data.topicBoxes, '话题盒', false);
          data.topicBoxes = undefined as any;
      }, data.topicBoxes?.length || 0);
      await runSection('期待事项', data.anticipations !== undefined, async () => {
          await clearAndAdd('anticipations', data.anticipations, '期待事项', false);
          data.anticipations = undefined as any;
      }, data.anticipations?.length || 0);
      await runSection('事件盒', data.eventBoxes !== undefined, async () => {
          await clearAndAdd('event_boxes', data.eventBoxes, '事件盒', false);
          data.eventBoxes = undefined as any;
      }, data.eventBoxes?.length || 0);
      await runSection('房间门牌', data.roomPlates !== undefined, async () => {
          await clearAndAdd('room_plates', data.roomPlates, '房间门牌', false);
          data.roomPlates = undefined as any;
      }, data.roomPlates?.length || 0);
      await runSection('消化日志', data.digestReports !== undefined, async () => {
          await clearAndAdd('digest_reports', data.digestReports, '消化日志', false);
          data.digestReports = undefined as any;
      }, data.digestReports?.length || 0);
      await runSection('记忆批次', data.memoryBatches !== undefined, async () => {
          await clearAndAdd('memory_batches', data.memoryBatches, '记忆批次', false);
          data.memoryBatches = undefined as any;
      }, data.memoryBatches?.length || 0);

      // 角色日程表（每日日程 + 意识流）
      await runSection('每日程', data.dailySchedules !== undefined, async () => {
          await clearAndAdd(STORE_DAILY_SCHEDULE, data.dailySchedules, '每日程', false);
          data.dailySchedules = undefined as any;
      }, data.dailySchedules?.length || 0);

      // 手账（跨角色聚合留痕本）
      await runSection('手账', data.handbooks !== undefined, async () => {
          await clearAndAdd(STORE_HANDBOOK, data.handbooks, '手账', false);
          data.handbooks = undefined as any;
      }, data.handbooks?.length || 0);

      // 手账 Tracker（健康/生活打卡引擎）
      await runSection('打卡项目', data.trackers !== undefined, async () => {
          await clearAndAdd(STORE_TRACKERS, data.trackers, '打卡项目', false);
          data.trackers = undefined as any;
      }, data.trackers?.length || 0);
      await runSection('打卡记录', data.trackerEntries !== undefined, async () => {
          await clearAndAdd(STORE_TRACKER_ENTRIES, data.trackerEntries, '打卡记录', false);
          data.trackerEntries = undefined as any;
      }, data.trackerEntries?.length || 0);

      // 生活记录（档案 App：生理期/药盒/锻炼 + 药盒计划 + 设置）
      await runSection('生活记录', data.lifeRecords !== undefined, async () => {
          await clearAndAdd(STORE_LIFE_RECORDS, data.lifeRecords, '生活记录', false);
          data.lifeRecords = undefined as any;
      }, data.lifeRecords?.length || 0);
      await runSection('药盒计划', data.medPlans !== undefined, async () => {
          await clearAndAdd(STORE_MED_PLANS, data.medPlans, '药盒计划', false);
          data.medPlans = undefined as any;
      }, data.medPlans?.length || 0);
      await runSection('生活记录设置', data.lifeRecordSettings !== undefined, async () => {
          await clearAndAdd(STORE_LIFE_SETTINGS, data.lifeRecordSettings, '生活记录设置', false);
          data.lifeRecordSettings = undefined as any;
      }, data.lifeRecordSettings?.length || 0);

      // 热点快照（全角色共享缓存）
      await runSection('热点快照', data.hotNewsSnapshots !== undefined, async () => {
          await clearAndAdd(STORE_HOTNEWS, data.hotNewsSnapshots, '热点快照', false);
          data.hotNewsSnapshots = undefined as any;
      }, data.hotNewsSnapshots?.length || 0);

      // Pixel Home（小屋像素界面）
      await runSection('像素小屋素材', data.pixelHomeAssets !== undefined, async () => {
          await clearAndAdd('pixel_home_assets', data.pixelHomeAssets, '像素小屋素材', true);
          data.pixelHomeAssets = undefined as any;
      }, data.pixelHomeAssets?.length || 0);
      await runSection('像素小屋布局', data.pixelHomeLayouts !== undefined, async () => {
          await clearAndAdd('pixel_home_layouts', data.pixelHomeLayouts, '像素小屋布局', false);
          data.pixelHomeLayouts = undefined as any;
      }, data.pixelHomeLayouts?.length || 0);

      await runSection('用户资料', data.userProfile !== undefined, async () => {
          if (!hasStore(STORE_USER)) return;
          await beforeWrite(data.userProfile, '用户资料', true);
          await withStore(STORE_USER, store => {
              store.clear();
              if (data.userProfile) {
                  store.put({ ...data.userProfile, id: 'me' });
              }
          });
          data.userProfile = undefined as any;
      }, data.userProfile ? 1 : 0);

      await runSection('银行状态', data.bankState !== undefined || data.bankDollhouse !== undefined, async () => {
          if (!hasStore(STORE_BANK_DATA)) return;
          await beforeWrite([data.bankState, data.bankDollhouse], '银行状态', true);
          await withStore(STORE_BANK_DATA, store => {
              store.clear();
              if (data.bankState) {
                  store.put({ ...data.bankState, id: 'main_state' });
              }
              if (data.bankDollhouse) {
                  store.put({ id: 'dollhouse_state', data: data.bankDollhouse });
              }
          });
          data.bankState = undefined as any;
          data.bankDollhouse = undefined as any;
      }, (data.bankState ? 1 : 0) + (data.bankDollhouse ? 1 : 0));
  }
};
