/**
 * amsg2 本地全流程实测 harness（上线前检查用，跑法：`node scripts/amsg2-e2e-harness.mjs`）。
 *
 * 使用当前依赖打出的 bundle 与 Node 24。这里验 cron 路径，不覆盖 Durable Object
 * 持久存储、alarm 或即时对话起跳；Cloudflare 基类只为载入模块占位，实例化会明确失败。
 *
 * 跑的是仓库里提交的 **同一份** worker/amsg/worker.bundle.js（用户粘进 CF Dashboard 的就是它），
 * 外围环境全部真实化：
 *   - D1 → node:sqlite 内存库（prepare/bind/run/first/all/batch 语义对齐）
 *   - Web Push → 真实 VAPID + RFC8291 aes128gcm 加密，harness 持有浏览器侧私钥现场解密验内容
 *   - LLM → mock（按请求内容路由脚本回复，校验请求里的 prompt 是不是 fire-time 现场渲染）
 *   - HTTP → node:http 桥接 worker.fetch，前端同款 @rei-standard/amsg-client 直连
 *
 * 场景：
 *   S0 鉴权/CORS/capabilities   S1 init-tenant + get-user-key + vapid-public-key
 *   S2 fixed 一次性任务端到端    S3 满血 v2 多任务（fire_pack 现场填槽 + RECALL 工具循环 +
 *      directives + occurrenceMs + 大值分块 + daily 推进 + /messages 投影 + cancel）
 *   S4 锚点前进 → 最新上下文交给模型决定静默  S5a 活跃租约新鲜 → 延期，回复结束后恢复
 *   S5b 租约过期 + 无 fire_pack → 抛错不降级        S6 force 策略 → 全绿灯照发
 *   S7 clear-client-state
 *   S8 通用 MCP native（tools 声明 → 直连真 MCP 服务器 → 结果回喂 → 暗号进 push）
 *   S8b 通用 MCP 正文兜底（不带 tools，提示词教协议，正文里的调用被识别执行）
 *   S9 自排链（角色到点给自己排下一条 → 用户全程不上线 → 下一条读得到上一条说了什么）
 *
 * 有意不进 vitest：它要起真端口、真等 cron 到点（多处 1.4s sleep）、并 mock 全局 fetch，
 * 是发布前手动跑的端到端体检，不是单测。改 worker/amsg 或升 amsg-server 后跑一次。
 */
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire, registerHooks } from 'node:module';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const require = createRequire(`${REPO}/package.json`);
const webpush = require('web-push');
const { ReiClient } = await import(pathToFileURL(`${REPO}/node_modules/@rei-standard/amsg-client/dist/index.mjs`));
const b64u = (buf) => Buffer.from(buf).toString('base64url');

// ─── 断言与结果账本 ───
const results = [];
let failures = 0;
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond, detail });
  if (!cond) failures++;
  console.log(`${cond ? '  ✅' : '  ❌'} ${name}${cond ? '' : detail ? `  ← ${detail}` : ''}`);
};
const section = (t) => console.log(`\n━━ ${t}`);

