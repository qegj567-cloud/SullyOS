


import {
    CharacterProfile, ChatTheme, Message, UserProfile,
    Task, Anniversary, DiaryEntry, RoomTodo, RoomNote, DailySchedule,
    GalleryImage, FullBackupData, GroupProfile, SocialPost, StudyCourse, GameSession, Worldbook, NovelBook, Emoji, EmojiCategory,
    BankTransaction, SavingsGoal, BankFullState, DollhouseState, XhsStockImage, XhsActivityRecord, SongSheet, QuizSession, GuidebookSession,
    LifeSimState, HandbookEntry, Tracker, TrackerEntry, HotNewsSnapshot
} from '../types';

const DB_NAME = 'AetherOS_Data';
const DB_VERSION = 51; // Bumped: v51 add 'hotnews_snapshots' store (分时段热点快照)

const STORE_CHARACTERS = 'characters';
const STORE_MESSAGES = 'messages';
const STORE_EMOJIS = 'emojis';
const STORE_EMOJI_CATEGORIES = 'emoji_categories'; 
const STORE_THEMES = 'themes';
const STORE_ASSETS = 'assets'; 
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
    { name: 'Sully晚安', url: 'https://sharkpan.xyz/f/pWg6HQ/night.png', categoryId: SULLY_CATEGORY_ID },
    { name: 'Sully无语', url: 'https://sharkpan.xyz/f/75wvuj/w.png', categoryId: SULLY_CATEGORY_ID },
    { name: 'Sully偷看', url: 'https://sharkpan.xyz/f/MK77Ia/see.png', categoryId: SULLY_CATEGORY_ID },
    { name: 'Sully打气', url: 'https://sharkpan.xyz/f/3WwMHe/fight.png', categoryId: SULLY_CATEGORY_ID },
    { name: 'Sully生气', url: 'https://sharkpan.xyz/f/5nwxCj/an.png', categoryId: SULLY_CATEGORY_ID },
    { name: 'Sully疑惑', url: 'https://sharkpan.xyz/f/ylWpfN/sDN.png', categoryId: SULLY_CATEGORY_ID },
    { name: 'Sully道歉', url: 'https://sharkpan.xyz/f/QdnaU6/sorry.png', categoryId: SULLY_CATEGORY_ID },
    { name: 'Sully等你消息', url: 'https://sharkpan.xyz/f/5nrJsj/wait.png', categoryId: SULLY_CATEGORY_ID },
];

export const openDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => {
        console.error("DB Open Error:", request.error);
        reject(request.error);
    };
    
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      
      const createStore = (name: string, options?: IDBObjectStoreParameters) => {
          if (!db.objectStoreNames.contains(name)) {
              db.createObjectStore(name, options);
          }
      };

      createStore(STORE_CHARACTERS, { keyPath: 'id' });
      
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
      
      createStore(STORE_EMOJIS, { keyPath: 'name' });
      createStore(STORE_EMOJI_CATEGORIES, { keyPath: 'id' });

      createStore(STORE_THEMES, { keyPath: 'id' });
      createStore(STORE_ASSETS, { keyPath: 'id' });
      
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
};

