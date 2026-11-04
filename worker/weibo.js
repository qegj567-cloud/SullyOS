// Node-only test facade. Keep production index.js limited to its default Worker entrypoint.
import {readFileSync} from 'node:fs';
const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const {weiboBridge} = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport {weiboBridge};').toString('base64'));
export const {handleWeibo,handleWeiboImage,readWeiboSession,weiboPageUid,normalizeWeiboPost,weiboImages} = weiboBridge;
