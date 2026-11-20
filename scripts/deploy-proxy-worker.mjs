#!/usr/bin/env node
/**
 * 将主代理 worker/index.js 安全同步到 Cloudflare Workers（默认对应 proxy.friedsully.com / sully-n）。
 *
 * 安全护栏：
 *   1. 只更新已存在的目标 Worker：先遍历当前 Token 可见的全部账号，通过自定义域名绑定
 *      （proxy.friedsully.com）或既有脚本设置（sully-n / sully-proxy）定位目标；找不到时绝不新建孤儿 Worker。
 *   2. 走 Cloudflare Script Upload API（PUT /accounts/:id/workers/scripts/:name）并携带
 *      keep_bindings: ['secret_text', 'secret_key', 'plain_text']，只替换脚本正文，保留面板已有的环境变量、
 *      密钥、自定义域名与路由绑定。
 *   3. 日志只输出脱敏账号前缀与状态码，不打印任何凭据或环境变量值。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CF_API = 'https://api.cloudflare.com/client/v4';
const TARGET_DOMAIN = (process.env.PROXY_CUSTOM_DOMAIN || 'proxy.friedsully.com').trim().toLowerCase();
const DEFAULT_KNOWN_ACCOUNT_ID = '2cd975a0e2a9d667b85119c456d9478f';

const token = (process.env.PROXY_CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || '').trim();
if (!token) {
  console.log('未配置 PROXY_CF_API_TOKEN 或 CLOUDFLARE_API_TOKEN，跳过主代理部署。');
  process.exit(0);
}

const maskId = (id) => {
  const s = String(id || '');
  return s.length <= 10 ? '***' : `${s.slice(0, 4)}...${s.slice(-4)}`;
};

async function cfFetch(path, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(`${CF_API}${path}`, { ...init, headers });
  const json = await res.json().catch(() => null);
  return {
    ok: res.ok && Boolean(json?.success),
    status: res.status,
    result: json?.result,
    errors: Array.isArray(json?.errors)
      ? json.errors.map((e) => `${e.code ?? ''}:${e.message ?? ''}`).join('; ')
      : `HTTP ${res.status}`,
  };
}

async function collectCandidateAccounts() {
  const ids = new Set();
  const explicit = (process.env.PROXY_CF_ACCOUNT_ID || '').trim();
  if (explicit) ids.add(explicit);

  const listed = await cfFetch('/accounts?per_page=50');
  if (listed.ok && Array.isArray(listed.result)) {
    for (const acc of listed.result) {
      if (acc?.id) ids.add(String(acc.id));
    }
    console.log(`Token 可读取账号列表数量: ${listed.result.length}`);
  } else {
    console.log(`读取 /accounts 未返回列表 (${listed.errors})，回退使用已知账号 ID 探测。`);
  }

  if (DEFAULT_KNOWN_ACCOUNT_ID) ids.add(DEFAULT_KNOWN_ACCOUNT_ID);
  return [...ids];
}

async function locateExistingProxyWorker(accountIds) {
  const explicitScript = (process.env.PROXY_CF_SCRIPT_NAME || '').trim();
  const candidateNames = [...new Set([explicitScript, 'sully-n', 'sully-proxy'].filter(Boolean))];

  // 第一优先级：直接按自定义域名 proxy.friedsully.com 反查绑定的账号与脚本名，零猜测
  for (const accountId of accountIds) {
    const domRes = await cfFetch(`/accounts/${accountId}/workers/domains`);
    if (domRes.ok && Array.isArray(domRes.result)) {
      const hit = domRes.result.find(
        (d) => String(d?.hostname || '').toLowerCase() === TARGET_DOMAIN && d?.service,
      );
      if (hit) {
        const settings = await cfFetch(
          `/accounts/${accountId}/workers/scripts/${encodeURIComponent(hit.service)}/settings`,
        );
        if (settings.ok) {
          console.log(`已在账号 ${maskId(accountId)} 通过域名 ${TARGET_DOMAIN} 定位到脚本 "${hit.service}"`);
          return { accountId, scriptName: String(hit.service), settings: settings.result, matchedBy: 'domain' };
        }
      }
    }
  }

  // 第二优先级：某些受限 Token 没勾 Workers Domains Read，按脚本名查既有 settings
  for (const accountId of accountIds) {
    for (const name of candidateNames) {
      const settings = await cfFetch(
        `/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}/settings`,
      );
      if (settings.ok) {
        console.log(`已在账号 ${maskId(accountId)} 找到既有脚本 "${name}"`);
        return { accountId, scriptName: name, settings: settings.result, matchedBy: 'script_name' };
      } else {
        console.log(`探测账号 ${maskId(accountId)} 脚本 "${name}": 未命中 (${settings.errors})`);
      }
    }
  }

  return null;
}

const accountIds = await collectCandidateAccounts();
const mode = (process.env.PROXY_DEPLOY_MODE || 'deploy').trim().toLowerCase();

if (mode === 'list') {
  for (const accountId of accountIds) {
    console.log(`=== Account ${maskId(accountId)} ===`);
    const scriptsRes = await cfFetch(`/accounts/${accountId}/workers/scripts`);
    if (scriptsRes.ok && Array.isArray(scriptsRes.result)) {
      console.log(`Workers (${scriptsRes.result.length}):`);
      for (const s of scriptsRes.result) {
        console.log(`  - ${s.id} (created: ${s.created_on || 'n/a'}, modified: ${s.modified_on || 'n/a'})`);
      }
    } else {
      console.log(`Workers list unavailable: ${scriptsRes.errors}`);
    }

    const domRes = await cfFetch(`/accounts/${accountId}/workers/domains`);
    if (domRes.ok && Array.isArray(domRes.result)) {
      console.log(`Custom Domains (${domRes.result.length}):`);
      for (const d of domRes.result) {
        console.log(`  - ${d.hostname} -> ${d.service} (${d.environment || 'production'})`);
      }
    } else {
      console.log(`Custom Domains unavailable: ${domRes.errors}`);
    }

    const d1Res = await cfFetch(`/accounts/${accountId}/d1/database`);
    if (d1Res.ok && Array.isArray(d1Res.result)) {
      console.log(`D1 Databases (${d1Res.result.length}):`);
      for (const db of d1Res.result) {
        console.log(`  - ${db.name} (created: ${db.created_at || 'n/a'})`);
      }
    } else {
      console.log(`D1 list unavailable: ${d1Res.errors}`);
    }
  }
  process.exit(0);
}

const located = await locateExistingProxyWorker(accountIds);

if (!located) {
  console.log(
    `在当前 Token 可访问的 ${accountIds.length} 个候选账号中均未找到 ${TARGET_DOMAIN} 或 sully-n / sully-proxy，` +
      '为避免在错误账号下新建孤儿 Worker，已安全停止。如需跨账号部署，请配置 PROXY_CF_API_TOKEN。',
  );
  process.exit(0);
}

const codePath = resolve(process.cwd(), 'worker/index.js');
const code = readFileSync(codePath, 'utf8');
if (code.length < 20_000) {
  throw new Error(`worker/index.js 体积异常 (${code.length} bytes)，中止上传`);
}

// 保留除 secret_text / secret_key / plain_text 外已在 settings 中声明的资源绑定（KV / D1 / R2 等），
// 同时用 keep_bindings 让服务端原样保留全部既有密钥和明文环境变量。
const preservedResourceBindings = Array.isArray(located.settings?.bindings)
  ? located.settings.bindings.filter(
      (b) => b && !['secret_text', 'secret_key', 'plain_text'].includes(b.type),
    )
  : [];

const metadata = {
  main_module: 'index.js',
  compatibility_date: located.settings?.compatibility_date || '2026-03-01',
  ...(Array.isArray(located.settings?.compatibility_flags) && located.settings.compatibility_flags.length
    ? { compatibility_flags: located.settings.compatibility_flags }
    : {}),
  bindings: preservedResourceBindings,
  keep_bindings: ['secret_text', 'secret_key', 'plain_text'],
  ...(located.settings?.observability ? { observability: located.settings.observability } : {}),
};

const form = new FormData();
form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
form.set('index.js', new Blob([code], { type: 'application/javascript+module' }), 'index.js');

const upload = await cfFetch(
  `/accounts/${located.accountId}/workers/scripts/${encodeURIComponent(located.scriptName)}`,
  { method: 'PUT', body: form },
);

if (!upload.ok) {
  throw new Error(`上传脚本 "${located.scriptName}" 失败: ${upload.errors}`);
}

console.log(
  `已成功更新账号 ${maskId(located.accountId)} 下的 "${located.scriptName}" (${code.length} bytes, 匹配方式: ${located.matchedBy})`,
);
