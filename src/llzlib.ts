import zlib from 'node:zlib';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { FdSlicer, StreamSlicer } from './fd-slicer';
import { Logger } from './types';

function readUInt64LE(buffer: Buffer, offset: number): number {
  // There is no native function for this, because we can't actually store 64-bit integers precisely.
  var lower32 = buffer.readUInt32LE(offset);
  var upper32 = buffer.readUInt32LE(offset + 4);
  // we can't use bitshifting here, because JavaScript bitshifting only works on 32-bit integers.
  return upper32 * 0x100000000 + lower32;
  // as long as we're bounds checking the result of this function against the total file size,
}

export const llzlib = {
  open: async (path: string): Promise<ZipFile> => {
    const fileHandle = await fs.open(path, 'r');
    const fdSlicer = new FdSlicer(fileHandle, { autoClose: true });
    const fileSize = await fs.stat(path).then((stat) => stat.size);

    return await ZipFile.fromReader(fdSlicer, fileSize);
  },

  /**
   * Create a ZipFile from an inflated stream of a nested zip entry using dynamic memory allocation.
   * @param streamFactory - A function that creates a new inflated stream (allows re-inflation on retry).
   * @param fileSize - The total size of the inflated stream.
   * @param options - The options for the capture.
   * @param options.defaultSize - The default size to cover most of the central directory.
   * @param options.retry - The number of retries with progressively larger buffers.
   * @param options.logger - Logger for debug output.
   * @returns The CentralDirectory and the size of the central directory (if larger than defaultSize).
   */
  createCdFromInflatedStream: async (
    streamFactory: () => Promise<Readable> | Readable,
    fileSize: number,
    options: { defaultSize: number; retry: number; logger: Logger },
  ): Promise<{ cd: CentralDirectory; cdSize?: number }> => {
    let cdBuffer: Buffer | null = null;
    const logger = options.logger ?? console;
    const retry = options.retry ?? 1;

    let eocd: EndOfCentralDirectoryRecord | null = null;
    let streamSlicer: StreamSlicer | null = null;
    let currentSize = options.defaultSize;

    // Dynamic retry: start with small buffer, re-inflate with larger buffer if needed
    for (let tryCount = 0; tryCount <= retry; tryCount++) {
      currentSize = options.defaultSize * Math.pow(2, tryCount);

      logger.debug(
        `Attempt ${tryCount + 1}: Using ring buffer with size: ${(currentSize / 1024 / 1024).toFixed(2)} MB`,
      );

      // Create a fresh stream for this attempt
      const stream = await streamFactory();

      // Stream through with ring buffer of current size
      streamSlicer = await StreamSlicer.fromStream(stream, { maxBufferSize: currentSize });

      // Try to find EOCD in the tail buffer
      const tailBuffer = streamSlicer.sliceLast(currentSize);

      try {
        eocd = await EndOfCentralDirectoryRecord.fromBuffer(tailBuffer, fileSize);
        logger.debug(`Found EOCD on attempt ${tryCount + 1}, EOCD size: ${eocd.size} bytes`);
        break; // Success! Exit retry loop
      } catch (error) {
        // EOCD not found in tail buffer
        if (tryCount >= retry) {
          throw new Error(
            `Failed to find the central directory, EOCD not found after ${tryCount + 1} attempts with sizes up to ${(currentSize / 1024 / 1024).toFixed(2)} MB`,
          );
        }
        logger.debug(
          `EOCD not found in ${(currentSize / 1024 / 1024).toFixed(2)} MB tail, will retry with larger buffer`,
        );
      }
    }

    if (!eocd || !streamSlicer) {
      throw new Error('EOCD not found');
    }

    let tailBuffer = streamSlicer.sliceLast(currentSize);

    // Determine where the CD starts in relation to the tail buffer
    let tailBufferStartOffset = fileSize - tailBuffer.length;

    // If CD starts before the tail buffer, we need to re-stream with a larger buffer
    if (eocd.centralDirOffset < tailBufferStartOffset) {
      // Calculate required buffer size: from CD start to end of file
      const requiredSize = fileSize - eocd.centralDirOffset;
      logger.debug(
        `Found EOCD, but CD starts at offset ${eocd.centralDirOffset} which is before the tail buffer. ` +
          `Re-streaming with buffer size: ${(requiredSize / 1024 / 1024).toFixed(2)} MB to capture entire CD + EOCD`,
      );

      // Re-stream with larger buffer to capture CD + EOCD
      const stream = await streamFactory();
      streamSlicer = await StreamSlicer.fromStream(stream, { maxBufferSize: requiredSize });
      tailBuffer = streamSlicer.sliceLast(requiredSize);
      tailBufferStartOffset = fileSize - tailBuffer.length;

      // Verify CD is now in the tail buffer
      if (eocd.centralDirOffset < tailBufferStartOffset) {
        throw new Error(
          `Failed to capture CD: CD offset ${eocd.centralDirOffset} is still before tail buffer start ${tailBufferStartOffset}`,
        );
      }
    }

    // CD should now be in the tail buffer, slice it out
    logger.debug(
      `CD is in the tail buffer, slicing from offset ${eocd.centralDirOffset} (size: ${(eocd.centralDirSize / 1024 / 1024).toFixed(2)} MB)`,
    );
    const cdStartOffsetInTailBuffer = eocd.centralDirOffset - tailBufferStartOffset;
    const cdEndOffsetInTailBuffer = cdStartOffsetInTailBuffer + eocd.centralDirSize;
    cdBuffer = tailBuffer.subarray(cdStartOffsetInTailBuffer, cdEndOffsetInTailBuffer);

    // CD buffer should start with central directory file header signature
    if (cdBuffer.readUInt32LE(0) !== 0x02014b50) {
      throw new Error('Invalid central directory file header signature');
    }

    // Extract EOCDR buffer (everything after the CD in the tail buffer)
    const eocdrBuffer = tailBuffer.subarray(cdEndOffsetInTailBuffer);

    // Combine CD and EOCDR buffers for CentralDirectory
    const cdWithEocdrBuffer = Buffer.concat([cdBuffer, eocdrBuffer]);

    // Clear references to allow GC
    streamSlicer = null;
    tailBuffer = null as any;
    cdBuffer = null;

    // Create a CentralDirectory object with the EOCD information we already have
    const cd = await CentralDirectory.fromBuffer(cdWithEocdrBuffer, fileSize);

    return { cd, cdSize: cd.centralDirSize > options.defaultSize ? cd.centralDirSize : undefined };
  },

  // createRawEntryReader: (inflatedStream: Readable, options: { maxSize: number }): Readable => {},
};

