import fs from 'node:fs';
import path from 'node:path';
import { CentralDir, CentralDirOptions } from './central-dir.js';
import { ZipEntry } from './entry.js';
import { Logger } from './types.js';
import { fileOrDirExists, findCacheDirectory } from './utils.js';

const DEFAULT_MAX_CENTRAL_DIR_COUNT = 10;
const DEFAULT_CONSISTENT_ENTRY_THRESHOLD = 50 * 1024 * 1024;

export interface AdvZlibOptions {
  logger?: Logger;
  cacheBaseDir?: string;
  maxCacheSize?: number;
  maxCentralDirCount?: number;
  consistentEntryThreshold?: number;
}

interface CacheInfos {
  cacheDir: string;
  maxCentralDirCount: number;
  consistentEntryThreshold: number;
  cachedCentralDirs: Map<string, CentralDir>;
  cachedExistenceInfos: Map<string, boolean>;
}

export class AdvZlib {
  private logger!: Logger;
  private cacheInfos!: CacheInfos;

  constructor(opts?: AdvZlibOptions) {
    this.logger = opts?.logger || console;
    this.cacheInfos = {
      cacheDir: opts?.cacheBaseDir ? path.join(opts.cacheBaseDir, 'adv-zlib') : findCacheDirectory({ name: 'adv-zlib' }),
      maxCentralDirCount: opts?.maxCentralDirCount || DEFAULT_MAX_CENTRAL_DIR_COUNT,
      consistentEntryThreshold: opts?.consistentEntryThreshold || DEFAULT_CONSISTENT_ENTRY_THRESHOLD,
      cachedCentralDirs: new Map<string, CentralDir>(),
      cachedExistenceInfos: new Map<string, boolean>(),
    };

    if (!fs.existsSync(this.cacheInfos.cacheDir)) {
      fs.mkdirSync(this.cacheInfos.cacheDir, { recursive: true });
    }
  }

  /**
   * Get the list of entries in a ZIP file
   * @param src The path of the zip file which can be:
   * - Normal: `/a/b.zip`
   * - Nested zip: `/a/b.zip/c.zip` or `/a/b.zip/c/d.zip`
   * @param filterFn An optional callback function to filter entries
   * @returns A promise that resolves to the list of filtered entries in the ZIP file.
   */
  public async getEntries(src: string, filterFn?: (entry: ZipEntry) => boolean): Promise<ZipEntry[]> {
    this.logger.debug(`[AdvZlib] getEntries(): Getting entries for ${src}`);

    if (!src) {
      throw new Error(`[AdvZlib] getEntries(): src is required`);
    }

    if (!src.endsWith('.zip')) {
      throw new Error(`[AdvZlib] getEntries(): ${src} is not a zip file`);
    }

    const centralDir = await this.getOrInitCentralDir(src);
    if (!centralDir) {
      this.logger.error(`[AdvZlib] getEntries(): Failed to get central directory for ${src}`);
      return [];
    }

    return centralDir.entries.filter((entry) => (filterFn ? filterFn(entry) : true));
  }

  /**
   * Check if a file exists in a ZIP file
   * @param src The path of the zip file which can be:
   * - Normal: `/a/b.zip/c.txt`
   * - Folder: `/a/b.zip/c/`
   * - Nested zip: `/a/b.zip/c.zip`
   * @returns A promise that resolves to a boolean indicating whether the file exists in the ZIP file.
   */
  public async exists(src: string): Promise<boolean> {
    this.logger.debug(`[AdvZlib] exists(): Checking if ${src} exists`);

    if (!src) {
      throw new Error(`[AdvZlib] exists(): ${src} is empty`);
    }

    if (this.cacheInfos.cachedExistenceInfos.has(src)) {
      return this.cacheInfos.cachedExistenceInfos.get(src) ?? false;
    }

    if (await fileOrDirExists(src)) {
      return true;
    }

    const centralDir = await this.getOrInitCentralDir(src);
    if (src.endsWith('.zip')) {
      return !!centralDir;
    }

    if (!centralDir) {
      this.logger.error(`[AdvZlib] exists(): Failed to get central directory for ${src}`);
      return false;
    }

    const entry = centralDir.entries.find((entry) => this.matchEntryByFullPath(entry, src));
    const exsistence = !!entry;
    this.cacheInfos.cachedExistenceInfos.set(src, exsistence);

    return exsistence;
  }

