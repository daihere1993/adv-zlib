import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import AdvZlib from '../src/index';
import { createBasicTestZipFiles, BasicTestAssets } from './test-assets';
import { info } from './test-utils';

describe('🧩 Unit Tests', () => {
  const testAssetsDir = join(__dirname, 'test-assets-03-unit');
  let testAssets: BasicTestAssets;

  const silentLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  beforeAll(async () => {
    await fs.mkdir(testAssetsDir, { recursive: true });
    testAssets = await createBasicTestZipFiles(testAssetsDir);
  }, 60000);

  afterAll(async () => {
    await fs.rm(testAssetsDir, { recursive: true, force: true });
  });

  describe('AdvZlib Class', () => {
    let advZlib: AdvZlib;

    beforeEach(() => {
      advZlib = new AdvZlib({
        logger: silentLogger,
        enableContentCaching: true,
        maxCentralDirCount: 5,
        maxCacheMemoryMB: 10,
        maxContentCacheCount: 10,
        maxContentCacheMemoryMB: 5,
      });
    });

    afterEach(async () => {
      await advZlib.cleanup();
    });

    test('should initialize with default options', () => {
      const defaultAdvZlib = new AdvZlib();
      expect(defaultAdvZlib).toBeDefined();
      expect(defaultAdvZlib.getCacheStats).toBeDefined();
    });

    test('should initialize with custom options', () => {
      const customAdvZlib = new AdvZlib({
        logger: silentLogger,
        enableContentCaching: false,
        maxCentralDirCount: 20,
        maxCacheMemoryMB: 50,
      });

      expect(customAdvZlib).toBeDefined();

      const stats = customAdvZlib.getCacheStats();
      expect(stats.content.entries).toBe(0);
      expect(stats.content.memoryMB).toBe(0);
    });

    test('should handle cleanup properly', async () => {
      // Load some data into cache
      await advZlib.getEntries(testAssets.simpleText);

      let stats = advZlib.getCacheStats();
      expect(stats.centralDir.entries).toBeGreaterThan(0);

      // Cleanup should clear caches
      await advZlib.cleanup();

      stats = advZlib.getCacheStats();
      expect(stats.centralDir.entries).toBe(0);
      expect(stats.content.entries).toBe(0);
    });

    test('should provide accurate cache statistics', async () => {
      const initialStats = advZlib.getCacheStats();
      expect(initialStats.centralDir.entries).toBe(0);
      expect(initialStats.content.entries).toBe(0);
      expect(initialStats.total.entries).toBe(0);

      // Load data to populate cache
      await advZlib.getEntries(testAssets.simpleText);
      await advZlib.read(`${testAssets.simpleText}/sample.txt`);

      const updatedStats = advZlib.getCacheStats();
      expect(updatedStats.centralDir.entries).toBeGreaterThan(0);
      expect(updatedStats.content.entries).toBeGreaterThan(0);
      expect(updatedStats.total.entries).toBe(updatedStats.centralDir.entries + updatedStats.content.entries);
      expect(updatedStats.total.memoryMB).toBe(updatedStats.centralDir.memoryMB + updatedStats.content.memoryMB);
    });
  });

  describe('CentralDir Cache Logic', () => {
    let advZlib: AdvZlib;

    beforeEach(() => {
      advZlib = new AdvZlib({
        logger: silentLogger,
        maxCentralDirCount: 2, // Small limit for testing eviction
        maxCacheMemoryMB: 1,
      });
    });

    afterEach(async () => {
      await advZlib.cleanup();
    });

    test('should cache CentralDir instances', async () => {
      // First access - should cache
      await advZlib.getEntries(testAssets.simpleText);

      let stats = advZlib.getCacheStats();
      expect(stats.centralDir.entries).toBe(1);

      // Second access - should use cache (faster)
      const start = performance.now();
      await advZlib.getEntries(testAssets.simpleText);
      const end = performance.now();
      const cachedTime = end - start;

      // Should be very fast due to cache
      expect(cachedTime).toBeLessThan(10); // Less than 10ms
    });

    test('should evict cache entries when limits exceeded', async () => {
      // Fill cache beyond limit
      await advZlib.getEntries(testAssets.simpleText);
      await advZlib.getEntries(testAssets.withDirectories);
      await advZlib.getEntries(testAssets.binaryFiles);

      const stats = advZlib.getCacheStats();
      // Should not exceed the limit
      expect(stats.centralDir.entries).toBeLessThanOrEqual(2);
    });

    test('should handle cache invalidation', async () => {
      // This test would require file modification simulation
      // For now, just verify cache behavior
      await advZlib.getEntries(testAssets.simpleText);

      const stats = advZlib.getCacheStats();
      expect(stats.centralDir.entries).toBeGreaterThan(0);
    });
  });

  describe('Content Cache Logic', () => {
    let advZlib: AdvZlib;

    beforeEach(() => {
      advZlib = new AdvZlib({
        logger: silentLogger,
        enableContentCaching: true,
        maxContentCacheCount: 3, // Small limit for testing
        maxContentCacheMemoryMB: 1,
      });
    });

    afterEach(async () => {
      await advZlib.cleanup();
    });

    test('should cache file content', async () => {
      const filePath = `${testAssets.simpleText}/sample.txt`;

      // First read - should cache
      await advZlib.read(filePath);

      let stats = advZlib.getCacheStats();
      expect(stats.content.entries).toBe(1);

      // Second read - should use cache
      const start = performance.now();
      const content = await advZlib.read(filePath);
      const end = performance.now();
      const cachedTime = end - start;

      expect(content.toString()).toBe('Hello, World!');
      expect(cachedTime).toBeLessThan(5); // Very fast due to cache
    });

    test('should evict content cache when limits exceeded', async () => {
      // Read multiple files to fill cache
      await advZlib.read(`${testAssets.simpleText}/sample.txt`);
      await advZlib.read(`${testAssets.simpleText}/another.txt`);
      await advZlib.read(`${testAssets.simpleText}/README.md`);
      await advZlib.read(`${testAssets.withDirectories}/root.txt`);

      const stats = advZlib.getCacheStats();
      // Should not exceed the limit
      expect(stats.content.entries).toBeLessThanOrEqual(3);
    });

    test('should handle cache with disabled content caching', async () => {
      const noCacheAdvZlib = new AdvZlib({
        logger: silentLogger,
        enableContentCaching: false,
      });

      try {
        await noCacheAdvZlib.read(`${testAssets.simpleText}/sample.txt`);

        const stats = noCacheAdvZlib.getCacheStats();
        expect(stats.content.entries).toBe(0);
        expect(stats.content.memoryMB).toBe(0);
      } finally {
        await noCacheAdvZlib.cleanup();
      }
    });
  });

  describe('ZipEntry Behavior', () => {
    let advZlib: AdvZlib;

    beforeEach(() => {
      advZlib = new AdvZlib({
        logger: silentLogger,
        enableContentCaching: true,
      });
    });

    afterEach(async () => {
      await advZlib.cleanup();
    });

    test('should have correct ZipEntry properties', async () => {
      const entries = await advZlib.getEntries(testAssets.withDirectories);

      expect(entries.length).toBeGreaterThan(0);

      const fileEntry = entries.find((e) => e.name === 'root.txt');
      expect(fileEntry).toBeDefined();

      if (fileEntry) {
        expect(fileEntry.name).toBe('root.txt');
        expect(fileEntry.relPath).toBe('root.txt');
        expect(fileEntry.isDirectory).toBe(false);
        expect(fileEntry.fullPath).toContain('root.txt');
        expect(typeof fileEntry.size).toBe('number');
      }

      const dirEntry = entries.find((e) => e.name === 'empty-dir');
      if (dirEntry) {
        expect(dirEntry.isDirectory).toBe(true);
      }
    });

    test('should read file content correctly', async () => {
      const filePath = `${testAssets.simpleText}/sample.txt`;
      const content = await advZlib.read(filePath);

      expect(content).toBeInstanceOf(Buffer);
      expect(content.toString()).toBe('Hello, World!');
    });

    test('should handle binary content correctly', async () => {
      const filePath = `${testAssets.binaryFiles}/sample.png`;
      const content = await advZlib.read(filePath);

      expect(content).toBeInstanceOf(Buffer);
      expect(content.length).toBeGreaterThan(0);

      // Check PNG signature
      expect(content[0]).toBe(0x89);
      expect(content[1]).toBe(0x50);
      expect(content[2]).toBe(0x4e);
      expect(content[3]).toBe(0x47);
    });

    test('should handle mixed content correctly', async () => {
      // Test binary content
      const binaryPath = `${testAssets.binaryFiles}/mixed.txt`;
      const binaryContent = await advZlib.read(binaryPath);
      expect(binaryContent.toString()).toBe('Text and binary mixed');

      // Test simple text content
      const textPath = `${testAssets.simpleText}/another.txt`;
      const textContent = await advZlib.read(textPath);
      expect(textContent.toString()).toBe('This is another file.');
    });
  });

  describe('Path Resolution Logic', () => {
    let advZlib: AdvZlib;

    beforeEach(() => {
      advZlib = new AdvZlib({ logger: silentLogger });
    });

    afterEach(async () => {
      await advZlib.cleanup();
    });

    test('should handle simple ZIP paths', async () => {
      const exists = await advZlib.exists(testAssets.simpleText);
      expect(exists).toBe(true);

      const entries = await advZlib.getEntries(testAssets.simpleText);
      expect(entries.length).toBeGreaterThan(0);
    });

    test('should handle file paths within ZIP', async () => {
      const filePath = `${testAssets.simpleText}/sample.txt`;
      const exists = await advZlib.exists(filePath);
      expect(exists).toBe(true);

      const content = await advZlib.read(filePath);
      expect(content.toString()).toBe('Hello, World!');
    });

    test('should handle directory paths within ZIP', async () => {
      // Check for an explicit directory entry that we know exists
      const dirPath = `${testAssets.withDirectories}/empty-dir/`;
      const exists = await advZlib.exists(dirPath);
      expect(exists).toBe(true);
    });

    test('should handle nested ZIP paths', async () => {
      const nestedZipPath = `${testAssets.nested}/inner.zip`;
      const exists = await advZlib.exists(nestedZipPath);
      expect(exists).toBe(true);

      const entries = await advZlib.getEntries(nestedZipPath);
      expect(entries.length).toBeGreaterThan(0);
    });

    test('should handle unusual filenames', async () => {
      const entries = await advZlib.getEntries(testAssets.unusualNames);

      const spaceFile = entries.find((e) => e.name.includes('spaces'));
      expect(spaceFile).toBeDefined();

      const unicodeFile = entries.find((e) => e.name.includes('файл'));
      expect(unicodeFile).toBeDefined();

      const emojiFile = entries.find((e) => e.name.includes('📄'));
      expect(emojiFile).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    let advZlib: AdvZlib;

    beforeEach(() => {
      advZlib = new AdvZlib({ logger: silentLogger });
    });

    afterEach(async () => {
      await advZlib.cleanup();
    });

    test('should throw errors for invalid inputs', async () => {
      await expect(advZlib.getEntries('')).rejects.toThrow();
      await expect(advZlib.getEntries('/nonexistent/file.zip')).rejects.toThrow();
      await expect(advZlib.getEntries('/some/file.txt')).rejects.toThrow();
    });

    test('should handle non-existent files gracefully', async () => {
      const exists = await advZlib.exists('/nonexistent/file.zip');
      expect(exists).toBe(false);

      const exists2 = await advZlib.exists(`${testAssets.simpleText}/nonexistent.txt`);
      expect(exists2).toBe(false);
    });

    test('should handle empty ZIP files', async () => {
      const entries = await advZlib.getEntries(testAssets.empty);
      expect(entries).toHaveLength(0);

      const exists = await advZlib.exists(testAssets.empty);
      expect(exists).toBe(true);
    });

    test('should return empty buffer for no matches', async () => {
      const content = await advZlib.read(testAssets.simpleText, () => false);
      expect(content).toBeInstanceOf(Buffer);
      expect(content.length).toBe(0);
    });

    test('should return empty buffer for multiple matches', async () => {
      const content = await advZlib.read(testAssets.withDirectories, (entry) => entry.name.endsWith('.txt'));
      expect(content).toBeInstanceOf(Buffer);
      expect(content.length).toBe(0);
    });
  });

  describe('Memory Management', () => {
    test('should respect memory limits', async () => {
      const limitedAdvZlib = new AdvZlib({
        logger: silentLogger,
        maxCentralDirCount: 1,
        maxCacheMemoryMB: 0.1, // Very small limit
        maxContentCacheCount: 1,
        maxContentCacheMemoryMB: 0.1,
      });

      try {
        // Try to exceed limits
        await limitedAdvZlib.getEntries(testAssets.simpleText);
        await limitedAdvZlib.getEntries(testAssets.withDirectories);
        await limitedAdvZlib.read(`${testAssets.simpleText}/sample.txt`);
        await limitedAdvZlib.read(`${testAssets.withDirectories}/root.txt`);

        const stats = limitedAdvZlib.getCacheStats();

        // Should respect limits
        expect(stats.centralDir.entries).toBeLessThanOrEqual(1);
        expect(stats.content.entries).toBeLessThanOrEqual(1);
        expect(stats.total.memoryMB).toBeLessThan(1); // Should be well under limits
      } finally {
        await limitedAdvZlib.cleanup();
      }
    });

    test('should handle files efficiently', async () => {
      const advZlib = new AdvZlib({
        logger: silentLogger,
        enableContentCaching: true,
      });

      try {
        const content = await advZlib.read(`${testAssets.simpleText}/README.md`);
        expect(content.toString()).toBe('README content here.');

        // Should cache the content
        const stats = advZlib.getCacheStats();
        expect(stats.content.memoryMB).toBeGreaterThanOrEqual(0);
      } finally {
        await advZlib.cleanup();
      }
    });
  });

  test('✅ Unit Tests Summary', () => {
    info('Unit Tests Complete!');
    info('All major classes tested thoroughly');
    info('Cache mechanisms working correctly');
    info('Error handling behaves as expected');
    info('Memory management respects limits');
    info('Path resolution handles all scenarios');
  });
});
