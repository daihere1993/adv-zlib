import { createReadStream, createWriteStream, ReadStream, promises as fs } from 'fs';
import { FileHandle, open, stat } from 'fs/promises';
import { PassThrough, Readable } from 'stream';
import { pipeline } from 'node:stream/promises';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

// =============================================================================
// TYPES AND INTERFACES
// =============================================================================

/**
 * Configuration options for AdvZlib
 */
export interface AdvZlibOptions {
  logger?: Logger;
  maxCentralDirCount?: number;
  maxCacheMemoryMB?: number;
  enableContentCaching?: boolean;
  maxContentCacheCount?: number;
  maxContentCacheMemoryMB?: number;
  maxContentCacheFileSizeMB?: number; // Max file size to cache in memory
  cacheBaseDir?: string; // Directory for disk cache
}

/**
 * Logger interface for debugging and monitoring
 */
export interface Logger {
  debug: (message: string, ...args: any[]) => void;
  info: (message: string, ...args: any[]) => void;
  warn: (message: string, ...args: any[]) => void;
  error: (message: string, ...args: any[]) => void;
}

// =============================================================================
// CACHE IMPLEMENTATION
// =============================================================================

/**
 * Cache entry for Central Directory information
 */
interface CacheEntry {
  centralDir: CentralDir;
  mtime: number; // File modification time for invalidation
  accessTime: number; // LRU tracking
  memorySize: number; // Estimated memory usage in bytes
}

/**
 * Cache entry for decompressed content
 */
interface DecompressedContentCacheEntry {
  content?: Buffer; // In-memory content (for small files)
  diskPath?: string; // Disk path (for large files)
  zipMtime: number; // ZIP file modification time for invalidation
  accessTime: number; // LRU tracking
  memorySize: number; // Memory usage (0 for disk-cached items)
  diskSize: number; // Actual content size (for both memory and disk)
  isOnDisk: boolean; // Whether content is stored on disk
}

/**
 * LRU cache for Central Directory records to improve performance
 */
class CentralDirCache {
  private cache = new Map<string, CacheEntry>();
  private totalMemoryBytes = 0;

  constructor(
    private maxEntries: number = 10,
    private maxMemoryBytes: number = 100 * 1024 * 1024, // 100MB default
    private logger: Logger = console
  ) {}

  async get(zipPath: string): Promise<CentralDir | null> {
    const entry = this.cache.get(zipPath);
    if (!entry) {
      return null;
    }

    // Update access time for LRU
    entry.accessTime = Date.now();

    this.logger.debug(`[CentralDirCache] Cache hit for ${zipPath}`);
    return entry.centralDir;
  }

  async set(zipPath: string, centralDir: CentralDir): Promise<void> {
    try {
      const memorySize = this.estimateMemorySize(centralDir);

      // Remove old entry if exists
      if (this.cache.has(zipPath)) {
        this.delete(zipPath);
      }

      // Ensure we have space (evict if necessary)
      await this.makeSpace(memorySize);

      const entry: CacheEntry = {
        centralDir,
        mtime: Date.now(), // Simple timestamp for LRU tracking
        accessTime: Date.now(),
        memorySize,
      };

      this.cache.set(zipPath, entry);
      this.totalMemoryBytes += memorySize;

      this.logger.debug(
        `[CentralDirCache] Cached ${zipPath}, memory: ${(memorySize / 1024 / 1024).toFixed(2)}MB, total: ${(
          this.totalMemoryBytes /
          1024 /
          1024
        ).toFixed(2)}MB`
      );
    } catch (error) {
      this.logger.warn(`[CentralDirCache] Failed to cache ${zipPath}: ${error}`);
    }
  }

  delete(zipPath: string): boolean {
    const entry = this.cache.get(zipPath);
    if (entry) {
      this.cache.delete(zipPath);
      this.totalMemoryBytes -= entry.memorySize;
      this.logger.debug(`[CentralDirCache] Removed ${zipPath} from cache`);
      return true;
    }
    return false;
  }

  clear(): void {
    this.cache.clear();
    this.totalMemoryBytes = 0;
    this.logger.debug(`[CentralDirCache] Cache cleared`);
  }

  private async makeSpace(neededBytes: number): Promise<void> {
    // Check if we need to evict entries
    while (this.cache.size >= this.maxEntries || this.totalMemoryBytes + neededBytes > this.maxMemoryBytes) {
      const oldestEntry = this.findLRUEntry();
      if (!oldestEntry) {
        break; // No entries to evict
      }

      this.logger.debug(`[CentralDirCache] Evicting LRU entry: ${oldestEntry.path}`);
      this.delete(oldestEntry.path);
    }
  }

  private findLRUEntry(): { path: string; accessTime: number } | null {
    let oldest: { path: string; accessTime: number } | null = null;

    for (const [path, entry] of Array.from(this.cache.entries())) {
      if (!oldest || entry.accessTime < oldest.accessTime) {
        oldest = { path, accessTime: entry.accessTime };
      }
    }

    return oldest;
  }

  private estimateMemorySize(centralDir: CentralDir): number {
    // Rough estimation based on entries count
    // Each entry has metadata, so approximately 1KB per entry + base overhead
    const baseSize = 10 * 1024; // 10KB base
    const perEntrySize = 1024; // 1KB per entry
    return baseSize + centralDir.entries.length * perEntrySize;
  }

  getStats(): { entries: number; memoryMB: number; hitRate?: number } {
    return {
      entries: this.cache.size,
      memoryMB: Number((this.totalMemoryBytes / 1024 / 1024).toFixed(2)),
    };
  }
}

/**
 * Cache for decompressed content with support for memory and disk storage
 */
class DecompressedContentCache {
  private cache = new Map<string, DecompressedContentCacheEntry>();
  private totalMemoryBytes = 0;
  private tempDir: string;
  private diskCacheFiles = new Set<string>(); // Track disk cache files for cleanup

  constructor(
    private maxEntries: number = 100,
    private maxMemoryBytes: number = 50 * 1024 * 1024, // 50MB default
    private maxFileSizeForMemory: number = 10 * 1024 * 1024, // 10MB default
    private tempDirPath: string = tmpdir(),
    private logger: Logger = console
  ) {
    this.tempDir = path.join(this.tempDirPath, 'adv-zlib-cache');
    this.ensureTempDir();
  }