export class ZipFile {
  public fileSize!: number;
  public entryCount!: number;

  private reader: FdSlicer;
  private readEntryCursor!: number;

  constructor(reader: FdSlicer) {
    this.reader = reader;
  }

  static async fromReader(reader: FdSlicer, fileSize: number): Promise<ZipFile> {
    // Access eocdr(End of Central Directory Record)
    const eocdrWithoutCommentSize = 22;
    const maxCommentSize = 0xffff;
    const zip64EocdlFixedSize = 20; // Zip64 End of Central Directory Locator Size
    const zip64EocdrFixedSize = 56; // Zip64 End of Central Directory Record Size (minimum to read offset 48)
    const bufferSize = Math.min(
      fileSize,
      eocdrWithoutCommentSize + zip64EocdlFixedSize + zip64EocdrFixedSize + maxCommentSize,
    );
    const buffer = Buffer.alloc(bufferSize);
    const bufferReadStart = fileSize - bufferSize;

    // Till `zipFile.close()` to unref() this reader
    reader.ref();
    await reader.read(buffer, 0, bufferSize, bufferReadStart);
    const cd = await CentralDirectory.fromBuffer(buffer, fileSize);
    const zipFile = new ZipFile(reader);
    zipFile.fileSize = fileSize;
    zipFile.entryCount = cd.entryCount;
    zipFile.readEntryCursor = cd.centralDirOffset;

    return zipFile;
  }

