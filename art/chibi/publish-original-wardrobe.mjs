import {build} from 'esbuild';
import {mkdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
mkdirSync('.tmp/original-wardrobe',{recursive:true});
const outfile=resolve('.tmp/original-wardrobe/publish.mjs');
await build({entryPoints:['art/chibi/publish-original-wardrobe.ts'],outfile,bundle:true,platform:'node',format:'esm',packages:'external'});
await import(pathToFileURL(outfile).href);