  private async ensureTempDir(): Promise<void> {
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
    } catch (error) {
      this.logger.warn(`[DecompressedContentCache] Failed to create temp dir: ${error}`);
    }
  }

  /**
   * Generate cache key for a zip entry
   * Format: zipPath:mtime:entryRelPath:crc32
   */
  private generateCacheKey(zipPath: string, zipMtime: number, entryRelPath: string, crc32: number): string {
    return `${zipPath}:${zipMtime}:${entryRelPath}:${crc32}`;
  }

  async get(zipPath: string, zipMtime: number, entryRelPath: string, crc32: number): Promise<Buffer | null> {
    const key = this.generateCacheKey(zipPath, zipMtime, entryRelPath, crc32);
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // Check if ZIP file has been modified (cache invalidation)
    if (entry.zipMtime !== zipMtime) {
      this.logger.debug(`[DecompressedContentCache] ZIP modified, invalidating content cache for ${key}`);
      await this.delete(key);
      return null;
    }

    // Update access time for LRU
    entry.accessTime = Date.now();

    if (entry.isOnDisk) {
      // Read from disk
      if (!entry.diskPath) {
        this.logger.warn(`[DecompressedContentCache] Disk entry missing path for ${key}`);
        await this.delete(key);
        return null;
      }

      try {
        const diskContent = await fs.readFile(entry.diskPath);
        this.logger.debug(`[DecompressedContentCache] Cache hit (disk) for ${entryRelPath} (${(entry.diskSize / 1024).toFixed(1)}KB)`);
        return diskContent;
      } catch (error) {
        this.logger.warn(`[DecompressedContentCache] Failed to read disk cache for ${key}: ${error}`);
        await this.delete(key);
        return null;
      }
    } else {
      // Read from memory
      this.logger.debug(`[DecompressedContentCache] Cache hit (memory) for ${entryRelPath} (${(entry.memorySize / 1024).toFixed(1)}KB)`);
      return entry.content || null;
    }
  }

  async set(zipPath: string, zipMtime: number, entryRelPath: string, crc32: number, content: Buffer): Promise<void> {
    const key = this.generateCacheKey(zipPath, zipMtime, entryRelPath, crc32);
    const contentSize = content.length;

    // Remove old entry if exists
    if (this.cache.has(key)) {
      await this.delete(key);
    }

    // Decide whether to store in memory or disk
    const shouldStoreOnDisk = contentSize > this.maxFileSizeForMemory;

    if (shouldStoreOnDisk) {
      // Store on disk
      const diskPath = path.join(this.tempDir, `${randomUUID()}.cache`);
      
      try {
        await fs.writeFile(diskPath, content);
        this.diskCacheFiles.add(diskPath);

        const entry: DecompressedContentCacheEntry = {
          diskPath,
          zipMtime,
          accessTime: Date.now(),
          memorySize: 0,
          diskSize: contentSize,
          isOnDisk: true,
        };

        this.cache.set(key, entry);

        this.logger.debug(
          `[DecompressedContentCache] Cached ${entryRelPath} on disk, size: ${(contentSize / 1024).toFixed(1)}KB`
        );
      } catch (error) {
        this.logger.warn(`[DecompressedContentCache] Failed to cache ${entryRelPath} on disk: ${error}`);
      }
    } else {
      // Store in memory
      // Ensure we have space (evict if necessary)
      await this.makeSpace(contentSize);

      const entry: DecompressedContentCacheEntry = {
        content: Buffer.from(content), // Create a copy to avoid external modifications
        zipMtime,
        accessTime: Date.now(),
        memorySize: contentSize,
        diskSize: contentSize,
        isOnDisk: false,
      };

      this.cache.set(key, entry);
      this.totalMemoryBytes += contentSize;

      this.logger.debug(
        `[DecompressedContentCache] Cached ${entryRelPath} in memory, size: ${(contentSize / 1024).toFixed(1)}KB, total: ${(
          this.totalMemoryBytes /
          1024 /
          1024
        ).toFixed(2)}MB`
      );
    }
  }

  async delete(key: string): Promise<boolean> {
    const entry = this.cache.get(key);
    if (entry) {
      this.cache.delete(key);
      
      if (entry.isOnDisk && entry.diskPath) {
        // Clean up disk file
        try {
          await fs.unlink(entry.diskPath);
          this.diskCacheFiles.delete(entry.diskPath);
        } catch (error) {
          this.logger.warn(`[DecompressedContentCache] Failed to delete disk cache file: ${error}`);
        }
      } else {
        this.totalMemoryBytes -= entry.memorySize;
      }

      this.logger.debug(`[DecompressedContentCache] Removed ${key} from cache`);
      return true;
    }
    return false;
  }

  async clear(): Promise<void> {
    // Clean up all disk cache files
    const diskCleanupPromises = Array.from(this.diskCacheFiles).map(async (diskPath) => {
      try {
        await fs.unlink(diskPath);
      } catch (error) {
        this.logger.warn(`[DecompressedContentCache] Failed to cleanup disk file ${diskPath}: ${error}`);
      }
    });

    await Promise.all(diskCleanupPromises);
    this.diskCacheFiles.clear();

    this.cache.clear();
    this.totalMemoryBytes = 0;
    this.logger.debug(`[DecompressedContentCache] Cache cleared`);
  }

  /**
   * Invalidate all entries for a specific ZIP file
   */
  async invalidateZipFile(zipPath: string): Promise<void> {
    const keysToDelete: string[] = [];

    for (const [key, entry] of Array.from(this.cache.entries())) {
      if (key.startsWith(`${zipPath}:`)) {
        keysToDelete.push(key);
      }
    }

    await Promise.all(keysToDelete.map((key) => this.delete(key)));

    if (keysToDelete.length > 0) {
      this.logger.debug(`[DecompressedContentCache] Invalidated ${keysToDelete.length} entries for ${zipPath}`);
    }
  }

  private async makeSpace(neededBytes: number): Promise<void> {
    // Check if we need to evict entries (only for memory-based entries)
    while (this.cache.size >= this.maxEntries || this.totalMemoryBytes + neededBytes > this.maxMemoryBytes) {
      const oldestEntry = this.findLRUEntry();
      if (!oldestEntry) {
        break; // No entries to evict
      }

      this.logger.debug(`[DecompressedContentCache] Evicting LRU entry: ${oldestEntry.key} (${(oldestEntry.size / 1024).toFixed(1)}KB)`);
      await this.delete(oldestEntry.key);
    }
  }

  private findLRUEntry(): { key: string; accessTime: number; size: number } | null {
    let oldest: { key: string; accessTime: number; size: number } | null = null;

    for (const [key, entry] of Array.from(this.cache.entries())) {
      const size = entry.isOnDisk ? entry.diskSize : entry.memorySize;
      if (!oldest || entry.accessTime < oldest.accessTime) {
        oldest = { key, accessTime: entry.accessTime, size };
      }
    }

    return oldest;
  }

  getStats(): { entries: number; memoryMB: number; diskEntries: number; memoryEntries: number; hitRate?: number } {
    let diskEntries = 0;
    let memoryEntries = 0;

    for (const entry of Array.from(this.cache.values())) {
      if (entry.isOnDisk) {
        diskEntries++;
      } else {
        memoryEntries++;
      }
    }

    return {
      entries: this.cache.size,
      memoryMB: Number((this.totalMemoryBytes / 1024 / 1024).toFixed(2)),
      diskEntries,
      memoryEntries,
    };
  }
}

// =============================================================================
// ZIP FILE FORMAT CLASSES
// =============================================================================

