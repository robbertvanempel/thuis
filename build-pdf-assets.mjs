import {mkdir,copyFile,cp} from 'node:fs/promises';
await mkdir('assets/pdfjs',{recursive:true});
await copyFile('node_modules/pdfjs-dist/build/pdf.worker.min.mjs','assets/pdf-worker.mjs');
for(const folder of ['cmaps','standard_fonts']) await cp(`node_modules/pdfjs-dist/${folder}`,`assets/pdfjs/${folder}`,{recursive:true});
await copyFile('node_modules/pdfjs-dist/LICENSE','assets/pdfjs/LICENSE');
