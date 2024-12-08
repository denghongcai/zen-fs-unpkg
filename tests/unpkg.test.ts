import { configureSingle, fs } from '@zenfs/core';
import assert from 'node:assert';
import { suite, test } from 'node:test';
import { Unpkg } from '../dist/fs.js';

suite('Basic Unpkg operations', () => {
  test('Configure', async () => {
    await configureSingle({ backend: Unpkg, baseUrl: 'https://unpkg.com' });
  });

  test('readdir /', () => {
    assert(fs.readdirSync('/').length == 0);
  });

  test('readdir /is-number', async () => {
    const files = await fs.promises.readdir('/is-number');
    assert(files.includes('package.json'));
  });

  test('readdir /is-number/', async () => {
    const files = await fs.promises.readdir('/is-number/');
    assert(files.includes('package.json'));
  });

  test('read /is-number/index.js', async () => {
    assert(
      (await fs.promises.readFile('/is-number/index.js', 'utf8')).includes(
        'is-number'
      )
    );
  });

  test('readdir /@zenfs', async () => {
    const files = await fs.promises.readdir('/@zenfs');
    assert(files.length == 0);
  });
});

suite('Unpkg zipfs', () => {
  test('check /is-number', async () => {
    const fs = Unpkg.create({
      baseUrl: 'https://unpkg.com',
      downloadZip: {
        filter: (name: string) => name === 'is-number',
        baseUrl: 'https://registry.npmjs.org',
      },
    });
    const files = await fs.readdir('/is-number');
    assert((await fs.openFile('/is-number/index.js', 'r')).statSync().size > 0);
    assert(
      (await fs.openFile('/is-number/package.json', 'r')).statSync().size > 0
    );
    assert(files.length > 1);
  });
  test('check /lodash', async () => {
    const fs = Unpkg.create({
      baseUrl: 'https://unpkg.com',
      downloadZip: {
        filter: (name: string) => name === 'lodash',
        baseUrl: 'https://registry.npmjs.org',
      },
    });
    const files = await fs.readdir('/lodash');
    assert((await fs.openFile('/lodash/fp/add.js', 'r')).statSync().size > 0);
    assert(
      (await fs.openFile('/lodash/package.json', 'r')).statSync().size > 0
    );
    assert(files.length > 1);
  });
});
