"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CentralDirFileHeader = void 0;
const node_assert_1 = __importDefault(require("node:assert"));
const node_path_1 = __importDefault(require("node:path"));
class CentralDirFileHeader {
    get fileName() {
        if (!this.fileNameBuffer)
            return '';
        // Normalize the file name to accommodate windows as the separator always be "/"
        // normalize() would consume more memory that is why we do it on-demand
        return node_path_1.default.normalize(this.fileNameBuffer.toString('utf8'));
    }
    constructor(minimalData) {
        (0, node_assert_1.default)(minimalData.readUInt32LE(0) === CentralDirFileHeader.SIGNATURE, 'The signature is not correct');
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
exports.CentralDirFileHeader = CentralDirFileHeader;
CentralDirFileHeader.SIGNATURE = 0x02014b50;
CentralDirFileHeader.MIN_SIZE = 46;
//# sourceMappingURL=cdfh.js.map