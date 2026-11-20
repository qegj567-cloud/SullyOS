// @vitest-environment jsdom
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {useChatTailProfileGesture} from '../hooks/useChatTailProfileGesture';

it('requires a second deliberate upward pull from the tail and cancels ordinary scrolling or a retracted pull',()=>{
    const open=vi.fn(), host=document.createElement('div'), root=createRoot(host);
    function Chat(){return React.createElement('div',useChatTailProfileGesture('sample',true,open),React.createElement('button',null,'打开文件'));}
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
    try {
        act(()=>root.render(React.createElement(Chat)));
        const el=host.firstElementChild as HTMLElement;
        Object.defineProperties(el,{clientHeight:{value:600},scrollHeight:{value:1200}});
        vi.spyOn(el,'getBoundingClientRect').mockReturnValue({top:0,bottom:600} as DOMRect);
        const finger=(type:string,y:number,x=100,target:Element=el)=>{
            const touch={clientX:x,clientY:y,identifier:1};
            target.dispatchEvent(Object.assign(new Event(type,{bubbles:true}),{touches:type==='touchend'?[]:[touch],changedTouches:[touch]}));
        };
        el.scrollTop=460; finger('touchstart',570); el.scrollTop=600; finger('touchend',400);
        finger('touchstart',570); finger('touchend',500);
        finger('touchstart',570); finger('touchmove',420); finger('touchend',449);
        finger('touchstart',570); finger('touchmove',480,180); finger('touchend',400);
        finger('touchstart',280); finger('touchend',100);
        finger('touchstart',570,100,el.querySelector('button')!); finger('touchend',380);
        finger('touchstart',570); finger('touchcancel',530); finger('touchend',380);
        expect(open).not.toHaveBeenCalled();
        finger('touchstart',570); finger('touchmove',505); finger('touchend',451);
        expect(open).toHaveBeenCalledTimes(1);
    } finally {act(()=>root.unmount());vi.unstubAllGlobals();}
});
