export class EndOfCentralDirRecord {
  static SIGNATURE = 0x06054b50;
  static MAX_COMMENT_SIZE = 0xffff;
  static MIN_SIZE = 22;
  static MAX_SIZE = EndOfCentralDirRecord.MIN_SIZE + EndOfCentralDirRecord.MAX_COMMENT_SIZE;

  public diskNumber!: number;
  public diskWithCentralDir!: number;
  public diskEntries!: number;
  public totalEntries!: number;
  public centralDirSize!: number;
  public centralDirOffset!: number;
  public commentLength!: number;
  public comment!: string;

  constructor(data: Buffer) {
    this.diskNumber = data.readUInt16LE(4);
    this.diskWithCentralDir = data.readUInt16LE(6);
    this.diskEntries = data.readUInt16LE(8);
    this.totalEntries = data.readUInt16LE(10);
    this.centralDirSize = data.readUInt32LE(12);
    this.centralDirOffset = data.readUInt32LE(16);
    this.commentLength = data.readUInt16LE(20);
    this.comment = data.toString(
      'utf8',
      EndOfCentralDirRecord.MIN_SIZE,
      EndOfCentralDirRecord.MIN_SIZE + this.commentLength
    );
  }
}
