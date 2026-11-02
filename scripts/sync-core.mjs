import {copyFileSync} from 'node:fs';
copyFileSync(new URL('../web/core.js',import.meta.url),new URL('../gas/Core.gs',import.meta.url));
console.log('Shared rasterizer copied to gas/Core.gs');