// ─── D1 shim（node:sqlite） ───
class D1Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.params = []; }
  bind(...p) { this.params = p.map((v) => v === undefined ? null : v); return this; }
  execute() {
    const statement = this.db.prepare(this.sql);
    if (statement.columns().length > 0) {
      const results = statement.all(...this.params);
      const meta = /^\s*(SELECT|PRAGMA)\b/i.test(this.sql)
        ? { changes: 0 }
        : this.db.prepare('SELECT changes() AS changes, last_insert_rowid() AS last_row_id').get();
      return { meta, results };
    }
    const result = statement.run(...this.params);
    return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) }, results: [] };
  }
  async run() { return this.execute(); }
  async first() { return this.db.prepare(this.sql).get(...this.params) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params) }; }
}
class D1Shim {
  constructor() { this.db = new DatabaseSync(':memory:'); }
  prepare(sql) { return new D1Stmt(this.db, sql); }
  async batch(stmts) {
    this.db.exec('BEGIN');
    try {
      const results = stmts.map((statement) => statement.execute());
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  raw(sql) { return this.db.prepare(sql).all(); }
}

// ─── 环境（与 CF Dashboard 部署一致的 env） ───
const vapidKeys = webpush.generateVAPIDKeys();
const SERVER_TOKEN = 'launch-check-shared-secret';
const d1 = new D1Shim();
const env = {
  AMSG_MASTER_KEY: crypto.randomBytes(32).toString('hex'),
  VAPID_EMAIL: 'mailto:e2e@example.com',
  VAPID_PUBLIC_KEY: vapidKeys.publicKey,
  VAPID_PRIVATE_KEY: vapidKeys.privateKey,
  AMSG_SERVER_TOKEN: SERVER_TOKEN,
  DB: d1,
};

// ─── 浏览器侧 push 订阅密钥（真实 P-256 + auth secret），并实现 RFC8291 解密 ───
const receiver = crypto.createECDH('prime256v1');
receiver.generateKeys();
const authSecret = crypto.randomBytes(16);
const subscription = {
  endpoint: 'https://push.test/harness-user',
  keys: { p256dh: b64u(receiver.getPublicKey()), auth: b64u(authSecret) },
};
const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
function decryptPush(bodyBuf) {
  const salt = bodyBuf.subarray(0, 16);
  const idlen = bodyBuf[20];
  const senderPub = bodyBuf.subarray(21, 21 + idlen);
  const ct = bodyBuf.subarray(21 + idlen);
  const shared = receiver.computeSecret(senderPub);
  const prkInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiver.getPublicKey(), senderPub]);
  const ikm = hkdf(authSecret, shared, prkInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const dec = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  dec.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([dec.update(ct.subarray(0, ct.length - 16)), dec.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  if (plain[end] !== 0x02) throw new Error('bad aes128gcm padding delimiter');
  return JSON.parse(plain.subarray(0, end).toString('utf8'));
}

// ─── 出网 fetch 拦截：push 端点 + mock LLM，其余透传（本地 http 走 127.0.0.1 不受影响） ───
const realFetch = globalThis.fetch;
const pushes = [];            // { tag, headers, payload }
const llmRequests = [];       // 原始请求体

// mock LLM 的两个应答构造器：一次普通回复 / 一次「顺手给自己排下一条」的工具调用。
const llmReply = (content, toolCalls) => new Response(JSON.stringify({
  choices: [{ message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }],
}), { status: 200, headers: { 'content-type': 'application/json' } });
const scheduleCall = (id, sendAt, promptHint) => ({
  id, type: 'function',
  function: {
    name: 'schedule_active_message',
    arguments: JSON.stringify({
      send_at: sendAt,
      ...(promptHint ? { mode: 'prompted', prompt_hint: promptHint } : {}),
    }),
  },
});
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://push.test/')) {
    const tag = url.slice('https://push.test/'.length);
    const headers = init.headers || {};
    const payload = decryptPush(Buffer.from(init.body));
    pushes.push({ tag, headers, payload });
    return new Response(null, { status: 201 });
  }
  if (url.startsWith('https://llm.test/')) {
    const req = JSON.parse(init.body);
    llmRequests.push(req);
    const all = req.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    const hasToolResult = req.messages.some((m) => m.role === 'tool');
    let content;
    if (all.includes('FIREPACK_FRESH_char-full') && !hasToolResult) {
      content = '（先想想上个月的事）等我翻翻记忆。\n[[RECALL: 2026-06]]';
    } else if (all.includes('FIREPACK_FRESH_char-full') && hasToolResult) {
      content = '想起来了，六月那天的烟花真好看。\n今晚也想拉你去河边。\n[[ACTION:POKE]]';
    } else if (all.includes('FIREPACK_FRESH_char-mcp-native') && !hasToolResult) {
      // native 模式第 1 轮：正文写旁白 + 走 function calling 通道发起 MCP 调用。
      // 这条要连 tool_calls 一起给，所以不套用下面统一的「只有 content」的包装。
      return new Response(JSON.stringify({ choices: [{ message: {
        role: 'assistant', content: '我问问那边今天的暗号。',
        tool_calls: [{
          id: 'call_mcp_1', type: 'function',
          function: { name: 'mcp__get_secret_word', arguments: '{"asked_by":"小满"}' },
        }],
      } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    } else if (all.includes('FIREPACK_FRESH_char-mcp-native') && hasToolResult) {
      const toolText = req.messages.filter((m) => m.role === 'tool').map((m) => String(m.content)).join('\n');
      const m = toolText.match(/HARNESS-MCP-\w+/);
      content = `拿到了，今天的暗号是 ${m ? m[0] : '（工具结果里没找到）'}。`;
    } else if (all.includes('FIREPACK_FRESH_char-mcp-text') && !hasToolResult) {
      // 正文兜底模式第 1 轮：模型把调用「演」在正文里（不支持 FC 的中转常见形态）
      content = '我问问那边今天的暗号。\nget_secret_word({"asked_by":"小满"})';
    } else if (all.includes('FIREPACK_FRESH_char-mcp-text') && hasToolResult) {
      const toolText = req.messages.filter((m) => m.role === 'tool').map((m) => String(m.content)).join('\n');
      const m = toolText.match(/HARNESS-MCP-\w+/);
      content = `拿到了，暗号是 ${m ? m[0] : '（没找到）'}。`;
    } else if (all.includes('FROZEN_char-frozen')) {
      content = '冻结提示词兜底照发成功。';
    } else if (all.includes('FIREPACK_FRESH_char-force')) {
      content = '闹钟型强制发送，正在聊天也照发。';
    } else if (all.includes('FIREPACK_FRESH_char-anchor')) {
      content = '[[SILENT]]';
    } else if (all.includes('FIREPACK_FRESH_char-presence')) {
      content = '上一轮已经聊完，现在接着说。';
    } else if (all.includes('FIREPACK_FRESH_char-chain')) {
      // 自排链：角色在这条消息里给自己排下一条，走 function calling 通道。
      // 分支只看「prompt 和回喂里出现了什么」，不数轮次——链断在任何一环，走到的
      // 分支就会不一样，断言直接红，比事后比对正文更贴近「角色到底看见了没有」。
      // 判定顺序要紧：ok:true 排在被打回那条前面，否则第三轮还会看到第一轮的打回记录。
      const seenPass = all.match(/CHAIN-PASS-\d+/);
      if (seenPass) {
        // 第二次触发。口令只可能来自云端自述回写（上一条正文），prompt 里读不到就接不上。
        content = `接着刚才那条说，口令还是 ${seenPass[0]}，我没忘。`;
      } else if (all.includes('"ok":true')) {
        content = '口令给你留一个：CHAIN-PASS-8823，等下我再来对。';
      } else if (all.includes('send_at_too_soon')) {
        // 被打回后按回喂改口，15 分钟后既满足最小提前量，也满足默认 10 分钟间隔。
        return llmReply('那就往后挪挪。', [
          scheduleCall('call_sched_2', new Date(Date.now() + 15 * 60_000).toISOString(), '接着口令那件事往下说'),
        ]);
      } else {
        // 第一轮故意把时间写太近（30 秒后）：验「参数写歪只回喂让它改口，不让整条 fire 失败」。
        return llmReply('等我先把后面那条排上。', [scheduleCall('call_sched_1', new Date(Date.now() + 30_000).toISOString())]);
      }
    } else {
      content = '（默认回复：未匹配任何脚本分支）';
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  return realFetch(input, init);
};

// ─── 载入与线上部署同一份的 worker bundle，并起 http 桥 ───
const cloudflareLoader = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') return { url: specifier, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'cloudflare:workers') {
      return {
        format: 'module', shortCircuit: true,
        source: `export class DurableObject {
          constructor() { throw new Error('This cron harness does not emulate Durable Object storage or alarms'); }
        }`,
      };
    }
    return nextLoad(url, context);
  },
});
let worker;
try {
  worker = (await import(pathToFileURL(`${REPO}/worker/amsg/worker.bundle.js`))).default;
} finally {
  cloudflareLoader.deregister();
}
const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const request = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) || body.length === 0 ? undefined : body,
    });
    const response = await worker.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    res.writeHead(500); res.end(String(e && e.stack || e));
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ─── S8 的 mock MCP 服务器（真 HTTP；worker 直连，不走 fetch 拦截） ───
// 地址是 127.0.0.1，上面那层 fetch 拦截只认 push.test / llm.test，所以 worker 发出的
// JSON-RPC 是真的走到了这个进程内的 HTTP 服务器上——握手、通知、tools/call 一步不少。
const MCP_PASSPHRASE = 'HARNESS-MCP-7731';
const mcpSeen = [];           // 收到的 JSON-RPC method 顺序
const mcpServer = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  mcpSeen.push(body.method);
  const reply = (obj, extra = {}) => {
    res.writeHead(200, { 'content-type': 'application/json', ...extra });
    res.end(JSON.stringify(obj));
  };
  if (body.method === 'initialize') {
    return reply(
      {
        jsonrpc: '2.0', id: body.id,
        result: {
          protocolVersion: '2025-11-25', capabilities: { tools: {} },
          serverInfo: { name: 'harness-mcp', version: '1.0.0' },
        },
      },
      { 'Mcp-Session-Id': 'harness-session' },
    );
  }
  if (String(body.method).startsWith('notifications/')) { res.writeHead(202); return res.end(); }
  if (body.method === 'tools/call' && body.params?.name === 'get_secret_word') {
    return reply({
      jsonrpc: '2.0', id: body.id,
      result: { content: [{ type: 'text', text: `暗号是 ${MCP_PASSPHRASE}` }] },
    });
  }
  reply({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `method not found: ${body.method}` } });
});
await new Promise((r) => mcpServer.listen(0, '127.0.0.1', r));
const MCP_URL = `http://127.0.0.1:${mcpServer.address().port}`;
// tool_config 直接写字面量（不过 collectMcpFireServers），所以本机地址不会被上云侧的
// 公网可达性过滤掉。useNative=false 对应前台「兼容模式」：请求不带 tools，改教正文协议。
const MCP_TOOL_CONFIG = (useNative) => JSON.stringify({
  v: 1, proxyWorkerUrl: '', newsEnabled: false, notionEnabled: false, feishuEnabled: false,
  mcpUseNativeTools: useNative,
  mcpServers: [{
    id: 'srv1', name: '暗号服务器', url: MCP_URL,
    tools: [{
      name: 'get_secret_word',
      description: '取回今日暗号',
      inputSchema: { type: 'object', properties: { asked_by: { type: 'string' } } },
    }],
  }],
});

const runCron = () => worker.scheduled({ scheduledTime: Date.now(), cron: '* * * * *' }, env);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 只推进测试进程的墙上时钟；任务的原始到点时刻、重试时间与频率闸全部保留。
async function withClockAt(at, run) {
  if (!Number.isFinite(at)) throw new Error(`Invalid harness clock: ${at}`);
  const ActualDate = globalThis.Date;
  class HarnessDate extends ActualDate {
    constructor(...args) { super(...(args.length ? args : [at])); }
    static now() { return at; }
  }
  globalThis.Date = HarnessDate;
  try { return await run(); }
  finally { globalThis.Date = ActualDate; }
}

// ─── 前端同款 client ───
const USER_ID = crypto.randomUUID();
const client = new ReiClient({ baseUrl: BASE, userId: USER_ID, serverToken: SERVER_TOKEN });

const authedHeaders = (extra = {}) => ({
  'X-Client-Token': SERVER_TOKEN, 'X-User-Id': USER_ID, ...extra,
});
// 复刻 activeMsgClient.fetchWithAuth + encryptPayload 的排程调用
async function scheduleTask(payload) {
  const encrypted = await client._encrypt(JSON.stringify(payload));
  const res = await realFetch(`${BASE}/schedule-message`, {
    method: 'POST',
    headers: authedHeaders({
      'Content-Type': 'application/json',
      'X-Payload-Encrypted': 'true',
      'X-Encryption-Version': '1',
    }),
    body: JSON.stringify(encrypted),
  });
  const result = await res.json();
  if (!result.success) throw new Error(`schedule-message failed: ${JSON.stringify(result.error)}`);
  return result;
}
async function listAllTasks() {
  const res = await realFetch(`${BASE}/messages?limit=100&offset=0`, {
    method: 'GET',
    headers: authedHeaders({ 'X-Response-Encrypted': 'true', 'X-Encryption-Version': '1' }),
  });
  const json = await res.json();
  if (!json.success) throw new Error('messages failed: ' + JSON.stringify(json.error));
  const data = json.encrypted === true ? await client._decrypt(json.data) : json.data;
  return data;
}
async function cancelTask(uuid) {
  const res = await realFetch(`${BASE}/cancel-message?id=${encodeURIComponent(uuid)}`, {
    method: 'DELETE', headers: authedHeaders(),
  });
  return res.json();
}
const putState = (entries) => client.putClientState(entries);