/**
 * Base class for End of Central Directory Record
 */
export class BaseEndOfCentralDirRecord {
  public centralDirSize!: number;
  public centralDirOffset!: number;

  /**
   * Reads and parses the End of Central Directory Record from a ZIP file source.
   *
   * This method implements the industry-standard algorithm used by libzip, minizip,
   * Chromium's zip reader, Java's ZipFile, Python's zipfile, Go's archive/zip,
   * Rust's zip crate, and Node's yauzl.
   *
   * Algorithm:
   * 1. Read a scanning window from the end of the file (max 65,557 bytes)
   * 2. Use reverse Boyer-Moore-Horspool to efficiently scan for EOCD signature
   * 3. For each EOCD signature found, validate it by checking comment length
   * 4. If ZIP64 format detected, read the ZIP64 EOCD record
   *
   * @param source - The FileHandle or Buffer representing the ZIP file to read from
   * @returns Promise resolving to the parsed EOCD record (standard or ZIP64)
   * @throws Error if no valid EOCD record is found
   * @throws Error if ZIP64 EOCD locator is invalid
   */
  static async create(source: FileHandle | Buffer): Promise<BaseEndOfCentralDirRecord> {
    const totalSize = await this.getTotalSize(source);

    // Standard algorithm used by libzip, minizip, Chromium, Java, Python, Go, Rust, Node.js
    const WINDOW = Math.min(totalSize, 65557); // 65535 (max comment) + 22 (min EOCD)
    const windowStart = totalSize - WINDOW;

    // Get scan window data
    const windowBuf = await this.readScanWindow(source, windowStart, WINDOW);

    // Create reverse BMH skip table for EOCD signature (0x06054b50 in little-endian)
    const pattern = Buffer.from([0x50, 0x4b, 0x05, 0x06]); // Little-endian signature bytes
    const skipTable = this.createReverseBMHSkipTable(pattern);

    // Start scanning from the last possible EOCD position
    let p = totalSize - EndOfCentralDirRecord.MIN_SIZE - windowStart; // Relative to buffer start
    const scanStart = 0; // Start of scan window (relative to buffer)

    // Reverse BMH scan for EOCD signature
    while (p >= scanStart) {
      // Check if we found the signature
      if (p + 3 < WINDOW && windowBuf.readUInt32LE(p) === EndOfCentralDirRecord.SIGNATURE) {
        // Validate: check if comment length makes this a valid EOCD
        const commentLen = windowBuf.readUInt16LE(p + 20);
        const expectedEnd = windowStart + p + EndOfCentralDirRecord.MIN_SIZE + commentLen;

        if (expectedEnd === totalSize) {
          // Found valid EOCD - extract the full record
          const remainingBytes = WINDOW - p;
          const eocdBuf = windowBuf.subarray(p, p + Math.min(remainingBytes, EndOfCentralDirRecord.MIN_SIZE + commentLen));
          let eocd = new EndOfCentralDirRecord(eocdBuf);

          // Check for ZIP64
          if (eocd.centralDirOffset === 0xffffffff) {
            eocd = await this.readZip64EocdRecord(source, windowStart, p);
          }

          return eocd;
        }
      }

      // BMH skip: look for mismatch and skip accordingly
      if (p >= 3) {
        const mismatchChar = windowBuf[p + 3]; // Check rightmost pattern character first
        const skip = skipTable[mismatchChar] || pattern.length;
        p -= skip;
      } else {
        p--; // Fallback to naive scan near boundaries
      }
    }

    throw new Error('End of Central Directory Record not found');
  }

  private static async getTotalSize(source: FileHandle | Buffer): Promise<number> {
    return Buffer.isBuffer(source) ? source.length : (await source.stat()).size;
  }

  private static async readScanWindow(source: FileHandle | Buffer, windowStart: number, windowSize: number): Promise<Buffer> {
    if (Buffer.isBuffer(source)) {
      return source.subarray(windowStart, windowStart + windowSize);
    } else {
      const buf = Buffer.alloc(windowSize);
      await source.read(buf, 0, windowSize, windowStart);
      return buf;
    }
  }

  private static async readDataAtOffset(source: FileHandle | Buffer, offset: number, size: number): Promise<Buffer> {
    if (Buffer.isBuffer(source)) {
      return source.subarray(offset, offset + size);
    } else {
      const buf = Buffer.alloc(size);
      await source.read(buf, 0, size, offset);
      return buf;
    }
  }

  private static async readZip64EocdRecord(
    source: FileHandle | Buffer,
    windowStart: number,
    p: number
  ): Promise<Zip64EndOfCentralDirRecord> {
    // Look for ZIP64 EOCD locator (20 bytes before current EOCD)
    const zip64LocatorOffset = windowStart + p - 20;
    if (zip64LocatorOffset >= 0) {
      // Read ZIP64 locator data
      const zip64LocatorBuf = await this.readDataAtOffset(source, zip64LocatorOffset, 20);

      // Read ZIP64 EOCD offset from locator
      const zip64EocdOffset = zip64LocatorBuf.readUInt32LE(8);

      // Read ZIP64 EOCD data
      const zip64EocdBuf = await this.readDataAtOffset(source, zip64EocdOffset, Zip64EndOfCentralDirRecord.SIZE);

      return new Zip64EndOfCentralDirRecord(zip64EocdBuf);
    }

    throw new Error('ZIP64 EOCD locator not found');
  }

  /**
   * Creates a reverse Boyer-Moore-Horspool skip table for pattern matching.
   * This table allows us to skip characters during reverse scanning when mismatches occur.
   *
   * @param pattern - The byte pattern to create skip table for (EOCD signature)
   * @returns Skip table array where skipTable[byte] = number of positions to skip
   */
  private static createReverseBMHSkipTable(pattern: Buffer): number[] {
    const skipTable = new Array(256).fill(pattern.length);

    // For reverse BMH, we process pattern from left to right
    // but skip distances are calculated for reverse scanning
    for (let i = 0; i < pattern.length - 1; i++) {
      skipTable[pattern[i]] = pattern.length - 1 - i;
    }

    return skipTable;
  }
}

/**
 * Standard End of Central Directory Record
 */
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

/**
 * ZIP64 End of Central Directory Record for large ZIP files
 */
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

/**
 * Central Directory File Header for ZIP entries
 */
export class CentralDirFileHeader {
  static SIGNATURE = 0x02014b50;
  static MIN_SIZE = 46;

  public compressionMethod!: number;
  public compressedSize!: number;
  public fileNameLength!: number;
  public extraFieldLength!: number;
  public fileCommentLength!: number;
  public localFileHeaderOffset!: number;
  public fileName!: string;

