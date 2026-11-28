import { trackEvent } from './analytics';

/** 调用用途只接受本入口固定值，绝不发送模型名、错误原文或用户输入。 */
export function trackDateGeneration(purpose: string, success: boolean): void {
    const stage = purpose === '见面开场' ? '开场'
        : purpose === '重随见面开场' ? '重生成开场'
        : purpose === '见面对话' ? '回复'
        : purpose === '重随见面回复' ? '重生成回复' : undefined;
    if (stage) trackEvent('见面生成结果', { 阶段: stage, 结果: success ? '成功' : '失败' });
}
