import {it,expect,vi} from 'vitest';
import {trackEvent} from './analytics';
import {trackBeauty, trackBeautyInbox} from './beautyAnalytics';
vi.mock('./analytics',()=>({trackEvent:vi.fn()}));
it('emits fixed enums and drops private or unknown values',()=>{
 vi.mocked(trackEvent).mockClear();trackBeauty('apply','bubbles');trackBeauty('submit','revision');
 expect(trackEvent).toHaveBeenNthCalledWith(1,'应用装扮完成',{分类:'气泡'});
 expect(trackEvent).toHaveBeenNthCalledWith(2,'提交美化审核',{分类:'更新投稿'});
 for(const poison of ['secret-author','S-123456789ABC','https://secret.invalid','__proto__','constructor']){
  trackBeauty('apply',poison);trackBeauty(poison,'bubbles');
 }
 expect(trackEvent).toHaveBeenCalledTimes(2);
});
it('counts inbox use without sending any information about its letters or author', () => {
  vi.mocked(trackEvent).mockClear();
  trackBeautyInbox('open');
  trackBeautyInbox('success');
  trackBeautyInbox('failure');
  trackBeautyInbox('private message' as never);
  expect(vi.mocked(trackEvent).mock.calls).toEqual([
    ['打开美化作者收件箱'],
    ['拉取美化作者收件箱', {结果: '成功'}],
    ['拉取美化作者收件箱', {结果: '失败'}],
  ]);
});
