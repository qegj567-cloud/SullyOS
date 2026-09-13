import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {syncNativeAppName} from './sync-native-app-name.mjs';
const name='SullyOS·糯米机';
for(const file of ['public/manifest.webmanifest','public/manifest-classic.webmanifest']){const data=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(data.name,name);assert.equal(data.short_name,name);assert.equal(data.start_url,'./');assert.equal(data.scope,'./');}
const config=JSON.parse(fs.readFileSync('capacitor.config.json','utf8'));assert.equal(config.appId,'com.aetheros.simulator');assert.equal(config.appName,name);assert.equal(JSON.parse(fs.readFileSync('metadata.json','utf8')).name,name);
const html=fs.readFileSync('index.html','utf8');assert(html.includes('<title>'+name+'</title>'));assert(html.includes('name="apple-mobile-web-app-title" content="'+name+'"'));assert(html.includes('name="application-name" content="'+name+'"'));
fs.mkdirSync('output/app-display-name',{recursive:true});
const root=fs.mkdtempSync(path.resolve('output/app-display-name/native-'));const xmlPath=path.join(root,'android/app/src/main/res/values/strings.xml');fs.mkdirSync(path.dirname(xmlPath),{recursive:true});
const original={appId:'com.example.keep',appName:'旧名字',webDir:'dist',plugins:{Keyboard:{resize:'body'}}};const configPath=path.join(root,'capacitor.config.json');fs.writeFileSync(configPath,JSON.stringify(original));
fs.writeFileSync(xmlPath,`<resources><string name="app_name">Old</string><string name='title_activity_main'>Old activity</string><string name="package_name">com.example.keep</string><string name="custom_url_scheme">com.example.keep</string></resources>`);
syncNativeAppName(root,name);assert.deepEqual(JSON.parse(fs.readFileSync(configPath,'utf8')),{...original,appName:name});const xml=fs.readFileSync(xmlPath,'utf8');assert.equal(xml.split(name).length-1,2);assert.equal(xml.split('com.example.keep').length-1,2);
syncNativeAppName(root,name);assert.equal(fs.readFileSync(xmlPath,'utf8'),xml);
const validConfig=fs.readFileSync(configPath,'utf8');fs.writeFileSync(xmlPath,'<resources><string name="app_name">Old</string></resources>');assert.throws(()=>syncNativeAppName(root,'Other'),/Missing Android display label/);assert.equal(fs.readFileSync(configPath,'utf8'),validConfig);
console.log('PASS browser/PWA names and identity, native config/XML labels, idempotence and validation before writes');
