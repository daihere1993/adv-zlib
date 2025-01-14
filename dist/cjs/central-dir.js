"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CentralDir = void 0;
const node_assert_1 = __importDefault(require("node:assert"));
const node_fs_1 = __importDefault(require("node:fs"));
const cdfh_1 = require("./cdfh");
const entry_1 = require("./entry");
const eocd_1 = require("./eocd");
const utils_1 = require("./utils");
class CentralDir {
    constructor(src, opts) {
        this.src = src;
        this.logger = opts.logger;
        this.dataSource = opts.dataSource || src;
        if (Buffer.isBuffer(this.dataSource)) {
            // Assert the buffer size should under 50MB
            (0, node_assert_1.default)(this.dataSource.length < 50 * 1024 * 1024, 'The buffer size should under 50MB');
        }
    }
    async init() {
        const start = Date.now();
        const eocd = new eocd_1.EndOfCentralDirRecord(await this.extractEOCDBuffer());
        const end = Date.now();
        this.logger.info(`[AdvZlib.CentralDir] init(): Init EOCD in ${end - start}ms`);
        const start2 = Date.now();
        const cdfhs = await (0, utils_1.testMemoryUsage)('initCDFHs', async () => {
            return this.initCDFHs(eocd);
        }, this.logger);
        const end2 = Date.now();
        this.logger.info(`[AdvZlib.CentralDir] init(): Init CDFHs in ${end2 - start2}ms`);
        const start3 = Date.now();
        this.entries = await (0, utils_1.testMemoryUsage)('initEntries', async () => {
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
        const fd = Buffer.isBuffer(this.dataSource) ? this.dataSource : await node_fs_1.default.promises.open(this.dataSource, 'r');
        const stat = Buffer.isBuffer(fd) ? { size: fd.length } : await fd.stat();
        const eocdSize = Math.min(stat.size, eocd_1.EndOfCentralDirRecord.MAX_SIZE);
        const eocdBuf = Buffer.alloc(eocdSize);
        if (!Buffer.isBuffer(fd)) {
            await fd.read(eocdBuf, 0, eocdSize, stat.size - eocdSize);
            await fd.close();
        }
        else {
            fd.copy(eocdBuf, 0, stat.size - eocdSize, stat.size);
        }
        const signatureBuffer = Buffer.alloc(4);
        signatureBuffer.writeUInt32LE(eocd_1.EndOfCentralDirRecord.SIGNATURE);
        const signatureIndex = eocdBuf.indexOf(signatureBuffer);
        if (signatureIndex === -1) {
            throw new Error(`[AdvZlib.CentralDir] extractEOCDBuffer(): EOCD signature not found in ${this.src}`);
        }
        return eocdBuf.subarray(signatureIndex);
    }
    async initCDFHs(eocd) {
        const fd = Buffer.isBuffer(this.dataSource) ? this.dataSource : await node_fs_1.default.promises.open(this.dataSource, 'r');
        let offset = eocd.centralDirOffset;
        const defaultExtraFieldSize = 0xffff; // Max file name length
        const cdfhs = [];
        const shardSize = Math.min(cdfh_1.CentralDirFileHeader.MIN_SIZE + defaultExtraFieldSize, eocd.centralDirSize);
        const shardBuffer = Buffer.alloc(shardSize);
        while (offset < eocd.centralDirOffset + eocd.centralDirSize) {
            // Read the minimal fixed-size part of the header
            await this.read(fd, shardBuffer, 0, shardSize, offset);
            const cdfh = new cdfh_1.CentralDirFileHeader(shardBuffer);
            const extraSize = cdfh.fileNameLength + cdfh.extraFieldLength + cdfh.fileCommentLength;
            cdfhs.push(cdfh);
            offset += cdfh_1.CentralDirFileHeader.MIN_SIZE + extraSize;
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
            const entry = new entry_1.ZipEntry(this.dataSource, cdfh, { logger: this.logger, outerZipPath: this.src });
            entries.push(entry);
        }
        return entries;
    }
}
exports.CentralDir = CentralDir;
//# sourceMappingURL=central-dir.js.map