  public async getEntryMetadatas(): Promise<ZipEntryMetadata[]> {
    const metadatas: ZipEntryMetadata[] = [];

    for (let i = 0; i < this.entryCount; i++) {
      const entry = await this.nextEntry();
      metadatas.push(entry);
    }

    return metadatas;
  }

  /**
   * Get the Central Directory by reading it into memory.
   * This is much faster than iterating through entries with nextEntry().
   * @returns A CentralDirectory object that can be used for in-memory search
   */
  public async getCentralDirectory(): Promise<CentralDirectory> {
    // First, read the EOCDR from the end of the file to get CD offset and size
    const eocdrWithoutCommentSize = 22;
    const maxCommentSize = 0xffff;
    const zip64EocdlFixedSize = 20; // Zip64 End of Central Directory Locator Size
    const zip64EocdrFixedSize = 56; // Zip64 End of Central Directory Record Size (minimum to read offset 48)
    const tailBufferSize = Math.min(
      this.fileSize,
      eocdrWithoutCommentSize + zip64EocdlFixedSize + zip64EocdrFixedSize + maxCommentSize,
    );
    const tailBuffer = Buffer.alloc(tailBufferSize);
    const tailBufferReadStart = this.fileSize - tailBufferSize;

    this.reader.ref();
    try {
      await this.reader.read(tailBuffer, 0, tailBufferSize, tailBufferReadStart);

      // Parse EOCDR from tail buffer to get CD offset and size
      // We use CentralDirectory.fromBuffer which internally parses the EOCDR
      const tempCd = await CentralDirectory.fromBuffer(tailBuffer, this.fileSize);
      const centralDirOffset = tempCd.centralDirOffset;
      const centralDirSize = tempCd.centralDirSize;

      // Calculate EOCDR size by reading it again (we need it to know the full size)
      // Actually, we can calculate: EOCDR is at the end, so we need to read from CD to end
      const cdEndOffset = centralDirOffset + centralDirSize;
      const eocdrSize = this.fileSize - cdEndOffset;

      // Read the entire CD + EOCDR buffer (from centralDirOffset to end of file)
      const cdWithEocdrSize = centralDirSize + eocdrSize;
      const cdWithEocdrBuffer = Buffer.alloc(cdWithEocdrSize);
      await this.reader.read(cdWithEocdrBuffer, 0, cdWithEocdrSize, centralDirOffset);

      // Create CentralDirectory from the full buffer (CD + EOCDR)
      return await CentralDirectory.fromBuffer(cdWithEocdrBuffer, this.fileSize);
    } finally {
      this.reader.unref();
    }
  }

  public async nextEntry(): Promise<ZipEntry> {
    const entry = await ZipEntry.fromReader(this.reader, this.readEntryCursor);
    this.readEntryCursor += entry.size;
    return entry;
  }

  public getReader(): FdSlicer {
    return this.reader;
  }

  public close(): void {
    this.reader.unref();
  }
}

export class CentralDirectory {
  public size!: number;
  public fileSize!: number;
  public entryCount!: number;
  public centralDirOffset!: number;
  public centralDirSize!: number;

  // Note: The buffer contains the CD and EOCDR
  private buffer: Buffer;

  constructor(fileSize: number, buffer: Buffer) {
    this.fileSize = fileSize;
    this.buffer = buffer;
    this.size = buffer.length; // CD + EOCDR
  }

  static async fromBuffer(buffer: Buffer, fileSize: number): Promise<CentralDirectory> {
    const centralDirectory = new CentralDirectory(fileSize, buffer);

    const eocdr = await EndOfCentralDirectoryRecord.fromBuffer(buffer, fileSize);
    centralDirectory.entryCount = eocdr.entryCount;
    centralDirectory.centralDirOffset = eocdr.centralDirOffset;
    centralDirectory.centralDirSize = eocdr.centralDirSize;

    return centralDirectory;
  }

