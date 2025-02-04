import fs from 'node:fs';
import { FileHandle } from 'node:fs/promises';
import { CentralDirFileHeader } from './cdfh.js';
import { ZipEntry } from './entry.js';
import { BaseEndOfCentralDirRecord, EndOfCentralDirRecord, Zip64EndOfCentralDirRecord } from './eocd.js';
import { Logger } from './types.js';
import { testMemoryUsage } from './utils.js';

export interface CentralDirOptions {
  logger: Logger;
  dataSource?: string | Buffer;
}

export class CentralDir {
  public src!: string;
  public entries!: ZipEntry[];
  private logger!: Logger;

  /**
   * dataSource:
   * - If it is an outer zip, it will be a file path.
   * - If it is an inner zip, there are two cases:
   *   - If the size exceeds 50MB, it will be a file path.
   *   - If the size does not exceed 50MB, it will be a buffer.
   */
  private dataSource!: string | Buffer;

  constructor(src: string, opts: CentralDirOptions) {
    this.src = src;
    this.logger = opts.logger;
    this.dataSource = opts.dataSource || src;

    if (Buffer.isBuffer(this.dataSource)) {
      if (this.dataSource.length > 50 * 1024 * 1024) {
        throw new Error('The buffer size should under 50MB');
      }
    }
  }

  public async init() {
    const fd = Buffer.isBuffer(this.dataSource) ? this.dataSource : await fs.promises.open(this.dataSource, 'r');

    const start = Date.now();
    const eocd = await this.getEOCD(fd);

    if (!eocd) throw new Error('[AdvZlib.CentralDir] init(): No EOCD record found');

    const end = Date.now();
    this.logger.info(`[AdvZlib.CentralDir] init(): Init EOCD in ${end - start}ms`);

    const start2 = Date.now();
    const cdfhs = await testMemoryUsage(
      'initCDFHs',
      async () => {
        return this.initCDFHs(eocd);
      },
      this.logger
    );
    const end2 = Date.now();
    this.logger.info(`[AdvZlib.CentralDir] init(): Init ${cdfhs.length} CDFHs in ${end2 - start2}ms`);

    const start3 = Date.now();
    this.entries = await testMemoryUsage(
      'initEntries',
      async () => {
        return this.initEntries(cdfhs);
      },
      this.logger
    );
    const end3 = Date.now();
    this.logger.info(`[AdvZlib.CentralDir] init(): Init entries in ${end3 - start3}ms`);

    if (!Buffer.isBuffer(fd)) {
      await fd.close();
    }
  }

  // Need to consider zip64 EOCD
  private async getEOCD(fd: Buffer | FileHandle): Promise<BaseEndOfCentralDirRecord | undefined> {
    const zip64EocdlSize = 20;
    const totalSize = Buffer.isBuffer(fd) ? fd.length : (await fd.stat()).size;
    const maxEOCDSize = EndOfCentralDirRecord.MIN_SIZE + EndOfCentralDirRecord.MAX_COMMENT_SIZE + zip64EocdlSize;
    const eocdSize = Math.min(totalSize, maxEOCDSize);
    const eocdMaxBuf = Buffer.alloc(eocdSize);

    await this.read(fd, eocdMaxBuf, totalSize - eocdSize, eocdSize);

    for (let i = eocdSize - 4; i >= 0; i--) {
      if (eocdMaxBuf.readUInt32LE(i) !== EndOfCentralDirRecord.SIGNATURE) continue;

      const eocdrOffset = i;
      const eocdBuf = eocdMaxBuf.subarray(eocdrOffset);
      let eocd = new EndOfCentralDirRecord(eocdBuf);
      if (eocd.centralDirOffset === 0xffffffff) {
        const eocdlOffset = eocdrOffset - zip64EocdlSize;
        if (eocdlOffset < 0) throw new Error('Invalid EOCD location offset');

        const zip64EocdOffset = eocdMaxBuf.readUInt32LE(eocdlOffset + 8);
        const zip64EocdBuf = Buffer.alloc(Zip64EndOfCentralDirRecord.SIZE);
        await this.read(fd, zip64EocdBuf, zip64EocdOffset, Zip64EndOfCentralDirRecord.SIZE);
        eocd = new Zip64EndOfCentralDirRecord(zip64EocdBuf);
      }

      return eocd;
    }
  }

  private async initCDFHs(eocd: EndOfCentralDirRecord): Promise<CentralDirFileHeader[]> {
    const fd = Buffer.isBuffer(this.dataSource) ? this.dataSource : await fs.promises.open(this.dataSource, 'r');

    let offset = eocd.centralDirOffset;
    const defaultExtraFieldSize = 0xffff; // Max file name length
    const cdfhs: CentralDirFileHeader[] = [];
    const shardSize = Math.min(CentralDirFileHeader.MIN_SIZE + defaultExtraFieldSize, eocd.centralDirSize);
    const shardBuffer = Buffer.alloc(shardSize);

    while (offset < eocd.centralDirOffset + eocd.centralDirSize) {
      // Read the minimal fixed-size part of the header
      await this.read(fd, shardBuffer, offset, shardSize);
      const cdfh = new CentralDirFileHeader(shardBuffer);
      const extraSize = cdfh.fileNameLength + cdfh.extraFieldLength + cdfh.fileCommentLength;

      cdfhs.push(cdfh);
      offset += CentralDirFileHeader.MIN_SIZE + extraSize;
    }

    return cdfhs;
  }

  private async read(fd: Buffer | FileHandle, buffer: Buffer, offset: number, length: number) {
    if (Buffer.isBuffer(fd)) {
      fd.copy(buffer, 0, offset, offset + length);
    } else {
      await fd.read(buffer, 0, length, offset);
    }
  }

  private async initEntries(cdfhs: CentralDirFileHeader[]): Promise<ZipEntry[]> {
    const entries: ZipEntry[] = [];

    for (const cdfh of cdfhs) {
      const entry = new ZipEntry(this.dataSource, cdfh, { logger: this.logger, outerZipPath: this.src });
      entries.push(entry);
    }

    return entries;
  }
}
