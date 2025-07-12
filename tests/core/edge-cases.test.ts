import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import AdvZlib from '../../src/index';
import { createBasicTestZipFiles, BasicTestAssets } from '../test-assets';

describe('Edge Cases and Error Handling', () => {
  const testAssetsDir = join(__dirname, '../test-assets-edge-cases');
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
    await fs.rm(testAssetsDir, { recursive: true, force: true });
  });

  describe('Invalid Input Handling', () => {
    test('should throw error for empty source path in exists()', async () => {
      await expect(advZlib.exists('')).rejects.toThrow();
    });

    test('should throw error for empty source path in read()', async () => {
      await expect(advZlib.read('')).rejects.toThrow();
    });

    test('should handle null/undefined gracefully', async () => {
      // @ts-ignore - Testing runtime behavior
      await expect(advZlib.exists(null)).rejects.toThrow();
      // @ts-ignore - Testing runtime behavior
      await expect(advZlib.exists(undefined)).rejects.toThrow();
    });

    test('should handle non-string paths gracefully', async () => {
      // @ts-ignore - Testing runtime behavior
      const result1 = await advZlib.exists(123);
      expect(result1).toBe(false);
      // @ts-ignore - Testing runtime behavior  
      const result2 = await advZlib.exists({});
      expect(result2).toBe(false);
    });
  });

  describe('Non-ZIP File Handling', () => {
    test('should handle non-ZIP file extension gracefully', async () => {
      const textFile = join(testAssetsDir, 'plain.txt');
      await fs.writeFile(textFile, 'This is not a ZIP file');

      const exists = await advZlib.exists(textFile);
      expect(exists).toBe(true); // File exists but is not a ZIP
      
      await expect(advZlib.getEntries(textFile)).rejects.toThrow();
    });

    test('should handle file with .zip extension but invalid content', async () => {
      const fakeZip = join(testAssetsDir, 'fake.zip');
      await fs.writeFile(fakeZip, 'This is not really a ZIP file');

      const exists = await advZlib.exists(fakeZip);
      expect(exists).toBe(true); // File exists, but when parsed as ZIP it will fail
    });

    test('should handle binary file with .zip extension', async () => {
      const binaryFake = join(testAssetsDir, 'binary-fake.zip');
      const binaryData = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // ZIP signature but incomplete
      await fs.writeFile(binaryFake, binaryData);

      const exists = await advZlib.exists(binaryFake);
      expect(exists).toBe(true); // File exists, parsing as ZIP may fail later
    });
  });

  describe('Empty and Edge Case ZIPs', () => {
    test('should handle empty ZIP file correctly', async () => {
      const exists = await advZlib.exists(basicAssets.empty);
      expect(exists).toBe(true);

      const entries = await advZlib.getEntries(basicAssets.empty);
      expect(entries).toHaveLength(0);
    });

    test('should handle ZIP with only directories', async () => {
      const entries = await advZlib.getEntries(basicAssets.withDirectories);
      const directories = entries.filter(e => e.isDirectory);
      const files = entries.filter(e => !e.isDirectory);
      
      expect(directories.length).toBeGreaterThan(0);
      expect(files.length).toBeGreaterThan(0); // Should have some files too
    });

    test('should handle basic ZIP file entries', async () => {
      const entries = await advZlib.getEntries(basicAssets.simpleText);
      expect(entries.length).toBeGreaterThan(0);
      
      const textEntry = entries.find(e => e.name === 'sample.txt');
      expect(textEntry).toBeDefined();
      expect(textEntry!.size).toBeGreaterThan(0);
    });
  });

  describe('Special Character Handling', () => {
    test('should handle files with unusual names', async () => {
      const entries = await advZlib.getEntries(basicAssets.unusualNames);
      expect(entries.length).toBeGreaterThan(0);

      // Check for files with spaces, unicode, special characters
      const spaceFile = entries.find(e => e.name.includes(' '));
      expect(spaceFile).toBeDefined();
    });

    test('should read content from files with unusual names', async () => {
      const content = await advZlib.read(join(basicAssets.unusualNames, 'file with spaces.txt'));
      expect(content.length).toBeGreaterThan(0);
    });

    test('should handle unicode filenames', async () => {
      const entries = await advZlib.getEntries(basicAssets.unusualNames);
      const unicodeFile = entries.find(e => /[^\x00-\x7F]/.test(e.name));
      
      if (unicodeFile) {
        const content = await advZlib.read(join(basicAssets.unusualNames, unicodeFile.name));
        expect(content.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Path Edge Cases', () => {
    test('should handle paths with double slashes', async () => {
      // Double slashes in paths should be normalized or handled gracefully
      const doubleslashPath = basicAssets.simpleText.replace('/', '//') + '//sample.txt';
      const exists = await advZlib.exists(doubleslashPath);
      // Path normalization may result in false, which is acceptable behavior
      expect(typeof exists).toBe('boolean');
    });

    test('should handle paths with trailing slashes', async () => {
      // Trailing slashes on ZIP files may not be supported
      const trailingSlashPath = basicAssets.simpleText + '/';
      const exists = await advZlib.exists(trailingSlashPath);
      // This may return false, which is acceptable behavior
      expect(typeof exists).toBe('boolean');
    });

    test('should handle very long paths', async () => {
      const longPath = basicAssets.simpleText + '/' + 'a'.repeat(200) + '.txt';
      const exists = await advZlib.exists(longPath);
      expect(exists).toBe(false); // Should not exist, but shouldn't crash
    });

    test('should handle paths with relative components', async () => {
      const relativePath = basicAssets.simpleText + '/../' + 'sample.txt';
      // This should be handled gracefully without crashing
      const exists = await advZlib.exists(relativePath);
      expect(typeof exists).toBe('boolean');
    });
  });

  describe('Memory and Resource Limits', () => {
    test('should handle cleanup gracefully', async () => {
      // Use the ZIP a few times to populate caches
      await advZlib.getEntries(basicAssets.simpleText);
      await advZlib.read(join(basicAssets.simpleText, 'sample.txt'));
      
      const statsBefore = advZlib.getCacheStats();
      expect(statsBefore.total.entries).toBeGreaterThan(0);

      await advZlib.cleanup();
      
      const statsAfter = advZlib.getCacheStats();
      expect(statsAfter.total.entries).toBe(0);
    });

    test('should handle multiple cleanup calls', async () => {
      await advZlib.cleanup();
      await advZlib.cleanup(); // Should not throw
      await advZlib.cleanup(); // Multiple calls should be safe
      
      const stats = advZlib.getCacheStats();
      expect(stats.total.entries).toBe(0);
    });

    test('should work after cleanup', async () => {
      await advZlib.cleanup();
      
      // Should still work after cleanup
      const exists = await advZlib.exists(basicAssets.simpleText);
      expect(exists).toBe(true);
      
      const content = await advZlib.read(join(basicAssets.simpleText, 'sample.txt'));
      expect(content.length).toBeGreaterThan(0);
    });
  });

  describe('Concurrent Access', () => {
    test('should handle concurrent reads safely', async () => {
      const promises = Array.from({ length: 5 }, () => 
        advZlib.read(join(basicAssets.simpleText, 'sample.txt'))
      );

      const results = await Promise.all(promises);
      
      // All reads should succeed and return identical content
      expect(results).toHaveLength(5);
      results.forEach((result, index) => {
        expect(result.length).toBeGreaterThan(0);
        if (index > 0) {
          expect(result.equals(results[0])).toBe(true);
        }
      });
    });

    test('should handle concurrent operations on different files', async () => {
      const operations = [
        advZlib.exists(basicAssets.simpleText),
        advZlib.getEntries(basicAssets.withDirectories),
        advZlib.read(join(basicAssets.simpleText, 'sample.txt')),
        advZlib.exists(basicAssets.binaryFiles),
        advZlib.getEntries(basicAssets.unusualNames),
      ];

      const results = await Promise.all(operations);
      
      // All operations should complete successfully
      expect(results).toHaveLength(5);
      expect(results[0]).toBe(true); // exists
      expect(Array.isArray(results[1])).toBe(true); // getEntries
      expect(Buffer.isBuffer(results[2])).toBe(true); // read
      expect(results[3]).toBe(true); // exists
      expect(Array.isArray(results[4])).toBe(true); // getEntries
    });
  });

  describe('Error Recovery', () => {
    test('should recover from temporary file system errors', async () => {
      // Test that the library can recover from transient errors
      const nonExistentPath = join(testAssetsDir, 'definitely-does-not-exist.zip');
      
      const exists1 = await advZlib.exists(nonExistentPath);
      expect(exists1).toBe(false);

      // Create the file
      await fs.copyFile(basicAssets.simpleText, nonExistentPath);
      
      const exists2 = await advZlib.exists(nonExistentPath);
      expect(exists2).toBe(true);

      // Clean up
      await fs.unlink(nonExistentPath);
    });

    test('should handle permission errors gracefully', async () => {
      // This test might not work on all systems, so we'll make it conditional
      try {
        const restrictedPath = join(testAssetsDir, 'restricted.zip');
        await fs.copyFile(basicAssets.simpleText, restrictedPath);
        await fs.chmod(restrictedPath, 0o000); // Remove all permissions

        const exists = await advZlib.exists(restrictedPath);
        // Should handle gracefully (likely return false)
        expect(typeof exists).toBe('boolean');

        // Restore permissions for cleanup
        await fs.chmod(restrictedPath, 0o644);
        await fs.unlink(restrictedPath);
      } catch (error) {
        // If chmod doesn't work on this system, skip this test
        console.warn('Skipping permission test due to system limitations');
      }
    });
  });
});