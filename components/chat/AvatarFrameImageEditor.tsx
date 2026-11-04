import {AVATAR_FRAME_TARGETS,readAvatarFrameTarget,targetAvatarFrameCss,type AvatarFrameTarget} from '../../utils/avatarFrameTarget';
import React, {useEffect, useRef, useState} from 'react';
import {UPLOADED_AVATAR_FRAME_STYLE, uploadedAvatarFrameCss} from '../../utils/avatarFrameUpload';
import {putImageBlobDeduped} from '../../utils/blobRef';

export default function AvatarFrameImageEditor({css, disabled, onChange, onBusy, onError}: {
    css: string; disabled: boolean; onChange: (css: string) => void;
    onBusy: (busy: boolean) => void; onError: (error: string) => void;
}) {
    const [frame, setFrame] = useState<{image: string; width: number; height: number} | null>(null);
    const [fit, setFit] = useState({...UPLOADED_AVATAR_FRAME_STYLE});
    const alive = useRef(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const [target,setTarget]=useState<AvatarFrameTarget>(()=>readAvatarFrameTarget(css));
    useEffect(()=>{if(css.trim())setTarget(readAvatarFrameTarget(css));},[css]);
    const generate=(image:string,width:number,height:number,style=UPLOADED_AVATAR_FRAME_STYLE)=>targetAvatarFrameCss(uploadedAvatarFrameCss(image,width,height,style),target);
    const adjustable = frame && css === generate(frame.image, frame.width, frame.height, fit);
    return <>
        <label>头像框给谁用<select aria-label="头像框给谁用" disabled={disabled} value={target} onChange={e=>{const next=e.target.value as AvatarFrameTarget;setTarget(next);onChange(targetAvatarFrameCss(css,next));}}>{AVATAR_FRAME_TARGETS.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
        <label>选择透明头像框图片<input type="file" accept="image/*" disabled={disabled} onChange={async event => {
            const file = event.target.files?.[0]; event.target.value = '';
            if (!file) return;
            onBusy(true); onError('');
            let temporaryUrl: string | undefined;
            try {
                if (file.size > 12 * 1024 * 1024) throw Error('请选择 12 MB 以内的图片');
                if (!file.type.startsWith('image/')) throw Error('请上传图片文件');
                // Preserve transparency and animation (including WebP/APNG).
                temporaryUrl = URL.createObjectURL(file);
                const img = new Image();
                await new Promise<void>((resolve, reject) => {
                    img.onload = () => resolve(); img.onerror = () => reject(Error('头像框图片读取失败')); img.src = temporaryUrl!;
                });
                if (!alive.current) return;
                const {token: image} = await putImageBlobDeduped(file);
                if (!alive.current) return;
                const next = {image, width: img.naturalWidth, height: img.naturalHeight};
                setFrame(next); setFit({...UPLOADED_AVATAR_FRAME_STYLE});
                onChange(generate(image, next.width, next.height));
            } catch (error) {
                if (alive.current) onError(error instanceof Error ? error.message : '图片读取失败');
            } finally { if (temporaryUrl) URL.revokeObjectURL(temporaryUrl); if (alive.current) onBusy(false); }
        }}/></label>
        {adjustable && <fieldset disabled={disabled}><legend>头像框位置与大小</legend>
            {([
                ['avatarDecorationX', '左右位置', 0, 100, 0.1],
                ['avatarDecorationY', '上下位置', 0, 100, 0.1],
                ['avatarDecorationScale', '缩放', 0.5, 3, 0.01],
                ['avatarDecorationRotate', '旋转', -180, 180, 1],
            ] as const).map(([key, label, min, max, step]) => <label key={key}>{label}：{fit[key]}
                <input aria-label={label} type="range" min={min} max={max} step={step} value={fit[key]} onChange={event => {
                    const next = {...fit, [key]: Number(event.target.value)}; setFit(next);
                    onChange(generate(frame.image, frame.width, frame.height, next));
                }}/>
            </label>)}
        </fieldset>}
    </>;
}