  public async getAllEntryMetadatas(): Promise<ZipEntryMetadata[]> {
    let readEntryCursor = 0;
    const entries: ZipEntryMetadata[] = [];

    for (let i = 0; i < this.entryCount; i++) {
      const entry = await ZipEntryMetadata.fromCdBuffer(this.buffer, readEntryCursor);
      readEntryCursor += entry.size;
      entries.push(entry);
    }

    return entries;
  }
}

class EndOfCentralDirectoryRecord {
  // The size of EOCDR
  public size!: number;
  public entryCount!: number;
  public centralDirOffset!: number;
  public centralDirSize!: number;

  static async fromBuffer(buffer: Buffer, fileSize: number): Promise<EndOfCentralDirectoryRecord> {
    const eocdrSignature = 0x06054b50;
    const eocdrFixedSize = 22;
    const zip64EocdlFixedSize = 20; // Zip64 End of Central Directory Locator Size
    const zip64EocdrFixedSize = 56; // Zip64 End of Central Directory Record Size (minimum to read offset 48)
    const bufferReadStart = fileSize - buffer.length;
    const eocdr = new EndOfCentralDirectoryRecord();

    for (let i = buffer.length - eocdrFixedSize; i >= 0; i--) {
      if (buffer.readUInt32LE(i) !== eocdrSignature) continue;

      const eocdrBuffer = buffer.subarray(i);
      // 0 - End of central directory signature = 0x06054b50
      // 4 - Number of this disks
      let diskNumber = eocdrBuffer.readUInt16LE(4);
      // 6 - Disk where central directory starts
      // 8 - Number of central directory records on this disk
      // 10 - Total number of central directory records
      eocdr.entryCount = eocdrBuffer.readUInt16LE(10);
      // 12 - Size of central directory (bytes)
      eocdr.centralDirSize = eocdrBuffer.readUInt32LE(12);
      // 16 - Offset of start of central directory, relative to start of archive
      eocdr.centralDirOffset = eocdrBuffer.readUInt32LE(16);
      // 20 - Comment length
      let commentSize = eocdrBuffer.readUInt16LE(20);

      eocdr.size = eocdrFixedSize + commentSize;

      // Check for ZIP64 by looking for the ZIP64 EOCDL signature (0x07064b50)
      // This is more reliable than checking sentinel values (0xffff, 0xffffffff)
      // because a ZIP64 file will always have the EOCDL structure present
      const hasZip64EocdlSignature =
        i >= zip64EocdlFixedSize && buffer.readUInt32LE(i - zip64EocdlFixedSize) === 0x07064b50;

      // Check if any sentinel values are present, which would indicate ZIP64 is required
      const hasSentinelValues =
        eocdr.entryCount === 0xffff || eocdr.centralDirSize === 0xffffffff || eocdr.centralDirOffset === 0xffffffff;

      // If sentinel values are present but ZIP64 EOCDL is missing, the file is corrupted
      if (hasSentinelValues && !hasZip64EocdlSignature) {
        throw new Error('Invalid end of central directory record, failed to find ZIP64 EOCDL');
      }

      const isZip64 = hasZip64EocdlSignature;
      if (isZip64) {
        // Zip64 End of Central Directory Locator Buffer
        const zip64EocdlBuffer = buffer.subarray(i - zip64EocdlFixedSize, i);
        // 4 - Number of the disk with the start of the ZIP64 EOCDR
        diskNumber = zip64EocdlBuffer.readUInt32LE(4);
        // 8 - Offset of the ZIP64 EOCDR
        const zip64EocdrOffset = readUInt64LE(zip64EocdlBuffer, 8);

        // Zip64 End of Central Directory Record Buffer
        // The ZIP64 EOCDR might be outside our current buffer, so we need to read it separately
        let zip64EocdrBuffer: Buffer;
        const zip64EocdrBufferOffset = zip64EocdrOffset - bufferReadStart;
        if (zip64EocdrBufferOffset >= 0 && zip64EocdrBufferOffset + zip64EocdrFixedSize <= buffer.length) {
          // ZIP64 EOCDR is within our current buffer
          zip64EocdrBuffer = buffer.subarray(zip64EocdrBufferOffset, zip64EocdrBufferOffset + zip64EocdrFixedSize);
        } else {
          throw new Error('ZIP64 EOCDR is outside our current buffer');
        }

        // 0 - Zip64 End of Central Directory Record signature = 0x06064b50
        if (zip64EocdrBuffer.readUInt32LE(0) !== 0x06064b50) {
          throw new Error('Invalid end of central directory record, failed to find ZIP64 EOCDR');
        }

        // 4 - Size of the ZIP64 EOCDR
        eocdr.size = zip64EocdrBuffer.readUInt32LE(4);
        // 32 - Total number of central directory records
        eocdr.entryCount = readUInt64LE(zip64EocdrBuffer, 32);
        // 40 - Size of central directory (bytes)
        eocdr.centralDirSize = readUInt64LE(zip64EocdrBuffer, 40);
        // 48 - Offset of start of central directory, relative to start of archive
        eocdr.centralDirOffset = readUInt64LE(zip64EocdrBuffer, 48);
      }

      if (diskNumber !== 0) {
        throw new Error('Do not support multi-disk zip files');
      }

      return eocdr;
    }

    throw new Error('Invalid end of central directory record');
  }
}

