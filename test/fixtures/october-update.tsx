import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import OctoberUpdatePopup from '../../components/os/OctoberUpdatePopup';
function Preview() {
    const [open, setOpen] = useState(true), [action, setAction] = useState('');
    return <main><h1>十月更新弹窗</h1><p>设计预览 · 不修改存档，不上报统计</p><button onClick={() => {setAction('');setOpen(true);}}>重新看弹窗</button><p role="status">{action}</p>{open && <OctoberUpdatePopup preview onDone={() => {setOpen(false);setAction('已关闭预览');}}/>}</main>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
