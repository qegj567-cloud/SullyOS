import { Capacitor, registerPlugin } from '@capacitor/core';

interface SystemAlarmPlugin {
    getStatus(): Promise<{ available: boolean }>;
    createAlarm(options: { hour: number; minutes: number; message: string }): Promise<{ opened: boolean }>;
}
const systemAlarm = registerPlugin<SystemAlarmPlugin>('SystemAlarm');
export const isAndroidAlarm = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

function requirePlugin(): void {
    if (!isAndroidAlarm()) throw new Error('系统闹钟需要在安卓 APK 中使用。');
    if (!Capacitor.isPluginAvailable('SystemAlarm')) throw new Error('当前安装包尚未接入系统闹钟，请更新 APK；只刷新网页无法启用。');
}

export async function checkNativeAlarm(): Promise<void> {
    requirePlugin();
    const status = await systemAlarm.getStatus();
    if (status?.available !== true) throw new Error('这台设备没有可接收创建闹钟请求的时钟应用。');
}

/** Android has no arbitrary calendar-date extra. Never translate an event date to a weekday. */
export async function createNativeAlarm(time: string, title: string): Promise<void> {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('请选择有效的闹钟时间。');
    requirePlugin();
    const [hour, minutes] = time.split(':').map(Number);
    const message = title.trim().slice(0, 160) || '时光契约';
    const result = await systemAlarm.createAlarm({ hour, minutes, message });
    if (result?.opened !== true) throw new Error('未能打开系统时钟，请重试。');
    // Intent handoff does not prove an alarm was saved, or that the user kept it.
}
