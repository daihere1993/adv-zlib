import { ZipEntry } from './entry';
import { Logger } from './types';
export interface CentralDirOptions {
    logger: Logger;
    dataSource?: string | Buffer;
}
export declare class CentralDir {
    src: string;
    entries: ZipEntry[];
    private logger;
    /**
     * dataSource:
     * - If it is an outer zip, it will be a file path.
     * - If it is an inner zip, there are two cases:
     *   - If the size exceeds 50MB, it will be a file path.
     *   - If the size does not exceed 50MB, it will be a buffer.
     */
    private dataSource;
    constructor(src: string, opts: CentralDirOptions);
    init(): Promise<void>;
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
    private extractEOCDBuffer;
    private initCDFHs;
    private read;
    private initEntries;
}
