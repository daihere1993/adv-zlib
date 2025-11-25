import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { llzlib, ZipEntry } from '../../src/llzlib';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import archiver from 'archiver';
import { createWriteStream as createWriteStream2, createReadStream } from 'node:fs';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

// Helper function to create a test zip file
async function createTestZip(
  zipPath: string,
  files: Record<string, string | null>,
  options?: { useStore?: boolean; forceZip64?: boolean },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream2(zipPath);
    const archive = archiver('zip', {
      zlib: { level: 9 },
      store: options?.useStore,
      forceZip64: options?.forceZip64,
    });

    output.on('close', () => resolve());
    output.on('error', (err) => reject(err));
    archive.on('error', (err) => reject(err));
    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') {
        console.warn('Archive warning:', err);
      } else {
        reject(err);
      }
    });

    archive.pipe(output);

    for (const [filename, content] of Object.entries(files)) {
      if (content === null) {
        // Create empty directory (must end with /)
        archive.append(Buffer.alloc(0), { name: filename });
      } else {
        archive.append(content, { name: filename, store: options?.useStore });
      }
    }

    archive.finalize();
  });
}

// Helper function to read stream to string
async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('error', (err) => reject(err));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

describe('lAdvZlib', () => {
  const testDir = join(tmpdir(), 'adv-zlib-test');
  let testZipPath: string;
  let storedZipPath: string;
  let corruptedZipPath: string;

  beforeAll(async () => {
    await mkdir(testDir, { recursive: true });

    // Create a test ZIP with compressed files
    testZipPath = join(testDir, 'test.zip');
    await createTestZip(testZipPath, {
      'file1.txt': 'Hello, World!',
      'file2.txt': 'This is a test file with more content.',
      'emptydir/': null,
      'dir/file3.txt': 'Nested file content',
    });

    // Create a test ZIP with stored (uncompressed) files
    storedZipPath = join(testDir, 'stored.zip');
    await createTestZip(
      storedZipPath,
      {
        'stored1.txt': 'Stored content',
        'stored2.txt': 'Another stored file',
      },
      { useStore: true },
    );

    // Create a corrupted ZIP file (invalid signature)
    corruptedZipPath = join(testDir, 'corrupted.zip');
    await createTestZip(corruptedZipPath, {
      'temp.txt': 'temp',
    });
    // Corrupt the end of central directory signature
    const fileBuffer = await readFile(corruptedZipPath);
    // Find and corrupt the EOCD signature (0x06054b50)
    const sigIndex = fileBuffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (sigIndex !== -1) {
      fileBuffer[sigIndex] = 0xff; // Corrupt the signature
      await writeFile(corruptedZipPath, fileBuffer);
    }
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('Basic ZIP Operations', () => {
    it('should open and parse a valid ZIP file', async () => {
      const zipFile = await llzlib.open(testZipPath);
      expect(zipFile).toBeDefined();
      expect(zipFile.entryCount).toBe(4);
      zipFile.close();
    });

    it('should read all entries with correct metadata', async () => {
      const zipFile = await llzlib.open(testZipPath);
      const entries: ZipEntry[] = [];

      for (let i = 0; i < zipFile.entryCount; i++) {
        const entry = await zipFile.nextEntry();
        entries.push(entry);
      }

      expect(entries).toHaveLength(4);

      // Check first entry
      expect(entries[0].fileName).toBe('file1.txt');
      expect(entries[0].compressionMethod).toBe(8); // Deflated

      // Check second entry
      expect(entries[1].fileName).toBe('file2.txt');
      expect(entries[1].compressionMethod).toBe(8); // Deflated

      // Check third entry (empty directory)
      expect(entries[2].fileName).toBe('emptydir/');
      // Directory entry should end with a slash
      expect(entries[2].fileName.endsWith('/')).toBe(true);

      // Check fourth entry (nested file)
      expect(entries[3].fileName).toBe('dir/file3.txt');
      expect(entries[3].compressionMethod).toBe(8); // Deflated

      zipFile.close();
    });

    it('should properly close and release resources', async () => {
      const zipFile = await llzlib.open(testZipPath);
      expect(() => zipFile.close()).not.toThrow();
    });
  });

  describe('Read Streams', () => {
    it('should create read stream for deflated entries', async () => {
      const zipFile = await llzlib.open(testZipPath);
      const entry = await zipFile.nextEntry();

      expect(entry.fileName).toBe('file1.txt');
      expect(entry.compressionMethod).toBe(8); // Deflated

      const stream = await entry.createReadStream();
      const content = await streamToString(stream);

      expect(content).toBe('Hello, World!');
      zipFile.close();
    });

    it('should create read stream for stored entries', async () => {
      const zipFile = await llzlib.open(storedZipPath);
      const entry = await zipFile.nextEntry();

      expect(entry.fileName).toBe('stored1.txt');
      expect(entry.compressionMethod).toBe(0); // Stored

      const stream = await entry.createReadStream();
      const content = await streamToString(stream);

      expect(content).toBe('Stored content');
      zipFile.close();
    });

    it('should verify content matches original for all entries', async () => {
      const zipFile = await llzlib.open(testZipPath);
      const expectedContents: Record<string, string> = {
        'file1.txt': 'Hello, World!',
        'file2.txt': 'This is a test file with more content.',
        'emptydir/': '',
        'dir/file3.txt': 'Nested file content',
      };

      for (let i = 0; i < zipFile.entryCount; i++) {
        const entry = await zipFile.nextEntry();
        const stream = await entry.createReadStream();
        const content = await streamToString(stream);

        expect(content).toBe(expectedContents[entry.fileName]);
      }

      zipFile.close();
    });
  });

  describe('Error Handling', () => {
    it('should throw error on corrupted ZIP signature', async () => {
      await expect(llzlib.open(corruptedZipPath)).rejects.toThrow('Invalid end of central directory record');
    });
  });

  describe('ZIP64 Support', () => {
    let zip64Path: string;
    let zip64StoredPath: string;
    let zip64WithDirsPath: string;
    let corruptedZip64EocdlPath: string;
    let corruptedZip64EocdrPath: string;
    let truncatedZip64Path: string;

    beforeAll(async () => {
      // Create a test ZIP64 file with deflated content
      zip64Path = join(testDir, 'test-zip64.zip');
      await createTestZip(
        zip64Path,
        {
          'zip64-file1.txt': 'ZIP64 content here!',
          'zip64-file2.txt': 'Another ZIP64 file with more text.',
          'zip64-file3.txt': 'Third file in ZIP64 format',
        },
        { forceZip64: true },
      );

      // Create a test ZIP64 file with stored (uncompressed) content
      zip64StoredPath = join(testDir, 'test-zip64-stored.zip');
      await createTestZip(
        zip64StoredPath,
        {
          'stored-zip64-1.txt': 'Stored ZIP64 content',
          'stored-zip64-2.txt': 'Another stored ZIP64 file',
        },
        { useStore: true, forceZip64: true },
      );

      // Create a test ZIP64 file with directories
      zip64WithDirsPath = join(testDir, 'test-zip64-dirs.zip');
      await createTestZip(
        zip64WithDirsPath,
        {
          'emptydir-zip64/': null,
          'dir-zip64/file.txt': 'File in directory',
          'dir-zip64/subdir/nested.txt': 'Nested file',
        },
        { forceZip64: true },
      );

      // Create corrupted ZIP64 files for error testing
      // 1. Corrupt ZIP64 EOCDL signature
      corruptedZip64EocdlPath = join(testDir, 'corrupted-zip64-eocdl.zip');
      await createTestZip(corruptedZip64EocdlPath, { 'test.txt': 'test content' }, { forceZip64: true });
      let buffer = await readFile(corruptedZip64EocdlPath);
      // Find ZIP64 EOCDL signature (0x07064b50) and corrupt it
      const eocdlSig = Buffer.from([0x50, 0x4b, 0x06, 0x07]);
      const eocdlIndex = buffer.lastIndexOf(eocdlSig);
      if (eocdlIndex !== -1) {
        buffer[eocdlIndex] = 0xff; // Corrupt the signature
        await writeFile(corruptedZip64EocdlPath, buffer);
      }

      // 2. Corrupt ZIP64 EOCDR signature
      corruptedZip64EocdrPath = join(testDir, 'corrupted-zip64-eocdr.zip');
      await createTestZip(corruptedZip64EocdrPath, { 'test.txt': 'test content' }, { forceZip64: true });
      buffer = await readFile(corruptedZip64EocdrPath);
      // Find ZIP64 EOCDR signature (0x06064b50) and corrupt it
      const eocdrSig = Buffer.from([0x50, 0x4b, 0x06, 0x06]);
      const eocdrIndex = buffer.lastIndexOf(eocdrSig);
      if (eocdrIndex !== -1) {
        buffer[eocdrIndex] = 0xff; // Corrupt the signature
        await writeFile(corruptedZip64EocdrPath, buffer);
      }

      // 3. Create truncated ZIP64 file
      truncatedZip64Path = join(testDir, 'truncated-zip64.zip');
      await createTestZip(truncatedZip64Path, { 'test.txt': 'test content' }, { forceZip64: true });
      buffer = await readFile(truncatedZip64Path);
      // Truncate the file to remove part of the ZIP64 structures
      // Remove last 30 bytes which should corrupt the ZIP64 structures
      const truncatedBuffer = buffer.subarray(0, buffer.length - 30);
      await writeFile(truncatedZip64Path, truncatedBuffer);
    });

    describe('Valid ZIP64 Files', () => {
      it('should detect ZIP64 by EOCDL signature when centralDirOffset is not 0xffffffff', async () => {
        // This test reproduces the issue where a ZIP64 file has entryCount = 0xffff
        // (because real entry count > 65535) but centralDirOffset < 0xffffffff
        // The current code only checks centralDirOffset to detect ZIP64, which fails

        // Create a ZIP64 file
        const zip64TestPath = join(testDir, 'test-zip64-eocdl-detection.zip');
        await createTestZip(
          zip64TestPath,
          {
            'test1.txt': 'content1',
            'test2.txt': 'content2',
          },
          { forceZip64: true },
        );

        // Modify the regular EOCDR to simulate a case where:
        // - entryCount = 0xffff (indicating ZIP64)
        // - centralDirOffset is a valid value (not 0xffffffff)
        let buffer = await readFile(zip64TestPath);

        // Find the regular EOCDR signature (0x06054b50)
        const eocdrSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
        const eocdrIndex = buffer.lastIndexOf(eocdrSig);

        if (eocdrIndex !== -1) {
          // Modify the entry count (offset 10-11) to 0xffff
          buffer.writeUInt16LE(0xffff, eocdrIndex + 10);
          // Modify centralDirOffset (offset 16-19) to a small value (not 0xffffffff)
          // Use 1000 as a placeholder - the real value is in ZIP64 EOCDR
          buffer.writeUInt32LE(1000, eocdrIndex + 16);
          await writeFile(zip64TestPath, buffer);
        }

        // This should work with the fixed code (detects ZIP64 by EOCDL signature)
        // but fails with the current code (only checks centralDirOffset)
        const zipFile = await llzlib.open(zip64TestPath);
        expect(zipFile).toBeDefined();
        expect(zipFile.entryCount).toBe(2); // Real count from ZIP64 EOCDR

        zipFile.close();
      });

      it('should open and parse a valid ZIP64 file', async () => {
        const zipFile = await llzlib.open(zip64Path);
        expect(zipFile).toBeDefined();
        expect(zipFile.entryCount).toBe(3);

        const entries: ZipEntry[] = [];
        for (let i = 0; i < zipFile.entryCount; i++) {
          const entry = await zipFile.nextEntry();
          entries.push(entry);
        }

        expect(entries).toHaveLength(3);
        expect(entries[0].fileName).toBe('zip64-file1.txt');
        expect(entries[1].fileName).toBe('zip64-file2.txt');
        expect(entries[2].fileName).toBe('zip64-file3.txt');

        zipFile.close();
      });

      it('should read streams from ZIP64 deflated entries', async () => {
        const zipFile = await llzlib.open(zip64Path);
        const expectedContents: Record<string, string> = {
          'zip64-file1.txt': 'ZIP64 content here!',
          'zip64-file2.txt': 'Another ZIP64 file with more text.',
          'zip64-file3.txt': 'Third file in ZIP64 format',
        };

        for (let i = 0; i < zipFile.entryCount; i++) {
          const entry = await zipFile.nextEntry();
          const stream = await entry.createReadStream();
          const content = await streamToString(stream);

          expect(content).toBe(expectedContents[entry.fileName]);
          expect(entry.compressionMethod).toBe(8); // Deflated
        }

        zipFile.close();
      });

      it('should read streams from ZIP64 stored entries', async () => {
        const zipFile = await llzlib.open(zip64StoredPath);
        const expectedContents: Record<string, string> = {
          'stored-zip64-1.txt': 'Stored ZIP64 content',
          'stored-zip64-2.txt': 'Another stored ZIP64 file',
        };

        for (let i = 0; i < zipFile.entryCount; i++) {
          const entry = await zipFile.nextEntry();
          const stream = await entry.createReadStream();
          const content = await streamToString(stream);

          expect(content).toBe(expectedContents[entry.fileName]);
          expect(entry.compressionMethod).toBe(0); // Stored
        }

        zipFile.close();
      });

      it('should handle ZIP64 files with directory entries', async () => {
        const zipFile = await llzlib.open(zip64WithDirsPath);
        expect(zipFile.entryCount).toBe(3);

        const entries: ZipEntry[] = [];
        for (let i = 0; i < zipFile.entryCount; i++) {
          const entry = await zipFile.nextEntry();
          entries.push(entry);
        }

        // Verify directory entry
        const dirEntry = entries.find((e) => e.fileName === 'emptydir-zip64/');
        expect(dirEntry).toBeDefined();
        expect(dirEntry!.fileName.endsWith('/')).toBe(true);

        // Verify nested file entries
        const fileEntry = entries.find((e) => e.fileName === 'dir-zip64/file.txt');
        expect(fileEntry).toBeDefined();

        const nestedEntry = entries.find((e) => e.fileName === 'dir-zip64/subdir/nested.txt');
        expect(nestedEntry).toBeDefined();

        // Read content from nested file
        const nestedStream = await nestedEntry!.createReadStream();
        const nestedContent = await streamToString(nestedStream);
        expect(nestedContent).toBe('Nested file');

        zipFile.close();
      });
    });

    describe('Error Cases', () => {
      it('should throw error on invalid ZIP64 EOCDL signature', async () => {
        await expect(llzlib.open(corruptedZip64EocdlPath)).rejects.toThrow(
          'Invalid end of central directory record, failed to find ZIP64 EOCDL',
        );
      });

      it('should throw error on invalid ZIP64 EOCDR signature', async () => {
        await expect(llzlib.open(corruptedZip64EocdrPath)).rejects.toThrow(
          'Invalid end of central directory record, failed to find ZIP64 EOCDR',
        );
      });

      it('should throw error on truncated ZIP64 file', async () => {
        await expect(llzlib.open(truncatedZip64Path)).rejects.toThrow(/Invalid end of central directory record/);
      });
    });
  });

  describe('createCdFromInflatedStream', () => {
    // Helper function to compress a ZIP file with raw deflate
    async function compressZipWithRawDeflate(zipPath: string, outputPath: string): Promise<number> {
      return new Promise((resolve, reject) => {
        const input = createReadStream(zipPath);
        const output = createWriteStream2(outputPath);
        const deflate = zlib.createDeflateRaw();

        let uncompressedSize = 0;
        input.on('data', (chunk) => {
          uncompressedSize += chunk.length;
        });

        input.pipe(deflate).pipe(output);

        output.on('finish', () => resolve(uncompressedSize));
        output.on('error', reject);
        input.on('error', reject);
        deflate.on('error', reject);
      });
    }

    // Helper function to create inflated stream from compressed file
    function createInflatedStream(compressedPath: string): Readable {
      const readStream = createReadStream(compressedPath);
      const inflate = zlib.createInflateRaw();
      return readStream.pipe(inflate);
    }

    // Mock logger for testing
    function createMockLogger() {
      const logs: { level: string; message: string }[] = [];
      return {
        logs,
        info: (message: string) => logs.push({ level: 'info', message }),
        debug: (message: string) => logs.push({ level: 'debug', message }),
        warn: (message: string) => logs.push({ level: 'warn', message }),
        error: (message: string) => logs.push({ level: 'error', message }),
      };
    }

    let smallZipPath: string;
    let smallZipCompressedPath: string;
    let smallZipUncompressedSize: number;

    let largeZipPath: string;
    let largeZipCompressedPath: string;
    let largeZipUncompressedSize: number;

    let mediumZipPath: string;
    let mediumZipCompressedPath: string;
    let mediumZipUncompressedSize: number;

    let storedZipPath2: string;
    let storedZipCompressedPath: string;
    let storedZipUncompressedSize: number;

    let minimalZipPath: string;
    let minimalZipCompressedPath: string;
    let minimalZipUncompressedSize: number;

    beforeAll(async () => {
      // Create a small ZIP (CD should fit in tail buffer)
      smallZipPath = join(testDir, 'small-nested.zip');
      await createTestZip(smallZipPath, {
        'file1.txt': 'content1',
        'file2.txt': 'content2',
      });
      smallZipCompressedPath = join(testDir, 'small-nested.zip.deflated');
      smallZipUncompressedSize = await compressZipWithRawDeflate(smallZipPath, smallZipCompressedPath);

      // Create a larger ZIP with many files (to test CD outside tail buffer)
      largeZipPath = join(testDir, 'large-nested.zip');
      const largeFiles: Record<string, string> = {};
      for (let i = 0; i < 50; i++) {
        largeFiles[`dir${i}/file${i}.txt`] = `Content for file ${i} with some extra text to make it larger`;
      }
      await createTestZip(largeZipPath, largeFiles);
      largeZipCompressedPath = join(testDir, 'large-nested.zip.deflated');
      largeZipUncompressedSize = await compressZipWithRawDeflate(largeZipPath, largeZipCompressedPath);

      // Create a medium ZIP for retry tests
      mediumZipPath = join(testDir, 'medium-nested.zip');
      const mediumFiles: Record<string, string> = {};
      for (let i = 0; i < 10; i++) {
        mediumFiles[`file${i}.txt`] = `Medium content ${i}`;
      }
      await createTestZip(mediumZipPath, mediumFiles);
      mediumZipCompressedPath = join(testDir, 'medium-nested.zip.deflated');
      mediumZipUncompressedSize = await compressZipWithRawDeflate(mediumZipPath, mediumZipCompressedPath);

      // Create a ZIP with stored (uncompressed) files
      storedZipPath2 = join(testDir, 'stored-nested.zip');
      await createTestZip(
        storedZipPath2,
        {
          'stored1.txt': 'Stored content 1',
          'stored2.txt': 'Stored content 2',
        },
        { useStore: true },
      );
      storedZipCompressedPath = join(testDir, 'stored-nested.zip.deflated');
      storedZipUncompressedSize = await compressZipWithRawDeflate(storedZipPath2, storedZipCompressedPath);

      // Create minimal ZIP (smallest valid ZIP)
      minimalZipPath = join(testDir, 'minimal-nested.zip');
      await createTestZip(minimalZipPath, {
        'a.txt': 'x',
      });
      minimalZipCompressedPath = join(testDir, 'minimal-nested.zip.deflated');
      minimalZipUncompressedSize = await compressZipWithRawDeflate(minimalZipPath, minimalZipCompressedPath);
    });

    describe('Basic Functionality', () => {
      it('should extract CD when fully contained in tail buffer', async () => {
        const logger = createMockLogger();

        const result = await llzlib.createCdFromInflatedStream(
          () => createInflatedStream(smallZipCompressedPath),
          smallZipUncompressedSize,
          {
            defaultSize: 1024 * 10, // 10KB, should be enough for small ZIP
            retry: 1,
            logger,
          },
        );

        expect(result.cd).toBeDefined();
        expect(result.cd.entryCount).toBe(2);
        expect(result.cdSize).toBeUndefined(); // CD fits in defaultSize
      });

      it('should extract CD when partially outside tail buffer', async () => {
        const logger = createMockLogger();

        const result = await llzlib.createCdFromInflatedStream(
          () => createInflatedStream(largeZipCompressedPath),
          largeZipUncompressedSize,
          {
            defaultSize: 500, // Small buffer to force CD outside
            retry: 3,
            logger,
          },
        );

        expect(result.cd).toBeDefined();
        expect(result.cd.entryCount).toBe(50);
        expect(result.cdSize).toBeDefined(); // CD larger than defaultSize
        expect(result.cdSize).toBeGreaterThan(500);
      });
    });

    describe('Retry Logic', () => {
      it('should retry with doubled defaultSize when EOCD not found', async () => {
        const logger = createMockLogger();

        const result = await llzlib.createCdFromInflatedStream(
          () => createInflatedStream(mediumZipCompressedPath),
          mediumZipUncompressedSize,
          {
            defaultSize: 20, // Very small, will definitely need retry
            retry: 5,
            logger,
          },
        );

        expect(result.cd).toBeDefined();
        expect(result.cd.entryCount).toBe(10);

        // Check that debug log indicates retry
        const debugLogs = logger.logs.filter((log) => log.level === 'debug');
        const hasRetryLog = debugLogs.some(
          (log) => log.message.includes('will retry with larger buffer') || log.message.includes('Attempt'),
        );
        expect(hasRetryLog).toBe(true);
      });

      it('should throw error after exceeding retry limit', async () => {
        const logger = createMockLogger();

        await expect(
          llzlib.createCdFromInflatedStream(
            () => createInflatedStream(mediumZipCompressedPath),
            mediumZipUncompressedSize,
            {
              defaultSize: 10, // Very small, will fail
              retry: 0, // No retries allowed
              logger,
            },
          ),
        ).rejects.toThrow(/Failed to find the central directory/);
      });
    });

    describe('Error Handling', () => {
      it('should throw error for invalid stream', async () => {
        const logger = createMockLogger();

        await expect(
          llzlib.createCdFromInflatedStream(
            () => {
              // Create a stream that emits error
              return new Readable({
                read() {
                  this.emit('error', new Error('Stream read error'));
                },
              });
            },
            1000,
            {
              defaultSize: 1024,
              retry: 1,
              logger,
            },
          ),
        ).rejects.toThrow('Stream read error');
      });

      it('should throw error for corrupted data', async () => {
        // Create a stream with random data (not a valid ZIP)
        const randomData = Buffer.alloc(1000);
        for (let i = 0; i < randomData.length; i++) {
          randomData[i] = Math.floor(Math.random() * 256);
        }

        const logger = createMockLogger();

        await expect(
          llzlib.createCdFromInflatedStream(
            () => {
              return new Readable({
                read() {
                  this.push(randomData);
                  this.push(null);
                },
              });
            },
            randomData.length,
            {
              defaultSize: 500,
              retry: 0, // Don't retry for corrupted data
              logger,
            },
          ),
        ).rejects.toThrow(/Failed to find the central directory/);
      });
    });

    describe('Edge Cases', () => {
      it('should handle minimal ZIP files', async () => {
        const logger = createMockLogger();

        const result = await llzlib.createCdFromInflatedStream(
          () => createInflatedStream(minimalZipCompressedPath),
          minimalZipUncompressedSize,
          {
            defaultSize: 1024,
            retry: 1,
            logger,
          },
        );

        expect(result.cd).toBeDefined();
        expect(result.cd.entryCount).toBe(1);
      });

      it('should handle very large tail buffers', async () => {
        const logger = createMockLogger();

        const result = await llzlib.createCdFromInflatedStream(
          () => createInflatedStream(smallZipCompressedPath),
          smallZipUncompressedSize,
          {
            defaultSize: 1024 * 1024, // 1MB, much larger than file
            retry: 1,
            logger,
          },
        );

        expect(result.cd).toBeDefined();
        expect(result.cd.entryCount).toBe(2);
      });

      it('should work with stored (uncompressed) ZIP entries', async () => {
        const logger = createMockLogger();

        const result = await llzlib.createCdFromInflatedStream(
          () => createInflatedStream(storedZipCompressedPath),
          storedZipUncompressedSize,
          {
            defaultSize: 1024,
            retry: 1,
            logger,
          },
        );

        expect(result.cd).toBeDefined();
        expect(result.cd.entryCount).toBe(2);
      });

      it('should work with deflated ZIP entries', async () => {
        const logger = createMockLogger();

        const result = await llzlib.createCdFromInflatedStream(
          () => createInflatedStream(smallZipCompressedPath),
          smallZipUncompressedSize,
          {
            defaultSize: 1024,
            retry: 1,
            logger,
          },
        );

        expect(result.cd).toBeDefined();
        expect(result.cd.entryCount).toBe(2);
      });
    });

    describe('Return Value Tests', () => {
      it('should return cdSize when actual size exceeds defaultSize', async () => {
        const logger = createMockLogger();

        const result = await llzlib.createCdFromInflatedStream(
          () => createInflatedStream(largeZipCompressedPath),
          largeZipUncompressedSize,
          {
            defaultSize: 200, // Smaller than CD size
            retry: 3,
            logger,
          },
        );

        expect(result.cd).toBeDefined();
        expect(result.cdSize).toBeDefined();
        expect(result.cdSize).toBeGreaterThan(200);
      });

      it('should return undefined cdSize when CD fits in defaultSize', async () => {
        const logger = createMockLogger();

        const result = await llzlib.createCdFromInflatedStream(
          () => createInflatedStream(smallZipCompressedPath),
          smallZipUncompressedSize,
          {
            defaultSize: 10 * 1024, // Larger than CD size
            retry: 1,
            logger,
          },
        );

        expect(result.cd).toBeDefined();
        expect(result.cdSize).toBeUndefined();
      });
    });

    describe('getAllEntries Tests', () => {
      it('should get all entries from CD of nested zip', async () => {
        const logger = createMockLogger();

        const result = await llzlib.createCdFromInflatedStream(
          () => createInflatedStream(smallZipCompressedPath),
          smallZipUncompressedSize,
          {
            defaultSize: 1024 * 10,
            retry: 1,
            logger,
          },
        );

        const entries = await result.cd.getAllEntryMetadatas();

        expect(entries).toHaveLength(2);
        expect(entries[0].fileName).toBe('file1.txt');
        expect(entries[0].compressionMethod).toBe(8);
        expect(entries[1].fileName).toBe('file2.txt');
        expect(entries[1].compressionMethod).toBe(8);
      });
    });
  });
});
