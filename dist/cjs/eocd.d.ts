export declare class EndOfCentralDirRecord {
    static SIGNATURE: number;
    static MAX_COMMENT_SIZE: number;
    static MIN_SIZE: number;
    static MAX_SIZE: number;
    diskNumber: number;
    diskWithCentralDir: number;
    diskEntries: number;
    totalEntries: number;
    centralDirSize: number;
    centralDirOffset: number;
    commentLength: number;
    comment: string;
    constructor(data: Buffer);
}