  /**
   * Extracts selected entries from a ZIP file to a specified destination directory.
   *
   * @param src The source path to the ZIP file. Can represent a simple ZIP file or a nested path within a ZIP file.
   * @param dest There several cases:
   * - Case1: src is a zip(whatever nested or not) file, then `dest` must be a directory and this directory must exist.
   * - Case2: src is a particular file within a zip file, then `dest` can either be a directory(where the content will be extracted)
   *   or a file path(indicating where the extracted content will be saved).
   * @param filterFn An optional filter function that determines which entries to extract.
   *                   If provided, only entries for which the function returns `true` will be extracted.
   * @returns A promise that resolves to an array of full paths of the extracted files.
   * @throws Will throw an error if the `src` ZIP file does not exist or if the `dest` directory does not exist.
   */
  public async extract(src: string, dest: string, filterFn?: (entry: ZipEntry) => boolean): Promise<string[]> {
    this.logger.debug(`[AdvZlib] extract(): Extracting ${src} to ${dest}`);

    if (!(await this.exists(src))) {
      throw new Error(`[AdvZlib] extract(): ZIP file ${src} does not exist.`);
    }

    if (src.endsWith('.zip') && !(await fileOrDirExists(dest))) {
      throw new Error(`[AdvZlib] extract(): As ${src} is a zip file, ${dest} must be an existing directory.`);
    }

    if (!src.endsWith('.zip') && !(await fileOrDirExists(path.dirname(dest)))) {
      throw new Error(`[AdvZlib] extract(): ${path.dirname(dest)} does not exist.`);
    }

    if (!src.endsWith('.zip') && filterFn) {
      throw new Error(`[AdvZlib] extract(): Filter function is only applicable for extracting a whole zip file.`);
    }

    const centralDir = await this.getOrInitCentralDir(src);
    if (!centralDir) {
      throw new Error(`[AdvZlib] extract(): Failed to get central directory for ${src}`);
    }

    const extracted: string[] = [];
    const entries = this.getRelatedEntries(src, centralDir.entries, filterFn);
    await Promise.all(entries.map(async (entry) => extracted.push(await entry.extract(dest))));

    return extracted;
  }

  /**
   * Reads the content of a specific file within a ZIP file.
   *
   * @param src - The path to the ZIP file or an entry within it. Accepted formats include:
   *   - Type 1: `/a/b.zip` - Reads using a `filterFn` function to filter entries.
   *   - Type 2: `/a/b.zip/c.txt` - Directly specifies a file entry to read, without a `filterFn`.
   *   - Type 3: `/a/b.zip/c.zip` - Specifies a nested ZIP entry, read with a `filterFn` function.
   *   - Type 4: `/a/b.zip/c.zip/d.txt` - Directly specifies a file entry within a nested ZIP, without a `filterFn`.
   * @param filterFn - An optional filter function to select entries within the ZIP file.
   *                   If provided, only entries for which the function returns `true` are considered.
   * @returns A promise that resolves to a `Buffer` containing the file's contents, or an empty `Buffer`
   *          if no matching entry is found or if multiple entries match.
   * @throws Will throw an error if the `src` file does not exist.
   */
  async read(src: string, filterFn?: (entry: ZipEntry) => boolean): Promise<Buffer> {
    this.logger.info(`[AdvZlib]read(): Reading content from ${src}`);

    if (!(await this.exists(src))) {
      throw new Error('read(): The source of the ZIP file is required.');
    }

    const centralDir = await this.getOrInitCentralDir(src);
    if (!centralDir) {
      throw new Error(`[AdvZlib] extract(): Failed to get central directory for ${src}`);
    }

    const entries = this.getRelatedEntries(src, centralDir.entries, filterFn);
    if (entries.length === 0) {
      this.logger.error(`[AdvZlib]read(): No matching entries found in ${src}`);
      return Buffer.alloc(0);
    }

    if (entries.length > 1) {
      this.logger.error(`[AdvZlib]read(): Multiple matching entries found in ${src}`);
      return Buffer.alloc(0);
    }

    return await entries[0].read();
  }

