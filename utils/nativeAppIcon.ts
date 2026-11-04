import { Capacitor, registerPlugin } from '@capacitor/core';

export type NativeAppIcon = 'jellyfish' | 'classic';
export interface NativeAppIconStatus { icon: NativeAppIcon | null }
interface LauncherIconPlugin {
    getIcon(): Promise<NativeAppIconStatus>;
    setIcon(options: { icon: NativeAppIcon }): Promise<NativeAppIconStatus>;
}
const launcherIcon = registerPlugin<LauncherIconPlugin>('LauncherIcon');
export const isAndroidAppIcon = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

function requirePlugin() {
    if (!isAndroidAppIcon() || !Capacitor.isPluginAvailable('LauncherIcon')) {
        throw new Error('此安装包尚不支持桌面图标切换，请先更新 APK。');
    }
}
function checkedStatus(status: NativeAppIconStatus): NativeAppIconStatus {
    if (!status || (status.icon !== null && status.icon !== 'jellyfish' && status.icon !== 'classic')) {
        throw new Error('无法确认桌面图标状态，请重试。');
    }
    return status;
}
export async function getNativeAppIcon(): Promise<NativeAppIconStatus> {
    requirePlugin();
    return checkedStatus(await launcherIcon.getIcon());
}
export async function setNativeAppIcon(icon: NativeAppIcon): Promise<NativeAppIconStatus> {
    if (icon !== 'jellyfish' && icon !== 'classic') throw new Error('只支持水母或经典图标。');
    requirePlugin();
    const status = checkedStatus(await launcherIcon.setIcon({ icon }));
    if (status.icon !== icon) throw new Error('图标切换未完成，请重试。');
    return status;
}
