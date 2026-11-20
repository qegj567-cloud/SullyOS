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

const save = document.getElementById('save-code');
const status = document.getElementById('download-status');
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
if (query.get('menu') === 'open') document.getElementById('snack-menu').open = true;
