export class BaseEndOfCentralDirRecord {
  public centralDirSize!: number;
  public centralDirOffset!: number;
}

export class EndOfCentralDirRecord extends BaseEndOfCentralDirRecord {
  static SIGNATURE = 0x06054b50;
  static MAX_COMMENT_SIZE = 0xffff;
  static MIN_SIZE = 22;

  constructor(data: Buffer) {
    super();

    if (data.readUInt32LE(0) !== EndOfCentralDirRecord.SIGNATURE) {
      throw new Error('EndOfCentralDirRecord: The signature is not correct');
    }

    this.centralDirSize = data.readUInt32LE(12);
    this.centralDirOffset = data.readUInt32LE(16);
  }
}

export class Zip64EndOfCentralDirRecord extends BaseEndOfCentralDirRecord {
  static SIZE = 56;
  static SIGNATURE = 0x06064b50;

  constructor(data: Buffer) {
    super();

    if (data.readUInt32LE(0) !== Zip64EndOfCentralDirRecord.SIGNATURE) {
      throw new Error('EndOfCentralDirRecord: The signature is not correct');
    }

    this.centralDirSize = data.readUInt32LE(40);
    this.centralDirOffset = data.readUInt32LE(48);
  }
}
