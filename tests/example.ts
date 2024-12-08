import fs, { configureSingle } from '@zenfs/core';
import { Unpkg } from '../dist/fs.js';

await configureSingle({
  backend: Unpkg,
  baseUrl: 'https://unpkg.com',
  downloadZip: {
    filter: (_name: string) => true,
    baseUrl: 'https://registry.npmjs.org',
  },
});

console.log((await fs.promises.readdir('/lodash')).slice(0, 10));
console.log(await fs.promises.readFile('/lodash/fp/add.js', 'utf-8'));
