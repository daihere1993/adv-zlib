import assert from 'node:assert';
import path from 'node:path';

export class CentralDirFileHeader {
  static SIGNATURE = 0x02014b50;
  static MIN_SIZE = 46;

  public compressionMethod!: number;
  public compressedSize!: number;
  public fileNameLength!: number;
  public extraFieldLength!: number;
  public fileCommentLength!: number;
  public localFileHeaderOffset!: number;
  public get fileName(): string {
    if (!this.fileNameBuffer) return '';
    // Normalize the file name to accommodate windows as the separator always be "/"
    // normalize() would consume more memory that is why we do it on-demand
    return path.normalize(this.fileNameBuffer.toString('utf8'));
  }

  // Instead of converting fileName to a string, store it as a Buffer and decode it on-demand.
  // This is to save memory.
  private fileNameBuffer?: Buffer;

  constructor(minimalData: Buffer) {
    if (minimalData.readUInt32LE(0) !== CentralDirFileHeader.SIGNATURE) {
      throw new Error('The signature is not correct');
    }

    this.compressionMethod = minimalData.readUInt16LE(10);
    this.compressedSize = minimalData.readUInt32LE(20);
    this.fileNameLength = minimalData.readUInt16LE(28);
    this.extraFieldLength = minimalData.readUInt16LE(30);
    this.fileCommentLength = minimalData.readUInt16LE(32);
    this.localFileHeaderOffset = minimalData.readUInt32LE(42);

    if (this.fileNameLength > 0) {
      this.fileNameBuffer = Buffer.from(
        Buffer.prototype.slice.call(
          minimalData,
          CentralDirFileHeader.MIN_SIZE,
          CentralDirFileHeader.MIN_SIZE + this.fileNameLength
        )
      );
    }
  }
}
