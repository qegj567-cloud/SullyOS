-- 彼方虚拟邮局 · D1 schema
-- 默认无需手动执行：Worker 启动时会自动建表（加性、不破坏老数据）。
-- 想提前建表 / 排查时可手动：
--   wrangler d1 create sullyos-post-office
--   wrangler d1 execute sullyos-post-office --file schema.sql

-- 公共信件池
CREATE TABLE IF NOT EXISTS po_letters (
  id          TEXT    PRIMARY KEY,            -- 远端信 id (uuid)
  device      TEXT    NOT NULL,               -- 寄信方匿名 owner_id
  pen         TEXT    NOT NULL,               -- 笔名（角色名/匿名）
  content     TEXT    NOT NULL,
  lang        TEXT,
  created_at  INTEGER NOT NULL,               -- ms epoch
  reply_count INTEGER NOT NULL DEFAULT 0,
  likes       INTEGER NOT NULL DEFAULT 0,     -- 点赞数（按 po_votes 重算）
  dislikes    INTEGER NOT NULL DEFAULT 0,     -- 点踩(=举报)数；达 PO_DISLIKE_LIMIT 即删信
  views       INTEGER NOT NULL DEFAULT 0      -- 被抽到次数（一设备只算一次）
);
-- 老库升级（已有 po_letters 时补列；列已存在会报错，可忽略）：
--   ALTER TABLE po_letters ADD COLUMN likes    INTEGER NOT NULL DEFAULT 0;
--   ALTER TABLE po_letters ADD COLUMN dislikes INTEGER NOT NULL DEFAULT 0;
--   ALTER TABLE po_letters ADD COLUMN views    INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_po_letters_dev  ON po_letters(device);
CREATE INDEX IF NOT EXISTS idx_po_letters_open ON po_letters(reply_count, created_at);

-- 谁抽到过哪封信（避免同一设备重复抽到同一封）
CREATE TABLE IF NOT EXISTS po_picks (
  device    TEXT    NOT NULL,
  letter_id TEXT    NOT NULL,
  at        INTEGER NOT NULL,
  PRIMARY KEY (device, letter_id)
);

-- 回信
CREATE TABLE IF NOT EXISTS po_replies (
  id         TEXT    PRIMARY KEY,
  letter_id  TEXT    NOT NULL,                -- 被回的信
  device     TEXT    NOT NULL,                -- 回信方 owner_id
  pen        TEXT    NOT NULL,
  content    TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_po_replies_letter ON po_replies(letter_id);

-- owner_id(UUID) ↔ 短整数 uid 映射：多行的投票表只存 uid，省空间
CREATE TABLE IF NOT EXISTS po_devices (
  uid        INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id   TEXT    NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- 投票（点赞 vote=1 / 点踩=举报 vote=-1），一设备一票
-- ip_hash：自动删除按「不同 IP」去重，防伪造 device 刷满阈值删信
CREATE TABLE IF NOT EXISTS po_votes (
  letter_id TEXT    NOT NULL,
  uid       INTEGER NOT NULL,                 -- 指向 po_devices.uid
  vote      INTEGER NOT NULL,                 -- 1 赞 / -1 踩
  at        INTEGER NOT NULL,
  ip_hash   TEXT,                             -- 加盐 IP 哈希（旧库 ALTER 补列）
  PRIMARY KEY (letter_id, uid)
);
-- 老库升级：ALTER TABLE po_votes ADD COLUMN ip_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_po_votes_letter ON po_votes(letter_id);

-- 限流计数（固定窗口；bucket = ipHash:action）
CREATE TABLE IF NOT EXISTS po_ratelimit (
  bucket   TEXT    PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

-- ════════ 信号坠落处 / 跨用户接龙诗 ════════
-- 复用本后端的匿名 device / 笔名 / 限流；走独立的 po_* 表。

-- 册子：容器 + 规格（多少首诗 / 每首句数 roll 区间 / 每句字数上限）
CREATE TABLE IF NOT EXISTS po_booklets (
  id             TEXT    PRIMARY KEY,
  title          TEXT    NOT NULL,
  subtitle       TEXT,
  theme          TEXT,
  poems_target   INTEGER NOT NULL,             -- 写满多少首算这本完成
  poem_count     INTEGER NOT NULL DEFAULT 0,   -- 已封存诗数（实算回填）
  lines_min      INTEGER NOT NULL,             -- 每首句数 roll 下限
  lines_max      INTEGER NOT NULL,             -- 上限
  chars_per_line INTEGER NOT NULL,             -- 每句字数上限
  status         TEXT    NOT NULL DEFAULT 'open', -- open / done
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_po_booklets_open ON po_booklets(status, created_at);

-- 诗：一首接龙诗（line_count 由 po_poem_lines 实算回填，避免并发自增漂移）
CREATE TABLE IF NOT EXISTS po_poems (
  id           TEXT    PRIMARY KEY,
  booklet_id   TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  brief        TEXT,
  target_lines INTEGER NOT NULL,               -- roll 到的篇幅（总句数）
  line_count   INTEGER NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL DEFAULT 'open', -- open / sealed
  starter_pen  TEXT,                            -- 起新篇者笔名
  created_at   INTEGER NOT NULL,
  sealed_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_po_poems_booklet ON po_poems(booklet_id, status);
CREATE INDEX IF NOT EXISTS idx_po_poems_sealed  ON po_poems(status, sealed_at);

-- 句：(poem_id, seq) 唯一，并发抢同号时第二条 INSERT 失败 → 天然防错位
CREATE TABLE IF NOT EXISTS po_poem_lines (
  id         TEXT    PRIMARY KEY,
  poem_id    TEXT    NOT NULL,
  booklet_id TEXT    NOT NULL,
  seq        INTEGER NOT NULL,                  -- 1-based 句号
  device     TEXT    NOT NULL,                  -- 贡献者匿名 owner_id
  pen        TEXT    NOT NULL,                  -- 笔名（马赛克后的角色名）
  content    TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_po_poem_lines_seq ON po_poem_lines(poem_id, seq);

CREATE TABLE IF NOT EXISTS po_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS po_signal_lock (id TEXT PRIMARY KEY, holder TEXT, expires_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS po_poem_writers (poem_id TEXT NOT NULL, device TEXT NOT NULL, turns INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (poem_id, device));