  constructor(data: Buffer) {
    if (data.readUInt32LE(0) !== CentralDirFileHeader.SIGNATURE) {
      throw new Error('Central Directory File Header: The signature is not correct');
    }

    this.compressionMethod = data.readUInt16LE(10);
    this.compressedSize = data.readUInt32LE(20);
    this.fileNameLength = data.readUInt16LE(28);
    this.extraFieldLength = data.readUInt16LE(30);
    this.fileCommentLength = data.readUInt16LE(32);
    this.localFileHeaderOffset = data.readUInt32LE(42);

    // Extract filename if present
    if (this.fileNameLength > 0) {
      const fileNameBuffer = data.subarray(CentralDirFileHeader.MIN_SIZE, CentralDirFileHeader.MIN_SIZE + this.fileNameLength);
      // Normalize the file name to accommodate windows as the separator always be "/"
      // normalize() would consume more memory that is why we do it on-demand
      this.fileName = path.normalize(fileNameBuffer.toString('utf8'));
    } else {
      this.fileName = '';
    }
  }
}

/**
 * Helper class for parsing multiple Central Directory File Headers
 */
export class CentralDirFileHeaders {
  /**
   * Reads and parses Central Directory File Headers from a ZIP file source.
   *
   * This method implements the standard algorithm used by most ZIP libraries:
   * 1. Seek to the central directory offset (from EOCD)
   * 2. Read the entire central directory into memory for efficient parsing
   * 3. Parse each CDFH sequentially, handling variable-length fields
   * 4. Advance offset by total CDFH size (fixed header + variable fields)
   *
   * @param source - The FileHandle or Buffer representing the ZIP file to read from
   * @param eocd - The End of Central Directory Record containing offset and size info
   * @returns Promise resolving to CentralDirFileHeaders instance with parsed CDFHs
   * @throws Error if CDFH signature is invalid or parsing fails
   */
  static async create(source: FileHandle | Buffer, eocd: BaseEndOfCentralDirRecord): Promise<CentralDirFileHeader[]> {
    // Read the entire central directory into memory for efficient parsing
    const centralDirBuf = await this.readCentralDirectoryData(source, eocd);

    // Parse all CDFHs from the buffer
    return this.parseCentralDirectoryFileHeaders(centralDirBuf, eocd.centralDirSize);
  }

  private static async readCentralDirectoryData(source: FileHandle | Buffer, eocd: BaseEndOfCentralDirRecord): Promise<Buffer> {
    if (Buffer.isBuffer(source)) {
      return source.subarray(eocd.centralDirOffset, eocd.centralDirOffset + eocd.centralDirSize);
    } else {
      const centralDirBuf = Buffer.alloc(eocd.centralDirSize);
      await source.read(centralDirBuf, 0, eocd.centralDirSize, eocd.centralDirOffset);
      return centralDirBuf;
    }
  }

  private static parseCentralDirectoryFileHeaders(centralDirBuf: Buffer, centralDirSize: number): CentralDirFileHeader[] {
    const cdfhs: CentralDirFileHeader[] = [];
    let bufferOffset = 0;
    const endOffset = centralDirSize;

    // Parse each CDFH sequentially from the buffer
    while (bufferOffset < endOffset) {
      // Ensure we have enough bytes for minimum CDFH header
      if (bufferOffset + CentralDirFileHeader.MIN_SIZE > endOffset) {
        break; // Insufficient data for another CDFH
      }

      // Create a view of the buffer starting at current offset for CDFH parsing
      const cdfhBuf = centralDirBuf.subarray(bufferOffset);
      const cdfh = new CentralDirFileHeader(cdfhBuf);

      // Calculate total size: fixed header + variable-length fields
      const totalCdfhSize = CentralDirFileHeader.MIN_SIZE + cdfh.fileNameLength + cdfh.extraFieldLength + cdfh.fileCommentLength;

      // Validate we have enough remaining bytes for this complete CDFH
      if (bufferOffset + totalCdfhSize > endOffset) {
        throw new Error('Incomplete Central Directory File Header detected');
      }

      cdfhs.push(cdfh);
      bufferOffset += totalCdfhSize;
    }

    return cdfhs;
  }
}

/**
 * Local File Header for ZIP entries
 */
export class LocalFileHeader {
  static MIN_SIZE = 30;
  static SIGNATURE = 0x04034b50;

  public totalSize!: number;
  public crc32!: number;
  public fileNameLength!: number;
  public extraFieldLength!: number;

  constructor(minimalData: Buffer) {
    if (minimalData.readUInt32LE(0) !== LocalFileHeader.SIGNATURE) {
      throw new Error('The signature is not correct');
    }

    this.crc32 = minimalData.readUInt32LE(14);
    this.fileNameLength = minimalData.readUInt16LE(26);
    this.extraFieldLength = minimalData.readUInt16LE(28);

    this.totalSize = LocalFileHeader.MIN_SIZE + this.fileNameLength + this.extraFieldLength;
  }

  static async create(source: FileHandle | Buffer, localFileHeaderOffset: number): Promise<LocalFileHeader> {
    const buffer = Buffer.alloc(LocalFileHeader.MIN_SIZE);
    if (Buffer.isBuffer(source)) {
      source.copy(buffer, 0, localFileHeaderOffset, localFileHeaderOffset + LocalFileHeader.MIN_SIZE);
    } else {
      await source.read(buffer, 0, LocalFileHeader.MIN_SIZE, localFileHeaderOffset);
    }
    return new LocalFileHeader(buffer);
  }
}

/**
 * File data extraction helper
 */
export class FileData {
  constructor(public lfh: LocalFileHeader, public cdfh: CentralDirFileHeader) {}

  public async createReadStream(src: FileHandle | Buffer): Promise<Readable> {
    if (Buffer.isBuffer(src)) {
      return Readable.from(this.extractDataFromBuffer(src));
    }

    // src is FileHandle - read the data and create a readable stream
    const buffer = Buffer.alloc(this.cdfh.compressedSize);
    const offset = this.cdfh.localFileHeaderOffset + this.lfh.totalSize;
    await src.read(buffer, 0, this.cdfh.compressedSize, offset);

    return Readable.from(buffer);
  }

  public async extractData(src: FileHandle | Buffer): Promise<Buffer> {
    if (Buffer.isBuffer(src)) {
      return this.extractDataFromBuffer(src);
    }

    // src is FileHandle - read from it directly
    const buffer = Buffer.alloc(this.cdfh.compressedSize);
    const offset = this.cdfh.localFileHeaderOffset + this.lfh.totalSize;
    await src.read(buffer, 0, this.cdfh.compressedSize, offset);

    return buffer;
  }

  public async extractDataFromFd(fd: FileHandle): Promise<Buffer> {
    const buffer = Buffer.alloc(this.cdfh.compressedSize);
    const offset = this.cdfh.localFileHeaderOffset + this.lfh.totalSize;
    await fd.read(buffer, 0, this.cdfh.compressedSize, offset);
    await fd.close();

    return buffer;
  }

  public extractDataFromBuffer(zipBuffer: Buffer): Buffer {
    const buffer = Buffer.alloc(this.cdfh.compressedSize);
    const offset = this.cdfh.localFileHeaderOffset + this.lfh.totalSize;
    zipBuffer.copy(buffer, 0, offset, offset + this.cdfh.compressedSize);

    return buffer;
  }
}

