import type {
  CollaborationAssetRecord,
  CollaborationCategory,
  CollaborationMessage,
  CollaborationLibraryFile,
  CollaborationSession,
  CollaborationSettings,
  CollaborationBackupSnapshot,
} from './types';
import { DEFAULT_COLLABORATION_SETTINGS } from './types';
import { validateCollaborationAppearance, type CollaborationAppearance } from './appearance';

const DB_NAME = 'SullyOS_Collaboration';
const DB_VERSION = 1;
const STORE_SESSIONS = 'sessions';
const STORE_MESSAGES = 'messages';
const STORE_CATEGORIES = 'categories';
const STORE_SETTINGS = 'settings';
const STORE_ASSETS = 'assets';

let databasePromise: Promise<IDBDatabase> | null = null;

const openCollaborationDatabase = (): Promise<IDBDatabase> => {
  if (databasePromise) return databasePromise;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        const store = db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
        store.createIndex('charId', 'charId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
        const store = db.createObjectStore(STORE_MESSAGES, { keyPath: 'id' });
        store.createIndex('sessionId', 'sessionId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_CATEGORIES)) {
        db.createObjectStore(STORE_CATEGORIES, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_ASSETS)) {
        db.createObjectStore(STORE_ASSETS, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        if (databasePromise === pending) databasePromise = null;
      };
      db.onclose = () => {
        if (databasePromise === pending) databasePromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      if (databasePromise === pending) databasePromise = null;
      reject(request.error);
    };
    request.onblocked = () => {
      if (databasePromise === pending) databasePromise = null;
      reject(new Error('协同工作数据库被其它标签页占用，请关闭其它页面后重试'));
    };
  });
  databasePromise = pending;
  return pending;
};

const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const commitTransaction = (transaction: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error || new Error('协同工作数据写入中断'));
});

const getAll = async <T>(storeName: string): Promise<T[]> => {
  const db = await openCollaborationDatabase();
  const transaction = db.transaction(storeName, 'readonly');
  return requestResult(transaction.objectStore(storeName).getAll()) as Promise<T[]>;
};

/** Count rows without reading message text, filenames, API settings, or blobs. */
const countAll = async (storeName: string): Promise<number> => {
  const db = await openCollaborationDatabase();
  const transaction = db.transaction(storeName, 'readonly');
  return requestResult(transaction.objectStore(storeName).count());
};

const put = async <T>(storeName: string, value: T): Promise<void> => {
  const db = await openCollaborationDatabase();
  const transaction = db.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).put(value);
  await commitTransaction(transaction);
};

