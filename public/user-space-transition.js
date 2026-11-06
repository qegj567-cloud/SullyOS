/* Inlined into HTML: the handover screen survives a full module/environment reload. */
(function () {
  var key = 'sully_space_transition_v1', node, timer, removal, arriving = null;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function clear() {
    clearTimeout(timer); clearTimeout(removal);
    if (node) node.remove();
    node = null;
    try { window.sessionStorage.removeItem(key); } catch (_) {}
  }
  function show(name, entering) {
    clear();
    if (!document.getElementById('sully-space-transition-style')) {
      var style = document.createElement('style');
      style.id = 'sully-space-transition-style';
      style.textContent = '#sully-space-transition{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;background:#f5f3f8;color:#423c50;font-family:system-ui,sans-serif;text-align:center;transition:opacity .36s ease;isolation:isolate}' +
        '#sully-space-transition:before{content:"";position:absolute;inset:0;z-index:-1;background:radial-gradient(ellipse at 50% 44%,#e9dff5 0,transparent 56%)}' +
        '#sully-space-transition .space-mark{width:76px;height:76px;margin:0 auto 24px;border-radius:26px;display:grid;place-items:center;background:#ffffffb8;border:1px solid #fff;font-size:28px;box-shadow:0 12px 40px #6f548914}' +
        '#sully-space-transition .space-name{font-size:22px;font-weight:500;max-width:80vw;overflow-wrap:anywhere;margin:0}' +
        '#sully-space-transition .space-caption{font-size:12px;letter-spacing:.12em;color:#91869e;margin-top:12px}' +
        '#sully-space-transition .space-line{width:36px;height:2px;background:#b6a0d0;margin:28px auto 0;border-radius:2px;animation:space-breathe 1.8s ease-in-out infinite}' +
        '@keyframes space-breathe{50%{opacity:.35;transform:scaleX(.6)}}' +
        '@keyframes space-cover{from{opacity:0}to{opacity:1}}' +
        '@media(prefers-reduced-motion:reduce){#sully-space-transition{transition:none!important;animation:none!important}#sully-space-transition .space-line{animation:none}}';
      document.head.appendChild(style);
    }
    node = document.createElement('div'); node.id = 'sully-space-transition';
    node.setAttribute('role', 'status'); node.setAttribute('aria-live', 'polite');
    var content = document.createElement('div'), mark = document.createElement('div'), title = document.createElement('p'), caption = document.createElement('p'), line = document.createElement('div');
    mark.className = 'space-mark'; mark.textContent = Array.from(name)[0] || 'U'; mark.setAttribute('aria-hidden', 'true');
    title.className = 'space-name'; title.textContent = name;
    caption.className = 'space-caption'; caption.textContent = '正在进入你的空间';
    line.className = 'space-line'; line.setAttribute('aria-hidden', 'true');
    content.append(mark, title, caption, line); node.appendChild(content);
    if (entering && !reduced) node.style.animation = 'space-cover .28s ease both';
    document.documentElement.appendChild(node);
    // Never conceal startup recovery, a failed database, or a stalled navigation indefinitely.
    timer = setTimeout(clear, 12000);
  }
  try {
    var saved = JSON.parse(window.sessionStorage.getItem(key) || 'null');
    window.sessionStorage.removeItem(key);
    if (saved && typeof saved.name === 'string' && saved.name.length <= 120 &&
        typeof saved.at === 'number' && Date.now() - saved.at >= 0 && Date.now() - saved.at < 30000 &&
        saved.id === (window.localStorage.getItem('sully_active_user_space_v1') || 'default')) {
      arriving = saved.id; show(saved.name, false);
    }
  } catch (_) {}
  window.__sullySpaceTransition = {
    arriving: function (id) { return arriving === id; },
    begin: function (id, name) {
      show(name.slice(0, 120), true);
      try { window.sessionStorage.setItem(key, JSON.stringify({ id: id, name: name.slice(0, 120), at: Date.now() })); } catch (_) {}
      return new Promise(function (resolve) { setTimeout(resolve, reduced ? 0 : 280); });
    },
    finish: function () {
      if (!node || node.dataset.leaving) return;
      node.dataset.leaving = 'true';
      // The target has committed its desktop; allow a paint before lifting the cover.
      removal = setTimeout(function () {
        if (node) { node.style.opacity = '0'; node.style.pointerEvents = 'none'; }
        removal = setTimeout(clear, reduced ? 0 : 360);
      }, reduced ? 0 : 100);
    },
    cancel: clear
  };
  window.addEventListener('error', function (event) { if (event.target === window) clear(); });
  window.addEventListener('pageshow', function (event) { if (event.persisted) clear(); });
})();
