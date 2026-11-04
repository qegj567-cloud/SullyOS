import {build} from 'esbuild';
await build({entryPoints:['worker/index.js'],outfile:'output/proxy/worker.bundle.js',bundle:true,format:'esm',platform:'neutral',target:'es2022'});
console.log('Standalone proxy Worker: output/proxy/worker.bundle.js');
