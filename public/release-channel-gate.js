/* canary 通道跳转。内联在 <head> 最前面、主包下载之前执行，见 docs/canary-channel.md。
 * 键名和 utils/releaseChannel.ts 一致（有测试对照）。 */
(function () {
  'use strict';
  var script = document.currentScript;
  var build = script && script.getAttribute('data-channel') === 'canary' ? 'canary' : 'stable';
  var host = (script && script.getAttribute('data-canary-host')) || '';
  var CHANNEL = 'sullyos_release_channel';
  var ATTEMPTS = 'sullyos_canary_boot_attempts';
  var FALLBACK = 'sullyos_canary_fallback_notice';
  var ARRIVAL = 'sullyos_channel_arrival';
  var PREFIX = '/canary';
  var MAX_FAILED_BOOTS = 2;
  try {
    var url = new URL(location.href);
    // 只有这个网址提供 canary；github.io、Vercel 上什么都不做。
    if (url.hostname !== host) return;
    var go = function (pathname) {
      // 跳转生效前别让另一个版本的界面露出来。
      document.documentElement.style.visibility = 'hidden';
      location.replace(pathname + url.search + url.hash);
    };
    var toStable = function () {
      return url.pathname.indexOf(PREFIX + '/') === 0 ? url.pathname.slice(PREFIX.length) : '/';
    };
    // 手动后门：白屏时也能回到正式版。
    if (url.searchParams.get('channel') === 'stable') {
      localStorage.setItem(CHANNEL, 'stable');
      localStorage.removeItem(ATTEMPTS);
      if (build === 'canary') { localStorage.setItem(ARRIVAL, '1'); go(toStable()); }
      return;
    }
    var chosen = localStorage.getItem(CHANNEL) === 'canary' ? 'canary' : 'stable';
    if (chosen === build) return;
    if (build === 'canary') { go(toStable()); return; }
    // 正式版 → canary：每次跳之前记一次数，canary 挂载成功后清零。
    var attempts = Number(localStorage.getItem(ATTEMPTS)) || 0;
    if (attempts >= MAX_FAILED_BOOTS) {
      localStorage.setItem(CHANNEL, 'stable');
      localStorage.removeItem(ATTEMPTS);
      localStorage.setItem(FALLBACK, '1');
      localStorage.setItem(ARRIVAL, '1');
      return;
    }
    localStorage.setItem(ATTEMPTS, String(attempts + 1));
    go(PREFIX + url.pathname);
  } catch (_) {
    // localStorage 不可用就留在当前版本。
  }
})();
