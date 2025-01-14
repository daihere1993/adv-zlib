import assert from 'node:assert';
import path from 'node:path';
export class CentralDirFileHeader {
    get fileName() {
        if (!this.fileNameBuffer)
            return '';
        // Normalize the file name to accommodate windows as the separator always be "/"
        // normalize() would consume more memory that is why we do it on-demand
        return path.normalize(this.fileNameBuffer.toString('utf8'));
    }
    constructor(minimalData) {
        assert(minimalData.readUInt32LE(0) === CentralDirFileHeader.SIGNATURE, 'The signature is not correct');
        this.compressionMethod = minimalData.readUInt16LE(10);
        this.compressedSize = minimalData.readUInt32LE(20);
        this.fileNameLength = minimalData.readUInt16LE(28);
        this.extraFieldLength = minimalData.readUInt16LE(30);
        this.fileCommentLength = minimalData.readUInt16LE(32);
        this.localFileHeaderOffset = minimalData.readUInt32LE(42);
        if (this.fileNameLength > 0) {
            this.fileNameBuffer = Buffer.from(Buffer.prototype.slice.call(minimalData, CentralDirFileHeader.MIN_SIZE, CentralDirFileHeader.MIN_SIZE + this.fileNameLength));
        }
    }
}
CentralDirFileHeader.SIGNATURE = 0x02014b50;
CentralDirFileHeader.MIN_SIZE = 46;
//# sourceMappingURL=cdfh.js.map