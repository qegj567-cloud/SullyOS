// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import FriendFeedSetup from '../apps/FriendFeedSetup';
import {defaultFriendFeedSettings} from './friendFeedSettings';

it('requires ten elapsed seconds before confirming the guide and cleans up the countdown',async()=>{
    vi.useFakeTimers({toFake:['setInterval','clearInterval','performance']});
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
    const host=document.createElement('div'),root=createRoot(host),onDone=vi.fn();
    const props={characters:[],settings:defaultFriendFeedSettings(),busy:false,onApi:vi.fn(),onCharacters:vi.fn(),onPreferences:vi.fn(),onWeibo:vi.fn(),onDone};
    try{
        await act(async()=>root.render(React.createElement(FriendFeedSetup,props)));
        const button=host.querySelector('.ff-setup > button') as HTMLButtonElement;
        expect(button.disabled).toBe(true);expect(button.textContent).toContain('10s');
        await act(async()=>vi.advanceTimersByTime(9000));
        expect(button.disabled).toBe(true);expect(button.textContent).toContain('1s');
        await act(async()=>button.click());expect(onDone).not.toHaveBeenCalled();
        await act(async()=>vi.advanceTimersByTime(1000));
        expect(button.disabled).toBe(false);expect(button.textContent).toBe('知道了，开始逛');
        await act(async()=>button.click());expect(onDone).toHaveBeenCalledTimes(1);
        await act(async()=>root.render(React.createElement(FriendFeedSetup,{...props,busy:true})));
        expect(button.disabled).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    }finally{await act(async()=>root.unmount());vi.useRealTimers();vi.unstubAllGlobals();}
});