export class ZipEntryMetadata {
  // The size of the entry in the central directory
  public size!: number;
  public fileName!: string;
  public localFileHeaderOffset!: number;
  public versionNeededToExtract!: number;
  public generalPurposeBitFlag!: number;
  public compressionMethod!: number;
  public fileLastModificationTime!: number;
  public fileLastModificationDate!: number;
  public crc32!: number;
  public compressedSize!: number;
  public uncompressedSize!: number;
  public extraField!: Buffer;
  public fileComment!: string;

  static async fromCdBuffer(cdBuffer: Buffer, offset: number): Promise<ZipEntryMetadata> {
    const buffer = cdBuffer.subarray(offset, offset + 46);
    const metaData = new ZipEntryMetadata();
    const cdlfSizeFixedSize = 46;
    const cdlfSignature = 0x02014b50;
    // 0 - Central directory file header signature = 0x02014b50
    const signature = buffer.readUInt32LE(0);
    if (signature !== cdlfSignature) {
      throw new Error('Invalid central directory file header signature');
    }
    // 4 - Version made by
    // 6 - Version needed to extract
    metaData.versionNeededToExtract = buffer.readUInt16LE(6);
    // 8 - General purpose bit flag
    metaData.generalPurposeBitFlag = buffer.readUInt16LE(8);
    // 10 - Compression method
    metaData.compressionMethod = buffer.readUInt16LE(10);
    // 12 - File last modification time
    metaData.fileLastModificationTime = buffer.readUInt16LE(12);
    // 14 - File last modification date
    metaData.fileLastModificationDate = buffer.readUInt16LE(14);
    // 16 - CRC-32
    metaData.crc32 = buffer.readUInt32LE(16);
    // 20 - Compressed size
    metaData.compressedSize = buffer.readUInt32LE(20);
    // 24 - Uncompressed size
    metaData.uncompressedSize = buffer.readUInt32LE(24);
    // 28 - File name length
    const fileNameLength = buffer.readUInt16LE(28);
    // 30 - Extra field length
    const extraFieldLength = buffer.readUInt16LE(30);
    // 32 - File comment length
    const fileCommentLength = buffer.readUInt16LE(32);
    // 34 - Disk number where file starts
    // 36 - Internal file attributes
    // 38 - External file attributes
    // 42 - Local file header offset
    metaData.localFileHeaderOffset = buffer.readUInt32LE(42);

    const fileNameBuffer = cdBuffer.subarray(offset + 46, offset + 46 + fileNameLength);
    metaData.fileName = fileNameBuffer.toString('utf-8');

    // Read the variable-length fields (file name, extra field, file comment)
    const variableFieldsLength = fileNameLength + extraFieldLength + fileCommentLength;
    metaData.size = cdlfSizeFixedSize + variableFieldsLength;

    return metaData;
  }
}

