import { createReadStream, createWriteStream, ReadStream, promises as fs, statSync } from 'fs';
import { FileHandle, open, stat } from 'fs/promises';
import { PassThrough, Readable } from 'stream';
import { pipeline } from 'node:stream/promises';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { randomUUID, createHash, createDecipheriv, pbkdf2Sync, createHmac } from 'node:crypto';
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
 * Options for ZIP operations that may involve encryption
 */
export interface ZipOptions {
  password?: string;
}

/**
 * Options for getEntries operation
 */
export interface GetEntriesOptions extends ZipOptions {
  filter?: (entry: ZipEntry) => boolean;
}

/**
 * Options for read operation
 */
export interface ReadOptions extends ZipOptions {
  filter?: (entry: ZipEntry) => boolean;
}

/**
 * Options for extract operation
 */
export interface ExtractOptions extends ZipOptions {
  filter?: (entry: ZipEntry) => boolean;
}

/**
 * Options for exists operation
 */
export interface ExistsOptions extends ZipOptions {}

/**
 * Information about encryption in a ZIP entry
 */
export interface EncryptionInfo {
  isEncrypted: boolean;
  encryptionMethod: 'none' | 'traditional' | 'aes-128' | 'aes-192' | 'aes-256' | 'unknown';
  needsPassword: boolean;
}

/**
 * Encryption method enumeration
 */
export enum EncryptionMethod {
  NONE = 'none',
  TRADITIONAL = 'traditional',
  AES_128 = 'aes-128',
  AES_192 = 'aes-192',
  AES_256 = 'aes-256',
  UNKNOWN = 'unknown',
}

/**
 * Custom error types for encryption operations
 */
export class EncryptionError extends Error {
  constructor(message: string, public encryptionMethod?: string) {
    super(message);
    this.name = 'EncryptionError';
  }
}

export class InvalidPasswordError extends EncryptionError {
  constructor(encryptionMethod?: string) {
    super(`Invalid password for ${encryptionMethod || 'encrypted'} content`, encryptionMethod);
    this.name = 'InvalidPasswordError';
  }
}