  public async cleanup() {
    this.cacheInfos.cachedCentralDirs.clear();
    this.cacheInfos.cachedExistenceInfos.clear();
    if (await fileOrDirExists(this.cacheInfos.cacheDir)) {
      await fs.promises.rm(this.cacheInfos.cacheDir, { recursive: true });
    }
  }

  /**
   * Get the central directory of a ZIP file if it cached or initialize it if not
   * @param src The path of the zip file which can be:
   * - Normal: `/a/b.zip`
   * - Nested zip: `/a/b.zip/c.zip` or `/a/b.zip/c/d.zip`
   * @returns A promise that resolves to the central directory
   */
  private async getOrInitCentralDir(src: string): Promise<CentralDir | undefined> {
    const cachedDir = this.getCentralDirFromCache(src);
    if (cachedDir) {
      this.logger.info(`[AdvZlib] getOrInitCentralDir(): Using cached central directory for ${src}`);
      return cachedDir;
    }

    const zipPathSegs = this.splitZipPathIntoSegs(src);

    if (zipPathSegs.length === 0) {
      this.logger.error(`[AdvZlib] getOrInitCentralDir(): No ZIP segments found in path: ${src}`);
      return;
    }

    let accumulatedPath = '';
    let entry: ZipEntry | undefined = undefined;
    let centralDir: CentralDir | undefined = undefined;

    for (const seg of zipPathSegs) {
      accumulatedPath = path.join(accumulatedPath, seg);

      if (!accumulatedPath.endsWith('.zip')) continue;

      if (!centralDir && !(await fileOrDirExists(accumulatedPath))) {
        this.logger.warn(`[AdvZlib] getOrInitCentralDir(): ZIP file ${accumulatedPath} does not exist.`);
        return;
      }

      if (centralDir) {
        entry = this.findZipEntry(centralDir, accumulatedPath);
        if (!entry || entry.size === 0) {
          this.logger.warn(`[AdvZlib] getOrInitCentralDir(): Entry ${seg} is empty in ${accumulatedPath}.`);
          return;
        }
      }

      centralDir = await this._getOrInitCentralDir(accumulatedPath, entry);
    }

    return centralDir;
  }

  /**
   * Initialize or retrieve a cached central directory
   * @param src The path to the ZIP file
   * @param dataSource Optional buffer data for nested ZIPs
   * @returns A promise that resolves to the central directory
   */
  private async _getOrInitCentralDir(src: string, entry?: ZipEntry): Promise<CentralDir> {
    if (this.cacheInfos.cachedCentralDirs.has(src)) {
      this.logger.debug(`[AdvZlib] _getOrInitCentralDir(): Using cached central directory for ${src}`);
      return this.getCentralDirFromCache(src)!;
    }

    let entryData: Buffer | string | undefined = undefined;
    if (entry) {
      entryData = await entry.cacheData(this.cacheInfos.consistentEntryThreshold, this.cacheInfos.cacheDir);
    }

    const opts: CentralDirOptions = { logger: this.logger, dataSource: entryData };
    const centralDir = new CentralDir(src, opts);
    await centralDir.init();

    if (this.cacheInfos.cachedCentralDirs.size < this.cacheInfos.maxCentralDirCount) {
      this.cacheInfos.cachedCentralDirs.set(src, centralDir);
    } else {
      // Remove the oldest one
      const oldest = this.cacheInfos.cachedCentralDirs.keys().next().value;
      if (oldest) {
        this.cacheInfos.cachedCentralDirs.delete(oldest);
      }
      // Append the new one
      this.cacheInfos.cachedCentralDirs.set(src, centralDir);
    }

    return centralDir;
  }

