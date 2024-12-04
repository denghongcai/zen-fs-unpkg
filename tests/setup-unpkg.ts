import { configureSingle, InMemory, Overlay } from '@zenfs/core';
import { Unpkg } from '../dist/fs.js';
import { copy, data } from '@zenfs/core/tests/setup.js';

await configureSingle({
	backend: Overlay,
	readable: Unpkg.create({
		baseUrl: 'https://unpkg.com',
	}),
	writable: InMemory.create({ name: 'tests' }),
});

// Copy the test data to the writable backend
copy(data);
