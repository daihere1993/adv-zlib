"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ZipEntry = exports.FileData = exports.LocalFileHeader = void 0;
const node_assert_1 = __importDefault(require("node:assert"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_stream_1 = require("node:stream");
const promises_1 = require("node:stream/promises");
const node_zlib_1 = __importDefault(require("node:zlib"));
const utils_1 = require("./utils");
var CompressionMethod;
(function (CompressionMethod) {
    CompressionMethod[CompressionMethod["NONE"] = 0] = "NONE";
    CompressionMethod[CompressionMethod["DEFLATED"] = 8] = "DEFLATED";
})(CompressionMethod || (CompressionMethod = {}));
class LocalFileHeader {
    constructor(minimalData) {
        (0, node_assert_1.default)(minimalData.length === LocalFileHeader.MIN_SIZE, 'The buffer size should be 30');
        (0, node_assert_1.default)(minimalData.readUInt32LE(0) === LocalFileHeader.SIGNATURE, 'The signature is not correct');
        this.fileNameLength = minimalData.readUInt16LE(26);
        this.extraFieldLength = minimalData.readUInt16LE(28);
        this.totalSize = LocalFileHeader.MIN_SIZE + this.fileNameLength + this.extraFieldLength;
    }
}
exports.LocalFileHeader = LocalFileHeader;
LocalFileHeader.MIN_SIZE = 30;
LocalFileHeader.SIGNATURE = 0x04034b50;
class FileData {
    constructor(lfh, cdfh) {
        this.lfh = lfh;
        this.cdfh = cdfh;
    }
    createReadStream(src) {
        if (Buffer.isBuffer(src)) {
            return node_stream_1.Readable.from(this.extractDataFromBuffer(src));
        }
        if (!src.endsWith('.zip')) {
            throw new Error(`The file ${src} is not a zip file.`);
        }
        if (!node_fs_1.default.existsSync(src)) {
            throw new Error(`The file ${src} does not exist.`);
        }
        const offset = this.cdfh.localFileHeaderOffset + this.lfh.totalSize;
        return node_fs_1.default.createReadStream(src, {
            start: offset,
            end: offset + this.cdfh.compressedSize,
        });
    }
    async extractData(src) {
        if (Buffer.isBuffer(src)) {
            return this.extractDataFromBuffer(src);
        }
        if (!src.endsWith('.zip')) {
            throw new Error(`The file ${src} is not a zip file.`);
        }
        if (!node_fs_1.default.existsSync(src)) {
            throw new Error(`The file ${src} does not exist.`);
        }
        return this.extractDataFromFd(await node_fs_1.default.promises.open(src, 'r'));
    }
    async extractDataFromFd(fd) {
        const buffer = Buffer.alloc(this.cdfh.compressedSize);
        const offset = this.cdfh.localFileHeaderOffset + this.lfh.totalSize;
        await fd.read(buffer, 0, this.cdfh.compressedSize, offset);
        return buffer;
    }
    extractDataFromBuffer(zipBuffer) {
        const buffer = Buffer.alloc(this.cdfh.compressedSize);
        const offset = this.cdfh.localFileHeaderOffset + this.lfh.totalSize;
        zipBuffer.copy(buffer, 0, offset, offset + this.cdfh.compressedSize);
        return buffer;
    }
}
exports.FileData = FileData;
class ZipEntry {
    get relPath() {
        return this.cdfh.fileName;
    }
    get name() {
        return node_path_1.default.basename(this.relPath);
    }
    get size() {
        return this.cdfh.compressedSize;
    }
    get fullPath() {
        return node_path_1.default.join(this.outerZipPath, this.relPath);
    }
    get isDirectory() {
        return this.relPath.endsWith('/') || this.relPath.endsWith('\\');
    }
    get isCached() {
        return !!this.cachePath || !!this.decompressedData;
    }
    constructor(dataSource, cdfh, opts) {
        if (!cdfh) {
            throw new Error('CentralDirFileHeader is empty.');
        }
        this.cdfh = cdfh;
        this.logger = opts.logger;
        this.dataSource = dataSource;
        this.outerZipPath = opts.outerZipPath;
    }
    async init() {
        const { localFileHeaderOffset } = this.cdfh;
        const fd = Buffer.isBuffer(this.dataSource) ? null : await node_fs_1.default.promises.open(this.dataSource, 'r');
        const minimalLFHBuffer = await this.readLocalFileHeader(fd, localFileHeaderOffset);
        this.lfh = new LocalFileHeader(minimalLFHBuffer);
        this.fileData = new FileData(this.lfh, this.cdfh);
    }
    async readLocalFileHeader(fd, offset) {
        const buffer = Buffer.alloc(LocalFileHeader.MIN_SIZE);
        if (fd) {
            await fd.read(buffer, 0, LocalFileHeader.MIN_SIZE, offset);
        }
        else {
            this.dataSource.copy(buffer, 0, offset, offset + LocalFileHeader.MIN_SIZE);
        }
        return buffer;
    }
    async createReadStream() {
        if (!this.fileData) {
            await this.init();
        }
        if (this.isCached) {
            if (this.decompressedData) {
                return node_stream_1.Readable.from(this.decompressedData);
            }
            else {
                return node_fs_1.default.createReadStream(this.cachePath);
            }
        }
        if (this.cdfh.compressionMethod === CompressionMethod.NONE) {
            if (Buffer.isBuffer(this.dataSource)) {
                return node_stream_1.Readable.from(this.dataSource);
            }
            else {
                return node_fs_1.default.createReadStream(this.dataSource);
            }
        }
        else if (this.cdfh.compressionMethod === CompressionMethod.DEFLATED) {
            return this.createInflateStream();
        }
        else {
            throw new Error(`Unsupported compression method: ${this.cdfh.compressionMethod}`);
        }
    }
    /**
     * 如果 entry data 特别的大，直接使用 read 来获取完整的 buffer 会导致内存的 spike
     * 最好提供一个 stream 接口供用户自己处理
     */
    async read() {
        if (!this.fileData) {
            await this.init();
        }
        if (this.isCached) {
            return this.getCachedData();
        }
        if (this.cdfh.compressionMethod === CompressionMethod.NONE) {
            return this.fileData.extractData(this.dataSource);
        }
        else if (this.cdfh.compressionMethod === CompressionMethod.DEFLATED) {
            return this.inflateCompressedData();
        }
        else {
            throw new Error(`Unsupported compression method: ${this.cdfh.compressionMethod}`);
        }
    }
    async extract(dest) {
        if (!this.fileData) {
            await this.init();
        }
        if (this.isDirectory) {
            await (0, utils_1.ensureDirectoryExists)(node_path_1.default.join(dest, this.name));
            this.logger.debug(`[AdvZlib.Entry] extract(): Extracted ${this.relPath} to ${dest}`);
            return node_path_1.default.join(dest, this.name);
        }
        dest = await this.checkIfDestIsDir(dest) ? node_path_1.default.join(dest, this.name) : dest;
        const readStream = await this.createReadStream();
        const writeStream = node_fs_1.default.createWriteStream(dest);
        await (0, promises_1.pipeline)(readStream, writeStream);
        this.logger.debug(`[AdvZlib.Entry] extract(): Extracted ${this.relPath} to ${dest}`);
        return dest;
    }
    onCache(cache) {
        if (this.isCached) {
            return;
        }
        if (Buffer.isBuffer(cache)) {
            this.decompressedData = cache;
        }
        else {
            this.cachePath = cache;
        }
    }
    async checkIfDestIsDir(dest) {
        return node_fs_1.default.promises
            .stat(dest)
            .then((stat) => stat.isDirectory())
            .catch(() => false);
    }
    async getCachedData() {
        if (this.decompressedData) {
            return this.decompressedData;
        }
        else if (this.cachePath) {
            return node_fs_1.default.promises.readFile(this.cachePath);
        }
        else {
            throw new Error('No cached data found.');
        }
    }
    async inflateCompressedData() {
        const compressedData = await this.fileData.extractData(this.dataSource);
        return new Promise((resolve, reject) => {
            const chunks = [];
            const inflater = node_zlib_1.default.createInflateRaw();
            const inputStream = new node_stream_1.PassThrough({ highWaterMark: 64 * 1024 }); // 64 KB buffer size
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
    createInflateStream() {
        const compressedStream = this.fileData.createReadStream(this.dataSource);
        const inflaterStream = node_zlib_1.default.createInflateRaw();
        compressedStream.pipe(inflaterStream);
        return inflaterStream;
    }
}
exports.ZipEntry = ZipEntry;
//# sourceMappingURL=entry.js.map