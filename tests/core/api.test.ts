import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import AdvZlib from '../../src/index';
import { createBasicTestZipFiles, BasicTestAssets, safeRemoveDir } from '../test-assets';

describe('AdvZlib Core API', () => {
  const testAssetsDir = join(__dirname, '../test-assets-api');
  let advZlib: AdvZlib;
  let basicAssets: BasicTestAssets;

  const silentLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  beforeAll(async () => {
    await fs.mkdir(testAssetsDir, { recursive: true });
    basicAssets = await createBasicTestZipFiles(testAssetsDir);
    advZlib = new AdvZlib({
      logger: silentLogger,
      enableContentCaching: true,
    });
  }, 60000);

  afterAll(async () => {
    await advZlib.cleanup();
    await safeRemoveDir(testAssetsDir);
  });

  describe('exists()', () => {
    test('should return true for existing simple ZIP file', async () => {
      const result = await advZlib.exists(basicAssets.simpleText);
      expect(result).toBe(true);
    });

    test('should return true for existing file within ZIP', async () => {
      const result = await advZlib.exists(join(basicAssets.simpleText, 'sample.txt'));
      expect(result).toBe(true);
    });

    test('should return true for existing directory within ZIP', async () => {
      // First check what directories actually exist
      const entries = await advZlib.getEntries(basicAssets.withDirectories);
      const dirs = entries.filter((e) => e.isDirectory);
      const dirName = dirs.length > 0 ? dirs[0].name : 'folder/';

      const result = await advZlib.exists(join(basicAssets.withDirectories, dirName));
      expect(result).toBe(true);
    });

    test('should return false for non-existent ZIP file', async () => {
      const result = await advZlib.exists(join(testAssetsDir, 'non-existent.zip'));
      expect(result).toBe(false);
    });

    test('should return false for non-existent file within ZIP', async () => {
      const result = await advZlib.exists(join(basicAssets.simpleText, 'non-existent.txt'));
      expect(result).toBe(false);
    });

    test('should handle nested ZIP existence check', async () => {
      const result = await advZlib.exists(basicAssets.nested);
      expect(result).toBe(true);
    });
  });

  describe('read()', () => {
    test('should read content from simple text file in ZIP', async () => {
      const content = await advZlib.read(join(basicAssets.simpleText, 'sample.txt'));
      expect(content.toString()).toContain('Hello, World!');
    });

    test('should read binary content from ZIP', async () => {
      const content = await advZlib.read(join(basicAssets.binaryFiles, 'sample.png'));
      expect(content.length).toBeGreaterThan(0);
      expect(content[0]).toBe(0x89); // PNG signature
    });

    test('should read content from another file correctly', async () => {
      const content = await advZlib.read(join(basicAssets.simpleText, 'another.txt'));
      expect(content.toString()).toContain('This is another file');
    });

    test('should read README content correctly', async () => {
      const content = await advZlib.read(join(basicAssets.simpleText, 'README.md'));
      expect(content.toString()).toContain('README content here');
    });

    test('should handle non-existent file gracefully', async () => {
      // The library throws for non-existent files, so test error behavior
      await expect(advZlib.read(join(basicAssets.simpleText, 'non-existent.txt'))).rejects.toThrow(
        'The source of the ZIP file is required'
      );
    });

    test('should handle files with unusual names', async () => {
      const content = await advZlib.read(join(basicAssets.unusualNames, 'file with spaces.txt'));
      expect(content.toString()).toContain('Space file content');
    });

    test('should use filter function to select specific entries', async () => {
      const content = await advZlib.read(basicAssets.simpleText, { filter: (entry) => entry.name === 'sample.txt' });
      expect(content.toString()).toContain('Hello, World!');
    });

    test('should read nested folder files with mixed path separators', async () => {
      // Test the path normalization fix - should work with both Unix and Windows style paths
      const unixPath = join(basicAssets.withDirectories, 'folder/subfolder/deep.txt');
      const windowsPath = basicAssets.withDirectories + '\\folder\\subfolder\\deep.txt';

      const content1 = await advZlib.read(unixPath);
      expect(content1.toString()).toContain('Deep nested file');

      const content2 = await advZlib.read(windowsPath);
      expect(content2.toString()).toContain('Deep nested file');
    });
  });

  describe('extract()', () => {
    test('should extract single file to directory', async () => {
      const outputDir = join(testAssetsDir, 'extract-single');
      await fs.mkdir(outputDir, { recursive: true });

      const extracted = await advZlib.extract(join(basicAssets.simpleText, 'sample.txt'), outputDir);
      expect(extracted).toHaveLength(1);
      expect(extracted[0]).toMatch(/sample\.txt$/);

      const content = await fs.readFile(extracted[0], 'utf8');
      expect(content).toContain('Hello, World!');
    });

    test('should extract entire ZIP to directory', async () => {
      const outputDir = join(testAssetsDir, 'extract-full');
      await fs.mkdir(outputDir, { recursive: true });

      const extracted = await advZlib.extract(basicAssets.withDirectories, outputDir);
      expect(extracted.length).toBeGreaterThan(1);

      // Verify directory structure is preserved
      const dirExists = await fs
        .access(join(outputDir, 'folder'))
        .then(() => true)
        .catch(() => false);
      expect(dirExists).toBe(true);
    });

    test('should extract with filter function', async () => {
      const outputDir = join(testAssetsDir, 'extract-filtered');
      await fs.mkdir(outputDir, { recursive: true });

      const extracted = await advZlib.extract(basicAssets.withDirectories, outputDir, {
        filter: (entry) => entry.name.endsWith('.txt'),
      });

      expect(extracted.length).toBeGreaterThan(0);
      extracted.forEach((path) => {
        expect(path).toMatch(/\.txt$/);
      });
    });

    test('should handle empty ZIP extraction', async () => {
      const outputDir = join(testAssetsDir, 'extract-empty');
      await fs.mkdir(outputDir, { recursive: true });

      const extracted = await advZlib.extract(basicAssets.empty, outputDir);
      expect(extracted).toHaveLength(0);
    });
  });

  describe('getEntries()', () => {
    test('should get all entries from simple ZIP', async () => {
      const entries = await advZlib.getEntries(basicAssets.simpleText);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0].name).toBe('sample.txt');
      expect(entries[0].isDirectory).toBe(false);
    });

    test('should get entries from ZIP with directories', async () => {
      const entries = await advZlib.getEntries(basicAssets.withDirectories);

      const directories = entries.filter((e) => e.isDirectory);
      const files = entries.filter((e) => !e.isDirectory);

      expect(directories.length).toBeGreaterThan(0);
      expect(files.length).toBeGreaterThan(0);
    });

    test('should filter entries using filter function', async () => {
      const entries = await advZlib.getEntries(basicAssets.withDirectories, { filter: (entry) => entry.name.endsWith('.txt') });

      expect(entries.length).toBeGreaterThan(0);
      entries.forEach((entry) => {
        expect(entry.name).toMatch(/\.txt$/);
      });
    });

    test('should return empty array for empty ZIP', async () => {
      const entries = await advZlib.getEntries(basicAssets.empty);
      expect(entries).toHaveLength(0);
    });

    test('should handle multiple file entries', async () => {
      const entries = await advZlib.getEntries(basicAssets.withDirectories);
      expect(entries.length).toBeGreaterThan(3); // Should have multiple files and directories

      const files = entries.filter((e) => !e.isDirectory);
      expect(files.length).toBeGreaterThan(2); // Should have multiple files
    });

    test('should return entries with platform-appropriate path separators', async () => {
      const entries = await advZlib.getEntries(basicAssets.withDirectories);
      const nestedEntry = entries.find((e) => e.relPath.includes('folder') && e.relPath.includes('subfolder'));

      expect(nestedEntry).toBeDefined();

      // On this platform, paths should use the platform's path separator
      const { sep } = require('path');
      if (sep === '\\') {
        // Windows: should use backslashes
        expect(nestedEntry!.relPath).toMatch(/\\/);
      } else {
        // Unix: should use forward slashes
        expect(nestedEntry!.relPath).toMatch(/\//);
      }

      // Should NOT have mixed separators
      const hasMixedSeparators = nestedEntry!.relPath.includes('/') && nestedEntry!.relPath.includes('\\');
      expect(hasMixedSeparators).toBe(false);
    });
  });

  describe('Cache Integration', () => {
    test('should improve performance with caching', async () => {
      // Use a unique file path to avoid cache contamination from other tests
      const uniqueFilePath = basicAssets.withDirectories;

      // Ensure clean cache state for this test
      await advZlib.cleanup();
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Verify cache is empty before test
      const initialStats = advZlib.getCacheStats();
      expect(initialStats.centralDir.entries).toBe(0);

      // First access (cold cache) - should read from disk
      const start1 = process.hrtime.bigint();
      const entries1 = await advZlib.getEntries(uniqueFilePath);
      const end1 = process.hrtime.bigint();
      const coldTime = Number(end1 - start1) / 1000000; // Convert to milliseconds

      // Verify content was cached after first read
      const afterFirstStats = advZlib.getCacheStats();
      expect(afterFirstStats.centralDir.entries).toBeGreaterThan(0);

      // Multiple warm cache reads to ensure consistency
      const warmReads = 3;
      const warmTimes: number[] = [];

      for (let i = 0; i < warmReads; i++) {
        const start = process.hrtime.bigint();
        const entries = await advZlib.getEntries(uniqueFilePath);
        const end = process.hrtime.bigint();

        expect(entries.length).toBe(entries1.length);
        warmTimes.push(Number(end - start) / 1000000); // Convert to milliseconds
      }

      // Check cache performance - warm reads should be faster than cold read
      const avgWarmTime = warmTimes.reduce((a, b) => a + b, 0) / warmTimes.length;

      expect(avgWarmTime).toBeLessThan(coldTime);
      expect(entries1.length).toBeGreaterThan(0);
    });

    test('should show cache statistics', () => {
      const stats = advZlib.getCacheStats();
      expect(stats).toHaveProperty('centralDir');
      expect(stats).toHaveProperty('content');
      expect(stats).toHaveProperty('total');
      expect(typeof stats.total.entries).toBe('number');
    });
  });
});