enum CompressionMethod {
  NONE = 0,
  DEFLATED = 8,
}

/**
 * Represents a single entry in a ZIP file with lazy loading support
 */
export class ZipEntry {
  /**
   * The name of the entry.
   * e.g.
   * - `a.txt` => `a.txt`
   * - `b/c.txt` => `c.txt`
   * - `d/` => `d`
   */
  public name!: string;
  /**
   * The relative path of the entry.
   * e.g.
   * - `a.txt`
   * - `b/c.txt`
   * - `d/`
   */
  public relPath!: string;
  /**
   * The size of the entry.
   */
  public size!: number;
  /**
   * The full path of the entry.
   * e.g.
   * - `/a/b.zip/c.txt`
   * - `/a/b.zip/c.zip/d.txt`
   * - `/a/b.zip/c.zip/e/`
   */
  public fullPath!: string;
  /**
   * Whether the entry is a directory.
   */
  public isDirectory!: boolean;

  private source!: FileHandle | Buffer;
  private fileData?: FileData; // Make optional for lazy initialization
  private cdfh!: CentralDirFileHeader;
  private contentCache?: DecompressedContentCache | null;
  private zipPath?: string;
  private zipMtime?: number;
  private initialized = false; // Track initialization state

  constructor(
    source: FileHandle | Buffer,
    cdfh: CentralDirFileHeader,
    outerZipPath: string,
    contentCache?: DecompressedContentCache | null,
    zipPath?: string,
    zipMtime?: number
  ) {
    this.source = source;
    this.cdfh = cdfh;
    this.name = path.basename(cdfh.fileName);
    this.relPath = cdfh.fileName;
    this.size = cdfh.compressedSize;
    this.fullPath = path.join(outerZipPath, this.relPath);
    this.isDirectory = this.relPath.endsWith('/') || this.relPath.endsWith('\\');
    this.contentCache = contentCache;
    this.zipPath = zipPath;
    this.zipMtime = zipMtime;
    // Note: NOT reading LFH here - lazy initialization!
  }

  static async create(
    source: FileHandle | Buffer,
    cdfh: CentralDirFileHeader,
    outerZipPath: string,
    contentCache?: DecompressedContentCache | null,
    zipPath?: string,
    zipMtime?: number
  ): Promise<ZipEntry> {
    // No longer read LFH during creation - use lazy initialization
    return new ZipEntry(source, cdfh, outerZipPath, contentCache, zipPath, zipMtime);
  }

  /**
   * Lazy initialization - only read LFH when actually needed
   */
  private async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const lfh = await LocalFileHeader.create(this.source, this.cdfh.localFileHeaderOffset);
    this.fileData = new FileData(lfh, this.cdfh);
    this.initialized = true;
  }

  /**
   * 1. If is non-zip entry, return the data directly
   * 2. If is zip entry, return the data after decompressing
   * 3. Use content cache if available for performance optimization
   */
  public async read(): Promise<Buffer> {
    // Initialize only when actually reading content
    await this.init();

    // Try content cache first if available
    if (this.contentCache && this.zipPath && this.zipMtime !== undefined) {
      const cachedContent = await this.contentCache.get(this.zipPath, this.zipMtime, this.relPath, this.fileData!.lfh.crc32 || 0);

      if (cachedContent) {
        return cachedContent;
      }
    }

    // Cache miss or no cache - perform normal read/decompression
    const rawData = await this.fileData!.extractData(this.source);
    let finalData: Buffer;

    if (this.cdfh.compressionMethod === CompressionMethod.NONE) {
      finalData = rawData;
    } else if (this.cdfh.compressionMethod === CompressionMethod.DEFLATED) {
      finalData = await this.inflateCompressedData(rawData);
    } else {
      throw new Error(`Unsupported compression method: ${this.cdfh.compressionMethod}`);
    }

    // Cache the result if cache is available and not a directory
    if (this.contentCache && this.zipPath && this.zipMtime !== undefined && !this.isDirectory) {
      await this.contentCache.set(this.zipPath, this.zipMtime, this.relPath, this.fileData!.lfh.crc32 || 0, finalData);
    }

    return finalData;
  }

  public async createReadStream(): Promise<Readable> {
    // Initialize only when actually creating stream
    await this.init();

    const rawDataReadStream = await this.fileData!.createReadStream(this.source);
    if (this.cdfh.compressionMethod === CompressionMethod.NONE) {
      return rawDataReadStream;
    } else if (this.cdfh.compressionMethod === CompressionMethod.DEFLATED) {
      return this.createInflateStream(rawDataReadStream);
    } else {
      throw new Error(`Unsupported compression method: ${this.cdfh.compressionMethod}`);
    }
  }

  public async extract(dest: string): Promise<string> {
    if (this.isDirectory) {
      // Create directory if it doesn't exist - use relPath to preserve directory structure
      const dirPath = path.join(dest, this.relPath);
      try {
        await fs.mkdir(dirPath, { recursive: true });
      } catch (error) {
        // Directory might already exist, ignore error
      }
      return dirPath;
    }

    // Initialize only when actually extracting
    await this.init();

    try {
      const stats = await stat(dest);
      if (stats.isDirectory()) {
        // When extracting to a directory, use just the filename (not the full relPath)
        // This maintains backward compatibility for single file extractions
        dest = path.join(dest, this.name);
      }
      // If dest is a file path, use it as-is
    } catch (error) {
      // dest is not a directory, treat as file path
      // But we need to ensure the parent directory exists
      const parentDir = path.dirname(dest);
      await fs.mkdir(parentDir, { recursive: true });
    }

    // Ensure parent directory exists for the destination file
    const parentDir = path.dirname(dest);
    await fs.mkdir(parentDir, { recursive: true });

    const readStream = await this.createReadStream();
    const writeStream = createWriteStream(dest);

    await pipeline(readStream, writeStream);

    return dest;
  }

  private async inflateCompressedData(compressedData: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const inflater = zlib.createInflateRaw();
      const inputStream = new PassThrough({ highWaterMark: 64 * 1024 }); // 64 KB buffer size

      inputStream.end(compressedData);
      inputStream.pipe(inflater);

      inflater.on('data', (chunk) => chunks.push(chunk));
      inflater.on('end', () => {
        const decompressedData = Buffer.concat(chunks);

        inflater.close();
        inflater.removeAllListeners();
        inputStream.removeAllListeners();

        resolve(decompressedData);
      });
      inflater.on('error', (err) => {
        inflater.close();
        inflater.removeAllListeners();
        inputStream.removeAllListeners();
        reject(err);
      });
    });
  }

  private createInflateStream(compressedStream: Readable): Readable {
    const inflaterStream = zlib.createInflateRaw();
    compressedStream.pipe(inflaterStream);

    return inflaterStream;
  }
}

/**
 * Central Directory representation with all ZIP entries
 */