export class UnsupportedEncryptionError extends EncryptionError {
  constructor(encryptionMethod: string) {
    super(`Unsupported encryption method: ${encryptionMethod}`, encryptionMethod);
    this.name = 'UnsupportedEncryptionError';
  }
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
        this.logger.debug(
          `[DecompressedContentCache] Cache hit (disk) for ${entryRelPath} (${(entry.diskSize / 1024).toFixed(1)}KB)`
        );
        return diskContent;
      } catch (error) {
        this.logger.warn(`[DecompressedContentCache] Failed to read disk cache for ${key}: ${error}`);
        await this.delete(key);
        return null;
      }
    } else {
      // Read from memory
      this.logger.debug(
        `[DecompressedContentCache] Cache hit (memory) for ${entryRelPath} (${(entry.memorySize / 1024).toFixed(1)}KB)`
      );
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

      this.logger.debug(
        `[DecompressedContentCache] Evicting LRU entry: ${oldestEntry.key} (${(oldestEntry.size / 1024).toFixed(1)}KB)`
      );
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
  public generalPurposeBitFlag!: number;
  public encryptionInfo!: EncryptionInfo;
  public dataBuffer!: Buffer; // Store the buffer for later access to extra fields

  constructor(data: Buffer) {
    this.dataBuffer = data;
    if (data.readUInt32LE(0) !== CentralDirFileHeader.SIGNATURE) {
      throw new Error('Central Directory File Header: The signature is not correct');
    }

    this.generalPurposeBitFlag = data.readUInt16LE(8);
    this.compressionMethod = data.readUInt16LE(10);
    this.compressedSize = data.readUInt32LE(20);
    this.fileNameLength = data.readUInt16LE(28);
    this.extraFieldLength = data.readUInt16LE(30);
    this.fileCommentLength = data.readUInt16LE(32);
    this.localFileHeaderOffset = data.readUInt32LE(42);

    // Extract filename if present
    if (this.fileNameLength > 0) {
      const fileNameBuffer = data.subarray(CentralDirFileHeader.MIN_SIZE, CentralDirFileHeader.MIN_SIZE + this.fileNameLength);
      // Keep the original filename with forward slashes as per ZIP specification
      // ZIP files always use forward slashes internally, regardless of platform
      this.fileName = fileNameBuffer.toString('utf8');
    } else {
      this.fileName = '';
    }

    // Parse encryption information
    this.encryptionInfo = this.parseEncryptionInfo(data);
  }

  /**
   * Parse encryption information from the CDFH
   */
  private parseEncryptionInfo(data: Buffer): EncryptionInfo {
    const isTraditionalEncrypted = (this.generalPurposeBitFlag & 0x0001) !== 0;
    const isStrongEncrypted = (this.generalPurposeBitFlag & 0x0040) !== 0;

    if (!isTraditionalEncrypted && !isStrongEncrypted) {
      return {
        isEncrypted: false,
        encryptionMethod: EncryptionMethod.NONE,
        needsPassword: false,
      };
    }

    if (isStrongEncrypted) {
      // Parse extra fields for AES encryption information
      const aesInfo = this.parseAESEncryption(data);
      if (aesInfo) {
        return aesInfo;
      }
    }

    // Traditional encryption
    return {
      isEncrypted: true,
      encryptionMethod: EncryptionMethod.TRADITIONAL,
      needsPassword: true,
    };
  }

  /**
   * Parse AES encryption from extra fields
   */
  private parseAESEncryption(data: Buffer): EncryptionInfo | null {
    if (this.extraFieldLength === 0) {
      return null;
    }

    const extraFieldStart = CentralDirFileHeader.MIN_SIZE + this.fileNameLength;
    const extraFieldEnd = extraFieldStart + this.extraFieldLength;

    if (data.length < extraFieldEnd) {
      return null;
    }

    let offset = extraFieldStart;

    while (offset < extraFieldEnd - 4) {
      const headerID = data.readUInt16LE(offset);
      const dataSize = data.readUInt16LE(offset + 2);

      // AES extra field header ID (0x9901)
      if (headerID === 0x9901 && dataSize >= 7) {
        const keySize = data.readUInt16LE(offset + 8); // AES key size

        switch (keySize) {
          case 1:
            return { isEncrypted: true, encryptionMethod: EncryptionMethod.AES_128, needsPassword: true };
          case 2:
            return { isEncrypted: true, encryptionMethod: EncryptionMethod.AES_192, needsPassword: true };
          case 3:
            return { isEncrypted: true, encryptionMethod: EncryptionMethod.AES_256, needsPassword: true };
          default:
            return { isEncrypted: true, encryptionMethod: EncryptionMethod.UNKNOWN, needsPassword: true };
        }
      }

      offset += 4 + dataSize;
    }

    return { isEncrypted: true, encryptionMethod: EncryptionMethod.UNKNOWN, needsPassword: true };
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
  AES = 99,
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
  /**
   * Whether the entry is encrypted.
   */
  public isEncrypted!: boolean;
  /**
   * Encryption information for this entry.
   */
  public encryptionInfo!: EncryptionInfo;

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
    // Keep the internal ZIP path format (forward slashes) but convert to platform-specific for public API
    // This ensures Windows users get backslashes and Unix users get forward slashes
    this.relPath = cdfh.fileName.replace(/\//g, path.sep);
    this.size = cdfh.compressedSize;
    // Use platform-specific path separator for consistency with user expectations
    this.fullPath = path.join(outerZipPath, this.relPath);
    this.isDirectory = this.relPath.endsWith('/') || this.relPath.endsWith('\\');
    this.isEncrypted = cdfh.encryptionInfo.isEncrypted;
    this.encryptionInfo = cdfh.encryptionInfo;
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
   * 4. Handle encrypted entries with password-based decryption
   */
  public async read(password?: string): Promise<Buffer> {
    // Initialize only when actually reading content
    await this.init();

    // Check if encrypted entry requires password
    if (this.isEncrypted && !password) {
      throw new Error(`Entry '${this.relPath}' is encrypted and requires a password`);
    }

    // Try content cache first if available (include password in cache key for encrypted files)
    const cacheKey =
      this.isEncrypted && password
        ? `${this.zipPath}:${this.relPath}:${createHash('sha256').update(password).digest('hex').substring(0, 16)}`
        : `${this.zipPath}:${this.relPath}`;

    if (this.contentCache && this.zipPath && this.zipMtime !== undefined) {
      const cachedContent = await this.contentCache.get(this.zipPath, this.zipMtime, cacheKey, this.fileData!.lfh.crc32 || 0);

      if (cachedContent) {
        return cachedContent;
      }
    }

    // Cache miss or no cache - perform normal read/decompression/decryption
    let rawData = await this.fileData!.extractData(this.source);

    // Handle decryption first if needed
    if (this.isEncrypted && password) {
      rawData = await this.decryptData(rawData, password);
    }

    let finalData: Buffer;

    if (this.cdfh.compressionMethod === CompressionMethod.AES) {
      // For AES files, after decryption, apply the actual compression method
      const actualCompressionMethod = this.getActualCompressionMethod();
      if (actualCompressionMethod === CompressionMethod.NONE) {
        finalData = rawData;
      } else if (actualCompressionMethod === CompressionMethod.DEFLATED) {
        finalData = await this.inflateCompressedData(rawData);
      } else {
        throw new Error(`Unsupported actual compression method in AES file: ${actualCompressionMethod}`);
      }
    } else if (this.cdfh.compressionMethod === CompressionMethod.NONE) {
      finalData = rawData;
    } else if (this.cdfh.compressionMethod === CompressionMethod.DEFLATED) {
      finalData = await this.inflateCompressedData(rawData);
    } else {
      throw new Error(`Unsupported compression method: ${this.cdfh.compressionMethod}`);
    }

    // Cache the result if cache is available and not a directory
    if (this.contentCache && this.zipPath && this.zipMtime !== undefined && !this.isDirectory) {
      await this.contentCache.set(this.zipPath, this.zipMtime, cacheKey, this.fileData!.lfh.crc32 || 0, finalData);
    }

    return finalData;
  }

  public async createReadStream(): Promise<Readable> {
    // Initialize only when actually creating stream
    await this.init();

    const rawDataReadStream = await this.fileData!.createReadStream(this.source);

    if (this.cdfh.compressionMethod === CompressionMethod.AES) {
      // For AES files, the stream needs special handling for decryption + decompression
      // Since this method doesn't handle passwords, we'll return the raw stream
      // The read() method handles AES decryption and decompression properly
      return rawDataReadStream;
    } else if (this.cdfh.compressionMethod === CompressionMethod.NONE) {
      return rawDataReadStream;
    } else if (this.cdfh.compressionMethod === CompressionMethod.DEFLATED) {
      return this.createInflateStream(rawDataReadStream);
    } else {
      throw new Error(`Unsupported compression method: ${this.cdfh.compressionMethod}`);
    }
  }

  public async extract(dest: string, password?: string): Promise<string> {
    // Check encryption requirements
    if (this.isEncrypted && !password) {
      throw new Error(`Entry '${this.relPath}' is encrypted and requires a password`);
    }

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

    const outputPath = this.determineOutputPath(dest);

    // Handle encrypted files by reading with password first
    if (this.isEncrypted && password) {
      const content = await this.read(password);
      await this.writeToFile(outputPath, content);
      return outputPath;
    }

    // Regular stream-based extraction for non-encrypted files
    return this.extractRegular(outputPath);
  }

  /**
   * Determine the output path for extraction
   */
  private determineOutputPath(dest: string): string {
    try {
      const stats = statSync(dest);
      if (stats.isDirectory()) {
        // When extracting to a directory, use just the filename (not the full relPath)
        // This maintains backward compatibility for single file extractions
        return path.join(dest, this.name);
      }
      // If dest is a file path, use it as-is
      return dest;
    } catch (error) {
      // dest is not a directory, treat as file path
      return dest;
    }
  }

  /**
   * Write content to file, ensuring parent directory exists
   */
  private async writeToFile(outputPath: string, content: Buffer): Promise<void> {
    const parentDir = path.dirname(outputPath);
    await fs.mkdir(parentDir, { recursive: true });
    await fs.writeFile(outputPath, content);
  }

  /**
   * Regular stream-based extraction for non-encrypted files
   */
  private async extractRegular(outputPath: string): Promise<string> {
    // Ensure parent directory exists for the destination file
    const parentDir = path.dirname(outputPath);
    await fs.mkdir(parentDir, { recursive: true });

    const readStream = await this.createReadStream();
    const writeStream = createWriteStream(outputPath);

    await pipeline(readStream, writeStream);

    return outputPath;
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

  /**
   * Decrypt encrypted ZIP data based on encryption method
   */
  private async decryptData(encryptedData: Buffer, password: string): Promise<Buffer> {
    switch (this.encryptionInfo.encryptionMethod) {
      case EncryptionMethod.TRADITIONAL:
        return this.decryptTraditional(encryptedData, password);
      case EncryptionMethod.AES_128:
      case EncryptionMethod.AES_192:
      case EncryptionMethod.AES_256:
        return this.decryptAES(encryptedData, password);
      default:
        throw new UnsupportedEncryptionError(this.encryptionInfo.encryptionMethod);
    }
  }

  /**
   * Decrypt traditional ZIP 2.0 encryption
   * This implements the standard ZIP 2.0 encryption algorithm
   */
  private decryptTraditional(encryptedData: Buffer, password: string): Buffer {
    if (encryptedData.length < 12) {
      throw new Error('Invalid encrypted data: too short for traditional encryption');
    }

    // Initialize keys with password
    let key0 = 0x12345678;
    let key1 = 0x23456789;
    let key2 = 0x34567890;

    // Process password to initialize keys
    for (let i = 0; i < password.length; i++) {
      key0 = this.crc32Update(key0, password.charCodeAt(i));
      key1 = (key1 + (key0 & 0xff)) & 0xffffffff;
      key1 = ((key1 * 134775813 + 1) & 0xffffffff) >>> 0;
      key2 = this.crc32Update(key2, key1 >>> 24);
    }

    // Verify password using encryption header (first 12 bytes)
    const header = Buffer.alloc(12);
    for (let i = 0; i < 12; i++) {
      const c = encryptedData[i] ^ this.decryptByte(key0, key1, key2);
      this.updateKeys(key0, key1, key2, c);
      header[i] = c;
      key0 = this.keys[0];
      key1 = this.keys[1];
      key2 = this.keys[2];
    }

    // For ZIP 2.0, the last byte of header should match high byte of CRC or time
    // This is a basic password verification
    const expectedByte = (this.fileData!.lfh.crc32 >>> 24) & 0xff;
    if (header[11] !== expectedByte) {
      throw new InvalidPasswordError(EncryptionMethod.TRADITIONAL);
    }

    // Decrypt the actual data
    const decryptedData = Buffer.alloc(encryptedData.length - 12);
    for (let i = 12; i < encryptedData.length; i++) {
      const c = encryptedData[i] ^ this.decryptByte(key0, key1, key2);
      this.updateKeys(key0, key1, key2, c);
      decryptedData[i - 12] = c;
      key0 = this.keys[0];
      key1 = this.keys[1];
      key2 = this.keys[2];
    }

    return decryptedData;
  }

  private keys = [0, 0, 0]; // Temporary storage for key updates

  private crc32Update(crc: number, byte: number): number {
    // Simple CRC32 update (in real implementation, use proper CRC32 table)
    return ((crc >>> 8) ^ this.crc32Table[(crc ^ byte) & 0xff]) >>> 0;
  }

  private decryptByte(key0: number, key1: number, key2: number): number {
    const temp = (key2 | 2) >>> 0;
    return ((temp * (temp ^ 1)) >>> 8) & 0xff;
  }

  private updateKeys(key0: number, key1: number, key2: number, c: number): void {
    key0 = this.crc32Update(key0, c);
    key1 = (key1 + (key0 & 0xff)) & 0xffffffff;
    key1 = ((key1 * 134775813 + 1) & 0xffffffff) >>> 0;
    key2 = this.crc32Update(key2, key1 >>> 24);

    this.keys[0] = key0;
    this.keys[1] = key1;
    this.keys[2] = key2;
  }

  // CRC32 table for traditional encryption (simplified)
  private crc32Table = new Array(256).fill(0).map((_, i) => {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return c >>> 0;
  });

  /**
   * Decrypt AES encrypted ZIP data using WinZip AES format
   * Implements the WinZip AES specification with HMAC authentication
   */
  private decryptAES(encryptedData: Buffer, password: string): Buffer {
    if (encryptedData.length < 12) {
      throw new Error('Invalid AES encrypted data: too short');
    }

    // Determine key lengths based on AES variant
    const keyLength = this.getAESKeyLength();
    const saltLength = keyLength / 2; // Salt is half the key length
    const macLength = 10; // HMAC-SHA1 truncated to 10 bytes

    if (encryptedData.length < saltLength + macLength + 2) {
      throw new Error('Invalid AES encrypted data: insufficient data for salt and MAC');
    }

    // Extract components
    const salt = encryptedData.subarray(0, saltLength);
    const passwordVerification = encryptedData.subarray(saltLength, saltLength + 2);
    const encryptedContent = encryptedData.subarray(saltLength + 2, encryptedData.length - macLength);
    const authenticationCode = encryptedData.subarray(encryptedData.length - macLength);

    // Derive encryption and authentication keys using PBKDF2
    const keyMaterial = pbkdf2Sync(password, salt, 1000, keyLength + keyLength + 2, 'sha1');
    const encryptionKey = keyMaterial.subarray(0, keyLength);
    const authenticationKey = keyMaterial.subarray(keyLength, keyLength + keyLength);
    const passwordCheck = keyMaterial.subarray(keyLength + keyLength, keyLength + keyLength + 2);

    // Verify password using constant-time comparison for security
    if (!this.constantTimeEquals(passwordVerification, passwordCheck)) {
      throw new InvalidPasswordError(this.encryptionInfo.encryptionMethod);
    }

    // Verify HMAC authentication
    const hmac = createHmac('sha1', authenticationKey);
    hmac.update(encryptedContent);
    const computedMac = hmac.digest().subarray(0, macLength);

    // Verify HMAC using constant-time comparison for security
    if (!this.constantTimeEquals(authenticationCode, computedMac)) {
      throw new EncryptionError(
        'AES authentication failed: file may be corrupted or password incorrect',
        this.encryptionInfo.encryptionMethod
      );
    }

    // Decrypt content using AES-CTR mode
    const iv = Buffer.alloc(16); // AES-CTR uses 16-byte IV, initialized to 0
    const cipher = this.getAESCipherName();
    const decipher = createDecipheriv(cipher, encryptionKey, iv);

    let decryptedData = decipher.update(encryptedContent);
    const final = decipher.final();

    if (final.length > 0) {
      decryptedData = Buffer.concat([decryptedData, final]);
    }

    return decryptedData;
  }

  /**
   * Get AES key length in bytes based on encryption method
   */
  private getAESKeyLength(): number {
    switch (this.encryptionInfo.encryptionMethod) {
      case EncryptionMethod.AES_128:
        return 16;
      case EncryptionMethod.AES_192:
        return 24;
      case EncryptionMethod.AES_256:
        return 32;
      default:
        throw new UnsupportedEncryptionError(this.encryptionInfo.encryptionMethod);
    }
  }

  /**
   * Get AES cipher name for Node.js crypto module
   */
  private getAESCipherName(): string {
    switch (this.encryptionInfo.encryptionMethod) {
      case EncryptionMethod.AES_128:
        return 'aes-128-ctr';
      case EncryptionMethod.AES_192:
        return 'aes-192-ctr';
      case EncryptionMethod.AES_256:
        return 'aes-256-ctr';
      default:
        throw new UnsupportedEncryptionError(this.encryptionInfo.encryptionMethod);
    }
  }

  /**
   * Get the actual compression method for AES encrypted files
   * For AES files, the actual compression method is stored in the extra field
   */
  private getActualCompressionMethod(): number {
    if (this.cdfh.compressionMethod !== CompressionMethod.AES) {
      return this.cdfh.compressionMethod;
    }

    // For AES files, extract the actual compression method from extra field
    const data = this.cdfh.dataBuffer;
    const extraFieldStart = 46 + this.cdfh.fileName.length;
    const extraFieldEnd = extraFieldStart + this.cdfh.extraFieldLength;

    if (data.length < extraFieldEnd) {
      return CompressionMethod.NONE; // Default fallback
    }

    let offset = extraFieldStart;
    while (offset < extraFieldEnd - 4) {
      const headerID = data.readUInt16LE(offset);
      const dataSize = data.readUInt16LE(offset + 2);

      // AES extra field header ID (0x9901)
      if (headerID === 0x9901 && dataSize >= 7) {
        // The actual compression method is stored at offset 9 (2 bytes)
        return data.readUInt16LE(offset + 4 + 5); // +4 for header, +5 for version(2) + vendor(2) + strength(1)
      }

      offset += 4 + dataSize;
    }

    return CompressionMethod.NONE; // Default fallback
  }

  /**
   * Constant-time comparison for password/HMAC verification to prevent timing attacks
   */
  private constantTimeEquals(a: Buffer, b: Buffer): boolean {
    if (a.length !== b.length) {
      return false;
    }

    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a[i] ^ b[i];
    }
    return result === 0;
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
   * Normalize path separators to forward slashes for consistent handling
   * This ensures Windows paths work correctly with the ZIP path logic
   * @param path The path to normalize
   * @returns Path with normalized separators
   */
  private normalizePath(path: string): string {
    return path.replace(/\\/g, '/');
  }

  /**
   * Split a path into segments, handling both forward slashes and backslashes
   * @param path The path to split
   * @returns Array of path segments
   */
  private splitPath(path: string): string[] {
    // First normalize the path, then split on forward slashes
    return this.normalizePath(path).split('/').filter(Boolean);
  }

  /**
   * Check if a ZIP file or entry is encrypted
   * @param src The path of the zip file or entry to check
   * @param options Optional options for the operation
   * @returns A promise that resolves to true if the ZIP contains encrypted entries
   */
  public async isEncrypted(src: string, options?: ExistsOptions): Promise<boolean> {
    this.logger.debug(`[AdvZlib] isEncrypted(): Checking encryption for ${src}`);

    if (!src) {
      throw new Error(`[AdvZlib] isEncrypted(): src is required`);
    }

    try {
      const centralDir = await this.createOrGetCentralDir(src);
      if (!centralDir) {
        return false;
      }

      if (this.isZipFile(src)) {
        // Check if any entry in the ZIP is encrypted
        return centralDir.entries.some((entry) => entry.isEncrypted);
      }

      // Check specific entry
      const entry = centralDir.entries.find((entry) => this.matchEntryByFullPath(entry, src));
      return entry ? entry.isEncrypted : false;
    } catch (error) {
      this.logger.debug(`[AdvZlib] isEncrypted(): Error checking ${src}: ${error}`);
      return false;
    }
  }

  /**
   * Get detailed encryption information for a ZIP file or entry
   * @param src The path of the zip file or entry
   * @param options Optional options for the operation
   * @returns A promise that resolves to encryption information
   */
  public async getEncryptionInfo(src: string, options?: ExistsOptions): Promise<EncryptionInfo> {
    this.logger.debug(`[AdvZlib] getEncryptionInfo(): Getting encryption info for ${src}`);

    if (!src) {
      throw new Error(`[AdvZlib] getEncryptionInfo(): src is required`);
    }

    const centralDir = await this.createOrGetCentralDir(src);
    if (!centralDir) {
      throw new Error(`[AdvZlib] getEncryptionInfo(): Failed to get central directory for ${src}`);
    }

    if (this.isZipFile(src)) {
      // Return info about the most restrictive encryption in the ZIP
      const encryptedEntries = centralDir.entries.filter((entry) => entry.isEncrypted);
      if (encryptedEntries.length === 0) {
        return { isEncrypted: false, encryptionMethod: EncryptionMethod.NONE, needsPassword: false };
      }

      // Find the strongest encryption method used
      const methods = encryptedEntries.map((e) => e.encryptionInfo.encryptionMethod);
      const strongestMethod = methods.includes(EncryptionMethod.AES_256)
        ? EncryptionMethod.AES_256
        : methods.includes(EncryptionMethod.AES_192)
        ? EncryptionMethod.AES_192
        : methods.includes(EncryptionMethod.AES_128)
        ? EncryptionMethod.AES_128
        : methods.includes(EncryptionMethod.TRADITIONAL)
        ? EncryptionMethod.TRADITIONAL
        : EncryptionMethod.UNKNOWN;

      return { isEncrypted: true, encryptionMethod: strongestMethod, needsPassword: true };
    }

    // Check specific entry
    const entry = centralDir.entries.find((entry) => this.matchEntryByFullPath(entry, src));
    if (!entry) {
      throw new Error(`[AdvZlib] getEncryptionInfo(): Entry not found: ${src}`);
    }

    return entry.encryptionInfo;
  }

  /**
   * Get the list of entries in a ZIP file
   * @param src The path of the zip file which can be:
   * - Normal: `/a/b.zip`
   * - Nested zip: `/a/b.zip/c.zip` or `/a/b.zip/c/d.zip`
   * @param options Optional options including filter function and password for encrypted files
   * @returns A promise that resolves to the list of filtered entries in the ZIP file.
   */
  public async getEntries(src: string, options?: GetEntriesOptions): Promise<ZipEntry[]> {
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

    return centralDir.entries.filter((entry) => (options?.filter ? options.filter(entry) : true));
  }

  /**
   * Check if a file exists in a ZIP file
   * @param src The path of the zip file which can be:
   * - Normal: `/a/b.zip/c.txt`
   * - Folder: `/a/b.zip/c/`
   * - Nested zip: `/a/b.zip/c.zip`
   * @param options Optional options including password for encrypted files
   * @returns A promise that resolves to a boolean indicating whether the file exists in the ZIP file.
   */
  public async exists(src: string, options?: ExistsOptions): Promise<boolean> {
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
   * @param options Optional options including filter function and password for encrypted files
   * @returns A promise that resolves to an array of full paths of the extracted files.
   * @throws Will throw an error if the `src` ZIP file does not exist or if the `dest` directory does not exist.
   */
  public async extract(src: string, dest: string, options?: ExtractOptions): Promise<string[]> {
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

    if (!this.isZipFile(src) && options?.filter) {
      throw new Error(`[AdvZlib] extract(): Filter function is only applicable for extracting a whole zip file.`);
    }

    const centralDir = await this.createOrGetCentralDir(src);
    if (!centralDir) {
      throw new Error(`[AdvZlib] extract(): Failed to get central directory for ${src}`);
    }

    const extracted: string[] = [];
    const entries = this.getRelatedEntries(src, centralDir.entries, options?.filter);

    // Extract all entries using the unified entry.extract() method
    for (const entry of entries) {
      try {
        extracted.push(await entry.extract(dest, options?.password));
      } catch (error) {
        this.logger.error(`[AdvZlib] extract(): Failed to extract entry ${entry.relPath}: ${error}`);
        throw error;
      }
    }

    return extracted;
  }

  /**
   * Reads the content of a specific file within a ZIP file.
   *
   * @param src - The path to the ZIP file or an entry within it. Accepted formats include:
   *   - Type 1: `/a/b.zip` - Reads using a `filter` function to filter entries.
   *   - Type 2: `/a/b.zip/c.txt` - Directly specifies a file entry to read, without a `filter`.
   *   - Type 3: `/a/b.zip/c.zip` - Specifies a nested ZIP entry, read with a `filter` function.
   *   - Type 4: `/a/b.zip/c.zip/d.txt` - Directly specifies a file entry within a nested ZIP, without a `filter`.
   * @param options - Optional options including filter function and password for encrypted files
   * @returns A promise that resolves to a `Buffer` containing the file's contents, or an empty `Buffer`
   *          if no matching entry is found or if multiple entries match.
   * @throws Will throw an error if the `src` file does not exist.
   */
  public async read(src: string, options?: ReadOptions): Promise<Buffer> {
    this.logger.info(`[AdvZlib] read(): Reading content from ${src}`);

    if (!(await this.exists(src))) {
      throw new Error('read(): The source of the ZIP file is required.');
    }

    const centralDir = await this.createOrGetCentralDir(src);
    if (!centralDir) {
      throw new Error(`[AdvZlib] read(): Failed to get central directory for ${src}`);
    }

    const entries = this.getRelatedEntries(src, centralDir.entries, options?.filter);
    if (entries.length === 0) {
      this.logger.error(`[AdvZlib] read(): No matching entries found in ${src}`);
      return Buffer.alloc(0);
    }

    if (entries.length > 1) {
      this.logger.error(`[AdvZlib] read(): Multiple matching entries found in ${src}`);
      return Buffer.alloc(0);
    }

    return await entries[0].read(options?.password);
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
    const entryFullPath = this.normalizePath(entry.fullPath);
    const srcPath = this.normalizePath(src);

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
      : entries.filter((entry) => {
          if (!entryRelPath) return true;
          // Normalize both paths to forward slashes for comparison
          // since entry.relPath now uses platform-specific separators
          const normalizedEntryPath = entry.relPath.replace(/\\/g, '/');
          return normalizedEntryPath === entryRelPath;
        });
  }

  /**
   * Get the last entry relative path, e.g., '/a/b.zip/c/d.txt' to 'c/d.txt'
   * @param src The source ZIP path
   * @returns The last entry relative path
   */
  private getLastEntryRelPath(src: string, includeZip = false): string {
    // Normalize the source path first
    const normalizedSrc = this.normalizePath(src);

    // Find the last ZIP file in the path
    const lastZipPath = this.findLastZipPath(normalizedSrc);
    if (!lastZipPath) {
      return '';
    }

    // Extract the path after the last ZIP file
    const afterZipPath = normalizedSrc.substring(lastZipPath.length);

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
          const normalizedSegment = this.normalizePath(segment);
          const normalizedPreviousZipPath = this.normalizePath(previousZipPath);
          const relativePathInParent = normalizedSegment.substring(normalizedPreviousZipPath.length + 1); // +1 to remove the leading slash
          // Normalize entry.relPath for comparison since it now uses platform-specific separators
          const zipEntry = currentCentralDir.entries.find((entry) => entry.relPath.replace(/\\/g, '/') === relativePathInParent);

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
   * 'C:\\a\\b.zip' -> 'C:/a/b.zip' (Windows paths)
   * 'C:\\a\\b.zip\\c.zip' -> 'C:/a/b.zip/c.zip' (Windows paths)
   */
  private findLastZipPath(source: string): string | null {
    const normalizedSource = this.normalizePath(source);
    const segments = this.splitPath(normalizedSource);
    let lastZipPath = '';
    let foundLastZip = false;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      lastZipPath += (i === 0 && normalizedSource.startsWith('/') ? '/' : i > 0 ? '/' : '') + segment;

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
   * 'C:\\a\\b.zip' -> ['C:/a/b.zip'] (Windows paths)
   * 'C:\\a\\b.zip\\c.zip' -> ['C:/a/b.zip', 'C:/a/b.zip/c.zip'] (Windows paths)
   */
  private extractZipSegments(source: string): string[] {
    const normalizedSource = this.normalizePath(source);
    const segments = this.splitPath(normalizedSource);
    const result: string[] = [];
    let currentPath = '';
    const isAbsolute = normalizedSource.startsWith('/');

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