export const CollaborationStore = {
  /** Privacy-safe usage snapshot for the once-per-session Umami stock event. */
  getUsageCounts: async (): Promise<{ sessions: number; messages: number; assets: number }> => {
    const [sessions, messages, assets] = await Promise.all([
      countAll(STORE_SESSIONS),
      countAll(STORE_MESSAGES),
      countAll(STORE_ASSETS),
    ]);
    return { sessions, messages, assets };
  },

  listSessions: async (charId: string): Promise<CollaborationSession[]> => {
    const db = await openCollaborationDatabase();
    const transaction = db.transaction(STORE_SESSIONS, 'readonly');
    const rows = await requestResult(transaction.objectStore(STORE_SESSIONS).index('charId').getAll(charId)) as CollaborationSession[];
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  },

  saveSession: (session: CollaborationSession): Promise<void> => put(STORE_SESSIONS, session),

  deleteSession: async (sessionId: string): Promise<void> => {
    const db = await openCollaborationDatabase();
    // Do not delete assets here. A ChatApp file card may still point at one of
    // them by assetId; retaining the canonical Blob keeps those deliveries
    // valid without copying the file into the main chat database.
    const transaction = db.transaction([STORE_SESSIONS, STORE_MESSAGES], 'readwrite');
    transaction.objectStore(STORE_SESSIONS).delete(sessionId);
    const messageStore = transaction.objectStore(STORE_MESSAGES);
    const cursorRequest = messageStore.index('sessionId').openCursor(IDBKeyRange.only(sessionId));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    await commitTransaction(transaction);
  },

  listMessages: async (sessionId: string): Promise<CollaborationMessage[]> => {
    const db = await openCollaborationDatabase();
    const transaction = db.transaction(STORE_MESSAGES, 'readonly');
    const rows = await requestResult(transaction.objectStore(STORE_MESSAGES).index('sessionId').getAll(sessionId)) as CollaborationMessage[];
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  },

  saveMessage: (message: CollaborationMessage): Promise<void> => put(STORE_MESSAGES, message),

  /**
   * Remove message rows without deleting their canonical assets. Generated or
   * uploaded files may already have been delivered to ChatApp by assetId, so a
   * message edit must never invalidate those existing file cards.
   */
  deleteMessages: async (messageIds: string[]): Promise<void> => {
    if (messageIds.length === 0) return;
    const db = await openCollaborationDatabase();
    const transaction = db.transaction(STORE_MESSAGES, 'readwrite');
    const store = transaction.objectStore(STORE_MESSAGES);
    messageIds.forEach(messageId => store.delete(messageId));
    await commitTransaction(transaction);
  },

  /**
   * Permanently remove one canonical file and every collaboration-message
   * attachment that points at it. ChatApp cards deliberately keep only the
   * asset id, so an explicit library deletion also makes old deliveries
   * unavailable instead of leaving a hidden duplicate behind.
   */
  deleteLibraryFile: async (assetId: string): Promise<void> => {
    const db = await openCollaborationDatabase();
    const transaction = db.transaction([STORE_MESSAGES, STORE_ASSETS], 'readwrite');
    transaction.objectStore(STORE_ASSETS).delete(assetId);
    const messageStore = transaction.objectStore(STORE_MESSAGES);
    const cursorRequest = messageStore.openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      const message = cursor.value as CollaborationMessage;
      const attachments = (message.attachments || []).filter(attachment => attachment.assetId !== assetId);
      if (attachments.length !== (message.attachments || []).length) {
        cursor.update({ ...message, attachments: attachments.length > 0 ? attachments : undefined });
      }
      cursor.continue();
    };
    await commitTransaction(transaction);
  },

  /**
   * Compute the current character's file cabinet from collaboration messages.
   * The result is metadata-only and deduplicated by assetId, so opening or
   * sending the same file repeatedly never produces a second Blob.
   */
  listLibraryFiles: async (charId: string): Promise<CollaborationLibraryFile[]> => {
    const sessions = await CollaborationStore.listSessions(charId);
    const rows = await Promise.all(sessions.map(async session => ({
      session,
      messages: await CollaborationStore.listMessages(session.id),
    })));
    const byAssetId = new Map<string, CollaborationLibraryFile>();
    rows.forEach(({ session, messages }) => {
      messages.forEach(message => {
        (message.attachments || []).forEach(attachment => {
          // Installable beautification/card/worldbook works are real canonical
          // assets too. Keep them in the same cabinet instead of hiding them:
          // ChatApp can then deliver the existing asset without making a copy.
          if (!attachment.assetId) return;
          const file: CollaborationLibraryFile = {
            ...attachment,
            sessionId: session.id,
            sessionTitle: session.title,
            messageId: message.id,
          };
          const previous = byAssetId.get(file.assetId);
          if (!previous || file.createdAt > previous.createdAt) byAssetId.set(file.assetId, file);
        });
      });
    });
    return [...byAssetId.values()].sort((a, b) => b.createdAt - a.createdAt);
  },

  listCategories: async (): Promise<CollaborationCategory[]> => {
    const rows = await getAll<CollaborationCategory>(STORE_CATEGORIES);
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  },

  saveCategory: (category: CollaborationCategory): Promise<void> => put(STORE_CATEGORIES, category),

  deleteCategory: async (categoryId: string): Promise<void> => {
    const db = await openCollaborationDatabase();
    const transaction = db.transaction([STORE_CATEGORIES, STORE_SESSIONS], 'readwrite');
    transaction.objectStore(STORE_CATEGORIES).delete(categoryId);
    const sessionStore = transaction.objectStore(STORE_SESSIONS);
    const cursorRequest = sessionStore.openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      const session = cursor.value as CollaborationSession;
      if (session.categoryId === categoryId) {
        cursor.update({ ...session, categoryId: undefined, updatedAt: Date.now() });
      }
      cursor.continue();
    };
    await commitTransaction(transaction);
  },

  loadSettings: async (): Promise<CollaborationSettings> => {
    const db = await openCollaborationDatabase();
    const transaction = db.transaction(STORE_SETTINGS, 'readonly');
    const saved = await requestResult(transaction.objectStore(STORE_SETTINGS).get('main')) as CollaborationSettings | undefined;
    return saved
      ? {
          ...DEFAULT_COLLABORATION_SETTINGS,
          ...saved,
          immersive: { ...DEFAULT_COLLABORATION_SETTINGS.immersive, ...saved.immersive },
          focused: { ...DEFAULT_COLLABORATION_SETTINGS.focused, ...saved.focused },
        }
      : {
          ...DEFAULT_COLLABORATION_SETTINGS,
          immersive: { ...DEFAULT_COLLABORATION_SETTINGS.immersive },
          focused: { ...DEFAULT_COLLABORATION_SETTINGS.focused },
        };
  },

  saveSettings: (settings: CollaborationSettings): Promise<void> => put(STORE_SETTINGS, settings),

  /** Patch only appearance in one transaction; never overwrite the user's API settings. */
  applyAppearance: async (value: CollaborationAppearance): Promise<void> => {
    const appearance = validateCollaborationAppearance(value);
    const db = await openCollaborationDatabase();
    const transaction = db.transaction(STORE_SETTINGS, 'readwrite');
    const committed = commitTransaction(transaction);
    const store = transaction.objectStore(STORE_SETTINGS);
    const request = store.get('main');
    request.onsuccess = () => store.put({ ...DEFAULT_COLLABORATION_SETTINGS, ...request.result, ...appearance, id: 'main', updatedAt: Date.now() });
    await committed;
  },

  saveAsset: (asset: CollaborationAssetRecord): Promise<void> => put(STORE_ASSETS, asset),

  getAsset: async (assetId: string): Promise<Blob | null> => {
    const db = await openCollaborationDatabase();
    const transaction = db.transaction(STORE_ASSETS, 'readonly');
    const row = await requestResult(transaction.objectStore(STORE_ASSETS).get(assetId)) as CollaborationAssetRecord | undefined;
    return row?.blob || null;
  },

  /** Export the sidecar database for Settings → Export. */
  exportBackup: async (includeAssets: boolean, includeText = true): Promise<CollaborationBackupSnapshot> => {
    const [sessions, messages, categories, settings, assets] = await Promise.all([
      includeText ? getAll<CollaborationSession>(STORE_SESSIONS) : Promise.resolve([]),
      includeText ? getAll<CollaborationMessage>(STORE_MESSAGES) : Promise.resolve([]),
      includeText ? getAll<CollaborationCategory>(STORE_CATEGORIES) : Promise.resolve([]),
      includeText ? CollaborationStore.loadSettings() : Promise.resolve(undefined),
      includeAssets ? getAll<CollaborationAssetRecord>(STORE_ASSETS) : Promise.resolve([]),
    ]);
    return {
      sessions: includeText ? sessions : undefined,
      messages: includeText ? messages : undefined,
      categories: includeText ? categories : undefined,
      settings: includeText ? settings : undefined,
      assets: includeAssets ? assets : undefined,
    };
  },

  /** Restore only the sections present in a backup; media-only restores upsert files. */
  importBackup: async (
    snapshot: CollaborationBackupSnapshot,
    options: { replaceAssets?: boolean } = {},
  ): Promise<void> => {
    const db = await openCollaborationDatabase();
    const names: string[] = [];
    if (snapshot.sessions !== undefined) names.push(STORE_SESSIONS);
    if (snapshot.messages !== undefined) names.push(STORE_MESSAGES);
    if (snapshot.categories !== undefined) names.push(STORE_CATEGORIES);
    if (snapshot.settings !== undefined) names.push(STORE_SETTINGS);
    if (snapshot.assets !== undefined) names.push(STORE_ASSETS);
    if (names.length === 0) return;
    const transaction = db.transaction(names, 'readwrite');
    const replaceRows = <T,>(storeName: string, rows: T[]) => {
      const store = transaction.objectStore(storeName);
      store.clear();
      rows.forEach(row => store.put(row));
    };
    if (snapshot.sessions !== undefined) replaceRows(STORE_SESSIONS, snapshot.sessions);
    if (snapshot.messages !== undefined) replaceRows(STORE_MESSAGES, snapshot.messages);
    if (snapshot.categories !== undefined) replaceRows(STORE_CATEGORIES, snapshot.categories);
    if (snapshot.settings !== undefined) replaceRows(STORE_SETTINGS, [snapshot.settings]);
    if (snapshot.assets !== undefined) {
      const store = transaction.objectStore(STORE_ASSETS);
      if (options.replaceAssets) store.clear();
      snapshot.assets.forEach(asset => store.put(asset));
    }
    await commitTransaction(transaction);
  },
};
