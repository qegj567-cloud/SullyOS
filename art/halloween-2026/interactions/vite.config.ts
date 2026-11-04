import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
 plugins:[react()],
 cacheDir:'node_modules/.vite-halloween-interactions',
 optimizeDeps:{entries:['test/fixtures/room3d-social.html']},
 server:{host:'127.0.0.1',port:5202,strictPort:true},
 build:{outDir:'art/halloween-2026/interactions/build',emptyOutDir:true,copyPublicDir:false,rollupOptions:{input:'test/fixtures/room3d-social.html'}},
});
