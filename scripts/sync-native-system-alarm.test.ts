import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncNativeSystemAlarm } from './sync-native-system-alarm.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'sully-system-alarm-')) throw new Error('Unexpected test directory'); fs.rmSync(root, { recursive: true, force: true }); } });
function fixture(activity = 'package com.aetheros.simulator;\nimport com.getcapacitor.BridgeActivity;\npublic class MainActivity extends BridgeActivity {}') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sully-system-alarm-')); roots.push(root);
    const java = path.join(root, 'android/app/src/main/java/com/aetheros/simulator');
    fs.mkdirSync(java, { recursive: true });
    fs.writeFileSync(path.join(root, 'capacitor.config.json'), JSON.stringify({ appId: 'com.aetheros.simulator' }));
    const manifest = path.join(root, 'android/app/src/main/AndroidManifest.xml');
    fs.writeFileSync(manifest, '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:label="keep" /><queries><package android:name="keep.package" /></queries></manifest>');
    fs.writeFileSync(path.join(java, 'MainActivity.java'), activity);
    return { root, java, manifest };
}
it('installs the native source, permission, query and registration idempotently while preserving the shell', () => {
    const f = fixture(); syncNativeSystemAlarm(f.root);
    const manifest = fs.readFileSync(f.manifest, 'utf8');
    const activity = fs.readFileSync(path.join(f.java, 'MainActivity.java'), 'utf8');
    expect(manifest).toContain('keep.package'); expect(manifest).toContain('android:label="keep"');
    expect(manifest).toContain('com.android.alarm.permission.SET_ALARM');
    expect(manifest).toContain('android.intent.action.SET_ALARM');
    expect(activity.indexOf('registerPlugin(SystemAlarmPlugin.class)')).toBeLessThan(activity.indexOf('super.onCreate'));
    expect(fs.readFileSync(path.join(f.java, 'SystemAlarmPlugin.java'), 'utf8')).toContain('.putExtra(AlarmClock.EXTRA_SKIP_UI, false)');
    syncNativeSystemAlarm(f.root);
    expect(fs.readFileSync(f.manifest, 'utf8')).toBe(manifest);
    expect(fs.readFileSync(path.join(f.java, 'MainActivity.java'), 'utf8')).toBe(activity);
});
it('keeps existing plugin registration and onCreate code', () => {
    const f = fixture('public class MainActivity extends BridgeActivity {\n protected void onCreate(Bundle state) {\n  registerPlugin(LauncherIconPlugin.class);\n  super.onCreate(state);\n  keepWindowSettings();\n }\n}');
    syncNativeSystemAlarm(f.root);
    const activity = fs.readFileSync(path.join(f.java, 'MainActivity.java'), 'utf8');
    expect(activity).toContain('LauncherIconPlugin.class'); expect(activity).toContain('keepWindowSettings();');
    expect(activity).toContain('registerPlugin(SystemAlarmPlugin.class);\n  super.onCreate(state)');
});
it('fails before changing files when a custom activity cannot be safely patched', () => {
    const f = fixture('public class MainActivity extends BridgeActivity { protected void onCreate(Bundle state) { customLifecycle(); } }');
    const before = fs.readFileSync(f.manifest, 'utf8');
    expect(() => syncNativeSystemAlarm(f.root)).toThrow('manually');
    expect(fs.readFileSync(f.manifest, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(f.java, 'SystemAlarmPlugin.java'))).toBe(false);
});
it('rejects wrappers with another app identity', () => {
    const f = fixture(); fs.writeFileSync(path.join(f.root, 'capacitor.config.json'), '{"appId":"other.app"}');
    expect(() => syncNativeSystemAlarm(f.root)).toThrow('com.aetheros.simulator');
});
