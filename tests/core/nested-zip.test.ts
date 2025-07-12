import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import AdvZlib from '../../src/index';
import { createBasicTestZipFiles, createPerformanceTestZipFiles, BasicTestAssets, PerformanceTestAssets, safeRemoveDir } from '../test-assets';

describe('Nested ZIP Handling', () => {
  const testAssetsDir = join(__dirname, '../test-assets-nested');
  let advZlib: AdvZlib;
  let basicAssets: BasicTestAssets;
  let perfAssets: PerformanceTestAssets;

  const silentLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  beforeAll(async () => {
    await fs.mkdir(testAssetsDir, { recursive: true });
    [basicAssets, perfAssets] = await Promise.all([
      createBasicTestZipFiles(testAssetsDir),
      createPerformanceTestZipFiles(testAssetsDir),
    ]);
    advZlib = new AdvZlib({
      logger: silentLogger,
      enableContentCaching: true,
      maxCentralDirCount: 20,
      maxContentCacheCount: 50,
    });
  }, 60000);

  afterAll(async () => {
    if (advZlib) {
      await advZlib.cleanup();
    }
    await safeRemoveDir(testAssetsDir);
  });

  describe('2-Level Nesting', () => {
    test('should check existence of nested ZIP file', async () => {
      const nestedZipExists = await advZlib.exists(basicAssets.nested);
      expect(nestedZipExists).toBe(true);
    });

    test('should check existence of file within nested ZIP', async () => {
      const fileInNestedZip = join(basicAssets.nested, 'inner.zip', 'inner.txt');
      const exists = await advZlib.exists(fileInNestedZip);
      expect(exists).toBe(true);
    });

    test('should read content from file within nested ZIP', async () => {
      const fileInNestedZip = join(basicAssets.nested, 'inner.zip', 'inner.txt');
      const content = await advZlib.read(fileInNestedZip);
      expect(content.toString()).toContain('Inner file content');
    });

    test('should get entries from nested ZIP', async () => {
      const nestedZipPath = join(basicAssets.nested, 'inner.zip');
      const entries = await advZlib.getEntries(nestedZipPath);
      expect(entries.length).toBeGreaterThan(0);

      const textEntry = entries.find((e) => e.name === 'inner.txt');
      expect(textEntry).toBeDefined();
      expect(textEntry!.isDirectory).toBe(false);
    });

    test('should extract file from nested ZIP', async () => {
      const outputDir = join(testAssetsDir, 'extract-nested');
      await fs.mkdir(outputDir, { recursive: true });

      const fileInNestedZip = join(basicAssets.nested, 'inner.zip', 'inner.txt');
      const extracted = await advZlib.extract(fileInNestedZip, outputDir);

      expect(extracted).toHaveLength(1);
      expect(extracted[0]).toMatch(/inner\.txt$/);

      const content = await fs.readFile(extracted[0], 'utf8');
      expect(content).toContain('Inner file content');
    });

    test('should extract entire nested ZIP', async () => {
      const outputDir = join(testAssetsDir, 'extract-nested-full');
      await fs.mkdir(outputDir, { recursive: true });

      const extracted = await advZlib.extract(basicAssets.nested, outputDir);
      expect(extracted.length).toBeGreaterThan(0);
    });
  });

  describe('3-Level Nesting', () => {
    test('should handle deep nested ZIP existence', async () => {
      const deepNestedExists = await advZlib.exists(perfAssets.deepNested);
      expect(deepNestedExists).toBe(true);
    });

    test('should check existence of file in deeply nested ZIP', async () => {
      const deepFile = join(perfAssets.deepNested, 'level2.zip', 'level3.zip', 'inner.txt');
      const exists = await advZlib.exists(deepFile);
      expect(exists).toBe(true);
    });

    test('should read content from deeply nested file', async () => {
      const deepFile = join(perfAssets.deepNested, 'level2.zip', 'level3.zip', 'inner.txt');
      const content = await advZlib.read(deepFile);
      expect(content.toString()).toContain('Inner file content');
    });

    test('should get entries from deeply nested ZIP', async () => {
      const level3ZipPath = join(perfAssets.deepNested, 'level2.zip', 'level3.zip');
      const entries = await advZlib.getEntries(level3ZipPath);
      expect(entries.length).toBeGreaterThan(0);

      const deepEntry = entries.find((e) => e.name === 'inner.txt');
      expect(deepEntry).toBeDefined();
    });

    test('should extract from deeply nested ZIP', async () => {
      const outputDir = join(testAssetsDir, 'extract-deep-nested');
      await fs.mkdir(outputDir, { recursive: true });

      const deepFile = join(perfAssets.deepNested, 'level2.zip', 'level3.zip', 'inner.txt');
      const extracted = await advZlib.extract(deepFile, outputDir);

      expect(extracted).toHaveLength(1);
      const content = await fs.readFile(extracted[0], 'utf8');
      expect(content).toContain('Inner file content');
    });
  });

  describe('Cache Efficiency for Nested ZIPs', () => {
    test('should cache intermediate ZIPs for better performance', async () => {
      // Access a nested file to populate cache
      const nestedFile = join(basicAssets.nested, 'inner.zip', 'inner.txt');

      // First access - populate cache
      const start1 = Date.now();
      await advZlib.read(nestedFile);
      const firstTime = Date.now() - start1;

      // Second access - should use cached intermediate ZIP
      const start2 = Date.now();
      await advZlib.read(nestedFile);
      const secondTime = Date.now() - start2;

      expect(secondTime).toBeLessThanOrEqual(firstTime);

      // Verify cache has entries
      const stats = advZlib.getCacheStats();
      expect(stats.centralDir.entries).toBeGreaterThan(0);
    });

    test('should cache content across nested ZIP accesses', async () => {
      const nestedFile = join(basicAssets.nested, 'inner.zip', 'inner.txt');

      // Read multiple times to test content caching
      const content1 = await advZlib.read(nestedFile);
      const content2 = await advZlib.read(nestedFile);

      expect(content1.equals(content2)).toBe(true);

      // Verify content cache has entries
      const stats = advZlib.getCacheStats();
      expect(stats.content.entries).toBeGreaterThan(0);
    });

    test('should maintain cache efficiency with multiple nested accesses', async () => {
      const files = [
        join(basicAssets.nested, 'inner.zip', 'inner.txt'),
        join(perfAssets.deepNested, 'level2.zip', 'level3.zip', 'inner.txt'),
      ];

      // Access multiple nested files
      for (const file of files) {
        await advZlib.exists(file);
        await advZlib.read(file);
      }

      const stats = advZlib.getCacheStats();
      expect(stats.total.entries).toBeGreaterThan(2);
      expect(stats.total.memoryMB).toBeGreaterThan(0);
    });
  });

  describe('Path Resolution', () => {
    test('should handle Windows-style paths in nested ZIPs', async () => {
      // Test path normalization with backslashes
      const windowsStylePath = basicAssets.nested.replace(/\//g, '\\') + '\\inner.zip\\inner.txt';
      const exists = await advZlib.exists(windowsStylePath);
      expect(exists).toBe(true);
    });

    test('should handle mixed path separators', async () => {
      const mixedPath = basicAssets.nested.replace(/\/([^\/]+)\.zip/, '\\$1.zip') + '/inner.zip/inner.txt';
      const exists = await advZlib.exists(mixedPath);
      expect(exists).toBe(true);
    });

    test('should resolve relative paths correctly', async () => {
      const nestedZipPath = join(basicAssets.nested, 'inner.zip');
      const entries = await advZlib.getEntries(nestedZipPath);
      expect(entries.length).toBeGreaterThan(0);

      // Verify relative paths are set correctly
      entries.forEach((entry) => {
        expect(entry.relPath).not.toMatch(/^[\/\\]/);
        expect(entry.fullPath).toContain(nestedZipPath);
      });
    });
  });

  describe('Error Handling for Nested ZIPs', () => {
    test('should handle non-existent nested ZIP gracefully', async () => {
      const fakeNestedPath = join(basicAssets.simpleText, 'fake.zip', 'file.txt');
      const exists = await advZlib.exists(fakeNestedPath);
      expect(exists).toBe(false);
    });

    test('should handle corrupted nested ZIP gracefully', async () => {
      const nonZipFile = join(basicAssets.simpleText, 'sample.txt', 'file.txt');
      const exists = await advZlib.exists(nonZipFile);
      expect(exists).toBe(false);
    });

    test('should handle non-existent file in nested ZIP gracefully', async () => {
      const nonExistentFile = join(basicAssets.nested, 'inner.zip', 'non-existent.txt');
      await expect(advZlib.read(nonExistentFile)).rejects.toThrow('The source of the ZIP file is required');
    });
  });
});
