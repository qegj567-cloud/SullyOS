/* Runs before application modules. Only bounded, local failure diagnostics are saved. */
(function () {
  'use strict';
  var script = document.currentScript;
  var standalone = script && script.getAttribute('data-mode') === 'recovery';
  var base = new URL((script && script.getAttribute('data-base')) || './', document.baseURI);
  var build = (script && script.getAttribute('data-build')) || 'recovery';
  var panel, status, detail, updateButton, observer, lastError = '', busy = false;
  var timer = 0, poll = 0, stopUpdate = null;
  var startedAt = Date.now(), session = startedAt.toString(36) + '-' + Math.random().toString(36).slice(2);
  var prefix = 'sully_startup_diagnostics_v1_', saveTimer = 0, dirty = false, storageUnavailable = false;
  var trace = { at: startedAt, build: build, events: [], mountedAfterFailure: false };
  var kinds = ['script-load', 'module-load', 'unexpected-eof', 'script-syntax', 'module-init-order', 'blob-store-init', 'missing-global', 'runtime-error', 'unhandled-rejection', 'startup-waiting'];
  // Persist fixed categories, never arbitrary exception text, API URLs or page query strings.
  function errorKind(text, fallback) {
    if (/Unexpected EOF|Unexpected end of (?:input|script)/i.test(text)) return 'unexpected-eof';
    if (/Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(text)) return 'module-load';
    if (/before initialization|Cannot access uninitialized variable/i.test(text)) return 'module-init-order';
    if (/createBlobStore: prefix must be a non-empty string/.test(text)) return 'blob-store-init';
    if (/SyntaxError|Unexpected token|Invalid or unexpected token/i.test(text)) return 'script-syntax';
    if (/is not defined|Can't find variable/i.test(text)) return 'missing-global';
    return fallback;
  }
  function resourcePath(value) {
    try {
      var url = new URL(value, base);
      if (url.origin !== base.origin || url.pathname.indexOf(base.pathname) !== 0) return '';
      var path = url.pathname.slice(base.pathname.length);
      return /^(?:assets\/build\/[a-zA-Z0-9_.-]+\.(?:js|css)|vendor\/tailwind-3\.4\.17\.js)$/.test(path) ? path : '';
    } catch (_) { return ''; }
  }
  function decode(value) {
    if (!value || !Number.isSafeInteger(value.at) || value.at < 0 || value.at > 8640000000000000 ||
        typeof value.build !== 'string' || !/^[a-zA-Z0-9_.-]{1,160}$/.test(value.build) || !Array.isArray(value.events)) return null;
    var events = value.events.slice(0, 8).filter(function (event) {
      return event && kinds.indexOf(event.kind) !== -1 && Number.isSafeInteger(event.elapsedMs) && event.elapsedMs >= 0;
    }).map(function (event) {
      return { kind: event.kind, elapsedMs: event.elapsedMs, online: event.online === true,
        controlled: event.controlled === true, resource: resourcePath(event.resource || ''),
        line: Number.isSafeInteger(event.line) && event.line >= 0 ? event.line : 0 };
    });
    return events.length ? { at: value.at, build: value.build, events: events, mountedAfterFailure: value.mountedAfterFailure === true } : null;
  }
  function savedSessions() {
    var records = [];
    try {
      var storage = window.localStorage;
      for (var i = 0; i < storage.length; i++) {
        var key = storage.key(i);
        if (!key || key.indexOf(prefix) !== 0) continue;
        try {
          var raw = storage.getItem(key);
          var value = raw && raw.length <= 12000 ? decode(JSON.parse(raw)) : null;
          records.push({ key: key, value: value });
        } catch (_) { records.push({ key: key, value: null }); }
      }
    } catch (_) { storageUnavailable = true; }
    return records.sort(function (a, b) { return (b.value ? b.value.at : 0) - (a.value ? a.value.at : 0); });
  }
  function saveTrace() {
    clearTimeout(saveTimer); saveTimer = 0;
    if (!dirty || !trace.events.length) return;
    try {
      var storage = window.localStorage, ownKey = prefix + session;
      // Each page owns a key so two failing tabs do not overwrite each other.
      savedSessions().filter(function (record) { return record.key !== ownKey; }).slice(7).forEach(function (record) {
        storage.removeItem(record.key);
      });
      storage.setItem(ownKey, JSON.stringify(trace)); dirty = false;
    } catch (_) { storageUnavailable = true; /* In-memory diagnostics remain copyable. */ }
  }
  function scheduleSave() {
    dirty = true;
    if (!saveTimer) saveTimer = setTimeout(saveTrace, 1000);
  }
  function record(kind, resource, line) {
    if (standalone || trace.events.length >= 8) return;
    resource = resourcePath(resource || '');
    if (trace.events.some(function (event) { return event.kind === kind && event.resource === resource && event.line === (line || 0); })) return;
    var controlled = false;
    try { controlled = !!(navigator.serviceWorker && navigator.serviceWorker.controller); } catch (_) {}
    trace.events.push({ kind: kind, elapsedMs: Math.max(0, Date.now() - startedAt), online: navigator.onLine !== false,
      controlled: controlled, resource: resource, line: line || 0 });
    scheduleSave();
  }
  function historyReport() {
    var history = savedSessions().filter(function (record) { return record.key !== prefix + session && record.value; })
      .map(function (record) { return record.value; });
    if (trace.events.length) history.unshift(trace);
    var lines = history.slice(0, 8).map(function (record) {
      return new Date(record.at).toISOString() + ' build ' + record.build +
        (record.mountedAfterFailure ? '（同页随后挂载；不代表全部功能正常）' : '（未记录到同页挂载）') + '\n' +
        record.events.map(function (event) {
          return '  +' + event.elapsedMs + 'ms ' + event.kind + ' ' + (event.online ? '在线' : '离线') +
            ' SW=' + (event.controlled ? '控制中' : '未控制') + (event.resource ? ' ' + event.resource + ':' + event.line : '');
        }).join('\n');
    });
    return '\n\n最近启动异常（本机时间，UTC；最多 8 次）\n' + (lines.join('\n') || '暂无记录；旧版本的故障无法补记。') +
      '\n历史仅保留错误类别和静态文件位置，不保存异常全文、不自动上传。' +
      (storageUnavailable ? '\n本页无法访问或写入本地诊断存储，刷新后可能无法保留。' : '');
  }
  window.__sullyStartupDiagnosticReport = diagnostics;
  window.addEventListener('pagehide', saveTrace);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') saveTrace(); });
  function blank() {
    var root = document.getElementById('root');
    return standalone || !root || root.childElementCount === 0;
  }
  function hideIfReady() {
    if (blank()) return false;
    if (trace.events.length && !trace.mountedAfterFailure) { trace.mountedAfterFailure = true; scheduleSave(); }
    if (panel) { panel.remove(); panel = null; }
    clearTimeout(timer);
    if (observer) observer.disconnect();
    if (stopUpdate) stopUpdate();
    return true;
  }
  function message(text) { if (status) status.textContent = text; }
  function diagnostics() {
    return 'SullyOS 启动诊断\n构建：' + build + '\n页面：' + location.origin + location.pathname +
      '\n浏览器：' + navigator.userAgent + '\n网络：' + (navigator.onLine === false ? '离线' : '在线') +
      '\n本页报错：' + (lastError || (blank() ? '暂未捕获到错误' : '未捕获到启动错误，页面已有内容')) + historyReport();
  }
  function refreshDetail() { if (detail) detail.value = diagnostics(); }
  function navigate() {
    if (hideIfReady()) return;
    if (stopUpdate) stopUpdate();
    saveTrace();
    if (standalone) location.replace(base.href);
    else location.reload();
  }
  function update() {
    if (busy) return;
    if (!navigator.serviceWorker) { message('当前浏览器无法使用网页更新服务，请先尝试重新打开；仍失败时复制诊断反馈。'); return; }
    clearTimeout(timer);
    busy = true; updateButton.disabled = true; message('正在检查网页更新，聊天与存档不会被删除…');
    var active = true, registration, approved, preparing, prepared, channel;
    function stopped() {
      active = false; busy = false; clearTimeout(timer); clearInterval(poll);
      if (channel) { channel.port1.close(); channel.port2.close(); channel = null; }
      navigator.serviceWorker.removeEventListener('controllerchange', changed);
      if (updateButton) updateButton.disabled = false;
      stopUpdate = null;
    }
    function fail() {
      if (!active) return;
      stopped(); message('更新尚未完成。请检查网络后重试；也可以关闭这个站点的其他标签页和桌面入口，再重新打开。');
    }
    function changed() {
      if (active && approved && navigator.serviceWorker.controller === approved) navigate();
    }
    function prepare(worker) {
      if (preparing || !active) return;
      if (!worker) { fail(); return; }
      preparing = worker;
      message('正在校验并补齐启动资源，完成后重新打开；已下好的文件会保留…');
      try {
        channel = new MessageChannel();
        channel.port1.onmessage = function (event) {
          if (!active) return;
          channel.port1.close(); channel.port2.close(); channel = null;
          preparing = null;
          if (!event.data || event.data.error || event.data.offlineReady !== true) { fail(); return; }
          prepared = worker;
          inspect();
        };
        // Also runs when this is already the latest worker. A module that never
        // mounted cannot reach the application's normal background cache preparation.
        worker.postMessage({type:'SULLY_CACHE_PREPARE'}, [channel.port2]);
      } catch (_) { fail(); }
    }
    function inspect() {
      if (!active || hideIfReady()) return;
      if (registration.waiting) {
        if (approved === registration.waiting) return;
        if (prepared !== registration.waiting) { prepare(registration.waiting); return; }
        approved = registration.waiting; message('新版已准备好，正在重新打开…');
        try { approved.postMessage({type:'SULLY_ACTIVATE_UPDATE'}); } catch (_) { fail(); }
      } else if (registration.installing) message('正在下载新版启动资源，请保持页面打开…');
      else if (!approved || approved.state === 'activated') {
        if (!registration.active) { fail(); return; }
        if (prepared !== registration.active) { prepare(registration.active); return; }
        navigate();
      }
    }
    stopUpdate = stopped;
    navigator.serviceWorker.addEventListener('controllerchange', changed);
    timer = setTimeout(fail, 120000);
    navigator.serviceWorker.getRegistration(base.href).then(function (existing) {
      if (!active) return null;
      // Preserve this registration and its push subscription. Never unregister it.
      return existing || navigator.serviceWorker.register(new URL('sw-keep-alive.js', base).href, {scope:base.href, updateViaCache:'none'});
    }).then(function (value) {
      if (!active || !value) return;
      if (new URL(value.scope).href !== base.href) throw new Error('Unexpected service worker scope');
      registration = value;
      return registration.update().then(function () {
        if (!active) return;
        poll = setInterval(inspect, 500); inspect();
      });
    }).catch(fail);
  }
  function show() {
    if (hideIfReady()) return;
    if (!lastError) record('startup-waiting');
    if (panel) { refreshDetail(); return; }
    panel = document.createElement('section'); panel.id = 'sully-startup-recovery';
    panel.setAttribute('role', 'alert');
    panel.style.cssText = 'position:fixed;inset:0;z-index:2147483647;overflow:auto;background:#f8f3ec;color:#473b34;padding:calc(32px + env(safe-area-inset-top,0px)) 24px 32px;box-sizing:border-box;font:15px/1.7 system-ui,sans-serif;text-align:left';
    var card = document.createElement('div'); card.style.cssText = 'max-width:480px;margin:8vh auto'; panel.appendChild(card);
    var title = document.createElement('h1'); title.textContent = standalone ? '网页启动修复' : lastError ? '启动遇到问题' : '启动尚未完成';
    title.style.cssText = 'font-size:24px;font-weight:600;margin:0 0 16px'; card.appendChild(title);
    status = document.createElement('p'); status.textContent = '可以检查网页更新后重试，不会清除聊天或存档。最近的启动异常会自动保留在本机；恢复后也可在设置底部复制，不会自动上传。'; card.appendChild(status);
    function button(label, action) {
      var el = document.createElement('button'); el.type = 'button'; el.textContent = label;
      el.style.cssText = 'font:inherit;border:1px solid #bca895;border-radius:12px;padding:10px 16px;background:#fffaf4;color:#473b34;margin:8px 8px 8px 0;cursor:pointer';
      el.onclick = action; card.appendChild(el); return el;
    }
    updateButton = button('检查更新并重试', update);
    button('重新打开', navigate);
    var details = document.createElement('details'), summary = document.createElement('summary');
    summary.textContent = '启动诊断（可复制给开发者）'; details.appendChild(summary);
    detail = document.createElement('textarea'); detail.readOnly = true; detail.setAttribute('aria-label','启动诊断');
    detail.style.cssText = 'box-sizing:border-box;width:100%;height:180px;margin:12px 0;padding:12px;font:12px/1.6 monospace;color:#473b34;background:white;border:1px solid #d8cbbd;border-radius:8px;user-select:text';
    details.appendChild(detail); card.appendChild(details); refreshDetail();
    button('复制启动诊断', function () {
      details.open = true; refreshDetail(); detail.focus(); detail.select();
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(detail.value).then(function () { message('启动诊断已复制，可粘贴给开发者。'); }, function () { message('请长按诊断文字复制。'); });
      else message('请长按诊断文字复制。');
    });
    (document.body || document.documentElement).appendChild(panel);
  }
  function capture(text, kind, resource, line) {
    if (!blank()) return;
    text = String(text || '启动资源加载失败').slice(0, 3000);
    // Keep the first error: a later "tailwind is not defined" must not hide its failed download.
    if (!lastError) lastError = text;
    var category = errorKind(text, kind);
    if (!resource && category === 'module-load') {
      var match = text.match(/https?:\/\/[^\s'"<>]+/);
      if (match) resource = match[0];
    }
    record(category, resource, line);
    setTimeout(show, 0);
  }
  window.addEventListener('error', function (event) {
    var target = event.target;
    if (event.message) capture(event.message + (event.filename ? '\n' + event.filename.split('?')[0] + ':' + event.lineno : ''), 'runtime-error', event.filename, event.lineno);
    else if (target && target.tagName === 'SCRIPT') capture('启动脚本加载失败：' + (target.src || '').split('?')[0], 'script-load', target.src);
  }, true);
  window.addEventListener('unhandledrejection', function (event) { capture(event.reason && event.reason.message || event.reason, 'unhandled-rejection'); });
  function watchRoot() {
    if (hideIfReady()) return;
    var root = document.getElementById('root');
    if (root && window.MutationObserver) { observer = new MutationObserver(hideIfReady); observer.observe(root, {childList:true}); }
    if (standalone) show();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchRoot, {once:true});
  else watchRoot();
  timer = setTimeout(show, standalone ? 0 : 12000);
}());
