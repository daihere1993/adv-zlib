import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import AdvZlib from '../../src/index';

describe('Real-World Integration Tests', () => {
  const assetsDir = join(__dirname, '../assets');
  let advZlib: AdvZlib;

  const silentLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  beforeAll(async () => {
    advZlib = new AdvZlib({
      logger: silentLogger,
      enableContentCaching: true,
      maxCentralDirCount: 20,
      maxContentCacheCount: 50,
    });
  }, 30000);

  afterAll(async () => {
    await advZlib.cleanup();
  });

  describe('E2E Asset Tests', () => {
    test('should handle simple-text.zip from assets', async () => {
      const zipPath = join(assetsDir, 'e2e', 'simple-text.zip');
      
      // Check if file exists first
      try {
        await fs.access(zipPath);
      } catch {
        console.warn('simple-text.zip not found, skipping test');
        return;
      }

      const exists = await advZlib.exists(zipPath);
      expect(exists).toBe(true);

      const entries = await advZlib.getEntries(zipPath);
      expect(entries.length).toBeGreaterThan(0);

      // Test reading content from first entry
      if (entries.length > 0 && !entries[0].isDirectory) {
        const content = await advZlib.read(join(zipPath, entries[0].relPath));
        expect(content.length).toBeGreaterThan(0);
      }
    });

    test('should handle large.zip from assets', async () => {
      const zipPath = join(assetsDir, 'e2e', 'large.zip');
      
      try {
        await fs.access(zipPath);
      } catch {
        console.warn('large.zip not found, skipping test');
        return;
      }

      const exists = await advZlib.exists(zipPath);
      expect(exists).toBe(true);

      const entries = await advZlib.getEntries(zipPath);
      expect(entries.length).toBeGreaterThan(0);

      // Find a large entry
      const largeEntry = entries.find(e => !e.isDirectory && e.size > 10000);
      if (largeEntry) {
        const start = Date.now();
        const content = await advZlib.read(join(zipPath, largeEntry.relPath));
        const readTime = Date.now() - start;
        
        expect(content.length).toBeGreaterThan(10000);
        console.log(`Read large file (${content.length} bytes) in ${readTime}ms`);
      }
    });

    test('should handle deep-nested.zip from assets', async () => {
      const zipPath = join(assetsDir, 'e2e', 'deep-nested.zip');
      
      try {
        await fs.access(zipPath);
      } catch {
        console.warn('deep-nested.zip not found, skipping test');
        return;
      }

      const exists = await advZlib.exists(zipPath);
      expect(exists).toBe(true);

      const entries = await advZlib.getEntries(zipPath);
      expect(entries.length).toBeGreaterThan(0);

      // Look for nested ZIP files
      const nestedZips = entries.filter(e => e.name.endsWith('.zip'));
      if (nestedZips.length > 0) {
        const nestedZipPath = join(zipPath, nestedZips[0].relPath);
        const nestedExists = await advZlib.exists(nestedZipPath);
        expect(nestedExists).toBe(true);

        const nestedEntries = await advZlib.getEntries(nestedZipPath);
        expect(nestedEntries.length).toBeGreaterThan(0);
      }
    });

    test('should handle compressed.zip from assets', async () => {
      const zipPath = join(assetsDir, 'e2e', 'compressed.zip');
      
      try {
        await fs.access(zipPath);
      } catch {
        console.warn('compressed.zip not found, skipping test');
        return;
      }

      const exists = await advZlib.exists(zipPath);
      expect(exists).toBe(true);

      const entries = await advZlib.getEntries(zipPath);
      expect(entries.length).toBeGreaterThan(0);

      // Test reading compressed content
      const fileEntries = entries.filter(e => !e.isDirectory);
      if (fileEntries.length > 0) {
        const content = await advZlib.read(join(zipPath, fileEntries[0].relPath));
        expect(content.length).toBeGreaterThan(0);
        
        // Content should be readable text or valid binary
        expect(Buffer.isBuffer(content)).toBe(true);
      }
    });

    test('should handle with-directories.zip from assets', async () => {
      const zipPath = join(assetsDir, 'e2e', 'with-directories.zip');
      
      try {
        await fs.access(zipPath);
      } catch {
        console.warn('with-directories.zip not found, skipping test');
        return;
      }

      const exists = await advZlib.exists(zipPath);
      expect(exists).toBe(true);

      const entries = await advZlib.getEntries(zipPath);
      expect(entries.length).toBeGreaterThan(0);

      const directories = entries.filter(e => e.isDirectory);
      const files = entries.filter(e => !e.isDirectory);

      expect(directories.length).toBeGreaterThan(0);
      expect(files.length).toBeGreaterThan(0);

      // Test extraction with directory structure
      const outputDir = join(__dirname, '../temp-extract-dirs');
      await fs.mkdir(outputDir, { recursive: true });

      try {
        const extracted = await advZlib.extract(zipPath, outputDir);
        expect(extracted.length).toBe(entries.length);

        // Verify directory structure was preserved
        for (const dir of directories) {
          const dirPath = join(outputDir, dir.relPath);
          const dirExists = await fs.access(dirPath).then(() => true).catch(() => false);
          expect(dirExists).toBe(true);
        }
      } finally {
        await fs.rm(outputDir, { recursive: true, force: true });
      }
    });

    test('should handle empty.zip from assets', async () => {
      const zipPath = join(assetsDir, 'e2e', 'empty.zip');
      
      try {
        await fs.access(zipPath);
      } catch {
        console.warn('empty.zip not found, skipping test');
        return;
      }

      const exists = await advZlib.exists(zipPath);
      expect(exists).toBe(true);

      const entries = await advZlib.getEntries(zipPath);
      expect(entries).toHaveLength(0);

      // Extraction should work but return no files
      const outputDir = join(__dirname, '../temp-extract-empty');
      await fs.mkdir(outputDir, { recursive: true });

      try {
        const extracted = await advZlib.extract(zipPath, outputDir);
        expect(extracted).toHaveLength(0);
      } finally {
        await fs.rm(outputDir, { recursive: true, force: true });
      }
    });

    test('should handle unusual-names.zip from assets', async () => {
      const zipPath = join(assetsDir, 'e2e', 'unusual-names.zip');
      
      try {
        await fs.access(zipPath);
      } catch {
        console.warn('unusual-names.zip not found, skipping test');
        return;
      }

      const exists = await advZlib.exists(zipPath);
      expect(exists).toBe(true);

      const entries = await advZlib.getEntries(zipPath);
      expect(entries.length).toBeGreaterThan(0);

      // Test files with special characters in names
      for (const entry of entries) {
        if (!entry.isDirectory) {
          const content = await advZlib.read(join(zipPath, entry.relPath));
          expect(Buffer.isBuffer(content)).toBe(true);
          
          console.log(`Successfully read file with unusual name: "${entry.name}"`);
        }
      }
    });
  });

  describe('ZIP64 Support', () => {
    test('should handle zip64.zip if present', async () => {
      const zipPath = join(assetsDir, 'zip64.zip');
      
      try {
        await fs.access(zipPath);
      } catch {
        console.warn('zip64.zip not found, skipping ZIP64 test');
        return;
      }

      const exists = await advZlib.exists(zipPath);
      expect(exists).toBe(true);

      const entries = await advZlib.getEntries(zipPath);
      expect(entries.length).toBeGreaterThan(0);

      console.log(`ZIP64 file contains ${entries.length} entries`);

      // Test reading from ZIP64 file
      const fileEntries = entries.filter(e => !e.isDirectory);
      if (fileEntries.length > 0) {
        const content = await advZlib.read(join(zipPath, fileEntries[0].relPath));
        expect(content.length).toBeGreaterThan(0);
        
        console.log(`Successfully read from ZIP64 file: ${fileEntries[0].name} (${content.length} bytes)`);
      }
    });
  });

  describe('Snapshot Files', () => {
    test('should handle large snapshot ZIP files from assets directory', async () => {
      const snapshotFiles = [
        'vdu_snapshot.zip',
        'big_nested.zip',
        'big_size.zip',
        'big_size_with_many_entries.zip',
      ];

      for (const filename of snapshotFiles) {
        const zipPath = join(assetsDir, '..', filename);
        
        try {
          await fs.access(zipPath);
        } catch {
          console.warn(`${filename} not found, skipping`);
          continue;
        }

        console.log(`Testing large snapshot file: ${filename}`);

        const start = Date.now();
        const exists = await advZlib.exists(zipPath);
        const existsTime = Date.now() - start;
        
        expect(exists).toBe(true);
        console.log(`  exists() took ${existsTime}ms`);

        const start2 = Date.now();
        const entries = await advZlib.getEntries(zipPath);
        const entriesTime = Date.now() - start2;
        
        expect(entries.length).toBeGreaterThan(0);
        console.log(`  getEntries() found ${entries.length} entries in ${entriesTime}ms`);

        // Test reading a sample file
        const fileEntries = entries.filter(e => !e.isDirectory);
        if (fileEntries.length > 0) {
          const sampleEntry = fileEntries[Math.floor(fileEntries.length / 2)]; // Pick middle entry
          
          const start3 = Date.now();
          const content = await advZlib.read(join(zipPath, sampleEntry.relPath));
          const readTime = Date.now() - start3;
          
          expect(content.length).toBeGreaterThan(0);
          console.log(`  read() sample file "${sampleEntry.name}" (${content.length} bytes) in ${readTime}ms`);
        }

        // Test cache performance on second access
        const start4 = Date.now();
        await advZlib.getEntries(zipPath);
        const cachedTime = Date.now() - start4;
        
        console.log(`  Cached getEntries() took ${cachedTime}ms (speedup: ${(entriesTime / cachedTime).toFixed(1)}x)`);
        
        // Cached access should be significantly faster
        expect(cachedTime).toBeLessThan(entriesTime);
      }
    });
  });

  describe('Real-World Performance', () => {
    test('should demonstrate practical performance with real files', async () => {
      const testFiles = [
        join(assetsDir, 'e2e', 'simple-text.zip'),
        join(assetsDir, 'e2e', 'compressed.zip'),
        join(assetsDir, 'e2e', 'with-directories.zip'),
      ];

      const results: { file: string; cold: number; warm: number; speedup: number }[] = [];

      for (const zipPath of testFiles) {
        try {
          await fs.access(zipPath);
        } catch {
          continue; // Skip if file doesn't exist
        }

        // Cold access
        await advZlib.cleanup(); // Clear cache
        const start1 = Date.now();
        await advZlib.getEntries(zipPath);
        const coldTime = Date.now() - start1;

        // Warm access
        const start2 = Date.now();
        await advZlib.getEntries(zipPath);
        const warmTime = Date.now() - start2;

        const speedup = coldTime / Math.max(warmTime, 1);
        results.push({
          file: zipPath.split('/').pop() || zipPath,
          cold: coldTime,
          warm: warmTime,
          speedup,
        });
      }

      console.log('\nReal-world performance results:');
      results.forEach(result => {
        console.log(`  ${result.file}: ${result.cold}ms -> ${result.warm}ms (${result.speedup.toFixed(1)}x speedup)`);
        expect(result.speedup).toBeGreaterThan(1); // Should always be faster with cache
      });

      if (results.length > 0) {
        const avgSpeedup = results.reduce((sum, r) => sum + r.speedup, 0) / results.length;
        console.log(`  Average speedup: ${avgSpeedup.toFixed(1)}x`);
        expect(avgSpeedup).toBeGreaterThan(2); // Should average at least 2x speedup
      }
    });

    test('should handle mixed operations efficiently', async () => {
      const zipFiles = [
        join(assetsDir, 'e2e', 'simple-text.zip'),
        join(assetsDir, 'e2e', 'compressed.zip'),
      ];

      // Filter to only existing files
      const existingFiles: string[] = [];
      for (const file of zipFiles) {
        try {
          await fs.access(file);
          existingFiles.push(file);
        } catch {
          // Skip non-existent files
        }
      }

      if (existingFiles.length === 0) {
        console.warn('No test files available for mixed operations test');
        return;
      }

      const operations = [
        () => advZlib.exists(existingFiles[0]),
        () => advZlib.getEntries(existingFiles[0]),
        () => existingFiles[1] ? advZlib.exists(existingFiles[1]) : Promise.resolve(true),
        () => existingFiles[1] ? advZlib.getEntries(existingFiles[1]) : Promise.resolve([]),
      ].filter(op => op); // Remove undefined operations

      // First round - populate cache
      const start1 = Date.now();
      await Promise.all(operations.map(op => op()));
      const firstRound = Date.now() - start1;

      // Second round - use cache
      const start2 = Date.now();
      await Promise.all(operations.map(op => op()));
      const secondRound = Date.now() - start2;

      console.log(`Mixed operations: ${firstRound}ms -> ${secondRound}ms`);
      expect(secondRound).toBeLessThan(firstRound);

      const stats = advZlib.getCacheStats();
      console.log(`Final cache: ${stats.total.entries} entries, ${stats.total.memoryMB}MB`);
    });
  });
});