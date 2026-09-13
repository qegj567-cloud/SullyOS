import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Sync display labels only; appId, package names and URL schemes retain installation identity. */
export function syncNativeAppName(wrapperRoot, appName) {
    const root = fs.realpathSync(wrapperRoot);
    const inside = relative => {
        const target = fs.realpathSync(path.join(root, relative));
        if (!target.startsWith(root + path.sep)) throw new Error('Native label target is outside the wrapper');
        return target;
    };
    const configPath = inside('capacitor.config.json');
    const stringsPath = inside('android/app/src/main/res/values/strings.xml');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const xmlName = appName.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    let strings = fs.readFileSync(stringsPath, 'utf8');
    for (const key of ['app_name', 'title_activity_main']) {
        const label = new RegExp(`(<string\\b[^>]*\\bname=["']${key}["'][^>]*>)[\\s\\S]*?(</string>)`);
        if (!label.test(strings)) throw new Error(`Missing Android display label: ${key}`);
        strings = strings.replace(label, (_, open, close) => open + xmlName + close);
    }
    // Validate all expected labels before changing either file.
    fs.writeFileSync(configPath, JSON.stringify({ ...config, appName }, null, 2) + '\n');
    fs.writeFileSync(stringsPath, strings);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (!process.argv[2]) throw new Error('Pass the existing Capacitor wrapper directory');
    const config = JSON.parse(fs.readFileSync(new URL('../capacitor.config.json', import.meta.url), 'utf8'));
    syncNativeAppName(process.argv[2], config.appName);
}
