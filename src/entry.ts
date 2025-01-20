import assert from 'node:assert';
import fs from 'node:fs';
import { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { createHash } from 'crypto';

import { CentralDirFileHeader } from './cdfh.js';
import { Logger } from './types.js';
import { ensureDirectoryExists } from './utils.js';

enum CompressionMethod {
  NONE = 0,
  DEFLATED = 8,
}

export interface EntryOptions {
  logger: Logger;
  outerZipPath: string;
}

export class LocalFileHeader {
  static MIN_SIZE = 30;
  static SIGNATURE = 0x04034b50;

  public totalSize!: number;
  public crc32!: number;
  public fileNameLength!: number;
  public extraFieldLength!: number;

  constructor(minimalData: Buffer) {
    if (minimalData.readUInt32LE(0) !== LocalFileHeader.SIGNATURE) {
      throw new Error('The signature is not correct');
    }

    this.crc32 = minimalData.readUInt32LE(14);
    this.fileNameLength = minimalData.readUInt16LE(26);
    this.extraFieldLength = minimalData.readUInt16LE(28);

    this.totalSize = LocalFileHeader.MIN_SIZE + this.fileNameLength + this.extraFieldLength;
  }
}

export class FileData {
  public readonly lfh!: LocalFileHeader;
  public readonly cdfh!: CentralDirFileHeader;

  constructor(lfh: LocalFileHeader, cdfh: CentralDirFileHeader) {
    this.lfh = lfh;
    this.cdfh = cdfh;
  }

  public createReadStream(src: string | Buffer): Readable {
    if (Buffer.isBuffer(src)) {
      return Readable.from(this.extractDataFromBuffer(src));
    }

    if (!fs.existsSync(src)) {
      throw new Error(`The file ${src} does not exist.`);
    }

    const offset = this.cdfh.localFileHeaderOffset + this.lfh.totalSize;
    return fs.createReadStream(src, {
      start: offset,
      end: offset + this.cdfh.compressedSize,
    });
  }

  public async extractData(src: string | Buffer): Promise<Buffer> {
    if (Buffer.isBuffer(src)) {
      return this.extractDataFromBuffer(src);
    }

    if (!fs.existsSync(src)) {
      throw new Error(`The file ${src} does not exist.`);
    }

    return this.extractDataFromFd(await fs.promises.open(src, 'r'));
  }

  public async extractDataFromFd(fd: FileHandle): Promise<Buffer> {
    const buffer = Buffer.alloc(this.cdfh.compressedSize);
    const offset = this.cdfh.localFileHeaderOffset + this.lfh.totalSize;
    await fd.read(buffer, 0, this.cdfh.compressedSize, offset);
    await fd.close();

    return buffer;
  }

  public extractDataFromBuffer(zipBuffer: Buffer): Buffer {
    const buffer = Buffer.alloc(this.cdfh.compressedSize);
    const offset = this.cdfh.localFileHeaderOffset + this.lfh.totalSize;
    zipBuffer.copy(buffer, 0, offset, offset + this.cdfh.compressedSize);

    return buffer;
  }
}

export class ZipEntry {
  public get relPath(): string {
    return this.cdfh.fileName;
  }
  public get name(): string {
    return path.basename(this.relPath);
  }
  public get size(): number {
    return this.cdfh.compressedSize;
  }
  public get fullPath(): string {
    return path.join(this.outerZipPath, this.relPath);
  }
  public get isDirectory(): boolean {
    return this.relPath.endsWith('/') || this.relPath.endsWith('\\');
  }

  private logger!: Logger;
  // The entire data source of zip file
  private dataSource!: string | Buffer;
  private cdfh!: CentralDirFileHeader;
  private lfh!: LocalFileHeader;
  private fileData!: FileData;
  private cachePath?: string;
  private decompressedData?: Buffer;
  private outerZipPath!: string;

  public get isCached(): boolean {
    return !!this.cachePath || !!this.decompressedData;
  }

  constructor(dataSource: string | Buffer, cdfh: CentralDirFileHeader, opts: EntryOptions) {
    if (!cdfh) {
      throw new Error('CentralDirFileHeader is empty.');
    }

    this.cdfh = cdfh;
    this.logger = opts.logger;
    this.dataSource = dataSource;
    this.outerZipPath = opts.outerZipPath;
  }

  public async init() {
    const { localFileHeaderOffset } = this.cdfh;
    const fd = Buffer.isBuffer(this.dataSource) ? null : await fs.promises.open(this.dataSource, 'r');
    const minimalLFHBuffer = await this.readLocalFileHeader(fd, localFileHeaderOffset);

    this.lfh = new LocalFileHeader(minimalLFHBuffer);
    this.fileData = new FileData(this.lfh, this.cdfh);
  }

  private async readLocalFileHeader(fd: FileHandle | null, offset: number): Promise<Buffer> {
    const buffer = Buffer.alloc(LocalFileHeader.MIN_SIZE);
    if (fd) {
      await fd.read(buffer, 0, LocalFileHeader.MIN_SIZE, offset);
      await fd.close();
    } else {
      (this.dataSource as Buffer).copy(buffer, 0, offset, offset + LocalFileHeader.MIN_SIZE);
    }
    return buffer;
  }

  public async createReadStream(): Promise<Readable> {
    if (!this.fileData) {
      await this.init();
    }

    if (this.isCached) {
      if (this.decompressedData) {
        return Readable.from(this.decompressedData);
      } else {
        return fs.createReadStream(this.cachePath!);
      }
    }

    if (this.cdfh.compressionMethod === CompressionMethod.NONE) {
      return this.fileData.createReadStream(this.dataSource);
    } else if (this.cdfh.compressionMethod === CompressionMethod.DEFLATED) {
      return this.createInflateStream();
    } else {
      throw new Error(`Unsupported compression method: ${this.cdfh.compressionMethod}`);
    }
  }

  /**
   * 如果 entry data 特别的大，直接使用 read 来获取完整的 buffer 会导致内存的 spike
   * 最好提供一个 stream 接口供用户自己处理
   */
  public async read(): Promise<Buffer> {
    if (!this.fileData) {
      await this.init();
    }

    if (this.isCached) {
      return this.getCachedData();
    }

    if (this.cdfh.compressionMethod === CompressionMethod.NONE) {
      return this.fileData.extractData(this.dataSource);
    } else if (this.cdfh.compressionMethod === CompressionMethod.DEFLATED) {
      return this.inflateCompressedData();
    } else {
      throw new Error(`Unsupported compression method: ${this.cdfh.compressionMethod}`);
    }
  }

  public generateCacheFilePath(cacheDir: string): string {
    // Combine size and CRC32 into a string
    const uniqueKey = `${this.size}:${this.lfh.crc32}`;
    // Hash the string to create a unique file name
    const hash = createHash('sha256').update(uniqueKey).digest('hex');

    // Return the full path to the cache file
    return path.join(cacheDir, hash);
  }

  public async cacheData(maxCacheSize: number, cacheDir: string): Promise<Buffer | string | undefined> {
    if (!this.fileData) {
      await this.init();
    }

    if (this.size >= maxCacheSize) {
      const cacheFile = this.generateCacheFilePath(cacheDir);
      if (fs.existsSync(cacheFile)) {
        return cacheFile;
      }

      await ensureDirectoryExists(path.dirname(cacheFile));
      const writeStream = fs.createWriteStream(cacheFile);
      const readStream = await this.createReadStream();

      try {
        await pipeline(readStream, writeStream);
        this.logger.info(`[AdvZlib.Entry] handleEntryData(): Cached large entry to ${cacheFile}`);
        this.cachePath = cacheFile;
        return cacheFile;
      } catch (err: any) {
        this.logger.error(`[AdvZlib.Entry] handleEntryData(): Failed to cache entry ${this.relPath}: ${err.message}`);
        return undefined;
      }
    } else {
      try {
        if (this.decompressedData) {
          return this.decompressedData;
        }

        const data = await this.read();
        if (data.length === 0) {
          this.logger.warn(`[AdvZlib.Entry] handleEntryData(): Entry ${this.relPath} is empty.`);
        }

        this.decompressedData = data;

        return data;
      } catch (err: any) {
        this.logger.error(`[AdvZlib.Entry] handleEntryData(): Failed to read entry ${this.relPath}: ${err.message}`);
        return undefined;
      }
    }
  }

  public async extract(dest: string): Promise<string> {
    if (!this.fileData) {
      await this.init();
    }

    if (this.isDirectory) {
      await ensureDirectoryExists(path.join(dest, this.name));
      this.logger.debug(`[AdvZlib.Entry] extract(): Extracted ${this.relPath} to ${dest}`);
      return path.join(dest, this.name);
    }

    dest = (await this.checkIfDestIsDir(dest)) ? path.join(dest, this.name) : dest;
    const readStream = await this.createReadStream();
    const writeStream = fs.createWriteStream(dest);

    await pipeline(readStream, writeStream);

    this.logger.debug(`[AdvZlib.Entry] extract(): Extracted ${this.relPath} to ${dest}`);

    return dest;
  }

  private async checkIfDestIsDir(dest: string): Promise<boolean> {
    return fs.promises
      .stat(dest)
      .then((stat) => stat.isDirectory())
      .catch(() => false);
  }

  private async getCachedData(): Promise<Buffer> {
    if (this.decompressedData) {
      return this.decompressedData;
    } else if (this.cachePath) {
      return fs.promises.readFile(this.cachePath);
    } else {
      throw new Error('No cached data found.');
    }
  }

  private async inflateCompressedData(): Promise<Buffer> {
    const compressedData = await this.fileData.extractData(this.dataSource);

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const inflater = zlib.createInflateRaw();
      const inputStream = new PassThrough({ highWaterMark: 64 * 1024 }); // 64 KB buffer size

      inputStream.end(compressedData);
      inputStream.pipe(inflater);

      inflater.on('data', (chunk) => chunks.push(chunk));
      inflater.on('end', () => {
        const decompressedData = Buffer.concat(chunks);

        inflater.close();
        inflater.removeAllListeners();
        inputStream.removeAllListeners();

        resolve(decompressedData);
      });
      inflater.on('error', (err) => {
        inflater.close();
        inflater.removeAllListeners();
        inputStream.removeAllListeners();
        reject(err);
      });
    });
  }

  private createInflateStream(): Readable {
    const compressedStream = this.fileData.createReadStream(this.dataSource);
    const inflaterStream = zlib.createInflateRaw();
    compressedStream.pipe(inflaterStream);

    return inflaterStream;
  }
}
