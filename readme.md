# ZenFS Unpkg Backends

[ZenFS](https://github.com/zen-fs/core) backends for unpkg.

> [!IMPORTANT]
> Please read the ZenFS core documentation!

## Usage

The easiest way to get started is by looking at these examples

```js
import { configure, fs } from '@zenfs/core';
import { Unpkg } from 'zen-fs-unpkg';

await configure({
	mounts: {
		'/node_modules': { backend: Unpkg, baseUrl: 'https://unpkg.com' },
	},
});

const contents = await fs.promises.readFile('/node_modules/is-number@7.0.0/index.js', 'utf-8');
console.log(contents);
```
