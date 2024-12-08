import { ReadableWebToNodeStream } from '@smessie/readable-web-to-node-stream';
import { Async, File, InMemory, NoSyncFile, Stats } from '@zenfs/core';
import type { Backend } from '@zenfs/core/backends/backend.js';
import { S_IFDIR, S_IFREG } from '@zenfs/core/emulation/constants.js';
import { Errno, ErrnoError } from '@zenfs/core/error.js';
import { FileSystem } from '@zenfs/core/filesystem.js';
import { Readonly } from '@zenfs/core/mixins/readonly.js';
import { dirname, isAbsolute, join, resolve } from 'path';
import * as tar from 'tar-stream';

export interface DownloadZipOptions {
  /**
   * Base URL for the registry
   */
  baseUrl: string;
  /**
   * Package size threshold for downloading zip files
   */
  packageSizeThreshold?: number;
  /**
   * Filter for package names
   */
  filter?: (packageName: string) => boolean;
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

interface PackageMeta {
  /**
   * Package name
   */
  name: string;
  /**
   * Package version
   */
  version: string;
  /**
   * Distribution tarball URL
   */
  dist: {
    /**
     * Unpacked size
     */
    unpackedSize?: number;
    /**
     * Distribution tarball URL
     */
    tarball: string;
  };
}

class FsIndex extends Map<String, Stats> {}

function parsePackageNameAndVersion(path: string):
  | {
      packageName: string;
      version: string;
    }
  | undefined {
  const match = path.match(
    /^\/((@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*)@([a-z0-9-~][a-z0-9-._~]*)/
  );
  if (match) {
    return {
      packageName: match[1],
      version: match[3],
    };
  }
  return undefined;
}

function parsePackageName(path: string): string | undefined {
  const match = path.match(
    /^\/((@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*)/
  );
  if (match) {
    return match[1];
  }
  return undefined;
}

export class UnpkgFS extends Readonly(Async(FileSystem)) {
  _sync = InMemory.create({ name: 'unpkg-tmpfs' });

  private _fetch: typeof fetch;

  private _index = new FsIndex();

  private _packagesOfZipFs = new Map<string, FileSystem>();

  private parseFileMetaAndSetToIndex(
    path: string,
    fileMeta: UnpkgFileMeta
  ): void {
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

  private async fetchPackageMetaFromRegistry(
    packageName: string,
    version: string
  ): Promise<PackageMeta> {
    if (!this.options.downloadZip) {
      throw new Error('downloadZip options are required');
    }
    try {
      const res = await this._fetch(
        `${this.options.downloadZip.baseUrl}/${packageName}/${version}`
      );
      if (!res.ok) {
        throw new ErrnoError(Errno.ENOENT, packageName);
      }
      return await res.json();
    } catch (err) {
      throw new ErrnoError(Errno.ENOENT, packageName);
    }
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
      const parsedPackageName = parsePackageNameAndVersion(
        new URL(res.url).pathname
      );
      if (parsedPackageName && this.options.downloadZip) {
        const zipFs = this._packagesOfZipFs.get(
          parsedPackageName.packageName + '@' + parsedPackageName.version
        );
        if (!zipFs) {
          const packageMeta = await this.fetchPackageMetaFromRegistry(
            parsedPackageName.packageName,
            parsedPackageName.version
          );
          if (
            this.options.downloadZip.filter?.(parsedPackageName.packageName) ||
            (typeof this.options.downloadZip.packageSizeThreshold !==
              'undefined' &&
              packageMeta.dist.unpackedSize &&
              packageMeta.dist.unpackedSize >
                this.options.downloadZip.packageSizeThreshold)
          ) {
            const res = await this._fetch(packageMeta.dist.tarball);
            if (!res.ok) {
              throw new ErrnoError(Errno.EBUSY, path);
            }
            const zipFs = InMemory.create({
              name: `unpkg-zip-fs-${parsedPackageName.packageName}@${parsedPackageName.version}`,
            });
            await zipFs.ready();
            const extract = tar.extract();
            function mkdirRecursiveSync(targetDir: string) {
              const sep = '/';
              const initDir = isAbsolute(targetDir) ? sep : '';

              return targetDir.split(sep).reduce((parentDir, childDir) => {
                const curDir = resolve(parentDir, childDir);
                try {
                  zipFs.mkdirSync(curDir, 0o755);
                } catch (e: unknown) {
                  const err = e as ErrnoError;
                  if (err.code === 'EEXIST') {
                    // curDir already exists!
                    return curDir;
                  }
                  // To avoid `EISDIR` error on Mac and `EACCES`-->`ENOENT` and `EPERM` on Windows.
                  if (err.code === 'ENOENT') {
                    // Throw the original parentDir error on curDir `ENOENT` failure.
                    throw new Error(
                      `EACCES: permission denied, mkdir '${parentDir}'`
                    );
                  }

                  const caughtErr =
                    ['EACCES', 'EPERM', 'EISDIR'].indexOf(err.code) > -1;
                  if (
                    !caughtErr ||
                    (caughtErr && curDir === resolve(targetDir))
                  ) {
                    throw err; // Throw if it's just the last created dir.
                  }
                }

                return curDir;
              }, initDir);
            }
            await new Promise((resolve, reject) => {
              extract.on('entry', async (header, stream, next) => {
                try {
                  const chunks: Uint8Array[] = [];
                  for await (const chunk of stream) {
                    chunks.push(chunk);
                  }
                  const content = Buffer.concat(chunks);

                  const normalizedPath = header.name.replace(/^package/, '');

                  if (header.type === 'directory') {
                    mkdirRecursiveSync(normalizedPath);
                  } else {
                    mkdirRecursiveSync(dirname(normalizedPath));
                    const file = await zipFs.createFile(
                      normalizedPath,
                      'w',
                      0o644
                    );
                    await file.write(content, 0, content.length);
                    await file.sync();
                    await file.close();
                  }
                  next();
                } catch (err) {
                  next(err as Error);
                }
              });

              extract.on('finish', resolve);
              extract.on('error', reject);

              new ReadableWebToNodeStream(
                res.body!.pipeThrough(new DecompressionStream('gzip'))
              ).pipe(extract);
            });
            this._packagesOfZipFs.set(parsedPackageName.packageName, zipFs);
            this._packagesOfZipFs.set(
              parsedPackageName.packageName + '@' + parsedPackageName.version,
              zipFs
            );
          }
        }
      }
      return fileMeta;
    } catch (err) {
      throw new ErrnoError(Errno.EIO, path);
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
    const packageName = parsePackageName(path);
    if (packageName) {
      const zipFs = this._packagesOfZipFs.get(packageName);
      if (zipFs) {
        return await zipFs.stat(path.replace(`/${packageName}`, '') || '/');
      }
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
    const packageName = parsePackageName(path);
    if (packageName) {
      const zipFs = this._packagesOfZipFs.get(packageName);
      if (zipFs) {
        return await zipFs.openFile(path.replace(`/${packageName}`, '') || '/', flag);
      }
    }
    const arrayBuffer = await this.fetchFile(path);
    return new NoSyncFile(
      this,
      path,
      flag,
      await this.stat(path),
      new Uint8Array(arrayBuffer)
    );
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
    const packageName = parsePackageName(path);
    if (packageName) {
      const zipFs = this._packagesOfZipFs.get(packageName);
      if (zipFs) {
        return await zipFs.readdir(path.replace(`/${packageName}`, '') || '/');
      }
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
        if (
          typeof opt.packageSizeThreshold !== 'undefined' &&
          typeof opt.packageSizeThreshold !== 'number'
        ) {
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
