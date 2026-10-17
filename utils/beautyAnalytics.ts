import {trackEvent} from './analytics';

// Only code-owned enum values leave this boundary; never names, codes, CSS or IDs.
const events = {
  library: '打开装扮收藏', maker: '打开装扮制作器', import: '导入装扮完成',
  apply: '应用装扮完成', save: '保存装扮完成', share: '分享装扮',
  submit: '提交美化审核', update: '更新本机装扮完成',
} as const;
const categories = {
  chat:'聊天装扮', appearance:'桌面主题', whitebox:'白框', bubbles:'气泡',
  avatar:'头像框', background:'聊天背景', psyche:'心象', sound:'提示音',
  collaboration:'协同工作', schedule:'日程表', journal:'交换日记', outfit:'搭配',
  file:'文件', image:'图片', css:'CSS', code:'分享码', new:'首次投稿', revision:'更新投稿',
} as const;
export function trackBeauty(action: string, category: unknown) {
  if (!Object.hasOwn(events, action) || typeof category !== 'string' || !Object.hasOwn(categories, category)) return;
  trackEvent(events[action as keyof typeof events], {分类: categories[category as keyof typeof categories]});
}