export class CentralDir {
  public eocd!: EndOfCentralDirRecord;
  public cdfhs!: CentralDirFileHeader[];
  public entries!: ZipEntry[];

  private constructor(public fullPath: string, public source: FileHandle | Buffer) {}

  static async create(
    fullPath: string,
    source: FileHandle | Buffer,
    contentCache?: DecompressedContentCache | null,
    zipMtime?: number
  ): Promise<CentralDir> {
    const instance = new CentralDir(fullPath, source);
    const eocd = await BaseEndOfCentralDirRecord.create(source);
    const cdfhs = await CentralDirFileHeaders.create(source, eocd);
    const entries = await Promise.all(
      cdfhs.map((cdfh) => ZipEntry.create(source, cdfh, fullPath, contentCache, fullPath, zipMtime))
    );

    instance.eocd = eocd;
    instance.cdfhs = cdfhs;
    instance.entries = entries;

    return instance;
  }

  /**
   * Cleans up all temporary files created by entries in this CentralDir.
   * Should be called when the CentralDir is no longer needed.
   */
  public async cleanup(): Promise<void> {
    // Note: ZipEntry cleanup method not implemented yet
    // await Promise.all(this.entries.map((entry) => entry.cleanup()));
  }
}

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * Advanced ZIP library with caching support for high-performance ZIP file operations
 */
export class AdvZlib {
  private logger: Logger;
  private cache: CentralDirCache;
  private contentCache: DecompressedContentCache | null;

  constructor(opts?: AdvZlibOptions) {
    this.logger = opts?.logger || console;
    this.cache = new CentralDirCache(opts?.maxCentralDirCount || 10, (opts?.maxCacheMemoryMB || 100) * 1024 * 1024, this.logger);

    // Initialize content cache if enabled
    if (opts?.enableContentCaching !== false) {
      // Default to enabled
      this.contentCache = new DecompressedContentCache(
        opts?.maxContentCacheCount || 100,
        (opts?.maxContentCacheMemoryMB || 50) * 1024 * 1024,
        (opts?.maxContentCacheFileSizeMB || 10) * 1024 * 1024,
        opts?.cacheBaseDir || tmpdir(),
        this.logger
      );
    } else {
      this.contentCache = null;
    }
  }

  /**
   * Helper method to check if a path ends with '.zip' in a case-insensitive manner
   * @param path The path to check
   * @returns True if the path ends with '.zip' (case-insensitive)
   */
  private isZipFile(path: string): boolean {
    return path.toLowerCase().endsWith('.zip');
  }

  /**
   * Get the list of entries in a ZIP file
   * @param src The path of the zip file which can be:
   * - Normal: `/a/b.zip`
   * - Nested zip: `/a/b.zip/c.zip` or `/a/b.zip/c/d.zip`
   * @param filterFn An optional callback function to filter entries
   * @returns A promise that resolves to the list of filtered entries in the ZIP file.
   */
  public async getEntries(src: string, filterFn?: (entry: ZipEntry) => boolean): Promise<ZipEntry[]> {
    this.logger.debug(`[AdvZlib] getEntries(): Getting entries for ${src}`);

    if (!src) {
      throw new Error(`[AdvZlib] getEntries(): src is required`);
    }

    if (!this.isZipFile(src)) {
      throw new Error(`[AdvZlib] getEntries(): ${src} is not a zip file`);
    }

    const centralDir = await this.createOrGetCentralDir(src);
    if (!centralDir) {
      // Check if the file exists first - if it doesn't exist, that's a clear error
      if (!(await this.fileOrDirExists(src))) {
        throw new Error(`[AdvZlib] getEntries(): File does not exist: ${src}`);
      }

      // If file exists but we can't get central directory, log and return empty array
      // This maintains backwards compatibility with legacy implementation
      this.logger.error(`[AdvZlib] getEntries(): Failed to get central directory for ${src}`);
      return [];
    }

    return centralDir.entries.filter((entry) => (filterFn ? filterFn(entry) : true));
  }

  /**
   * Check if a file exists in a ZIP file
   * @param src The path of the zip file which can be:
   * - Normal: `/a/b.zip/c.txt`
   * - Folder: `/a/b.zip/c/`
   * - Nested zip: `/a/b.zip/c.zip`
   * @returns A promise that resolves to a boolean indicating whether the file exists in the ZIP file.
   */
  public async exists(src: string): Promise<boolean> {
    this.logger.debug(`[AdvZlib] exists(): Checking if ${src} exists`);

    if (!src) {
      throw new Error(`[AdvZlib] exists(): ${src} is empty`);
    }

    if (await this.fileOrDirExists(src)) {
      return true;
    }

    try {
      const centralDir = await this.createOrGetCentralDir(src);
    if (this.isZipFile(src)) {
      return !!centralDir;
    }

    if (!centralDir) {
      return false;
    }

    const entry = centralDir.entries.find((entry) => this.matchEntryByFullPath(entry, src));
      return !!entry;
    } catch (error) {
      // If we can't access the ZIP file (e.g., it doesn't exist), return false
      this.logger.debug(`[AdvZlib] exists(): Error checking ${src}: ${error}`);
      return false;
    }
  }

  /**
   * Extracts selected entries from a ZIP file to a specified destination directory.
   *
   * @param src The source path to the ZIP file. Can represent a simple ZIP file or a nested path within a ZIP file.
   * @param dest There several cases:
   * - Case1: src is a zip(whatever nested or not) file, then `dest` must be a directory and this directory must exist.
   * - Case2: src is a particular file within a zip file, then `dest` can either be a directory(where the content will be extracted)
   *   or a file path(indicating where the extracted content will be saved).
   * @param filterFn An optional filter function that determines which entries to extract.
   *                   If provided, only entries for which the function returns `true` will be extracted.
   * @returns A promise that resolves to an array of full paths of the extracted files.
   * @throws Will throw an error if the `src` ZIP file does not exist or if the `dest` directory does not exist.
   */
  public async extract(src: string, dest: string, filterFn?: (entry: ZipEntry) => boolean): Promise<string[]> {
    this.logger.debug(`[AdvZlib] extract(): Extracting ${src} to ${dest}`);

    if (!(await this.exists(src))) {
      throw new Error(`[AdvZlib] extract(): ZIP file ${src} does not exist.`);
    }

    if (this.isZipFile(src) && !(await this.fileOrDirExists(dest))) {
      throw new Error(`[AdvZlib] extract(): As ${src} is a zip file, ${dest} must be an existing directory.`);
    }

    if (!this.isZipFile(src) && !(await this.fileOrDirExists(path.dirname(dest)))) {
      throw new Error(`[AdvZlib] extract(): ${path.dirname(dest)} does not exist.`);
    }

    if (!this.isZipFile(src) && filterFn) {
      throw new Error(`[AdvZlib] extract(): Filter function is only applicable for extracting a whole zip file.`);
    }

    const centralDir = await this.createOrGetCentralDir(src);
    if (!centralDir) {
      throw new Error(`[AdvZlib] extract(): Failed to get central directory for ${src}`);
    }

    const extracted: string[] = [];
    const entries = this.getRelatedEntries(src, centralDir.entries, filterFn);
    await Promise.all(entries.map(async (entry) => extracted.push(await entry.extract(dest))));

    return extracted;
  }

