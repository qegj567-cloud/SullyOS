import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Add only the clock bridge; preserve the wrapper's signing, push, icons and other plugins. */
export function syncNativeSystemAlarm(wrapperRoot) {
    const root = fs.realpathSync(wrapperRoot);
    const inside = relative => {
        const target = path.join(root, relative);
        const resolved = fs.existsSync(target) ? fs.realpathSync(target) : path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
        if (!resolved.startsWith(root + path.sep)) throw new Error('System alarm target is outside the wrapper');
        return resolved;
    };
    const config = JSON.parse(fs.readFileSync(inside('capacitor.config.json'), 'utf8'));
    if (config.appId !== 'com.aetheros.simulator') throw new Error('System alarm sync expects com.aetheros.simulator; adapt the Java package for other wrappers first');
    const manifestPath = inside('android/app/src/main/AndroidManifest.xml');
    const activityPath = inside('android/app/src/main/java/com/aetheros/simulator/MainActivity.java');
    const pluginPath = inside('android/app/src/main/java/com/aetheros/simulator/SystemAlarmPlugin.java');
    let manifest = fs.readFileSync(manifestPath, 'utf8');
    let activity = fs.readFileSync(activityPath, 'utf8');
    const plugin = fs.readFileSync(new URL('../native/android/system-alarm/main/java/com/aetheros/simulator/SystemAlarmPlugin.java', import.meta.url), 'utf8');
    if (!/<manifest\b[^>]*>/.test(manifest) || !/<\/manifest>/.test(manifest) || !/<application\b/.test(manifest)) throw new Error('Unrecognized Android manifest');
    if (!/<uses-permission\b[^>]*android:name\s*=\s*["']com\.android\.alarm\.permission\.SET_ALARM["']/.test(manifest)) {
        manifest = manifest.replace(/(<manifest\b[^>]*>)/, '$1\n    <uses-permission android:name="com.android.alarm.permission.SET_ALARM" />');
    }
    const query = '        <intent><action android:name="android.intent.action.SET_ALARM" /></intent>';
    const queries = manifest.match(/<queries\b[^>]*>([\s\S]*?)<\/queries>/);
    if (!queries?.[1].includes('android.intent.action.SET_ALARM')) {
        if (queries) manifest = manifest.replace('</queries>', query + '\n    </queries>');
        else if (/<queries\s*\/>/.test(manifest)) manifest = manifest.replace(/<queries\s*\/>/, '<queries>\n' + query + '\n    </queries>');
        else manifest = manifest.replace('</manifest>', '    <queries>\n' + query + '\n    </queries>\n</manifest>');
    }
    if (!/registerPlugin\(\s*SystemAlarmPlugin\.class\s*\)/.test(activity)) {
        const superCalls = [...activity.matchAll(/^([ \t]*)super\.onCreate\(([^;\n]+)\);/gm)];
        if (superCalls.length === 1) {
            activity = activity.replace(superCalls[0][0], `${superCalls[0][1]}registerPlugin(SystemAlarmPlugin.class);\n${superCalls[0][0]}`);
        } else if (superCalls.length === 0 && !/\bonCreate\s*\(/.test(activity) && /class\s+MainActivity\s+extends\s+BridgeActivity\s*\{/.test(activity)) {
            activity = activity.replace(/(class\s+MainActivity\s+extends\s+BridgeActivity\s*\{)/, '$1\n    @Override\n    protected void onCreate(android.os.Bundle savedInstanceState) {\n        registerPlugin(SystemAlarmPlugin.class);\n        super.onCreate(savedInstanceState);\n    }\n');
        } else throw new Error('MainActivity uses a custom onCreate; register SystemAlarmPlugin.class before super.onCreate manually, then rerun');
    }
    // All paths and expected structure are checked before any mutation.
    fs.writeFileSync(pluginPath, plugin);
    fs.writeFileSync(manifestPath, manifest);
    fs.writeFileSync(activityPath, activity);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (!process.argv[2]) throw new Error('Pass the existing Capacitor wrapper directory');
    syncNativeSystemAlarm(process.argv[2]);
    console.log('SystemAlarm plugin, permission, package query and registration are ready. Rebuild the APK.');
}
