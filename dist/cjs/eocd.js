"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EndOfCentralDirRecord = void 0;
class EndOfCentralDirRecord {
    constructor(data) {
        this.diskNumber = data.readUInt16LE(4);
        this.diskWithCentralDir = data.readUInt16LE(6);
        this.diskEntries = data.readUInt16LE(8);
        this.totalEntries = data.readUInt16LE(10);
        this.centralDirSize = data.readUInt32LE(12);
        this.centralDirOffset = data.readUInt32LE(16);
        this.commentLength = data.readUInt16LE(20);
        this.comment = data.toString('utf8', EndOfCentralDirRecord.MIN_SIZE, EndOfCentralDirRecord.MIN_SIZE + this.commentLength);
    }
}
exports.EndOfCentralDirRecord = EndOfCentralDirRecord;
EndOfCentralDirRecord.SIGNATURE = 0x06054b50;
EndOfCentralDirRecord.MAX_COMMENT_SIZE = 0xffff;
EndOfCentralDirRecord.MIN_SIZE = 22;
EndOfCentralDirRecord.MAX_SIZE = EndOfCentralDirRecord.MIN_SIZE + EndOfCentralDirRecord.MAX_COMMENT_SIZE;
//# sourceMappingURL=eocd.js.map