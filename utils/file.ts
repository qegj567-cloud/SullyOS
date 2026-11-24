
export const processImage = (file: File, options?: { maxWidth?: number, quality?: number, forceJpeg?: boolean, skipCompression?: boolean }): Promise<string> => {
    return new Promise((resolve, reject) => {
        // 简单验证
        if (!file.type.startsWith('image/')) {
            reject(new Error('请上传图片文件'));
            return;
        }

        // 1. 如果开启了 skipCompression (用于壁纸等)，直接读取原文件返回，不经过Canvas重绘
        if (options?.skipCompression) {
            const reader = new FileReader();
            reader.readAsDataURL(file);
            reader.onload = (e) => resolve(e.target?.result as string);
            reader.onerror = (e) => reject(new Error('文件读取失败'));
            return;
        }

        // GIF 不压缩直接读取（放宽限制至 50MB）
        if (file.type === 'image/gif') {
            if (file.size > 50 * 1024 * 1024) {
                reject(new Error('GIF 图片过大(>50MB)，可能导致应用崩溃'));
                return;
            }
            const reader = new FileReader();
            reader.readAsDataURL(file);
            reader.onload = (e) => resolve(e.target?.result as string);
            reader.onerror = () => reject(new Error('文件读取失败'));
            return;
        }

        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (event) => {
            const img = new Image();
            img.src = event.target?.result as string;
            img.onload = () => {
                // 压缩逻辑
                // 默认 1200 (高画质)，如果传入 options 则使用传入值 (如 Chat 中传 600)
                const MAX_WIDTH = options?.maxWidth || 1200; 
                const MAX_HEIGHT = MAX_WIDTH; // 保持比例限制
                
                let width = img.width;
                let height = img.height;

                if (width > height) {
                    if (width > MAX_WIDTH) {
                        height *= MAX_WIDTH / width;
                        width = MAX_WIDTH;
                    }
                } else {
                    if (height > MAX_HEIGHT) {
                        width *= MAX_HEIGHT / height;
                        height = MAX_HEIGHT;
                    }
                }

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    reject(new Error('Canvas context error'));
                    return;
                }
                
                // 清空画布 (保证透明)
                ctx.clearRect(0, 0, width, height);
                ctx.drawImage(img, 0, 0, width, height);
                
                // 智能格式选择: 
                // 1. 如果 forceJpeg 为 true (如聊天发送图)，强制转 JPEG 以节省体积
                // 2. 否则如果原图是 PNG/WebP，保持格式以保留透明通道 (如立绘、贴纸)
                // 3. 默认 JPEG
                let mimeType = 'image/jpeg';
                if (!options?.forceJpeg && (file.type === 'image/png' || file.type === 'image/webp')) {
                    mimeType = file.type;
                }
                
                // 质量控制: 默认 0.85，传入值优先
                const quality = options?.quality || 0.85;
                
                const dataUrl = canvas.toDataURL(mimeType, quality);
                resolve(dataUrl);
            };
            img.onerror = (err) => reject(new Error('图片加载失败'));
        };
        reader.onerror = (err) => reject(new Error('文件读取失败'));
    });
};

/**
 * 与 processImage 同款压缩逻辑，但产出 Blob 而非 base64 data URL —— 供改存 Blob 的
 * 场景（壁纸、小屋等，见 utils/blobRef.ts）使用，省掉一次 base64 编码 + 常驻内存。
 * GIF / skipCompression 直接返回原文件（File 本身即 Blob，不经 Canvas 重绘）。
 */
export const processImageToBlob = async (file: Blob, options?: { maxWidth?: number, quality?: number, forceJpeg?: boolean, skipCompression?: boolean, outputType?: 'image/webp' }): Promise<Blob> => {
    if (!file.type.startsWith('image/')) throw new Error('请上传图片文件');
    if (options?.skipCompression) return file;
    if (file.type === 'image/gif') {
        if (file.size > 50 * 1024 * 1024) throw new Error('GIF 图片过大(>50MB)，可能导致应用崩溃');
        return file;
    }
    const url = URL.createObjectURL(file);
    try {
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve(); img.onerror = () => reject(new Error('图片加载失败')); img.src = url;
        });
        const scale = Math.min(1, (options?.maxWidth || 1200) / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas context error');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const mimeType = options?.outputType ?? (!options?.forceJpeg && (file.type === 'image/png' || file.type === 'image/webp') ? file.type : 'image/jpeg');
        return await new Promise<Blob>((resolve, reject) => canvas.toBlob(
            blob => blob ? resolve(blob) : reject(new Error('图片压缩失败')), mimeType, options?.quality ?? 0.85,
        ));
    } finally { URL.revokeObjectURL(url); }
};
