import { Async, File, InMemory, NoSyncFile, Stats } from '@zenfs/core';
import type { Backend } from '@zenfs/core/backends/backend.js';
import { S_IFDIR, S_IFREG } from '@zenfs/core/emulation/constants.js';
import { Errno, ErrnoError } from '@zenfs/core/error.js';
import { FileSystem } from '@zenfs/core/filesystem.js';
import { Readonly } from '@zenfs/core/mixins/readonly.js';
import { join } from 'path';

export interface DownloadZipOptions {
	/**
	 * Base URL for the registry
	 */
	baseUrl: string;
	/**
	 * Package size threshold for downloading zip files
	 */
	packageSizeThreshold?: number;
}

/**
 * Configuration options for a UnpkgFS file system.
 */
export interface UnpkgOptions {
	/**
	 * Fetch function to use
	 */
	fetch?: typeof fetch;
	/**
	 * Unpkg site URL
	 */
	baseUrl: string;
	/**
	 * Download zip files instead of individual files
	 */
	downloadZip?: DownloadZipOptions;
}

interface UnpkgFileMeta {
	/**
	 * File size
	 */
	size?: number;
	/**
	 * File type
	 */
	type: 'file' | 'directory';
	/**
	 * File path
	 */
	path: string;
	/**
	 * Files
	 */
	files?: UnpkgFileMeta[];
}

class FsIndex extends Map<String, Stats> {}

function parsePackageName(path: string): string {
	const match = path.match(/(\/)(@[a-z0-9-~][a-z0-9-._~]*)/);
	if (match) {
		return match[2];
	}
	return '';
}

export class UnpkgFS extends Readonly(Async(FileSystem)) {
	_sync = InMemory.create({ name: 'unpkg-tmpfs' });

	private _fetch: typeof fetch;

	private _index = new FsIndex();

	private _packagesOfZipFs = new Map<string, FileSystem>();

	private parseFileMetaAndSetToIndex(path: string, fileMeta: UnpkgFileMeta): void {
		if (fileMeta.type === 'directory') {
			const stats = new Stats({
				mode: 0o555 | S_IFDIR,
				size: 4096,
			});
			this._index.set(fileMeta.path, stats);
			fileMeta.files?.forEach(file => {
				this.parseFileMetaAndSetToIndex(join(path, fileMeta.path), file);
			});
		} else {
			const stats = new Stats({
				mode: 0o555 | S_IFREG,
				size: fileMeta.size,
			});
			this._index.set(path, stats);
		}
	}

	constructor(private readonly options: UnpkgOptions) {
		super();
		this._fetch = options.fetch ?? fetch;
	}
	private async fetchFileMeta(path: string): Promise<UnpkgFileMeta> {
		let url = `${this.options.baseUrl}${path}`;
		if (!url.endsWith('/')) {
			url = `${url}/?meta`;
		}
		try {
			const res = await this._fetch(url);
			if (!res.ok) {
				throw new ErrnoError(Errno.ENOENT, path);
			}
			const fileMeta = (await res.json()) as UnpkgFileMeta;
			return fileMeta;
		} catch (err) {
			throw new ErrnoError(Errno.EBUSY, path);
		}
	}
	private async fetchFile(path: string): Promise<ArrayBuffer> {
		const url = `${this.options.baseUrl}${path}`;
		try {
			const res = await this._fetch(url);
			if (!res.ok) {
				throw new ErrnoError(Errno.ENOENT, path);
			}
			return await res.arrayBuffer();
		} catch (err) {
			throw new ErrnoError(Errno.EBUSY, path);
		}
	}
	async stat(path: string): Promise<Stats> {
		// Special case for root
		if (path === '/') {
			return new Stats({
				mode: 0o555 | S_IFDIR,
				size: 4096,
			});
		}
		// Special case for scope packages
		if (/(\/node_modules)?(\/)(@[a-z0-9-~][a-z0-9-._~]*)/.test(path)) {
			return new Stats({
				mode: 0o555 | S_IFDIR,
				size: 4096,
			});
		}
		if (this._index.has(path)) {
			return this._index.get(path)!;
		}
		const fileMeta = await this.fetchFileMeta(path);
		this.parseFileMetaAndSetToIndex(path, fileMeta);
		if (fileMeta.type === 'directory') {
			const stats = new Stats({
				mode: 0o555 | S_IFDIR,
				size: 4096,
			});
			return stats;
		} else {
			const stats = new Stats({
				mode: 0o555 | S_IFREG,
				size: fileMeta.size,
			});
			return stats;
		}
	}
	async openFile(path: string, flag: string): Promise<File> {
		const arrayBuffer = await this.fetchFile(path);
		return new NoSyncFile(this, path, flag, await this.stat(path), new Uint8Array(arrayBuffer));
	}
	async readdir(path: string): Promise<string[]> {
		// Special case for root
		if (path === '/') {
			return [];
		}
		// Special case for scope packages
		if (/(\/node_modules)?(\/)(@[a-z0-9-~][a-z0-9-._~]*)/.test(path)) {
			return [];
		}
		const fileMeta = await this.fetchFileMeta(path);
		if (fileMeta.type === 'directory') {
			// Remove leading slash
			return fileMeta.files?.map(file => file.path.replace(/^\//, '')) ?? [];
		} else {
			throw new ErrnoError(Errno.ENOTDIR, path);
		}
	}
}

const _Unpkg = {
	name: 'Unpkg',

	options: {
		baseUrl: {
			type: 'string',
			required: true,
		},
		downloadZip: {
			type: 'object',
			validator(opt: DownloadZipOptions) {
				if (typeof opt.packageSizeThreshold !== 'number') {
					throw new Error('packageSizeThreshold must be a number');
				}
				if (typeof opt.baseUrl !== 'string') {
					throw new Error('baseUrl must be a string');
				}
			},
			required: false,
		},
	},

	isAvailable(): boolean {
		return true;
	},

	create(options: UnpkgOptions): UnpkgFS {
		return new UnpkgFS(options);
	},
} satisfies Backend<UnpkgFS, UnpkgOptions>;
type _Unpkg = typeof _Unpkg;
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Unpkg extends _Unpkg {}
export const Unpkg: Unpkg = _Unpkg;
