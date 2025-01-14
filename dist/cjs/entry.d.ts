import { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { CentralDirFileHeader } from './cdfh';
import { Logger } from './types';
export interface EntryOptions {
    logger: Logger;
    outerZipPath: string;
}
export declare class LocalFileHeader {
    static MIN_SIZE: number;
    static SIGNATURE: number;
    totalSize: number;
    fileNameLength: number;
    extraFieldLength: number;
    constructor(minimalData: Buffer);
}
export declare class FileData {
    readonly lfh: LocalFileHeader;
    readonly cdfh: CentralDirFileHeader;
    constructor(lfh: LocalFileHeader, cdfh: CentralDirFileHeader);
    createReadStream(src: string | Buffer): Readable;
    extractData(src: string | Buffer): Promise<Buffer>;
    extractDataFromFd(fd: FileHandle): Promise<Buffer>;
    extractDataFromBuffer(zipBuffer: Buffer): Buffer;
}
export declare class ZipEntry {
    get relPath(): string;
    get name(): string;
    get size(): number;
    get fullPath(): string;
    get isDirectory(): boolean;
    private logger;
    private dataSource;
    private cdfh;
    private lfh;
    private fileData;
    private cachePath?;
    private decompressedData?;
    private outerZipPath;
    get isCached(): boolean;
    constructor(dataSource: string | Buffer, cdfh: CentralDirFileHeader, opts: EntryOptions);
    init(): Promise<void>;
    private readLocalFileHeader;
    createReadStream(): Promise<Readable>;
    /**
     * 如果 entry data 特别的大，直接使用 read 来获取完整的 buffer 会导致内存的 spike
     * 最好提供一个 stream 接口供用户自己处理
     */
    read(): Promise<Buffer>;
    extract(dest: string): Promise<string>;
    onCache(cache: Buffer | string): void;
    private checkIfDestIsDir;
    private getCachedData;
    private inflateCompressedData;
    private createInflateStream;
}
