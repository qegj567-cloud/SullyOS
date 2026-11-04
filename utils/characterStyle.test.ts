// @vitest-environment jsdom
import {beforeEach,describe,it,expect,vi} from 'vitest';
beforeEach(()=>{vi.resetModules();localStorage.clear();});
describe('character rendering preference',()=>{
 it('defaults to modern and retains legacy after reload',async()=>{
  const a=await import('../apps/room3d/chibi/characterStyle');expect(a.getCharacterStyle()).toBe('modern');
  a.setCharacterStyle('legacy');vi.resetModules();const b=await import('../apps/room3d/chibi/characterStyle');expect(b.getCharacterStyle()).toBe('legacy');
  localStorage.setItem(a.CHARACTER_STYLE_KEY,'invalid');vi.resetModules();expect((await import('../apps/room3d/chibi/characterStyle')).getCharacterStyle()).toBe('modern');
 });
 it('notifies local and cross-tab consumers, and releases subscriptions',async()=>{
  const a=await import('../apps/room3d/chibi/characterStyle'),first=vi.fn(),second=vi.fn();const off=a.subscribeCharacterStyle(first),off2=a.subscribeCharacterStyle(second);
  a.setCharacterStyle('legacy');a.setCharacterStyle('legacy');expect(first).toHaveBeenCalledTimes(1);expect(second).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new StorageEvent('storage',{key:a.CHARACTER_STYLE_KEY,newValue:'modern'}));expect(a.getCharacterStyle()).toBe('modern');expect(first).toHaveBeenCalledTimes(2);
  off();a.setCharacterStyle('legacy');expect(first).toHaveBeenCalledTimes(2);expect(second).toHaveBeenCalledTimes(3);off2();
 });
 it('still switches in memory if saving is blocked',async()=>{
  const a=await import('../apps/room3d/chibi/characterStyle');const block=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('blocked');});
  a.setCharacterStyle('legacy');const off=a.subscribeCharacterStyle(()=>{});expect(a.getCharacterStyle()).toBe('legacy');off();block.mockRestore();
 });
});
