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
		assert((await fs.promises.readFile('/is-number/index.js', 'utf8')).includes('is-number'));
	});

	test('readdir /@zenfs', async () => {
		const files = await fs.promises.readdir('/@zenfs');
		assert(files.length == 0);
	});
});