  private getRelatedEntries(src: string, entries: ZipEntry[], filterFn?: (entry: ZipEntry) => boolean): ZipEntry[] {
    const entryRelPath = this.getLastEntryRelPath(src);
    return filterFn
      ? entries.filter((entry) => filterFn(entry))
      : entries.filter((entry) => (entryRelPath ? entry.relPath === entryRelPath : true));
  }

  /**
   * Split a ZIP path into its ZIP segments
   * E.g., '/a/b.zip/c.zip/d/e.zip/f.txt' to ['/a/b.zip', '/c.zip', '/d/e.zip', '/f.txt']
   * @param src The source ZIP path
   * @returns An array of path segments
   */
  private splitZipPathIntoSegs(src: string): string[] {
    const normalizedPath = path.normalize(src);
    const segments = normalizedPath.split(path.sep);
    const result: string[] = [];

    const finalPath = segments.reduce(
      (accumulator, segment) => {
        if (segment === '') return accumulator;
        if (accumulator === '') return segment;

        const newPath = accumulator === path.sep ? `${accumulator}${segment}` : `${accumulator}${path.sep}${segment}`;

        if (segment.endsWith('.zip')) {
          result.push(newPath);
          return path.sep;
        }

        return newPath;
      },
      src.startsWith(path.sep) ? path.sep : ''
    );

    if (finalPath && finalPath !== path.sep) {
      result.push(finalPath);
    }

    return result;
  }

  /**
   * Get the last entry relative path, e.g., '/a/b.zip/c/d.txt' to 'c/d.txt'
   * @param src The source ZIP path
   * @returns The last entry relative path
   */
  private getLastEntryRelPath(src: string, includeZip = false): string {
    let lastEntryRelPath = this.splitZipPathIntoSegs(src)
      .pop()
      ?.replace(/^[/\\]+/, '');

    if (lastEntryRelPath?.endsWith('.zip')) {
      lastEntryRelPath = includeZip ? lastEntryRelPath : '';
    }

    return lastEntryRelPath || '';
  }

  /**
   * Get the deepest zip path, e.g., '/a/b.zip/c/d.zip/e.txt' to '/a/b.zip/c/d.zip'
   * @param src The source ZIP path
   * @returns The deepest zip path
   */
  private getDeepestZipPath(src: string): string {
    if (src.endsWith('.zip')) {
      return src;
    }

    const zipPathSegs = this.splitZipPathIntoSegs(src).filter((seg) => seg.endsWith('.zip'));
    return path.join(...zipPathSegs);
  }

  /**
   * Find a ZIP entry within the central directory
   * @param centralDir The central directory to search
   * @param zipFilePath The current ZIP file path
   * @returns The found entry or undefined
   */
  private findZipEntry(centralDir: CentralDir, zipFilePath: string): ZipEntry | undefined {
    const lastEntryRelPath = this.getLastEntryRelPath(zipFilePath, true);
    const entry = centralDir.entries.find((entry) => !entry.isDirectory && entry.relPath === lastEntryRelPath);

    if (!entry) {
      this.logger.error(`[AdvZlib] findZipEntry(): Entry ${lastEntryRelPath} does not exist in ${zipFilePath}.`);
      return undefined;
    }

    if (entry.size === 0) {
      this.logger.warn(`[AdvZlib] findZipEntry(): Entry ${lastEntryRelPath} is empty in ${zipFilePath}.`);
      return undefined;
    }

    return entry;
  }

  private matchEntryByFullPath(entry: ZipEntry, src: string): boolean {
    // trim last "/" or "\" of entry.fullPath
    const entryFullPath = entry.fullPath.replace(/\/|\\/g, '');
    // trim "/" or "\" of src
    const srcPath = src.replace(/\/|\\/g, '');
    return entryFullPath === srcPath;
  }

  private getCentralDirFromCache(src: string): CentralDir | null {
    const deepestZipPath = this.getDeepestZipPath(src);
    const cachedDir = this.cacheInfos.cachedCentralDirs.get(deepestZipPath);
    if (cachedDir) {
      this.logger.info(`[AdvZlib] _getOrInitCentralDir(): Using cached central directory for ${deepestZipPath}`);
      return cachedDir;
    }
    return null;
  }
}