// fire_pack / tool_pack / chat_presence 的形状与 key（与 utils/amsgFirePack.ts、
// utils/amsgToolPack.ts、utils/amsgChatPresence.ts 一致；parse 不过 worker 会静默回退，
// 场景断言里的 FIREPACK_FRESH 标记会立刻暴露）
const NS = (charId) => `amsg:char:${charId}`;
const SLOT_TIME = '{{AMSG_CURRENT_TIME}}';
const SLOT_SINCE = '{{AMSG_TIME_SINCE_USER}}';
const SLOT_AWAY = '{{AMSG_AWAY_HINT}}';
const SLOT_TASK = '{{AMSG_TASK_INSTRUCTION}}';
const SLOT_SELF_LOG = '{{AMSG_SELF_LOG}}';
const SLOT_TASK_LIST = '{{AMSG_TASK_LIST}}';
/** 自述回写那一段的小标题（utils/amsgFirePack.ts renderSelfLogBlock），S9 靠它判断段落到没到。 */
const SELF_LOG_HEADING = '【这之后你又发过（对方还没回）】';
/** 排程清单那一段的小标题（utils/amsg2Tasks.ts buildFireTaskListBlock）。 */
const TASK_LIST_HEADING = '【你还挂着这些排程·仅你可见】';
/**
 * 客户端打上来的 fire_pack（v7）。槽位顺序照客户端实际打包的样子：自述回写紧跟对话记录，
 * 排程清单在时间信息之后、本次任务之前。
 * opts: { fillerKb 世界书填充体积, builtAt 打包时刻, pendingTasks 打包那一刻挂着的任务 }
 */
const firePack = (marker, lastUserMessageAt, opts = {}) => ({
  v: 7,
  template: [
    `【角色系统设定】${marker} 的完整人设……`,
    opts.fillerKb ? `【世界书填充】${'填'.repeat(opts.fillerKb * 512)}【填充结束FILLER_END】` : '',
    '【最近对话上下文】',
    `user: ${opts.latestUserMessage ?? '想起什么就跟我说。'}`,
    SLOT_SELF_LOG,
    `当前本地时间：${SLOT_TIME}`,
    SLOT_SINCE,
    SLOT_AWAY,
    SLOT_TASK_LIST,
    '【本次任务】',
    SLOT_TASK,
  ].join('\n'),
  lastUserMessageAt,
  // 与客户端 buildFirePack 同款（必填）：worker 侧一切给角色看的时间都按这个参照系渲染。
  tzId: Intl.DateTimeFormat().resolvedOptions().timeZone,
  userTzId: Intl.DateTimeFormat().resolvedOptions().timeZone,
  targetName: '测试者',
  scene: null,
  selfScheduleEnabled: true,
  builtAt: opts.builtAt ?? Date.now(),
  pendingTasks: opts.pendingTasks ?? [],
});
const toolPack = (charName) => ({
  v: 1,
  charName,
  timeAwarenessEnabled: true,
  xhsEnabled: false,
  // 2026-06 不在激活月清单 → runRecall 走「取回月度总结」正路（激活月按设计返回 null）
  activeMemoryMonths: [],
  memories: [{ date: '2026-06-15', summary: 'RECALL_MEMORY_MARKER 六月一起看了烟花', mood: '开心' }],
});
const presence = (charId, activeAt, lastUserMessageAt) => ({ v: 1, charId, activeAt, lastUserMessageAt });

// 复刻 activeMsgClient.scheduleCharacterTask 的 AI 任务 payload（字段一字不差）
function aiTaskPayload({ charId, charName, mode, firstSendTime, recurrenceType, expirePolicy, anchorMs, taskInstruction, frozenPrompt }) {
  const clientTaskId = crypto.randomUUID();
  return {
    clientTaskId,
    payload: {
      contactName: charName,
      avatarUrl: null,
      messageType: mode,
      messageSubtype: 'chat',
      firstSendTime,
      recurrenceType,
      metadata: {
        charId, charName,
        source: 'active_msg_2',
        amsgMode: mode,
        amsgClientTaskId: clientTaskId,
        amsgExpirePolicy: expirePolicy,
        amsgRecurrence: recurrenceType,
        amsgAnchorMs: anchorMs ?? 0,
        amsgTaskInstruction: taskInstruction,
      },
      completePrompt: frozenPrompt,
      credRefs: { chat: 'harness/chat' },
    },
  };
}

