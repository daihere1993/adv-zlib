export declare class CentralDirFileHeader {
    static SIGNATURE: number;
    static MIN_SIZE: number;
    compressionMethod: number;
    compressedSize: number;
    fileNameLength: number;
    extraFieldLength: number;
    fileCommentLength: number;
    localFileHeaderOffset: number;
    get fileName(): string;
    private fileNameBuffer?;
    constructor(minimalData: Buffer);
}
