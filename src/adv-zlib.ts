import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
// import findCacheDirectory from 'find-cache-dir';
import { CentralDir, CentralDirOptions } from "./central-dir.js";
import { ZipEntry } from "./entry.js";
import { Logger } from "./types.js";
import { ensureDirectoryExists } from "./utils.js";

export interface AdvZlibOptions {
  logger?: Logger;
  cacheDir?: string;
  maxCacheSize?: number;
  maxCacheEntries?: number;
}

export class AdvZlib {
  private logger!: Logger;
  private maxCacheSize!: number;
  private maxCacheEntries!: number;
  private cacheDir!: string;
  private cachedCentralDirs = new Map<string, CentralDir>();
  private cachedExistenceInfos = new Map<string, boolean>();

  constructor(opts?: AdvZlibOptions) {
    this.logger = opts?.logger || console;
    this.maxCacheSize = opts?.maxCacheSize || 50 * 1024 * 1024;
    this.maxCacheEntries = opts?.maxCacheEntries || 10;
    this.cacheDir = opts?.cacheDir || "/tmp/adv-zlib";
    // this.cacheDir = opts?.cacheDir || findCacheDirectory({ name: 'adv-zlib' })!;

    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
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
  public async getEntries(
    src: string,
    filterFn?: (entry: ZipEntry) => boolean
  ): Promise<ZipEntry[]> {
    this.logger.debug(`[AdvZlib] getEntries(): Getting entries for ${src}`);

    if (!src) {
      throw new Error(`[AdvZlib] getEntries(): src is required`);
    }

    if (!src.endsWith(".zip")) {
      throw new Error(`[AdvZlib] getEntries(): ${src} is not a zip file`);
    }

    const centralDir = await this.getOrInitCentralDir(src);
    if (!centralDir) {
      this.logger.error(
        `[AdvZlib] getEntries(): Failed to get central directory for ${src}`
      );
      return [];
    }

    return centralDir.entries.filter((entry) =>
      filterFn ? filterFn(entry) : true
    );
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

    if (this.cachedExistenceInfos.has(src)) {
      return this.cachedExistenceInfos.get(src) ?? false;
    }

    if (await this.checkFileExists(src)) {
      return true;
    }

    const centralDir = await this.getOrInitCentralDir(src);
    if (src.endsWith(".zip")) {
      return !!centralDir;
    }

    if (!centralDir) {
      this.logger.error(
        `[AdvZlib] exists(): Failed to get central directory for ${src}`
      );
      return false;
    }

    const entry = centralDir.entries.find((entry) => entry.fullPath === src);
    const exsistence = !!entry;
    this.cachedExistenceInfos.set(src, exsistence);

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
  public async extract(
    src: string,
    dest: string,
    filterFn?: (entry: ZipEntry) => boolean
  ): Promise<string[]> {
    this.logger.debug(`[AdvZlib] extract(): Extracting ${src} to ${dest}`);

    if (!(await this.exists(src))) {
      throw new Error(`[AdvZlib] extract(): ZIP file ${src} does not exist.`);
    }

    if (src.endsWith(".zip") && !(await this.checkFileExists(dest))) {
      throw new Error(
        `[AdvZlib] extract(): As ${src} is a zip file, ${dest} must be an existing directory.`
      );
    }

    if (
      !src.endsWith(".zip") &&
      !(await this.checkFileExists(path.dirname(dest)))
    ) {
      throw new Error(
        `[AdvZlib] extract(): ${path.dirname(dest)} does not exist.`
      );
    }

    if (!src.endsWith(".zip") && filterFn) {
      throw new Error(
        `[AdvZlib] extract(): Filter function is only applicable for extracting a whole zip file.`
      );
    }

    const centralDir = await this.getOrInitCentralDir(src);
    if (!centralDir) {
      throw new Error(
        `[AdvZlib] extract(): Failed to get central directory for ${src}`
      );
    }

    const extracted: string[] = [];
    const entries = this.getRelatedEntries(src, centralDir.entries, filterFn);
    await Promise.all(
      entries.map(async (entry) => extracted.push(await entry.extract(dest)))
    );

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
  async read(
    src: string,
    filterFn?: (entry: ZipEntry) => boolean
  ): Promise<Buffer> {
    this.logger.info(`[AdvZlib]read(): Reading content from ${src}`);

    if (!(await this.exists(src))) {
      throw new Error("read(): The source of the ZIP file is required.");
    }

    const centralDir = await this.getOrInitCentralDir(src);
    if (!centralDir) {
      throw new Error(
        `[AdvZlib] extract(): Failed to get central directory for ${src}`
      );
    }

    const entries = this.getRelatedEntries(src, centralDir.entries, filterFn);
    if (entries.length === 0) {
      this.logger.error(`[AdvZlib]read(): No matching entries found in ${src}`);
      return Buffer.alloc(0);
    }

    if (entries.length > 1) {
      this.logger.error(
        `[AdvZlib]read(): Multiple matching entries found in ${src}`
      );
      return Buffer.alloc(0);
    }

    return await entries[0].read();
  }

  public async cleanup() {
    this.cachedCentralDirs.clear();
    this.cachedExistenceInfos.clear();
    await fsPromises.rm(this.cacheDir, { recursive: true, force: true });
  }

  /**
   * Get the central directory of a ZIP file if it cached or initialize it if not
   * @param src The path of the zip file which can be:
   * - Normal: `/a/b.zip`
   * - Nested zip: `/a/b.zip/c.zip` or `/a/b.zip/c/d.zip`
   * @returns A promise that resolves to the central directory
   */
  private async getOrInitCentralDir(src: string): Promise<CentralDir | null> {
    const deepestZipPath = this.getDeepestZipPath(src);
    const cachedDir = this.cachedCentralDirs.get(deepestZipPath);
    if (cachedDir) {
      this.logger.info(
        `[AdvZlib] _getOrInitCentralDir(): Using cached central directory for ${deepestZipPath}`
      );
      return cachedDir;
    }

    const zipPathSegs = this.splitZipPathIntoSegs(src).filter((seg) =>
      seg.endsWith(".zip")
    );

    if (zipPathSegs.length === 0) {
      this.logger.error(
        `[AdvZlib] getOrInitCentralDir(): No ZIP segments found in path: ${src}`
      );
      return null;
    }

    let accumulatedPath = "";
    let centralDir: CentralDir | null = null;

    for (const seg of zipPathSegs) {
      accumulatedPath = path.join(accumulatedPath, seg);

      if (!centralDir) {
        // Handle outermost ZIP file
        const exists = await this.checkFileExists(accumulatedPath);
        if (!exists) {
          throw new Error(
            `[AdvZlib] getOrInitCentralDir(): ZIP file ${accumulatedPath} does not exist.`
          );
        }

        centralDir = await this._getOrInitCentralDir(accumulatedPath);
      } else {
        // Handle nested ZIP entries
        const entry = this.findZipEntry(centralDir, accumulatedPath);
        if (!entry) return null;

        if (entry.size === 0) {
          this.logger.warn(
            `[AdvZlib] getOrInitCentralDir(): Entry ${seg} is empty in ${accumulatedPath}.`
          );
          return null;
        }

        const entryData = await this.handleEntryData(entry, accumulatedPath);
        if (Buffer.isBuffer(entryData)) {
          centralDir = await this._getOrInitCentralDir(
            accumulatedPath,
            entryData
          );
        } else if (typeof entryData === "string") {
          // Large file cached to disk, no need to proceed further
          centralDir = await this._getOrInitCentralDir(
            accumulatedPath,
            entryData
          );
        } else {
          this.logger.warn(
            `[AdvZlib] getOrInitCentralDir(): Entry ${seg} is empty in ${accumulatedPath}.`
          );
          return null;
        }
      }
    }

    return centralDir;
  }

  /**
   * Initialize or retrieve a cached central directory
   * @param src The path to the ZIP file
   * @param dataSource Optional buffer data for nested ZIPs
   * @returns A promise that resolves to the central directory
   */
  private async _getOrInitCentralDir(
    src: string,
    dataSource?: Buffer | string
  ): Promise<CentralDir> {
    const cachedDir = this.cachedCentralDirs.get(src);
    if (cachedDir) {
      this.logger.info(
        `[AdvZlib] _getOrInitCentralDir(): Using cached central directory for ${src}`
      );
      return cachedDir;
    }

    const opts: CentralDirOptions = { logger: this.logger, dataSource };
    const centralDir = new CentralDir(src, opts);
    await centralDir.init();

    if (this.cachedCentralDirs.size < this.maxCacheEntries) {
      this.cachedCentralDirs.set(src, centralDir);
    } else {
      // Remove the oldest one
      const oldest = this.cachedCentralDirs.keys().next().value;
      if (oldest) {
        this.cachedCentralDirs.delete(oldest);
      }
      // Append the new one
      this.cachedCentralDirs.set(src, centralDir);
    }

    return centralDir;
  }

  private getRelatedEntries(
    src: string,
    entries: ZipEntry[],
    filterFn?: (entry: ZipEntry) => boolean
  ): ZipEntry[] {
    const entryRelPath = this.getLastEntryRelPath(src);
    return filterFn
      ? entries.filter((entry) => filterFn(entry))
      : entries.filter((entry) =>
          entryRelPath ? entry.relPath === entryRelPath : true
        );
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
        if (segment === "") return accumulator;
        if (accumulator === "") return segment;

        const newPath =
          accumulator === path.sep
            ? `${accumulator}${segment}`
            : `${accumulator}${path.sep}${segment}`;

        if (segment.endsWith(".zip")) {
          result.push(newPath);
          return path.sep;
        }

        return newPath;
      },
      src.startsWith(path.sep) ? path.sep : ""
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
    let lastEntryRelPath = this.splitZipPathIntoSegs(src).pop();

    if (lastEntryRelPath?.endsWith(".zip")) {
      lastEntryRelPath = includeZip ? lastEntryRelPath : "";
    }

    if (lastEntryRelPath?.startsWith("/")) {
      lastEntryRelPath = lastEntryRelPath.slice(1);
    }

    return lastEntryRelPath || "";
  }

  /**
   * Get the deepest zip path, e.g., '/a/b.zip/c/d.zip/e.txt' to '/a/b.zip/c/d.zip'
   * @param src The source ZIP path
   * @returns The deepest zip path
   */
  private getDeepestZipPath(src: string): string {
    if (src.endsWith(".zip")) {
      return src;
    }

    const zipPathSegs = this.splitZipPathIntoSegs(src).filter((seg) =>
      seg.endsWith(".zip")
    );
    return path.join(...zipPathSegs);
  }

  /**
   * Check if a file exists asynchronously
   * @param filePath The path to the file
   * @returns A promise that resolves to true if exists, false otherwise
   */
  private async checkFileExists(filePath: string): Promise<boolean> {
    try {
      await fsPromises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Find a ZIP entry within the central directory
   * @param centralDir The central directory to search
   * @param zipFilePath The current ZIP file path
   * @returns The found entry or null
   */
  private findZipEntry(
    centralDir: CentralDir,
    zipFilePath: string
  ): ZipEntry | null {
    const lastEntryRelPath = this.getLastEntryRelPath(zipFilePath, true);
    const entry = centralDir.entries.find(
      (entry) => !entry.isDirectory && entry.relPath === lastEntryRelPath
    );

    if (!entry) {
      this.logger.error(
        `[AdvZlib] findZipEntry(): Entry ${lastEntryRelPath} does not exist in ${zipFilePath}.`
      );
      return null;
    }

    if (entry.size === 0) {
      this.logger.warn(
        `[AdvZlib] findZipEntry(): Entry ${lastEntryRelPath} is empty in ${zipFilePath}.`
      );
      return null;
    }

    return entry;
  }

  /**
   * Handle reading and caching of a ZIP entry
   * @param entry The ZIP entry to handle
   * @param zipFilePath The current ZIP file path
   * @returns The entry data buffer or null if cached to disk
   */
  private async handleEntryData(
    entry: ZipEntry,
    zipFilePath: string
  ): Promise<Buffer | string | null> {
    if (entry.size >= this.maxCacheSize) {
      const segs = this.splitZipPathIntoSegs(zipFilePath);
      segs[0] = path.basename(segs[0]);
      const cacheFile = path.join(this.cacheDir, ...segs);

      await ensureDirectoryExists(path.dirname(cacheFile));
      const writeStream = fs.createWriteStream(cacheFile);
      const readStream = await entry.createReadStream();

      try {
        await pipeline(readStream, writeStream);
        this.logger.info(
          `[AdvZlib] handleEntryData(): Cached large entry to ${cacheFile}`
        );
        entry.onCache(cacheFile);
        return cacheFile;
      } catch (err: any) {
        this.logger.error(
          `[AdvZlib] handleEntryData(): Failed to cache entry ${entry.relPath}: ${err.message}`
        );
        return null;
      }
    } else {
      try {
        const data = await entry.read();
        if (data.length === 0) {
          this.logger.warn(
            `[AdvZlib] handleEntryData(): Entry ${entry.relPath} is empty.`
          );
          return null;
        }
        entry.onCache(data);
        return data;
      } catch (err: any) {
        this.logger.error(
          `[AdvZlib] handleEntryData(): Failed to read entry ${entry.relPath}: ${err.message}`
        );
        return null;
      }
    }
  }
}