// ══════════════════════════ 场景 ══════════════════════════
try {
  section('S0 鉴权 / CORS / capabilities');
  {
    const r1 = await realFetch(`${BASE}/capabilities`);
    check('无密钥请求被 401 拒绝', r1.status === 401, `got ${r1.status}`);
    const r2 = await realFetch(`${BASE}/capabilities`, { headers: { 'X-Client-Token': 'wrong' } });
    check('错误密钥被 401 拒绝', r2.status === 401, `got ${r2.status}`);
    const pre = await realFetch(`${BASE}/schedule-message`, {
      method: 'OPTIONS', headers: { origin: 'https://sully.example', 'access-control-request-method': 'POST' },
    });
    check('CORS 预检 204 + allow-origin *', pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*',
      `status=${pre.status} origin=${pre.headers.get('access-control-allow-origin')}`);
    const caps = await client.getCapabilities();
    // 与 package.json 声明的 amsg-server 版本对比（不写死）：升依赖后 harness 零改动，
    // 且能抓住「升了依赖忘了 pnpm build:workers 重打 bundle」——bundle 内嵌的是旧版本号。
    const declaredServer = String(
      require(`${REPO}/package.json`).devDependencies['@rei-standard/amsg-server'] || '',
    ).replace(/^[\^~]/, '');
    check(`capabilities: serverVersion 与 package.json 声明一致（${declaredServer}）`,
      !!declaredServer && caps?.serverVersion === declaredServer, JSON.stringify(caps));
    for (const f of ['client-state', 'client-state-chunking', 'agentic-hooks', 'agentic-scratch', 'vapid-public-key']) {
      check(`capabilities.features 含 ${f}`, caps?.features?.includes(f));
    }
  }

  section('S1 连接流程：init-tenant → get-user-key → vapid-public-key');
  {
    const init = await (await realFetch(`${BASE}/init-tenant`, { method: 'POST', headers: authedHeaders() })).json();
    check('POST /init-tenant 幂等建表成功', init?.success === true, JSON.stringify(init));
    const init2 = await (await realFetch(`${BASE}/init-tenant`, { method: 'POST', headers: authedHeaders() })).json();
    check('再次 init-tenant 幂等', init2?.success === true);
    await client.init();
    check('client.init() 拿到 user key（加密通道就绪）', true);
    const vk = await client.getVapidPublicKey();
    check('GET /vapid-public-key 与 env 一致', vk === vapidKeys.publicKey);
    const registered = await client.putPushSubscription(subscription);
    check('登记用户级推送订阅成功', registered?.success === true, JSON.stringify(registered));
    const credentials = await client.putLlmCredentials([{ credId: 'harness/chat', value: {
      apiUrl: 'https://llm.test/v1/chat/completions', apiKey: 'sk-e2e', primaryModel: 'mock-model',
    } }]);
    check('登记模型凭据成功（任务只携带 credRefs）', credentials?.success === true, JSON.stringify(credentials));
  }

  section('S2 fixed 一次性任务端到端（排程 → cron → push → 解密验文）');
  {
    const clientTaskId = crypto.randomUUID();
    const sched = await scheduleTask({
      contactName: '小固', avatarUrl: null,
      messageType: 'fixed', messageSubtype: 'chat',
      userMessage: '到点了，这是固定消息正文。',
      firstSendTime: new Date(Date.now() + 1000).toISOString(),
      recurrenceType: 'none',
      metadata: {
        charId: 'char-fixed', charName: '小固', source: 'active_msg_2', amsgMode: 'fixed',
        amsgClientTaskId: clientTaskId, amsgExpirePolicy: 'force', amsgRecurrence: 'none', amsgAnchorMs: 0,
      },
    });
    check('schedule-message(fixed) 成功', sched?.success === true, JSON.stringify(sched?.error || sched));
    const listed = await listAllTasks();
    const row = listed.tasks.find((t) => t.uuid === sched.data.uuid);
    check('GET /messages 投影 charId', row?.charId === 'char-fixed', JSON.stringify(row));
    check('GET /messages 投影 clientTaskId', row?.clientTaskId === clientTaskId);
    await sleep(1400);
    await runCron();
    const mine = pushes.filter((p) => p.payload?.metadata?.charId === 'char-fixed');
    check('cron 到点后收到 1 条 push', mine.length === 1, `got ${mine.length}`);
    const p = mine[0]?.payload;
    check('push 正文 = 固定消息原文', p?.message === '到点了，这是固定消息正文。', JSON.stringify(p?.message));
    check('push 元数据带 amsgClientTaskId（送达归属键）', p?.metadata?.amsgClientTaskId === clientTaskId);
    check('push messageIndex/totalMessages = 1/1', p?.messageIndex === 1 && p?.totalMessages === 1);
    check('push 带 VAPID Authorization 头', String(mine[0]?.headers?.Authorization || mine[0]?.headers?.authorization || '').startsWith('vapid'));
    const after = await listAllTasks();
    check('一次性任务发完即从远端清单消失', !after.tasks.some((t) => t.uuid === sched.data.uuid));
  }

  section('S3 满血 v2：fire_pack 现场填槽 + RECALL 工具循环 + directives + daily 推进');
  let s3uuid = null;
  {
    const now = Date.now();
    // 大值：fire_pack 里塞 ~256KB 填充，验证 2.6.0-next.4 存储层透明分块读回
    await putState([
      { namespace: NS('char-full'), key: 'fire_pack', value: JSON.stringify(firePack('FIREPACK_FRESH_char-full', now - 3600_000, { fillerKb: 512 })), updatedAt: now },
      { namespace: NS('char-full'), key: 'tool_pack', value: JSON.stringify(toolPack('小满')), updatedAt: now },
      { namespace: 'amsg:global', key: 'tool_config', value: JSON.stringify({ v: 1, proxyWorkerUrl: '', newsEnabled: false, notionEnabled: false, feishuEnabled: false }), updatedAt: now },
    ]);
    check('putClientState(fire_pack ~256KB + tool_pack + tool_config) 成功', true);

    const fireAt = new Date(now + 1000);
    const { payload, clientTaskId } = aiTaskPayload({
      charId: 'char-full', charName: '小满', mode: 'auto',
      firstSendTime: fireAt.toISOString(), recurrenceType: 'daily', expirePolicy: 'expire',
      anchorMs: now - 3600_000, // 锚点=1小时前的最后用户消息；fire_pack.lastUserMessageAt 同值 → 不作废
      taskInstruction: '这是一条需要 AI 自主生成的主动消息。\nTASK_SLOT_MARKER_FULL\n可选灵感补充：无',
      frozenPrompt: 'FROZEN_char-full 排程时冻结的完整 prompt（不应被用到）',
    });
    const sched = await scheduleTask(payload);
    check('schedule-message(auto/daily) 成功', sched?.success === true, JSON.stringify(sched?.error || sched));
    s3uuid = sched?.data?.uuid;
    const llmBefore = llmRequests.length;
    await sleep(1400);
    await runCron();

    const reqs = llmRequests.slice(llmBefore);
    check('工具循环共 2 轮 LLM 调用', reqs.length === 2, `got ${reqs.length}`);
    const r1c = reqs[0]?.messages?.map((m) => String(m.content)).join('\n') || '';
    check('第 1 轮 prompt 来自 fire_pack 现场渲染（非冻结 prompt）', r1c.includes('FIREPACK_FRESH_char-full') && !r1c.includes('FROZEN_char-full'));
    check('大值分块读回完整（256KB 填充尾标在）', r1c.includes('【填充结束FILLER_END】'));
    // ② 起时间槽是自然中文（与 buildCoreContext 同款）：2026年8月1日 周六 早晨 08:00
    check('时间槽位已在 fire 时刻填值（自然中文格式）',
      /当前本地时间：\d{4}年\d{1,2}月\d{1,2}日 周[日一二三四五六] (?:凌晨|早晨|上午|中午|下午|傍晚|晚上|深夜) \d{2}:\d{2}/.test(r1c)
      && !r1c.includes(SLOT_TIME));
    check('任务指令槽位从 task metadata 填入', r1c.includes('TASK_SLOT_MARKER_FULL') && !r1c.includes(SLOT_TASK));
    check('时间差文案按 fire 时刻现算（约 1 小时）', /距离用户上次主动发消息大约 1 小时/.test(r1c), r1c.match(/距离用户[^\n]*/)?.[0]);
    const r2msgs = reqs[1]?.messages || [];
    const toolMsg = r2msgs.find((m) => m.role === 'tool');
    check('第 2 轮带回 RECALL 工具结果（月度总结命中）', String(toolMsg?.content || '').includes('RECALL_MEMORY_MARKER'), String(toolMsg?.content || '').slice(0, 120));

    const mine = pushes.filter((p) => p.payload?.metadata?.charId === 'char-full');
    check('finish 后按行分段推送 3 条', mine.length === 3, `got ${mine.length}`);
    const [p1, , pLast] = [mine[0]?.payload, mine[1]?.payload, mine[mine.length - 1]?.payload];
    check('旁白（round-1 prefix）保序排在正文前', String(p1?.message || '').includes('翻翻记忆'), JSON.stringify(p1?.message));
    check('正文引用工具结果（跨轮上下文连续）', mine.some((m) => String(m.payload?.message || '').includes('烟花')));
    check('directives 只挂最后一条 push', !!pLast?.metadata?.directives?.length && mine.slice(0, -1).every((m) => !m.payload?.metadata?.directives));
    check('POKE 副作用被结构化为 directive', JSON.stringify(pLast?.metadata?.directives || []).toLowerCase().includes('poke'));
    check('正文不再含 [[ACTION:POKE]] 裸标签', mine.every((m) => !String(m.payload?.message || '').includes('[[ACTION:POKE]]')));
    check('每条 push 带 amsgOccurrenceMs = 本次触发时刻', mine.every((m) => m.payload?.metadata?.amsgOccurrenceMs === fireAt.getTime()),
      JSON.stringify(mine.map((m) => m.payload?.metadata?.amsgOccurrenceMs)));
    check('push 元数据带 amsgClientTaskId', mine.every((m) => m.payload?.metadata?.amsgClientTaskId === clientTaskId));
    check('通知横幅 body 为净化文本', mine.every((m) => typeof m.payload?.notification?.body === 'string' && !m.payload.notification.body.includes('[[')));
    check('messageIndex 1-based 连续编号', mine.map((m) => m.payload?.messageIndex).join(',') === '1,2,3' && mine.every((m) => m.payload?.totalMessages === 3));

    const listed = await listAllTasks();
    const row = listed.tasks.find((t) => t.uuid === s3uuid);
    check('daily 任务 fire 后仍在清单且 next_send_at +24h', !!row && Math.abs(new Date(row.nextSendAt).getTime() - (fireAt.getTime() + 24 * 3600_000)) < 1500,
      JSON.stringify({ nextSendAt: row?.nextSendAt, expect: new Date(fireAt.getTime() + 24 * 3600_000).toISOString() }));
    check('清单行仍带 charId/clientTaskId 投影', row?.charId === 'char-full' && row?.clientTaskId === clientTaskId);
    const cancel = await cancelTask(s3uuid);
    check('cancel-message 取消 daily 任务成功', cancel?.success === true, JSON.stringify(cancel));
    const after = await listAllTasks();
    check('取消后远端清单不再含该任务', !after.tasks.some((t) => t.uuid === s3uuid));
  }

  section('S4 锚点后有新用户消息 → 模型看到最新上下文并决定静默');
  {
    const now = Date.now();
    const anchor = now - 3600_000;
    const latestUserMessage = 'ANCHOR_LATEST_MESSAGE 我已经说完了，先不用回。';
    await putState([
      // 锚点前进不再硬作废：带最新对话进模型，让角色判断这次是否需要开口。
      { namespace: NS('char-anchor'), key: 'fire_pack', value: JSON.stringify(firePack('FIREPACK_FRESH_char-anchor', anchor + 60_000, { latestUserMessage })), updatedAt: now },
      { namespace: NS('char-anchor'), key: 'tool_pack', value: JSON.stringify(toolPack('小锚')), updatedAt: now },
    ]);
    const { payload } = aiTaskPayload({
      charId: 'char-anchor', charName: '小锚', mode: 'auto',
      firstSendTime: new Date(now + 1000).toISOString(), recurrenceType: 'none', expirePolicy: 'expire',
      anchorMs: anchor,
      taskInstruction: '看看最新对话，再决定现在是否需要开口。',
      frozenPrompt: 'FROZEN_char-anchor（不得使用排程时的旧上下文）',
    });
    const sched = await scheduleTask(payload);
    const uuid = sched?.data?.uuid;
    const llmBefore = llmRequests.length; const pushBefore = pushes.length;
    await sleep(1400);
    await runCron();
    const reqs = llmRequests.slice(llmBefore);
    const prompt = reqs[0]?.messages?.map((m) => String(m.content)).join('\n') || '';
    check('锚点前进仍调用一次模型，让角色决定是否开口', reqs.length === 1, `got ${reqs.length}`);
    check('模型拿到更新后的对话与 fire_pack，没有旧冻结上下文',
      prompt.includes(latestUserMessage) && prompt.includes('FIREPACK_FRESH_char-anchor') && !prompt.includes('FROZEN_char-anchor'));
    check('合法静默响应：零 push', pushes.length === pushBefore, `+${pushes.length - pushBefore}`);
    const listed = await listAllTasks();
    check('静默后一次性任务正常出清，不作为异常重试', !listed.tasks.some((t) => t.uuid === uuid));
  }

  section('S5a 活跃租约新鲜 → 先延期，回复结束并同步上下文后恢复');
  {
    const now = Date.now();
    await putState([
      { namespace: NS('char-presence'), key: 'chat_presence', value: JSON.stringify(presence('char-presence', now, now - 5000)), updatedAt: now },
    ]);
    const { payload } = aiTaskPayload({
      charId: 'char-presence', charName: '小租', mode: 'auto',
      firstSendTime: new Date(now + 1000).toISOString(), recurrenceType: 'none', expirePolicy: 'expire',
      anchorMs: now - 3600_000,
      taskInstruction: '等当前回复写完，再接着最新对话说。',
      frozenPrompt: 'FROZEN_char-presence（不得使用排程时的旧上下文）',
    });
    const sched = await scheduleTask(payload);
    const uuid = sched?.data?.uuid;
    const llmBefore = llmRequests.length; const pushBefore = pushes.length;
    await sleep(1400);
    const deferStartedAt = Date.now();
    await runCron();
    check('新鲜租约 → 零 LLM / 零 push', llmRequests.length === llmBefore && pushes.length === pushBefore,
      `llm+${llmRequests.length - llmBefore} push+${pushes.length - pushBefore}`);
    const listed = await listAllTasks();
    const deferred = d1.db.prepare('SELECT status, next_send_at, retry_after, retry_count FROM scheduled_messages WHERE uuid = ?').get(uuid);
    const retryAt = Date.parse(deferred?.retry_after);
    check('延期后任务仍待发送，未消耗失败重试额度',
      listed.tasks.some((t) => t.uuid === uuid) && deferred?.status === 'pending' && deferred?.retry_count === 0,
      JSON.stringify(deferred));
    check('延期 45 秒且保留原始触发时刻',
      retryAt >= deferStartedAt + 45_000 && retryAt <= Date.now() + 45_000
      && deferred?.next_send_at === payload.firstSendTime, JSON.stringify(deferred));

    const resumeAt = retryAt + 1000;
    const latestUserMessage = 'PRESENCE_REPLY_FINISHED 刚才那轮已经聊完了。';
    await withClockAt(resumeAt, async () => {
      await putState([
        { namespace: NS('char-presence'), key: 'chat_presence', value: JSON.stringify(presence('char-presence', now - 120_000, now - 5000)), updatedAt: resumeAt },
        { namespace: NS('char-presence'), key: 'fire_pack', value: JSON.stringify(firePack('FIREPACK_FRESH_char-presence', now - 5000, { latestUserMessage })), updatedAt: resumeAt },
        { namespace: NS('char-presence'), key: 'tool_pack', value: JSON.stringify(toolPack('小租')), updatedAt: resumeAt },
      ]);
      await runCron();
    });
    const reqs = llmRequests.slice(llmBefore);
    const prompt = reqs[0]?.messages?.map((m) => String(m.content)).join('\n') || '';
    check('租约结束后恢复生成，读到回复完成后的最新上下文',
      reqs.length === 1 && prompt.includes(latestUserMessage) && !prompt.includes('FROZEN_char-presence'), `got ${reqs.length}`);
    const mine = pushes.slice(pushBefore).filter((p) => p.payload?.metadata?.charId === 'char-presence');
    check('恢复后正常投递，仍沿用原始触发身份',
      mine.length > 0 && mine.some((p) => String(p.payload?.message || '').includes('上一轮已经聊完'))
      && mine.every((p) => p.payload?.metadata?.amsgOccurrenceMs === Date.parse(payload.firstSendTime)), JSON.stringify(mine));
    const afterResume = await listAllTasks();
    check('恢复投递后一次性任务出清', !afterResume.tasks.some((t) => t.uuid === uuid));
  }

  section('S5b 租约过期 + 无 fire_pack → 抛 AMSG2_FIRE_STATE_MISSING（不降级）');
  {
    const now = Date.now();
    await putState([
      // 过期租约（2 分钟前）不拦；该角色没有 fire_pack → 云端状态不全，onBeforeFire 直接抛错。
      // 任务体里那份冻结 prompt 是排程那一刻的上下文，发出去用户根本看不出它是旧的——
      // 宁可这次不发（走投递失败路径重试），也不拿它顶包。
      { namespace: NS('char-frozen'), key: 'chat_presence', value: JSON.stringify(presence('char-frozen', now - 120_000, now - 120_000)), updatedAt: now },
    ]);
    const { payload } = aiTaskPayload({
      charId: 'char-frozen', charName: '小冻', mode: 'auto',
      firstSendTime: new Date(now + 1000).toISOString(), recurrenceType: 'none', expirePolicy: 'expire',
      anchorMs: now - 3600_000,
      taskInstruction: '（状态缺失场景不应进入 LLM）',
      frozenPrompt: 'FROZEN_char-frozen 排程时冻结的完整 prompt，不该再被任何路径吃到。',
    });
    const sched = await scheduleTask(payload);
    const uuid = sched?.data?.uuid;
    const llmBefore = llmRequests.length; const pushBefore = pushes.length;
    await sleep(1400);
    await runCron();
    const reqs = llmRequests.slice(llmBefore);
    check('状态缺失 → 零 LLM 调用（不吃冻结 prompt）', reqs.length === 0, `reqs=${reqs.length}`);
    const mine = pushes.slice(pushBefore).filter((p) => p.payload?.metadata?.charId === 'char-frozen');
    check('状态缺失 → 零 push', mine.length === 0, JSON.stringify(mine.map((m) => m.payload?.message)));
    const listed = await listAllTasks();
    check('任务不被当成发完出清（留在远端等重试）', listed.tasks.some((t) => t.uuid === uuid));
  }

  section('S5c fire_pack 缺 tzId → 整包按格式不对打回（tzId 必填，没有第二套时间算法）');
  {
    const now = Date.now();
    const { tzId: _tz, ...packNoTz } = firePack('FIREPACK_NOTZ_char-no-tz', now);
    await putState([
      { namespace: NS('char-no-tz'), key: 'fire_pack', value: JSON.stringify(packNoTz), updatedAt: now },
      { namespace: NS('char-no-tz'), key: 'tool_pack', value: JSON.stringify(toolPack('小无')), updatedAt: now },
    ]);
    const { payload } = aiTaskPayload({
      charId: 'char-no-tz', charName: '小无', mode: 'auto',
      firstSendTime: new Date(now + 1000).toISOString(), recurrenceType: 'none', expirePolicy: 'force',
      anchorMs: now - 3600_000,
      taskInstruction: '（缺 tzId 场景不应进入 LLM）',
      frozenPrompt: 'FROZEN_char-no-tz（不应被用到）',
    });
    const sched = await scheduleTask(payload);
    const uuid = sched?.data?.uuid;
    const llmBefore = llmRequests.length; const pushBefore = pushes.length;
    await sleep(1400);
    await runCron();
    check('缺 tzId → 零 LLM 调用（parse 失败走 fire-state 错误路径）',
      llmRequests.length === llmBefore, `llm+${llmRequests.length - llmBefore}`);
    const mine = pushes.slice(pushBefore).filter((p) => p.payload?.metadata?.charId === 'char-no-tz');
    check('缺 tzId → 零 push', mine.length === 0, JSON.stringify(mine.map((m) => m.payload?.message)));
    const listed = await listAllTasks();
    check('缺 tzId 的任务留在远端等重试（不静默出清）', listed.tasks.some((t) => t.uuid === uuid));
  }

  section('S6 force 策略：新鲜租约 + 锚点已前进也照发（闹钟语义）');
  {
    const now = Date.now();
    await putState([
      { namespace: NS('char-force'), key: 'chat_presence', value: JSON.stringify(presence('char-force', now, now)), updatedAt: now },
      { namespace: NS('char-force'), key: 'fire_pack', value: JSON.stringify(firePack('FIREPACK_FRESH_char-force', now)), updatedAt: now },
      // tool_pack 与 fire_pack 同批上传，缺一样就是状态异常（worker 直接抛错）。
      // 这节测的是 force 绕开闸，状态得给齐，别把断言挂在别的原因上。
      { namespace: NS('char-force'), key: 'tool_pack', value: JSON.stringify(toolPack('小强')), updatedAt: now },
    ]);
    const { payload } = aiTaskPayload({
      charId: 'char-force', charName: '小强', mode: 'auto',
      firstSendTime: new Date(now + 1000).toISOString(), recurrenceType: 'none', expirePolicy: 'force',
      anchorMs: now - 3600_000,
      taskInstruction: 'FORCE_TASK_MARKER 到点必须叫用户',
      frozenPrompt: 'FROZEN_char-force（不应被用到）',
    });
    const sched = await scheduleTask(payload);
    const uuid = sched?.data?.uuid;
    const llmBefore = llmRequests.length; const pushBefore = pushes.length;
    await sleep(1400);
    await runCron();
    const reqs = llmRequests.slice(llmBefore);
    check('force：照走满血链路（fire_pack 渲染 + 任务槽）', reqs.length === 1 && JSON.stringify(reqs[0]).includes('FIREPACK_FRESH_char-force') && JSON.stringify(reqs[0]).includes('FORCE_TASK_MARKER'), `reqs=${reqs.length}`);
    const mine = pushes.slice(pushBefore).filter((p) => p.payload?.metadata?.charId === 'char-force');
    check('force：push 送达', mine.length >= 1 && String(mine[0]?.payload?.message || '').includes('照发'));
    const listed = await listAllTasks();
    check('force 任务发完出清', !listed.tasks.some((t) => t.uuid === uuid));
  }

  section('S6b 旧旁路存储：客户端读回 + 删除整行');
  {
    // worker 把装不下一条 push 的 XHS 会话数据写进 client_state、push 只带引用键，
    // 客户端上线后按键取回再删。这里验的就是取回和删除这两步——它们走的是 HTTP
    // GET/PUT /client-state，跟 hook 的 writeState 是同一张表，两边必须真的通。
    const ns = NS('char-offload');
    const key = 'xhs_session:task-offload-1';
    const value = JSON.stringify({
      notes: [{ idx: 1, note: { noteId: 'note-1', title: '旁路笔记', desc: '描述', likes: 1, author: 'a', authorId: 'a1' } }],
      xsecTokens: [['note-1', 'tok-1']],
    });
    await putState([{ namespace: ns, key, value, updatedAt: Date.now() }]);

    const read = await client.getClientState(ns);
    const hit = (read?.data?.entries || []).find((e) => e.key === key);
    check('按 namespace + key 读回旁路存储，内容逐字一致', hit?.value === value, JSON.stringify(hit?.value || read));

    // HTTP 与 hook 现在共用 value:null 删除语义；空串仍是有效值，不能当作删行。
    await client.putClientState([{ namespace: ns, key, value: null, updatedAt: Date.now() }]);
    const afterNull = await client.getClientState(ns);
    const afterDelete = (afterNull?.data?.entries || []).find((e) => e.key === key);
    check('HTTP PUT value:null 删除整行', afterDelete === undefined, JSON.stringify(afterDelete));

    await client.putClientState([{ namespace: ns, key, value: '', updatedAt: Date.now() }]);
    const afterClear = await client.getClientState(ns);
    const cleared = (afterClear?.data?.entries || []).find((e) => e.key === key);
    check('写空串保留一条空值记录，与删除语义区分', cleared !== undefined && cleared.value === '', JSON.stringify(cleared));
  }

  section('S7 clear-client-state（设置页「清除云端状态」）');
  {
    const r = await client.clearClientState();
    check('clearClientState 成功且删除了条目', r?.success === true && (r?.data?.deleted ?? 0) > 0, JSON.stringify(r));
  }

  // S8 / S8b 共用全局 namespace 的那行 tool_config（后者覆盖前者），必须顺序跑；
  // 跑完这两段它就停在「带 MCP 配置」的版本，后面再加场景要自己重写这一行。
  section('S8 通用 MCP · native：tools 声明 → 真连服务器 → 结果回喂 → 暗号进 push');
  {
    const now = Date.now();
    await putState([
      { namespace: NS('char-mcp-native'), key: 'fire_pack', value: JSON.stringify(firePack('FIREPACK_FRESH_char-mcp-native', now - 3600_000)), updatedAt: now },
      { namespace: NS('char-mcp-native'), key: 'tool_pack', value: JSON.stringify(toolPack('小满')), updatedAt: now },
      { namespace: 'amsg:global', key: 'tool_config', value: MCP_TOOL_CONFIG(true), updatedAt: now },
    ]);
    const { payload } = aiTaskPayload({
      charId: 'char-mcp-native', charName: '小满', mode: 'auto',
      firstSendTime: new Date(now + 1000).toISOString(), recurrenceType: 'none', expirePolicy: 'expire',
      anchorMs: now - 3600_000,
      taskInstruction: '问一下今天的暗号，然后告诉用户。',
      frozenPrompt: 'FROZEN_char-mcp-native（不应被用到）',
    });
    const sched = await scheduleTask(payload);
    check('schedule-message(MCP native) 成功', sched?.success === true, JSON.stringify(sched?.error || sched));
    const llmBefore = llmRequests.length; const pushBefore = pushes.length; const mcpBefore = mcpSeen.length;
    await sleep(1400);
    await runCron();

    const reqs = llmRequests.slice(llmBefore);
    check('native：工具循环共 2 轮 LLM 调用', reqs.length === 2, `got ${reqs.length}`);
    const declared = Array.isArray(reqs[0]?.tools) ? reqs[0].tools.map((t) => t?.function?.name) : null;
    check('第 1 轮请求体声明了 mcp__ 工具（native tools 数组）',
      Array.isArray(reqs[0]?.tools) && declared.includes('mcp__get_secret_word'), JSON.stringify(declared));
    const r1c = reqs[0]?.messages?.map((m) => String(m.content)).join('\n') || '';
    check('提示词尾部带 MCP 工具块（列出工具与说明）',
      r1c.includes('【外部工具') && r1c.includes('- get_secret_word：取回今日暗号'), r1c.slice(-300));
    check('native 模式不教正文调用协议（教了反而勾引模型往正文写）',
      !r1c.includes('tool_name({"参数":"值"})') && !r1c.includes('get_secret_word('), r1c.slice(-300));
    const mcpCalls = mcpSeen.slice(mcpBefore);
    check('worker 真连了 MCP 服务器（initialize + tools/call）',
      mcpCalls.includes('initialize') && mcpCalls.includes('tools/call'), JSON.stringify(mcpCalls));

    const r2msgs = reqs[1]?.messages || [];
    const assistant = r2msgs.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
    check('第 2 轮 assistant 消息原样带回 native tool_calls',
      assistant?.tool_calls?.[0]?.id === 'call_mcp_1'
      && assistant?.tool_calls?.[0]?.function?.name === 'mcp__get_secret_word',
      JSON.stringify(assistant?.tool_calls));
    const toolMsg = r2msgs.find((m) => m.role === 'tool');
    check('tool 消息与 assistant 的 tool_call id 配对', toolMsg?.tool_call_id === 'call_mcp_1', JSON.stringify(toolMsg?.tool_call_id));
    const toolText = String(toolMsg?.content || '');
    check('工具结果按暗号原文回喂', toolText.includes(MCP_PASSPHRASE), toolText.slice(0, 160));
    check('回喂措辞可读，且不漏 mcp__ 内部前缀',
      toolText.includes('调用「get_secret_word」') && !toolText.includes('mcp__'), toolText.slice(0, 160));

    const mine = pushes.slice(pushBefore).filter((p) => p.payload?.metadata?.charId === 'char-mcp-native');
    check('native：push 带回暗号', mine.some((m) => String(m.payload?.message || '').includes(MCP_PASSPHRASE)),
      JSON.stringify(mine.map((m) => m.payload?.message)));
    check('native：旁白保序排在正文前', String(mine[0]?.payload?.message || '').includes('问问那边'), JSON.stringify(mine[0]?.payload?.message));
    check('native：正文无工具调用语法残留', mine.every((m) => !String(m.payload?.message || '').includes('get_secret_word(')));
  }

  section('S8b 通用 MCP · 正文兜底：中转拒 tools → 提示词教协议 → 正文调用被识别');
  {
    const now = Date.now();
    await putState([
      { namespace: NS('char-mcp-text'), key: 'fire_pack', value: JSON.stringify(firePack('FIREPACK_FRESH_char-mcp-text', now - 3600_000)), updatedAt: now },
      { namespace: NS('char-mcp-text'), key: 'tool_pack', value: JSON.stringify(toolPack('小满')), updatedAt: now },
      { namespace: 'amsg:global', key: 'tool_config', value: MCP_TOOL_CONFIG(false), updatedAt: now },
    ]);
    const { payload } = aiTaskPayload({
      charId: 'char-mcp-text', charName: '小满', mode: 'auto',
      firstSendTime: new Date(now + 1000).toISOString(), recurrenceType: 'none', expirePolicy: 'expire',
      anchorMs: now - 3600_000,
      taskInstruction: '问一下今天的暗号，然后告诉用户。',
      frozenPrompt: 'FROZEN_char-mcp-text（不应被用到）',
    });
    const sched = await scheduleTask(payload);
    check('schedule-message(MCP 正文兜底) 成功', sched?.success === true, JSON.stringify(sched?.error || sched));
    const llmBefore = llmRequests.length; const pushBefore = pushes.length; const mcpBefore = mcpSeen.length;
    await sleep(1400);
    await runCron();

    const reqs = llmRequests.slice(llmBefore);
    check('正文兜底：工具循环共 2 轮 LLM 调用', reqs.length === 2, `got ${reqs.length}`);
    check('两轮请求体都不带 tools 参数（中转拒 tools 的场景）',
      reqs.every((r) => !('tools' in r)), JSON.stringify(reqs.map((r) => Object.keys(r))));
    const r1c = reqs[0]?.messages?.map((m) => String(m.content)).join('\n') || '';
    check('提示词改教正文调用协议（带参数签名与写法示例）',
      r1c.includes('- get_secret_word(asked_by:string)：取回今日暗号') && r1c.includes('tool_name({"参数":"值"})'),
      r1c.slice(-300));
    const mcpCalls = mcpSeen.slice(mcpBefore);
    check('正文里的调用被识别并真跑到了 MCP 服务器',
      mcpCalls.includes('initialize') && mcpCalls.includes('tools/call'), JSON.stringify(mcpCalls));
    const toolText = String((reqs[1]?.messages || []).find((m) => m.role === 'tool')?.content || '');
    check('正文兜底：工具结果按暗号原文回喂', toolText.includes(MCP_PASSPHRASE), toolText.slice(0, 160));

    const mine = pushes.slice(pushBefore).filter((p) => p.payload?.metadata?.charId === 'char-mcp-text');
    check('正文兜底：push 带回暗号', mine.some((m) => String(m.payload?.message || '').includes(MCP_PASSPHRASE)),
      JSON.stringify(mine.map((m) => m.payload?.message)));
    check('正文兜底：调用语法被剥掉，不进 push',
      mine.length > 0 && mine.every((m) => !String(m.payload?.message || '').includes('get_secret_word(')),
      JSON.stringify(mine.map((m) => m.payload?.message)));
  }

  section('S9 自排链：角色到点给自己排下一条，下一条接得上（用户全程不上线）');
  {
    const ns = NS('char-chain');
    const t0 = Date.now();
    const builtAt = t0 - 120_000;   // 客户端两分钟前聊完那一轮打的包
    const readSelfLog = async () => {
      const read = await client.getClientState(ns);
      const hit = (read?.data?.entries || []).find((e) => e.key === 'self_log');
      if (!hit?.value) return null;
      try { return JSON.parse(hit.value); } catch { return { parseError: hit.value }; }
    };
    const taskRecord = (over) => ({
      mode: 'auto', recurrenceType: 'none', expirePolicy: 'expire',
      anchorLastUserMsgAt: t0 - 3600_000, source: 'user', status: 'scheduled', createdAt: builtAt, ...over,
    });
    const promptsOf = (from) => llmRequests.slice(from)
      .map((r) => r.messages.map((m) => String(m.content)).join('\n')).join('\n');

    // ── 第一次触发：角色一边说话一边给自己排下一条 ──
    const fire1 = new Date(t0 + 1000);
    const first = aiTaskPayload({
      charId: 'char-chain', charName: '小链', mode: 'auto',
      firstSendTime: fire1.toISOString(), recurrenceType: 'none', expirePolicy: 'expire',
      anchorMs: t0 - 3600_000,
      taskInstruction: '第一条：随口给用户留个口令。',
      frozenPrompt: 'FROZEN_char-chain（不应被用到）',
    });
    const sched1 = await scheduleTask(first.payload);
    check('schedule-message(自排链·第一条) 成功', sched1?.success === true, JSON.stringify(sched1?.error || sched1));

    // 任务列表以服务端实况为准；另一条必须真排到云端，不能只塞进客户端快照。
    const other = aiTaskPayload({
      charId: 'char-chain', charName: '小链', mode: 'auto',
      firstSendTime: new Date(t0 + 3600_000).toISOString(), recurrenceType: 'none', expirePolicy: 'expire',
      anchorMs: t0 - 3600_000, taskInstruction: '另一条尚未到点的任务', frozenPrompt: 'FROZEN_char-chain',
    });
    const otherScheduled = await scheduleTask(other.payload);
    const otherTask = taskRecord({
      taskUuid: otherScheduled.data.uuid, clientTaskId: other.clientTaskId,
      firstSendTime: new Date(t0 + 3600_000).toISOString(),
    });
    const firingTask = taskRecord({
      taskUuid: sched1?.data?.uuid, clientTaskId: first.clientTaskId, firstSendTime: fire1.toISOString(),
    });
    await putState([
      { namespace: ns, key: 'fire_pack', value: JSON.stringify(firePack('FIREPACK_FRESH_char-chain', t0 - 3600_000, { builtAt, pendingTasks: [otherTask, firingTask] })), updatedAt: t0 },
      { namespace: ns, key: 'tool_pack', value: JSON.stringify(toolPack('小链')), updatedAt: t0 },
      // S8/S8b 把全局那行换成带 MCP 的版本了，这里换回无工具版——本场景只测自排链
      { namespace: 'amsg:global', key: 'tool_config', value: JSON.stringify({ v: 1, proxyWorkerUrl: '', newsEnabled: false, notionEnabled: false, feishuEnabled: false }), updatedAt: t0 },
    ]);

    let llmBefore = llmRequests.length;
    let pushBefore = pushes.length;
    await sleep(1400);
    await runCron();

    const reqs = llmRequests.slice(llmBefore);
    check('第一次触发跑了三轮（排程被打回 → 改口重排 → 写正文）', reqs.length === 3, `got ${reqs.length}`);
    const p1 = reqs[0]?.messages?.map((m) => String(m.content)).join('\n') || '';
    const declared = Array.isArray(reqs[0]?.tools) ? reqs[0].tools.map((t) => t?.function?.name) : null;
    check('请求里声明了 schedule_active_message（角色手上真有这个工具）',
      !!declared?.includes('schedule_active_message'), JSON.stringify(declared));
    check('提示词带「你可以给自己排下一条」说明块', p1.includes('【你可以给自己排下一条】'), p1.slice(-400));
    check('第一次没有自述段（云端还没日志）', !p1.includes(SELF_LOG_HEADING));
    check('空日志时槽位被抹平，不裸露给模型', !p1.includes(SLOT_SELF_LOG));
    check('排程清单块列出另一条实际挂着的任务', p1.includes(TASK_LIST_HEADING) && p1.includes(`[${otherTask.taskUuid.slice(0, 8)}]`),
      p1.slice(p1.indexOf(TASK_LIST_HEADING), p1.indexOf(TASK_LIST_HEADING) + 200));
    check('排程清单块摘掉正在发的这一条（否则角色以为还要再排一次）',
      !p1.includes(`[${String(sched1?.data?.uuid).slice(0, 8)}]`));

    const fb1 = String((reqs[1]?.messages || []).find((m) => m.role === 'tool')?.content || '');
    check('时间写太近被打回，回喂一句能照做的话（不让整条 fire 失败）',
      fb1.includes('send_at_too_soon') && fb1.includes('至少要比现在晚 1 分钟'), fb1.slice(0, 200));
    const fb2 = String((reqs[2]?.messages || []).filter((m) => m.role === 'tool').pop()?.content || '');
    check('改口后排上了（回喂 ok:true + 任务号）',
      fb2.includes('"ok":true') && fb2.includes('排好了'), fb2.slice(0, 200));

    const mine1 = pushes.slice(pushBefore).filter((p) => p.payload?.metadata?.charId === 'char-chain');
    const text1 = mine1.map((m) => String(m.payload?.message || '')).join('\n');
    check('第一条 push 带上口令', text1.includes('CHAIN-PASS-8823'), text1);
    const selfScheduled = mine1[mine1.length - 1]?.payload?.metadata?.amsgSelfScheduled;
    check('自排的任务随最后一条 push 带回客户端认领',
      Array.isArray(selfScheduled) && selfScheduled.length === 1, JSON.stringify(selfScheduled));
    check('只挂最后一条（收侧 isLastChunk 保证只重放一次）',
      mine1.slice(0, -1).every((m) => !m.payload?.metadata?.amsgSelfScheduled));
    const selfTask = selfScheduled?.[0];
    check('带回的记录标着来源是角色自己排的', selfTask?.source === 'character' && selfTask?.mode === 'prompted',
      JSON.stringify(selfTask));
    // 当前 ID 在原身份前加 FNV-1a32 摘要，让清单前 8 位短号能区分不同任务。
    // 独立按协议计算完整预期值；仍精确比较，不用后缀匹配放过错误摘要。
    const idSeed = `char-chain|${fire1.getTime()}|0`;
    const idDigest = [...idSeed].reduce((hash, char) =>
      BigInt.asUintN(32, (hash ^ BigInt(char.charCodeAt(0))) * 16777619n), 2166136261n);
    const expectedUuid = `${idDigest.toString(16).padStart(8, '0')}-amsgself-char-chain-${fire1.getTime()}-0`;
    check('任务 uuid 精确包含稳定摘要、角色、触发时刻与序号（重跑不会多排）',
      selfTask?.taskUuid === expectedUuid, JSON.stringify({ got: selfTask?.taskUuid, want: expectedUuid }));

    const listedAfter1 = await listAllTasks();
    const bRow = listedAfter1.tasks.find((t) => t.uuid === selfTask?.taskUuid);
    check('自排的任务真在远端建了行（不依赖客户端在线）', !!bRow, JSON.stringify(listedAfter1.tasks.map((t) => t.uuid)));
    check('远端行投影 charId / clientTaskId（面板列得出、用户也能取消）',
      bRow?.charId === 'char-chain' && bRow?.clientTaskId === selfTask?.clientTaskId, JSON.stringify(bRow));
    const wantMs = new Date(selfTask?.firstSendTime).getTime();
    check('远端行的触发时刻 = 角色要的那个时间', !!bRow && new Date(bRow.nextSendAt).getTime() === wantMs,
      JSON.stringify({ got: bRow?.nextSendAt, want: selfTask?.firstSendTime }));
    check('角色要的是 15 分钟后（满足默认 10 分钟间隔）', Math.abs(wantMs - (Date.now() + 15 * 60_000)) < 5000,
      `差 ${Math.round((wantMs - Date.now()) / 1000)}s`);

    const log1 = await readSelfLog();
    check('发完把正文写回云端（v4，1 条）', log1?.v === 4 && log1?.entries?.length === 1, JSON.stringify(log1?.entries));
    check('日志锚在这份 fire_pack 的 builtAt 上', log1?.basePackAt === builtAt,
      JSON.stringify({ got: log1?.basePackAt, want: builtAt }));
    check('记的就是刚发出去那条正文（含口令）',
      String(log1?.entries?.[0]?.text || '').includes('CHAIN-PASS-8823'), JSON.stringify(log1?.entries?.[0]));
    // ⑥ 起 at 记的是**实际发送时刻**（onAfterSend 里取的 now），不再是名义 occurrenceMs；
    // 去重仍靠 id = clientTaskId@occurrenceMs，重试不会记成两条。
    check('时间戳是实际发送时刻（≥ 名义时刻、在本轮 cron 的合理窗口内）',
      typeof log1?.entries?.[0]?.at === 'number'
      && log1.entries[0].at >= fire1.getTime()
      && log1.entries[0].at <= Date.now(),
      JSON.stringify({ got: log1?.entries?.[0]?.at, nominal: fire1.getTime(), now: Date.now() }));
    check('去重 id 仍锚在名义时刻上（clientTaskId@occurrenceMs）',
      String(log1?.entries?.[0]?.id || '').endsWith(`@${fire1.getTime()}`),
      JSON.stringify(log1?.entries?.[0]?.id));
    check('自排的任务也记进日志（客户端没认领之前，下次到点仍看得见）',
      log1?.tasks?.length === 1 && log1.tasks[0].taskUuid === selfTask?.taskUuid, JSON.stringify(log1?.tasks));

    // 推进测试时钟到原定时间，保留任务行和默认间隔，客户端也不认领这条任务。
    llmBefore = llmRequests.length;
    pushBefore = pushes.length;
    await withClockAt(wantMs + 1000, runCron);

    const reqs2 = llmRequests.slice(llmBefore);
    check('第二次到点自动触发（用户全程没上线）', reqs2.length === 1, `got ${reqs2.length}`);
    const p2 = promptsOf(llmBefore);
    check('第二次 prompt 出现自述段', p2.includes(SELF_LOG_HEADING), p2.slice(0, 300));
    check('自述段里是第一条的原话（口令读得回来）', p2.includes('CHAIN-PASS-8823'));
    check('自述段落在对话记录之后、本次任务之前（读起来是一条时间线）',
      p2.indexOf(SELF_LOG_HEADING) > p2.indexOf('【最近对话上下文】')
      && p2.indexOf(SELF_LOG_HEADING) < p2.indexOf('【本次任务】'));
    check('本次任务指令是角色自己当初写的方向', p2.includes('接着口令那件事往下说'),
      p2.slice(p2.indexOf('【本次任务】'), p2.indexOf('【本次任务】') + 200));
    check('排程清单不再列正在发的这条自排任务',
      !p2.includes(`[${String(selfTask?.taskUuid).slice(0, 8)}]`));

    const mine2 = pushes.slice(pushBefore).filter((p) => p.payload?.metadata?.charId === 'char-chain');
    const text2 = mine2.map((m) => String(m.payload?.message || '')).join('\n');
    check('第二条 push 接着上一条说（复述了自己留的口令）',
      text2.includes('CHAIN-PASS-8823') && text2.includes('没忘'), text2);
    check('第二条 push 的触发时刻 = 角色原先排定的时刻',
      mine2.length > 0 && mine2.every((m) => m.payload?.metadata?.amsgOccurrenceMs === wantMs),
      JSON.stringify(mine2.map((m) => m.payload?.metadata?.amsgOccurrenceMs)));

    const log2 = await readSelfLog();
    check('两次触发各记一笔（累计 2 条，同一份日志）',
      log2?.entries?.length === 2 && log2?.basePackAt === builtAt,
      JSON.stringify(log2?.entries?.map((e) => e.text)));
    const listedAfter2 = await listAllTasks();
    check('自排的一次性任务发完出清', !listedAfter2.tasks.some((t) => t.uuid === selfTask?.taskUuid));
  }
} catch (e) {
  failures++;
  console.error('\n💥 harness 异常中止：', e && e.stack || e);
} finally {
  server.close();
  mcpServer.close();
}

console.log(`\n═══ 结果：${results.filter((r) => r.ok).length}/${results.length} 通过，${failures} 失败 ═══`);
process.exit(failures ? 1 : 0);
