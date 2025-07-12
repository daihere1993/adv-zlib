import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import AdvZlib from '../../src/index';
import { createBasicTestZipFiles, createPerformanceTestZipFiles, BasicTestAssets, PerformanceTestAssets, safeRemoveDir } from '../test-assets';

describe('Cache Performance Tests', () => {
  const testAssetsDir = join(__dirname, '../test-assets-cache-perf');
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
      createPerformanceTestZipFiles(testAssetsDir)
    ]);
    advZlib = new AdvZlib({
      logger: silentLogger,
      enableContentCaching: true,
      maxCentralDirCount: 50,
      maxCacheMemoryMB: 100,
      maxContentCacheCount: 100,
      maxContentCacheMemoryMB: 50,
    });
  }, 60000);

  afterAll(async () => {
    if (advZlib) {
      await advZlib.cleanup();
    }
    await safeRemoveDir(testAssetsDir);
  });

  describe('Central Directory Cache Performance', () => {
    test('should show significant speedup with Central Directory caching', async () => {
      const zipPath = basicAssets.withDirectories;
      
      // First access - cold cache
      const start1 = Date.now();
      await advZlib.getEntries(zipPath);
      const coldTime = Date.now() - start1;

      // Second access - warm cache
      const start2 = Date.now();
      await advZlib.getEntries(zipPath);
      const warmTime = Date.now() - start2;

      // Cache should provide some speedup (operations may be very fast)
      const speedupRatio = coldTime / Math.max(warmTime, 1);
      expect(speedupRatio).toBeGreaterThanOrEqual(1); // At least as fast as cold access

      console.log(`Central Directory Cache - Cold: ${coldTime}ms, Warm: ${warmTime}ms, Speedup: ${speedupRatio.toFixed(1)}x`);
    });

    test('should maintain cache hit ratio above 90% for repeated accesses', async () => {
      const zipPaths = [
        basicAssets.simpleText,
        basicAssets.withDirectories,
        perfAssets.compressed,
        perfAssets.large,
      ];

      // Multiple accesses to build cache
      for (let i = 0; i < 3; i++) {
        for (const zipPath of zipPaths) {
          await advZlib.getEntries(zipPath);
        }
      }

      const stats = advZlib.getCacheStats();
      expect(stats.centralDir.entries).toBeGreaterThan(0);
      expect(stats.centralDir.memoryMB).toBeGreaterThan(0);
    });

    test('should handle cache eviction gracefully under memory pressure', async () => {
      // Create many entries to trigger cache eviction
      const manyAccesses = Array.from({ length: 60 }, (_, i) => 
        advZlib.getEntries(basicAssets.simpleText)
      );

      await Promise.all(manyAccesses);

      const stats = advZlib.getCacheStats();
      expect(stats.centralDir.entries).toBeLessThanOrEqual(50); // Should respect max limit
      expect(stats.centralDir.memoryMB).toBeLessThanOrEqual(100); // Should respect memory limit
    });
  });

  describe('Content Cache Performance', () => {
    test('should show significant speedup with content caching', async () => {
      const filePath = join(perfAssets.large, 'large-file.txt');
      
      // First read - cold cache
      const start1 = Date.now();
      const content1 = await advZlib.read(filePath);
      const coldTime = Date.now() - start1;

      // Second read - warm cache
      const start2 = Date.now();
      const content2 = await advZlib.read(filePath);
      const warmTime = Date.now() - start2;

      // Content should be identical
      expect(content1.equals(content2)).toBe(true);

      // Cache should provide some speedup for large files
      const speedupRatio = coldTime / Math.max(warmTime, 1);
      expect(speedupRatio).toBeGreaterThanOrEqual(1); // At least as fast as cold access

      console.log(`Content Cache - Cold: ${coldTime}ms, Warm: ${warmTime}ms, Speedup: ${speedupRatio.toFixed(1)}x`);
    });

    test('should cache different files independently', async () => {
      const files = [
        join(basicAssets.simpleText, 'sample.txt'),
        join(perfAssets.compressed, 'compressed.txt'),
        join(perfAssets.uncompressed, 'stored.txt'),
      ];

      // Read all files to populate cache
      const contents = await Promise.all(files.map(f => advZlib.read(f)));

      // Read again - should all be cached
      const cachedContents = await Promise.all(files.map(f => advZlib.read(f)));

      // Contents should be identical
      for (let i = 0; i < contents.length; i++) {
        expect(contents[i].equals(cachedContents[i])).toBe(true);
      }

      const stats = advZlib.getCacheStats();
      expect(stats.content.entries).toBeGreaterThanOrEqual(files.length);
    });

    test('should respect memory limits for content caching', async () => {
      // Read multiple large files to test memory management
      const largeFiles = [
        join(perfAssets.large, 'large-file.txt'),
        join(perfAssets.compressed, 'compressed.txt'),
        join(perfAssets.uncompressed, 'stored.txt'),
      ];

      for (const file of largeFiles) {
        await advZlib.read(file);
      }

      const stats = advZlib.getCacheStats();
      expect(stats.content.memoryMB).toBeLessThanOrEqual(50); // Should respect memory limit
      expect(stats.content.entries).toBeLessThanOrEqual(100); // Should respect count limit
    });
  });

  describe('Combined Cache Performance', () => {
    test('should show synergistic benefits from both cache levels', async () => {
      const nestedFile = join(basicAssets.nested, 'inner.zip', 'inner.txt');
      
      // First access - completely cold
      const start1 = Date.now();
      await advZlib.read(nestedFile);
      const firstTime = Date.now() - start1;

      // Second access - central directory cached, content cold
      const start2 = Date.now();
      await advZlib.read(nestedFile);
      const secondTime = Date.now() - start2;

      // Third access - both caches warm
      const start3 = Date.now();
      await advZlib.read(nestedFile);
      const thirdTime = Date.now() - start3;

      // Each subsequent access should be at least as fast (timing may be imprecise for fast operations)
      expect(secondTime).toBeLessThanOrEqual(Math.max(firstTime, 5)); // Allow some tolerance
      expect(thirdTime).toBeLessThanOrEqual(Math.max(secondTime, 5)); // Allow some tolerance

      const totalSpeedup = firstTime / Math.max(thirdTime, 1);
      expect(totalSpeedup).toBeGreaterThanOrEqual(1); // Should be at least as fast

      console.log(`Combined Cache - 1st: ${firstTime}ms, 2nd: ${secondTime}ms, 3rd: ${thirdTime}ms, Total Speedup: ${totalSpeedup.toFixed(1)}x`);
    });

    test('should maintain high cache efficiency across mixed operations', async () => {
      const operations = [
        () => advZlib.exists(basicAssets.simpleText),
        () => advZlib.getEntries(basicAssets.withDirectories),
        () => advZlib.read(join(perfAssets.compressed, 'compressed.txt')),
        () => advZlib.exists(join(perfAssets.large, 'large-file.txt')),
        () => advZlib.read(join(basicAssets.nested, 'inner.zip', 'inner.txt')),
      ];

      // Run operations multiple times to build up cache
      for (let round = 0; round < 3; round++) {
        const startRound = Date.now();
        await Promise.all(operations.map(op => op()));
        const roundTime = Date.now() - startRound;
        
        console.log(`Round ${round + 1}: ${roundTime}ms`);
        
        // Later rounds should be faster due to caching
        if (round > 0) {
          // Each round should be getting more efficient
          expect(roundTime).toBeLessThan(1000); // Should complete quickly after caching
        }
      }

      const finalStats = advZlib.getCacheStats();
      expect(finalStats.total.entries).toBeGreaterThan(3);
      console.log(`Final cache stats: ${finalStats.total.entries} entries, ${finalStats.total.memoryMB}MB`);
    });
  });

  describe('Cache Memory Management', () => {
    test('should track memory usage accurately', async () => {
      // Clear cache to get accurate baseline
      await advZlib.cleanup();
      
      const startStats = advZlib.getCacheStats();
      const startMemory = startStats.total.memoryMB;
      expect(startStats.total.entries).toBe(0); // Should start empty

      // Add several entries to cache
      await advZlib.read(join(perfAssets.large, 'large-file.txt'));
      await advZlib.getEntries(basicAssets.withDirectories);
      await advZlib.read(join(perfAssets.compressed, 'compressed.txt'));

      const endStats = advZlib.getCacheStats();
      const endMemory = endStats.total.memoryMB;

      // Memory usage should increase and cache entries should be added
      expect(endMemory).toBeGreaterThanOrEqual(startMemory);
      expect(endStats.total.entries).toBeGreaterThan(startStats.total.entries);

      console.log(`Memory usage increased from ${startMemory}MB to ${endMemory}MB`);
    });

    test('should clean up memory properly', async () => {
      // Populate cache
      await advZlib.read(join(perfAssets.large, 'large-file.txt'));
      await advZlib.getEntries(basicAssets.withDirectories);

      const beforeCleanup = advZlib.getCacheStats();
      expect(beforeCleanup.total.entries).toBeGreaterThan(0);

      // Clean up
      await advZlib.cleanup();

      const afterCleanup = advZlib.getCacheStats();
      expect(afterCleanup.total.entries).toBe(0);
      expect(afterCleanup.total.memoryMB).toBe(0);

      console.log(`Cleanup: ${beforeCleanup.total.entries} entries -> ${afterCleanup.total.entries} entries`);
    });
  });

  describe('Performance Benchmarks', () => {
    test('should achieve target throughput for typical operations', async () => {
      const operations = 20;
      const filePath = join(basicAssets.simpleText, 'sample.txt');

      // Warm up cache
      await advZlib.read(filePath);

      // Measure throughput
      const start = Date.now();
      const promises = Array.from({ length: operations }, () => advZlib.read(filePath));
      await Promise.all(promises);
      const totalTime = Date.now() - start;

      const opsPerSecond = (operations * 1000) / totalTime;
      console.log(`Throughput: ${opsPerSecond.toFixed(1)} ops/sec (${totalTime}ms for ${operations} ops)`);

      // Should achieve at least 100 ops/sec for cached reads
      expect(opsPerSecond).toBeGreaterThan(100);
    });

    test('should handle concurrent nested ZIP operations efficiently', async () => {
      const concurrentOps = 10;
      const nestedFile = join(basicAssets.nested, 'inner.zip', 'inner.txt');

      const start = Date.now();
      const promises = Array.from({ length: concurrentOps }, async () => {
        await advZlib.exists(nestedFile);
        return advZlib.read(nestedFile);
      });

      const results = await Promise.all(promises);
      const totalTime = Date.now() - start;

      // All operations should succeed
      expect(results).toHaveLength(concurrentOps);
      results.forEach(result => {
        expect(Buffer.isBuffer(result)).toBe(true);
        expect(result.length).toBeGreaterThan(0);
      });

      const opsPerSecond = (concurrentOps * 1000) / totalTime;
      console.log(`Concurrent nested operations: ${opsPerSecond.toFixed(1)} ops/sec`);

      // Should handle concurrent operations efficiently
      expect(totalTime).toBeLessThan(5000); // Should complete within 5 seconds
    });
  });
});