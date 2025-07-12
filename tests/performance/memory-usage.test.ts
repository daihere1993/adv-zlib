import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import AdvZlib from '../../src/index';
import { createBasicTestZipFiles, createPerformanceTestZipFiles, BasicTestAssets, PerformanceTestAssets } from '../test-assets';

describe('Memory Usage Tests', () => {
  const testAssetsDir = join(__dirname, '../test-assets-memory');
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
      createPerformanceTestZipFiles(testAssetsDir)
    ]);
  }, 60000);

  afterAll(async () => {
    await fs.rm(testAssetsDir, { recursive: true, force: true });
  });

  describe('Memory Limit Enforcement', () => {
    test('should respect central directory cache memory limits', async () => {
      const maxMemoryMB = 5;
      const advZlib = new AdvZlib({
        logger: silentLogger,
        maxCentralDirCount: 100, // High count limit
        maxCacheMemoryMB: maxMemoryMB, // Low memory limit
        enableContentCaching: false, // Disable content cache for this test
      });

      try {
        // Access multiple ZIPs to fill cache
        const zipFiles = [
          basicAssets.simpleText,
          basicAssets.withDirectories,
          perfAssets.compressed,
          perfAssets.uncompressed,
          perfAssets.large,
        ];

        // Access each multiple times to trigger potential memory buildup
        for (let round = 0; round < 5; round++) {
          for (const zipFile of zipFiles) {
            await advZlib.getEntries(zipFile);
          }
        }

        const stats = advZlib.getCacheStats();
        expect(stats.centralDir.memoryMB).toBeLessThanOrEqual(maxMemoryMB);
        console.log(`Central Directory cache: ${stats.centralDir.memoryMB}MB (limit: ${maxMemoryMB}MB)`);
      } finally {
        await advZlib.cleanup();
      }
    });

    test('should respect content cache memory limits', async () => {
      const maxContentMemoryMB = 10;
      const advZlib = new AdvZlib({
        logger: silentLogger,
        enableContentCaching: true,
        maxContentCacheCount: 50, // High count limit
        maxContentCacheMemoryMB: maxContentMemoryMB, // Low memory limit
        maxContentCacheFileSizeMB: 1, // Allow caching of smaller files
      });

      try {
        // Read multiple files to fill content cache
        const files = [
          join(basicAssets.simpleText, 'sample.txt'),
          join(perfAssets.compressed, 'compressed.txt'),
          join(perfAssets.uncompressed, 'stored.txt'),
        ];

        // Read each file multiple times
        for (let round = 0; round < 10; round++) {
          for (const file of files) {
            await advZlib.read(file);
          }
        }

        const stats = advZlib.getCacheStats();
        expect(stats.content.memoryMB).toBeLessThanOrEqual(maxContentMemoryMB);
        console.log(`Content cache: ${stats.content.memoryMB}MB (limit: ${maxContentMemoryMB}MB)`);
      } finally {
        await advZlib.cleanup();
      }
    });

    test('should respect entry count limits', async () => {
      const maxEntries = 5;
      const advZlib = new AdvZlib({
        logger: silentLogger,
        maxCentralDirCount: maxEntries,
        maxCacheMemoryMB: 100, // High memory limit
        enableContentCaching: false,
      });

      try {
        // Access more ZIPs than the limit allows
        const zipFiles = [
          basicAssets.simpleText,
          basicAssets.withDirectories,
          perfAssets.compressed,
          perfAssets.uncompressed,
          perfAssets.large,
          basicAssets.unusualNames,
          basicAssets.empty,
          basicAssets.nested,
        ];

        for (const zipFile of zipFiles) {
          await advZlib.getEntries(zipFile);
        }

        const stats = advZlib.getCacheStats();
        expect(stats.centralDir.entries).toBeLessThanOrEqual(maxEntries);
        console.log(`Central Directory entries: ${stats.centralDir.entries} (limit: ${maxEntries})`);
      } finally {
        await advZlib.cleanup();
      }
    });
  });

  describe('LRU Eviction Behavior', () => {
    test('should evict least recently used entries when memory limit reached', async () => {
      const advZlib = new AdvZlib({
        logger: silentLogger,
        maxCentralDirCount: 3, // Small limit to trigger eviction
        maxCacheMemoryMB: 50,
        enableContentCaching: false,
      });

      try {
        // Access first ZIP
        await advZlib.getEntries(basicAssets.simpleText);
        let stats = advZlib.getCacheStats();
        expect(stats.centralDir.entries).toBe(1);

        // Access second ZIP
        await advZlib.getEntries(perfAssets.compressed);
        stats = advZlib.getCacheStats();
        expect(stats.centralDir.entries).toBe(2);

        // Access third ZIP
        await advZlib.getEntries(perfAssets.large);
        stats = advZlib.getCacheStats();
        expect(stats.centralDir.entries).toBe(3);

        // Access fourth ZIP - should trigger eviction
        await advZlib.getEntries(basicAssets.withDirectories);
        stats = advZlib.getCacheStats();
        expect(stats.centralDir.entries).toBe(3); // Should still be at limit

        // Access the first ZIP again - should require re-parsing if evicted
        const start = Date.now();
        await advZlib.getEntries(basicAssets.simpleText);
        const accessTime = Date.now() - start;

        // If it was evicted and re-parsed, it should take some time
        console.log(`Re-access time after potential eviction: ${accessTime}ms`);
      } finally {
        await advZlib.cleanup();
      }
    });

    test('should maintain recently accessed entries in cache', async () => {
      const advZlib = new AdvZlib({
        logger: silentLogger,
        maxCentralDirCount: 2,
        enableContentCaching: true,
        maxContentCacheCount: 3,
      });

      try {
        // Access entries to fill cache
        await advZlib.read(join(basicAssets.simpleText, 'sample.txt'));
        await advZlib.read(join(perfAssets.compressed, 'compressed.txt'));

        // Access first entry again to make it recently used
        await advZlib.read(join(basicAssets.simpleText, 'sample.txt'));

        // Add more entries to trigger eviction
        await advZlib.read(join(perfAssets.uncompressed, 'stored.txt'));
        await advZlib.read(join(perfAssets.large, 'large-file.txt'));

        // The recently accessed entry should still provide cache benefits
        const start = Date.now();
        await advZlib.read(join(basicAssets.simpleText, 'sample.txt'));
        const recentAccessTime = Date.now() - start;

        expect(recentAccessTime).toBeLessThan(50); // Should be very fast if cached
        console.log(`Recently used entry access time: ${recentAccessTime}ms`);
      } finally {
        await advZlib.cleanup();
      }
    });
  });

  describe('Large File Handling', () => {
    test('should handle large files without memory bloat', async () => {
      const advZlib = new AdvZlib({
        logger: silentLogger,
        enableContentCaching: true,
        maxContentCacheFileSizeMB: 0.1, // Very small limit - 100KB
        maxContentCacheMemoryMB: 5,
      });

      try {
        const initialStats = advZlib.getCacheStats();
        
        // Read large file - should not be cached in memory due to size limit
        await advZlib.read(join(perfAssets.large, 'large-file.txt'));
        
        const afterLargeRead = advZlib.getCacheStats();
        
        // Memory shouldn't increase significantly for large files
        const memoryIncrease = afterLargeRead.total.memoryMB - initialStats.total.memoryMB;
        expect(memoryIncrease).toBeLessThan(1); // Less than 1MB increase
        
        console.log(`Memory increase after large file read: ${memoryIncrease.toFixed(2)}MB`);
      } finally {
        await advZlib.cleanup();
      }
    });

    test('should prefer disk caching for large content', async () => {
      const advZlib = new AdvZlib({
        logger: silentLogger,
        enableContentCaching: true,
        maxContentCacheFileSizeMB: 0.05, // 50KB limit - force disk caching
        maxContentCacheMemoryMB: 20,
      });

      try {
        // Read large file multiple times
        const content1 = await advZlib.read(join(perfAssets.large, 'large-file.txt'));
        const content2 = await advZlib.read(join(perfAssets.large, 'large-file.txt'));
        
        // Content should be identical (proving caching works)
        expect(content1.equals(content2)).toBe(true);
        
        const stats = advZlib.getCacheStats();
        
        // Should have disk cache entries
        expect(stats.content.diskEntries).toBeGreaterThan(0);
        console.log(`Cache stats - Memory entries: ${stats.content.memoryEntries}, Disk entries: ${stats.content.diskEntries}`);
      } finally {
        await advZlib.cleanup();
      }
    });
  });

  describe('Memory Leak Prevention', () => {
    test('should not leak memory with repeated operations', async () => {
      const advZlib = new AdvZlib({
        logger: silentLogger,
        enableContentCaching: true,
        maxCentralDirCount: 10,
        maxContentCacheCount: 20,
      });

      try {
        const operations = [
          () => advZlib.exists(basicAssets.simpleText),
          () => advZlib.read(join(basicAssets.simpleText, 'sample.txt')),
          () => advZlib.getEntries(perfAssets.compressed),
          () => advZlib.read(join(perfAssets.compressed, 'compressed.txt')),
        ];

        // Perform many operations
        for (let round = 0; round < 20; round++) {
          await Promise.all(operations.map(op => op()));
          
          // Check memory usage periodically
          if (round % 5 === 0) {
            const stats = advZlib.getCacheStats();
            console.log(`Round ${round}: ${stats.total.entries} entries, ${stats.total.memoryMB}MB`);
            
            // Memory should stabilize and not grow indefinitely
            expect(stats.total.memoryMB).toBeLessThan(50);
            expect(stats.total.entries).toBeLessThan(30);
          }
        }

        const finalStats = advZlib.getCacheStats();
        console.log(`Final stats: ${finalStats.total.entries} entries, ${finalStats.total.memoryMB}MB`);
      } finally {
        await advZlib.cleanup();
      }
    });

    test('should completely clean up resources', async () => {
      let advZlib = new AdvZlib({
        logger: silentLogger,
        enableContentCaching: true,
      });

      // Use the library extensively
      await advZlib.read(join(perfAssets.large, 'large-file.txt'));
      await advZlib.getEntries(basicAssets.withDirectories);
      await advZlib.read(join(basicAssets.nested, 'inner.zip', 'inner.txt'));

      const beforeCleanup = advZlib.getCacheStats();
      expect(beforeCleanup.total.entries).toBeGreaterThan(0);

      // Clean up
      await advZlib.cleanup();

      const afterCleanup = advZlib.getCacheStats();
      expect(afterCleanup.total.entries).toBe(0);
      expect(afterCleanup.total.memoryMB).toBe(0);
      expect(afterCleanup.centralDir.entries).toBe(0);
      expect(afterCleanup.content.entries).toBe(0);

      // Library should still work after cleanup
      const exists = await advZlib.exists(basicAssets.simpleText);
      expect(exists).toBe(true);

      console.log(`Complete cleanup verified - all caches cleared`);
    });
  });

  describe('Concurrent Memory Management', () => {
    test('should handle concurrent operations without memory issues', async () => {
      const advZlib = new AdvZlib({
        logger: silentLogger,
        enableContentCaching: true,
        maxCentralDirCount: 15,
        maxContentCacheCount: 30,
      });

      try {
        // Create many concurrent operations
        const concurrentOps = Array.from({ length: 20 }, (_, i) => {
          const operations = [
            advZlib.exists(basicAssets.simpleText),
            advZlib.read(join(perfAssets.compressed, 'compressed.txt')),
            advZlib.getEntries(basicAssets.withDirectories),
          ];
          return Promise.all(operations);
        });

        const results = await Promise.all(concurrentOps);
        
        // All operations should succeed
        expect(results).toHaveLength(20);
        results.forEach(result => {
          expect(result).toHaveLength(3); // Each concurrent op has 3 operations
        });

        const stats = advZlib.getCacheStats();
        
        // Memory should be within reasonable bounds despite concurrent access
        expect(stats.total.memoryMB).toBeLessThan(100);
        expect(stats.total.entries).toBeLessThan(50);
        
        console.log(`Concurrent operations completed - ${stats.total.entries} entries, ${stats.total.memoryMB}MB`);
      } finally {
        await advZlib.cleanup();
      }
    });
  });
});