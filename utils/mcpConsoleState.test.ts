// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
import McpConnectionConsole from '../components/settings/McpConnectionConsole';
vi.mock('../context/OSContext',()=>({useOS:()=>({characters:[],groups:[]})}));
vi.mock('@phosphor-icons/react',()=>Object.fromEntries(['CaretDown','CheckCircle','GlobeHemisphereWest','LockKey','Plus','SpinnerGap','Trash','WarningCircle'].map(name=>[name,()=>null])));
vi.mock('./analytics',()=>({trackEvent:vi.fn()}));
vi.mock('./mcpClient',()=>({loadMcpServers:()=>[{id:'one',name:'测试服务器',enabled:false,url:'',updatedAt:0}],getMcpUseNativeTools:()=>true}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const host=document.createElement('div');document.body.append(host);
let root:ReturnType<typeof createRoot>;
const mount=()=>{root=createRoot(host);act(()=>root.render(React.createElement(McpConnectionConsole,{addToast:()=>{}})));};
const toggle=()=>host.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
afterEach(()=>{act(()=>root.unmount());localStorage.clear();});
it('keeps a collapsed server collapsed after closing and reopening settings, and remembers an explicit expansion',()=>{
 mount();expect(toggle().getAttribute('aria-expanded')).toBe('true');act(()=>toggle().click());act(()=>root.unmount());
 mount();expect(toggle().getAttribute('aria-expanded')).toBe('false');act(()=>toggle().click());act(()=>root.unmount());
 mount();expect(toggle().getAttribute('aria-expanded')).toBe('true');
});
it('does not expand a different server if the saved expanded server was deleted',()=>{
 localStorage.setItem('sully-mcp-expanded-server','deleted');mount();expect(toggle().getAttribute('aria-expanded')).toBe('false');
});