export const DB = {
  deleteDB: async (): Promise<void> => {
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
    const transaction = db.transaction(STORE_CHARACTERS, 'readwrite');
    transaction.objectStore(STORE_CHARACTERS).put(character);
  },

  deleteCharacter: async (id: string): Promise<void> => {
    const db = await openDB();
    const transaction = db.transaction(STORE_CHARACTERS, 'readwrite');
    transaction.objectStore(STORE_CHARACTERS).delete(id);
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
        request.onsuccess = () => resolve(request.result as number);
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

  initializeEmojiData: async (): Promise<void> => {
      const cats = await DB.getEmojiCategories();
      if (!cats.some(c => c.id === 'default')) {
          await DB.saveEmojiCategory({ id: 'default', name: '默认', isSystem: true });
      }
      if (!cats.some(c => c.id === SULLY_CATEGORY_ID)) {
          await DB.saveEmojiCategory({ id: SULLY_CATEGORY_ID, name: 'Sully 专属', isSystem: true });
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
    const transaction = db.transaction(STORE_ASSETS, 'readwrite');
    transaction.objectStore(STORE_ASSETS).put({ id, data });
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
    const transaction = db.transaction(STORE_ASSETS, 'readwrite');
    transaction.objectStore(STORE_ASSETS).delete(id);
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

      const [characters, messages, themes, emojis, emojiCategories, assets, galleryImages, userProfiles, diaries, tasks, anniversaries, roomTodos, roomNotes, groups, journalStickers, socialPosts, courses, games, worldbooks, novels, bankTx, bankData, xhsActivities, xhsStockImages, songs, quizzes, guidebookSessions, scheduledMessages, lifeSimStates, handbooks, trackers, trackerEntries] = await Promise.all([
          getAllFromStore(STORE_CHARACTERS),
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
      ]);

      const userProfile = userProfiles.length > 0 ? {
          name: userProfiles[0].name,
          avatar: userProfiles[0].avatar,
          bio: userProfiles[0].bio
      } : undefined;

      const mainState = bankData.find((d: any) => d.id === 'main_state');
      const dollhouseRecord = bankData.find((d: any) => d.id === 'dollhouse_state');

      return {
          characters, messages, customThemes: themes, savedEmojis: emojis, emojiCategories, assets, galleryImages, userProfile, diaries, tasks, anniversaries, roomTodos, roomNotes, groups, savedJournalStickers: journalStickers, socialPosts, courses, games, worldbooks, novels,
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
      };
  },

  importFullData: async (data: FullBackupData): Promise<void> => {
      const db = await openDB();
      
      const availableStores = [
          STORE_CHARACTERS, STORE_MESSAGES, STORE_THEMES, STORE_EMOJIS, STORE_EMOJI_CATEGORIES,
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
          'memory_nodes', 'memory_vectors', 'memory_links', 'topic_boxes', 'anticipations', 'event_boxes',
          'memory_batches', 'pixel_home_assets', 'pixel_home_layouts'
      ].filter(name => db.objectStoreNames.contains(name));

      const tx = db.transaction(availableStores, 'readwrite');

      const clearAndAdd = (storeName: string, items: any[]) => {
          if (!availableStores.includes(storeName)) return;
          if (items === undefined || items === null) return;
          
          const store = tx.objectStore(storeName);
          store.clear();
          items.forEach(item => store.put(item));
      };

      const mergeStore = (storeName: string, items: any[]) => {
          if (!availableStores.includes(storeName)) return;
          if (!items || items.length === 0) return;
          
          const store = tx.objectStore(storeName);
          items.forEach(item => store.put(item));
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

      if (data.characters) {
          if (data.mediaAssets) {
              data.characters = data.characters.map(c => {
                  const media = data.mediaAssets?.find(m => m.charId === c.id);
                  return media ? applyMediaToChar(c, media) : c;
              });
          }
          clearAndAdd(STORE_CHARACTERS, data.characters);
      } else if (data.mediaAssets && availableStores.includes(STORE_CHARACTERS)) {
          const charStore = tx.objectStore(STORE_CHARACTERS);
          const request = charStore.getAll();
          request.onsuccess = () => {
              const existingChars = request.result as CharacterProfile[];
              if (existingChars && existingChars.length > 0) {
                  const updatedChars = existingChars.map(c => {
                      const media = data.mediaAssets?.find(m => m.charId === c.id);
                      return media ? applyMediaToChar(c, media) : c;
                  });
                  updatedChars.forEach(c => charStore.put(c));
              }
          };
      }

      if (data.messages) {
           if (availableStores.includes(STORE_MESSAGES) && data.messages.length > 0) {
               const store = tx.objectStore(STORE_MESSAGES);
               const isPatchMode = !data.characters;
               if (!isPatchMode) {
                   store.clear();
               }
               data.messages.forEach(m => store.put(m)); 
           }
      }
      
      if (data.customThemes) mergeStore(STORE_THEMES, data.customThemes);
      if (data.savedEmojis) mergeStore(STORE_EMOJIS, data.savedEmojis);
      if (data.emojiCategories) mergeStore(STORE_EMOJI_CATEGORIES, data.emojiCategories); 
      if (data.assets !== undefined) clearAndAdd(STORE_ASSETS, data.assets || []);
      if (data.savedJournalStickers) mergeStore(STORE_JOURNAL_STICKERS, data.savedJournalStickers);

      if (data.galleryImages) clearAndAdd(STORE_GALLERY, data.galleryImages);
      if (data.diaries) clearAndAdd(STORE_DIARIES, data.diaries);
      if (data.tasks) clearAndAdd(STORE_TASKS, data.tasks);
      if (data.anniversaries) clearAndAdd(STORE_ANNIVERSARIES, data.anniversaries);
      if (data.roomTodos) clearAndAdd(STORE_ROOM_TODOS, data.roomTodos);
      if (data.roomNotes) clearAndAdd(STORE_ROOM_NOTES, data.roomNotes);
      if (data.groups) clearAndAdd(STORE_GROUPS, data.groups);
      if (data.socialPosts) clearAndAdd(STORE_SOCIAL_POSTS, data.socialPosts);
      if (data.courses) clearAndAdd(STORE_COURSES, data.courses);
      if (data.games) clearAndAdd(STORE_GAMES, data.games);
      if (data.worldbooks) clearAndAdd(STORE_WORLDBOOKS, data.worldbooks);
      if (data.novels) clearAndAdd(STORE_NOVELS, data.novels);
      if (data.songs) clearAndAdd(STORE_SONGS, data.songs);
      if (data.quizSessions) clearAndAdd(STORE_QUIZZES, data.quizSessions);
      if (data.guidebookSessions) clearAndAdd(STORE_GUIDEBOOK, data.guidebookSessions);
      if (data.scheduledMessages !== undefined && availableStores.includes(STORE_SCHEDULED)) {
          const store = tx.objectStore(STORE_SCHEDULED);
          store.clear();
          (data.scheduledMessages || []).forEach(item => store.put(item));
      }
      if (data.lifeSimState !== undefined && availableStores.includes(STORE_LIFE_SIM)) {
          const store = tx.objectStore(STORE_LIFE_SIM);
          store.clear();
          if (data.lifeSimState) {
              store.put({ ...data.lifeSimState, id: 'main' });
          }
      }
      if (data.bankTransactions) clearAndAdd(STORE_BANK_TX, data.bankTransactions);
      if (data.xhsActivities) clearAndAdd(STORE_XHS_ACTIVITIES, data.xhsActivities);
      if (data.xhsStockImages) clearAndAdd(STORE_XHS_STOCK, data.xhsStockImages);

      // Memory Palace (记忆宫殿)
      if (data.memoryNodes) clearAndAdd('memory_nodes', data.memoryNodes);
      if (data.memoryVectors) {
          // 备份里的 vector 是 number[]（JSON 兼容形态）。直接还原写回 Uint8Array
          // 把磁盘占用立刻降下来 — 不然要等下次读这个角色的向量时 lazy 迁移才生效。
          const upgraded = data.memoryVectors.map((v: any) => {
              if (!v || !v.vector || !Array.isArray(v.vector)) return v;
              const f32 = new Float32Array(v.vector);
              return { ...v, vector: new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength) };
          });
          clearAndAdd('memory_vectors', upgraded);
      }
      if (data.memoryLinks) clearAndAdd('memory_links', data.memoryLinks);
      if (data.topicBoxes) clearAndAdd('topic_boxes', data.topicBoxes);
      if (data.anticipations) clearAndAdd('anticipations', data.anticipations);
      if (data.eventBoxes && db.objectStoreNames.contains('event_boxes')) clearAndAdd('event_boxes', data.eventBoxes);
      if (data.memoryBatches && db.objectStoreNames.contains('memory_batches')) clearAndAdd('memory_batches', data.memoryBatches);

      // 角色日程表（每日日程 + 意识流）
      if (data.dailySchedules) clearAndAdd(STORE_DAILY_SCHEDULE, data.dailySchedules);

      // 手账（跨角色聚合留痕本）
      if (data.handbooks) clearAndAdd(STORE_HANDBOOK, data.handbooks);

      // 手账 Tracker（健康/生活打卡引擎）
      if (data.trackers) clearAndAdd(STORE_TRACKERS, data.trackers);
      if (data.trackerEntries) clearAndAdd(STORE_TRACKER_ENTRIES, data.trackerEntries);

      // Pixel Home（小屋像素界面）
      if (data.pixelHomeAssets && db.objectStoreNames.contains('pixel_home_assets')) clearAndAdd('pixel_home_assets', data.pixelHomeAssets);
      if (data.pixelHomeLayouts && db.objectStoreNames.contains('pixel_home_layouts')) clearAndAdd('pixel_home_layouts', data.pixelHomeLayouts);

      if (data.userProfile) {
          if (availableStores.includes(STORE_USER)) {
              const store = tx.objectStore(STORE_USER);
              store.clear();
              store.put({ ...data.userProfile, id: 'me' });
          }
      }

      if (data.bankState || data.bankDollhouse) {
          if (availableStores.includes(STORE_BANK_DATA)) {
              const store = tx.objectStore(STORE_BANK_DATA);
              store.clear();
              if (data.bankState) {
                  store.put({ ...data.bankState, id: 'main_state' });
              }
              if (data.bankDollhouse) {
                  store.put({ id: 'dollhouse_state', data: data.bankDollhouse });
              }
          }
      }

      return new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
      });
  }
};