export class ZipEntry extends ZipEntryMetadata {
  private reader: FdSlicer;

  constructor(reader: FdSlicer) {
    super();
    this.reader = reader;
  }

  /**
   * Create a ZipEntry from an already-parsed ZipEntryMetadata.
   * This avoids redundant disk I/O when metadata is already in memory.
   */
  static fromMetadata(reader: FdSlicer, metadata: ZipEntryMetadata): ZipEntry {
    const entry = new ZipEntry(reader);
    entry.size = metadata.size;
    entry.fileName = metadata.fileName;
    entry.localFileHeaderOffset = metadata.localFileHeaderOffset;
    entry.versionNeededToExtract = metadata.versionNeededToExtract;
    entry.generalPurposeBitFlag = metadata.generalPurposeBitFlag;
    entry.compressionMethod = metadata.compressionMethod;
    entry.fileLastModificationTime = metadata.fileLastModificationTime;
    entry.fileLastModificationDate = metadata.fileLastModificationDate;
    entry.crc32 = metadata.crc32;
    entry.compressedSize = metadata.compressedSize;
    entry.uncompressedSize = metadata.uncompressedSize;
    entry.extraField = metadata.extraField;
    entry.fileComment = metadata.fileComment;
    return entry;
  }

  static async fromReader(reader: FdSlicer, offset: number): Promise<ZipEntry> {
    try {
      const cdlfSizeFixedSize = 46;
      const entry = new ZipEntry(reader);

      // First, read the fixed-size header to determine variable field lengths
      const fixedBuffer = Buffer.alloc(cdlfSizeFixedSize);
      reader.ref();
      await reader.read(fixedBuffer, 0, cdlfSizeFixedSize, offset);

      // 28 - File name length
      const fileNameLength = fixedBuffer.readUInt16LE(28);
      // 30 - Extra field length
      const extraFieldLength = fixedBuffer.readUInt16LE(30);
      // 32 - File comment length
      const fileCommentLength = fixedBuffer.readUInt16LE(32);

      const variableFieldsLength = fileNameLength + extraFieldLength + fileCommentLength;
      const totalSize = cdlfSizeFixedSize + variableFieldsLength;

      // Read the entire entry (fixed + variable fields) into a buffer
      const entryBuffer = Buffer.alloc(totalSize);
      try {
        reader.ref();
        await reader.read(entryBuffer, 0, totalSize, offset);
      } finally {
        reader.unref();
      }

      // Reuse the parsing logic from ZipEntryMetadata
      const metadata = await ZipEntryMetadata.fromCdBuffer(entryBuffer, 0);

      // Copy all metadata properties to the entry
      entry.size = metadata.size;
      entry.fileName = metadata.fileName;
      entry.localFileHeaderOffset = metadata.localFileHeaderOffset;
      entry.versionNeededToExtract = metadata.versionNeededToExtract;
      entry.generalPurposeBitFlag = metadata.generalPurposeBitFlag;
      entry.compressionMethod = metadata.compressionMethod;
      entry.fileLastModificationTime = metadata.fileLastModificationTime;
      entry.fileLastModificationDate = metadata.fileLastModificationDate;
      entry.crc32 = metadata.crc32;
      entry.compressedSize = metadata.compressedSize;
      entry.uncompressedSize = metadata.uncompressedSize;
      entry.extraField = metadata.extraField;
      entry.fileComment = metadata.fileComment;

      return entry;
    } finally {
      reader.unref();
    }
  }

