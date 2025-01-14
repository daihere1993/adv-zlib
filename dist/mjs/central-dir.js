import assert from 'node:assert';
import fs from 'node:fs';
import { CentralDirFileHeader } from './cdfh';
import { ZipEntry } from './entry';
import { EndOfCentralDirRecord } from './eocd';
import { testMemoryUsage } from './utils';
export class CentralDir {
    constructor(src, opts) {
        this.src = src;
        this.logger = opts.logger;
        this.dataSource = opts.dataSource || src;
        if (Buffer.isBuffer(this.dataSource)) {
            // Assert the buffer size should under 50MB
            assert(this.dataSource.length < 50 * 1024 * 1024, 'The buffer size should under 50MB');
        }
    }
    async init() {
        const start = Date.now();
        const eocd = new EndOfCentralDirRecord(await this.extractEOCDBuffer());
        const end = Date.now();
        this.logger.info(`[AdvZlib.CentralDir] init(): Init EOCD in ${end - start}ms`);
        const start2 = Date.now();
        const cdfhs = await testMemoryUsage('initCDFHs', async () => {
            return this.initCDFHs(eocd);
        }, this.logger);
        const end2 = Date.now();
        this.logger.info(`[AdvZlib.CentralDir] init(): Init CDFHs in ${end2 - start2}ms`);
        const start3 = Date.now();
        this.entries = await testMemoryUsage('initEntries', async () => {
            return this.initEntries(cdfhs);
        }, this.logger);
        const end3 = Date.now();
        this.logger.info(`[AdvZlib.CentralDir] init(): Init entries in ${end3 - start3}ms`);
    }
    /**
     * Extracts the EndOfCentralDirRecord from the given data source.
     *
     * If the data source is a file, it reads the last 22 bytes of the file (the minimum size of EOCD).
     * If the data source is a buffer, it copies the last 22 bytes of the buffer (the minimum size of EOCD).
     * Then it searches for the EOCD signature from the end of the buffer.
     * If the signature is found, it returns the buffer from the signature index to the end.
     * If the signature is not found, it throws an error.
     *
     * @returns A promise that resolves to the EndOfCentralDirRecord buffer
     */
    async extractEOCDBuffer() {
        const fd = Buffer.isBuffer(this.dataSource) ? this.dataSource : await fs.promises.open(this.dataSource, 'r');
        const stat = Buffer.isBuffer(fd) ? { size: fd.length } : await fd.stat();
        const eocdSize = Math.min(stat.size, EndOfCentralDirRecord.MAX_SIZE);
        const eocdBuf = Buffer.alloc(eocdSize);
        if (!Buffer.isBuffer(fd)) {
            await fd.read(eocdBuf, 0, eocdSize, stat.size - eocdSize);
            await fd.close();
        }
        else {
            fd.copy(eocdBuf, 0, stat.size - eocdSize, stat.size);
        }
        const signatureBuffer = Buffer.alloc(4);
        signatureBuffer.writeUInt32LE(EndOfCentralDirRecord.SIGNATURE);
        const signatureIndex = eocdBuf.indexOf(signatureBuffer);
        if (signatureIndex === -1) {
            throw new Error(`[AdvZlib.CentralDir] extractEOCDBuffer(): EOCD signature not found in ${this.src}`);
        }
        return eocdBuf.subarray(signatureIndex);
    }
    async initCDFHs(eocd) {
        const fd = Buffer.isBuffer(this.dataSource) ? this.dataSource : await fs.promises.open(this.dataSource, 'r');
        let offset = eocd.centralDirOffset;
        const defaultExtraFieldSize = 0xffff; // Max file name length
        const cdfhs = [];
        const shardSize = Math.min(CentralDirFileHeader.MIN_SIZE + defaultExtraFieldSize, eocd.centralDirSize);
        const shardBuffer = Buffer.alloc(shardSize);
        while (offset < eocd.centralDirOffset + eocd.centralDirSize) {
            // Read the minimal fixed-size part of the header
            await this.read(fd, shardBuffer, 0, shardSize, offset);
            const cdfh = new CentralDirFileHeader(shardBuffer);
            const extraSize = cdfh.fileNameLength + cdfh.extraFieldLength + cdfh.fileCommentLength;
            cdfhs.push(cdfh);
            offset += CentralDirFileHeader.MIN_SIZE + extraSize;
        }
        return cdfhs;
    }
    async read(fd, buffer, offset, length, position) {
        if (Buffer.isBuffer(fd)) {
            fd.copy(buffer, offset, position, position + length);
        }
        else {
            await fd.read(buffer, offset, length, position);
        }
    }
    async initEntries(cdfhs) {
        const entries = [];
        for (const cdfh of cdfhs) {
            const entry = new ZipEntry(this.dataSource, cdfh, { logger: this.logger, outerZipPath: this.src });
            entries.push(entry);
        }
        return entries;
    }
}
//# sourceMappingURL=central-dir.js.map