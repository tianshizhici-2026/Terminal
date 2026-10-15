import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
const out = 'src/Mist.Terminal/www';
await mkdir(out, {recursive:true});
await build({entryPoints:['ui/app.js'], bundle:true, minify:true, outfile:`${out}/app.js`, loader:{'.woff2':'file','.woff':'file'}, assetNames:'assets/[name]-[hash]'});
await copyFile('ui/index.html', `${out}/index.html`);
await copyFile('ui/filter-worker.js', `${out}/filter-worker.js`);