  /**
   * Create a read stream for the zip entry, it would be inflated if it has been deflated.
   */
  public async createReadStream(): Promise<Readable> {
    const localFileHeader = await LocalFileHeader.fromReader(this.reader, this.localFileHeaderOffset);

    // Use compressedSize from the central directory (this.compressedSize) instead of the
    // local file header, as streaming zip creation may leave the local header with zeros
    const compressedSize = this.compressedSize || localFileHeader.compressedSize;

    const readStream = this.reader.createReadStream({
      start: localFileHeader.localFileDataStartOffset,
      end: localFileHeader.localFileDataStartOffset + compressedSize,
    });

    if (this.compressionMethod === 0) {
      // 0 - The file is stored (no compression)
      return readStream;
    } else if (this.compressionMethod === 8) {
      // 8 - The file is Deflated
      const inflateStream = zlib.createInflateRaw();
      // Properly handle errors: if source stream errors, propagate to destination
      readStream.on('error', (err) => {
        inflateStream.destroy(err);
      });
      readStream.pipe(inflateStream);
      return inflateStream;
    } else {
      throw new Error(`Unsupported compression method: ${this.compressionMethod}`);
    }
  }

  private async readLocalFileHeader(): Promise<void> {}
}

export class LocalFileHeader {
  public versionNeededToExtract!: number;
  public generalPurposeBitFlag!: number;
  public compressionMethod!: number;
  public fileLastModificationTime!: number;
  public fileLastModificationDate!: number;
  public crc32!: number;
  public compressedSize!: number;
  public uncompressedSize!: number;
  public fileName!: string;
  public extraField!: Buffer;
  public localFileDataStartOffset!: number;

  static async fromReader(reader: FdSlicer, offset: number): Promise<LocalFileHeader> {
    try {
      // Fixed size of local file header
      const lfhFixedSize = 30;
      const lfhSignature = 0x04034b50;
      const lfhFixedBuffer = Buffer.alloc(lfhFixedSize);
      const localFileHeader = new LocalFileHeader();
      reader.ref();
      await reader.read(lfhFixedBuffer, 0, lfhFixedSize, offset);

      // 0 - Local file header signature = 0x04034b50
      const signature = lfhFixedBuffer.readUInt32LE(0);
      if (signature !== lfhSignature) {
        throw new Error('Invalid local file header signature');
      }
      // 4 - Version needed to extract
      localFileHeader.versionNeededToExtract = lfhFixedBuffer.readUInt16LE(4);
      // 6 - General purpose bit flag
      localFileHeader.generalPurposeBitFlag = lfhFixedBuffer.readUInt16LE(6);
      // 8 - Compression method
      localFileHeader.compressionMethod = lfhFixedBuffer.readUInt16LE(8);
      // 10 - File last modification time
      localFileHeader.fileLastModificationTime = lfhFixedBuffer.readUInt16LE(10);
      // 12 - File last modification date
      localFileHeader.fileLastModificationDate = lfhFixedBuffer.readUInt16LE(12);
      // 14 - CRC-32
      localFileHeader.crc32 = lfhFixedBuffer.readUInt32LE(14);
      // 18 - Compressed size
      localFileHeader.compressedSize = lfhFixedBuffer.readUInt32LE(18);
      // 22 - Uncompressed size
      localFileHeader.uncompressedSize = lfhFixedBuffer.readUInt32LE(22);
      // 26 - File name length
      const fileNameLength = lfhFixedBuffer.readUInt16LE(26);
      // 28 - Extra field length
      const extraFieldLength = lfhFixedBuffer.readUInt16LE(28);
      localFileHeader.localFileDataStartOffset = offset + lfhFixedSize + fileNameLength + extraFieldLength;

      try {
        reader.ref();
        const lfhLeftBuffer = Buffer.alloc(fileNameLength + extraFieldLength);
        await reader.read(lfhLeftBuffer, 0, lfhLeftBuffer.length, offset + lfhFixedSize);
        const fileName = lfhLeftBuffer.subarray(0, fileNameLength).toString('utf-8');
        const extraField = lfhLeftBuffer.subarray(fileNameLength, fileNameLength + extraFieldLength);
        localFileHeader.fileName = fileName;
        localFileHeader.extraField = extraField;

        return localFileHeader;
      } finally {
        reader.unref();
      }
    } finally {
      reader.unref();
    }
  }
}
