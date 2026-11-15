// Standalone visual prototype. No app state, storage, analytics, payment requests or remote assets.
const board = document.querySelector('.board');
const viewButtons = [...document.querySelectorAll('[data-view][type="button"]')];
function setView(view, moveFocus = false) {
  board.dataset.view = view;
  viewButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
  if (moveFocus) {
    const target = document.getElementById(view === 'settings' ? 'open-support' : 'back-settings');
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'start', behavior: 'auto' });
  }
}
viewButtons.forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
document.getElementById('open-support').addEventListener('click', () => setView('detail', true));
document.getElementById('back-settings').addEventListener('click', () => setView('settings', true));

const channels = {
  wechat: { image: 'assets/wechat-sully-code.png', original: 'assets/wechat-original.png', card: 'assets/wechat-support-card.png', alt: '微信赞赏码，中央为 Sully 头像', caption: '微信赞赏 · 单次上限 ¥200', save: '保存投喂小票', filename: 'Sully-微信投喂小票.png', help: '微信扫一扫 → 从相册选择 → 填写金额与署名', fallback: '识别不顺利？打开原始赞赏码 ↗' },
  alipay: { image: 'assets/alipay-sully-code.png', original: 'assets/alipay-original.png', card: 'assets/alipay-support-card.png', alt: '统一 Sully 头像的支付宝经营收款码', caption: '支付宝经营码 · 手抓糯米鸡', save: '保存投喂小票', filename: 'Sully-支付宝投喂小票.png', help: '支付宝扫一扫 → 从相册选择 → 填写金额与署名', fallback: '识别不顺利？打开原始收款码 ↗' },
};
const tabs = [...document.querySelectorAll('[data-payment]')];
const code = document.getElementById('payment-code');
const save = document.getElementById('save-code');
const original = document.getElementById('open-original');
const status = document.getElementById('download-status');
function selectChannel(channel, moveFocus = false) {
  const data = channels[channel];
  if (!data) return;
  tabs.forEach(tab => {
    const selected = tab.dataset.payment === channel;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && moveFocus) tab.focus();
  });
  document.getElementById('payment-panel').setAttribute('aria-labelledby', `tab-${channel}`);
  document.getElementById('qr-crop').className = `qr-crop qr-crop--${channel}`;
  code.src = data.image;
  code.alt = data.alt;
  code.width = channel === 'wechat' ? 550 : 740;
  code.height = code.width;
  document.getElementById('code-caption').textContent = data.caption;
  save.href = data.card;
  save.download = data.filename;
  save.querySelector('span').textContent = data.save;
  original.href = data.original;
  original.textContent = data.fallback;
  document.getElementById('save-help').textContent = data.help;
  status.hidden = true;
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectChannel(tab.dataset.payment));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    selectChannel(tabs[next].dataset.payment, true);
  });
});
save.addEventListener('click', () => {
  status.textContent = '若未出现保存选项，请打开原图，长按保存。';
  status.hidden = false;
});
const petMessages = ['摸摸收到。今天也要好好照顾自己。', '嗯，再陪你待一会儿。', '你愿意来，我就已经很开心了。'];
let petIndex = 0;
const heroArt = document.querySelector('.hero-art');
document.getElementById('pet-sully').addEventListener('click', () => {
  document.getElementById('pet-response').textContent = petMessages[petIndex % petMessages.length];
  petIndex += 1;
  heroArt.classList.remove('is-petted');
  void heroArt.offsetWidth;
  heroArt.classList.add('is-petted');
});
heroArt.addEventListener('animationend', event => { if (event.animationName === 'heart-rise') heroArt.classList.remove('is-petted'); });

const query = new URLSearchParams(window.location.search);
if (['both', 'settings', 'detail'].includes(query.get('view'))) setView(query.get('view'));
else if (window.matchMedia('(max-width: 740px)').matches) setView('detail');
if (query.get('channel') === 'alipay') selectChannel('alipay');
if (query.get('menu') === 'open') document.getElementById('snack-menu').open = true;