  /**
   * Reads the content of a specific file within a ZIP file.
   *
   * @param src - The path to the ZIP file or an entry within it. Accepted formats include:
   *   - Type 1: `/a/b.zip` - Reads using a `filterFn` function to filter entries.
   *   - Type 2: `/a/b.zip/c.txt` - Directly specifies a file entry to read, without a `filterFn`.
   *   - Type 3: `/a/b.zip/c.zip` - Specifies a nested ZIP entry, read with a `filterFn` function.
   *   - Type 4: `/a/b.zip/c.zip/d.txt` - Directly specifies a file entry within a nested ZIP, without a `filterFn`.
   * @param filterFn - An optional filter function to select entries within the ZIP file.
   *                   If provided, only entries for which the function returns `true` are considered.
   * @returns A promise that resolves to a `Buffer` containing the file's contents, or an empty `Buffer`
   *          if no matching entry is found or if multiple entries match.
   * @throws Will throw an error if the `src` file does not exist.
   */
  public async read(src: string, filterFn?: (entry: ZipEntry) => boolean): Promise<Buffer> {
    this.logger.info(`[AdvZlib] read(): Reading content from ${src}`);

    if (!(await this.exists(src))) {
      throw new Error('read(): The source of the ZIP file is required.');
    }

    const centralDir = await this.createOrGetCentralDir(src);
    if (!centralDir) {
      throw new Error(`[AdvZlib] read(): Failed to get central directory for ${src}`);
    }

    const entries = this.getRelatedEntries(src, centralDir.entries, filterFn);
    if (entries.length === 0) {
      this.logger.error(`[AdvZlib] read(): No matching entries found in ${src}`);
      return Buffer.alloc(0);
    }

    if (entries.length > 1) {
      this.logger.error(`[AdvZlib] read(): Multiple matching entries found in ${src}`);
      return Buffer.alloc(0);
    }

    return await entries[0].read();
  }

  /**
   * Clean up resources and cache
   */
  public async cleanup(): Promise<void> {
    const centralStats = this.cache.getStats();
    const contentStats = this.contentCache?.getStats() || { entries: 0, memoryMB: 0, diskEntries: 0, memoryEntries: 0 };

    this.logger.debug(
      `[AdvZlib] cleanup(): Clearing caches - CentralDir: ${centralStats.entries} entries, ${centralStats.memoryMB}MB; Content: ${contentStats.entries} entries (${contentStats.memoryEntries} memory, ${contentStats.diskEntries} disk), ${contentStats.memoryMB}MB`
    );

    this.cache.clear();
    await this.contentCache?.clear();
  }

  /**
   * Get cache statistics
   */
  public getCacheStats(): {
    centralDir: { entries: number; memoryMB: number };
    content: { entries: number; memoryMB: number; diskEntries: number; memoryEntries: number };
    total: { entries: number; memoryMB: number };
  } {
    const centralStats = this.cache.getStats();
    const contentStats = this.contentCache?.getStats() || { entries: 0, memoryMB: 0, diskEntries: 0, memoryEntries: 0 };

    return {
      centralDir: centralStats,
      content: contentStats,
      total: {
        entries: centralStats.entries + contentStats.entries,
        memoryMB: Number((centralStats.memoryMB + contentStats.memoryMB).toFixed(2)),
      },
    };
  }

  /**
   * Check if a file or directory exists in the filesystem
   */
  private async fileOrDirExists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Match entry by full path, handling path separators
   */
  private matchEntryByFullPath(entry: ZipEntry, src: string): boolean {
    // Normalize path separators to forward slashes
    const entryFullPath = entry.fullPath.replace(/\\/g, '/');
    const srcPath = src.replace(/\\/g, '/');

    // Handle exact matches
    if (entryFullPath === srcPath) {
      return true;
    }

    // Handle directory matches - if src ends with '/', try matching without it
    if (srcPath.endsWith('/')) {
      const srcWithoutTrailingSlash = srcPath.slice(0, -1);
      if (entryFullPath === srcWithoutTrailingSlash) {
        return true;
      }
    }

    // Also check if entry path ends with '/' and src doesn't
    if (entryFullPath.endsWith('/')) {
      const entryWithoutTrailingSlash = entryFullPath.slice(0, -1);
      if (entryWithoutTrailingSlash === srcPath) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get related entries based on source path and optional filter function
   */
  private getRelatedEntries(src: string, entries: ZipEntry[], filterFn?: (entry: ZipEntry) => boolean): ZipEntry[] {
    const entryRelPath = this.getLastEntryRelPath(src);
    return filterFn
      ? entries.filter((entry) => filterFn(entry))
      : entries.filter((entry) => (entryRelPath ? entry.relPath === entryRelPath : true));
  }

  /**
   * Get the last entry relative path, e.g., '/a/b.zip/c/d.txt' to 'c/d.txt'
   * @param src The source ZIP path
   * @returns The last entry relative path
   */
  private getLastEntryRelPath(src: string, includeZip = false): string {
    // Find the last ZIP file in the path
    const lastZipPath = this.findLastZipPath(src);
    if (!lastZipPath) {
      return '';
    }

    // Extract the path after the last ZIP file
    const afterZipPath = src.substring(lastZipPath.length);

    // Remove leading slashes and return the relative path
    const entryRelPath = afterZipPath.replace(/^[/\\]+/, '');

    // If the path ends with .zip and includeZip is false, return empty
    if (this.isZipFile(entryRelPath) && !includeZip) {
      return '';
    }

    return entryRelPath;
  }

  /**
   * Creates or retrieves the CentralDir instance for the last ZIP file in a given path.
   * This is a core function that handles various ZIP nesting scenarios to identify
   * the deepest ZIP file that contains the target resource.
   *
   * Supported path patterns:
   * - Single ZIP: `/a/b.zip` → Returns CentralDir for `b.zip`
   * - Nested ZIP with file: `/a/b.zip/c.zip/d.txt` → Returns CentralDir for `c.zip`
   * - Nested ZIP ending with ZIP: `/a/b.zip/c.zip` → Returns CentralDir for `c.zip`
   * - Deeply nested: `/a/b.zip/c.zip/d.zip/e.txt` → Returns CentralDir for `d.zip`
   *
   * Algorithm:
   * 1. Parse the path to identify all ZIP file segments
   * 2. Find the last (deepest) ZIP file in the path
   * 3. Check cache first (including nested ZIP cache), then create CentralDir instance if not cached
   * 4. Handle nested ZIP file access through parent ZIP entries
   *
   * @param source - The file path which may contain nested ZIP files
   * @returns Promise resolving to CentralDir for the last ZIP file, or null if no ZIP found
   * @throws Error if ZIP file access fails or path is invalid
   */
  private async createOrGetCentralDir(source: string): Promise<CentralDir | null> {
    if (!source || typeof source !== 'string') {
      return null;
    }

    // Find the last ZIP file in the path
    const lastZipPath = this.findLastZipPath(source);
    if (!lastZipPath) {
      return null;
    }

    // Check cache first (works for both filesystem and nested ZIP paths)
    const cachedCentralDir = await this.cache.get(lastZipPath);
    if (cachedCentralDir) {
      this.logger.debug(`[AdvZlib] createOrGetCentralDir(): Using cached CentralDir for ${lastZipPath}`);
      return cachedCentralDir;
    }

    // Check if this is a direct filesystem ZIP (no nested ZIPs in path)
    const zipSegments = this.extractZipSegments(source);
    const isDirectZip = zipSegments.length === 1 && lastZipPath === source;

    if (isDirectZip) {
      // For simple cases (direct ZIP file), create CentralDir directly
      try {
        const fd = await open(lastZipPath, 'r');

        // Get file modification time for content caching
        let zipMtime: number | undefined;
        try {
          const stats = await stat(lastZipPath);
          zipMtime = stats.mtimeMs;
        } catch (error) {
          this.logger.debug(`[AdvZlib] createOrGetCentralDir(): Failed to get mtime for ${lastZipPath}: ${error}`);
        }

        const centralDir = await CentralDir.create(lastZipPath, fd, this.contentCache, zipMtime);

        // Cache the result (filesystem ZIPs can be cached with mtime)
        await this.cache.set(lastZipPath, centralDir);

        return centralDir;
      } catch (error) {
        this.logger.debug(`[AdvZlib] createOrGetCentralDir(): Failed to open ${lastZipPath}: ${error}`);
        return null;
      }
    }

    // For nested ZIP cases, we need to traverse through parent ZIPs
    let currentCentralDir: CentralDir | null = null;
    let parentZipMtime: number | undefined;
    let previousZipPath = '';

    for (const segment of zipSegments) {
      if (this.isZipFile(segment)) {
        if (!currentCentralDir) {
          // First ZIP file - read from filesystem
          const fd = await open(segment, 'r');

          // Get file modification time for filesystem ZIP files
          try {
            const stats = await stat(segment);
            parentZipMtime = stats.mtimeMs;
          } catch (error) {
            this.logger.debug(`[AdvZlib] createOrGetCentralDir(): Failed to get mtime for ${segment}: ${error}`);
          }

          currentCentralDir = await CentralDir.create(segment, fd, this.contentCache, parentZipMtime);
          
          // Cache filesystem ZIP
          await this.cache.set(segment, currentCentralDir);
          previousZipPath = segment;
        } else {
          // Nested ZIP file - find entry in parent ZIP
          // Calculate the relative path from the previous ZIP to this ZIP
          const relativePathInParent = segment.substring(previousZipPath.length + 1); // +1 to remove the leading slash
          const zipEntry = currentCentralDir.entries.find((entry) => entry.relPath === relativePathInParent);

          if (!zipEntry) {
            throw new Error(`ZIP entry not found: ${relativePathInParent} in ${currentCentralDir.fullPath}`);
          }

          // Extract nested ZIP entry data
          const data = await zipEntry.read();
          if (!data) {
            throw new Error(`Failed to read nested ZIP entry: ${segment}`);
          }

          // For nested ZIPs, use current timestamp for simple cache management
          const nestedZipMtime = Date.now();
          
          currentCentralDir = await CentralDir.create(segment, data, this.contentCache, nestedZipMtime);

          // Cache nested ZIP with composite cache key
          await this.cache.set(segment, currentCentralDir);
          previousZipPath = segment;
        }

        // If this is our target ZIP file, return it
        if (segment === lastZipPath) {
          return currentCentralDir;
        }
      }
    }

    return currentCentralDir;
  }

  /**
   * Finds the last (deepest) ZIP file path in a given source path.
   * This method identifies the ZIP file that would contain the target resource.
   *
   * @param source - The source path to analyze
   * @returns The path to the last ZIP file, or null if none found
   *
   * @example
   * '/a/b.zip' -> '/a/b.zip'
   * '/a/b.zip/c.zip/d.txt' -> '/a/b.zip/c.zip'
   * '/a/b.zip/c.zip' -> '/a/b.zip/c.zip'
   * '/a/b.zip/c.zip/d.zip/e.txt' -> '/a/b.zip/c.zip/d.zip'
   * '/a/b/c.txt' -> null
   * '/a/b.zip/folder/' -> '/a/b.zip'
   */
  private findLastZipPath(source: string): string | null {
    const segments = source.split('/').filter(Boolean);
    let lastZipPath = '';
    let foundLastZip = false;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      lastZipPath += (i === 0 && source.startsWith('/') ? '/' : i > 0 ? '/' : '') + segment;

      if (this.isZipFile(segment)) {
        foundLastZip = true;
        // Check if there are more ZIP files ahead
        let hasMoreZips = false;
        for (let j = i + 1; j < segments.length; j++) {
          if (this.isZipFile(segments[j])) {
            hasMoreZips = true;
            break;
          }
        }

        if (!hasMoreZips) {
          return lastZipPath; // This is the last ZIP file
        }
      }
    }

    return foundLastZip ? lastZipPath : null;
  }

  /**
   * Extracts ZIP file segments from a path for sequential processing.
   * This method creates an ordered list of all ZIP file paths encountered
   * in the source path, which is used for nested ZIP traversal.
   *
   * @param source - The source path to extract segments from
   * @returns Array of path segments up to each ZIP file, in order of depth
   *
   * @example
   * '/a/b.zip' -> ['/a/b.zip']
   * 'a/b.zip' -> ['a/b.zip']
   * '/a/b.zip/c.zip' -> ['/a/b.zip', '/a/b.zip/c.zip']
   * '/a/b.zip/c.zip/d.zip' -> ['/a/b.zip', '/a/b.zip/c.zip', '/a/b.zip/c.zip/d.zip']
   * '/project/data.zip/nested.zip/files/deep.zip/doc.txt' -> ['/project/data.zip', '/project/data.zip/nested.zip', '/project/data.zip/nested.zip/files/deep.zip']
   * '/a/b/c.txt' -> []
   * '' -> []
   * '/a/b.zip/folder/c.zip/file.txt' -> ['/a/b.zip', '/a/b.zip/folder/c.zip']
   */
  private extractZipSegments(source: string): string[] {
    const segments = source.split('/').filter(Boolean);
    const result: string[] = [];
    let currentPath = '';
    const isAbsolute = source.startsWith('/');

    for (const segment of segments) {
      if (currentPath === '') {
        currentPath = isAbsolute ? '/' + segment : segment;
      } else {
        currentPath += '/' + segment;
      }

      if (this.isZipFile(segment)) {
        result.push(currentPath);
      }
    }

    return result;
  }
}
