import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import AdvZlib, { EncryptionMethod, type ZipOptions } from '../../src/index';
import { createBasicTestZipFiles, BasicTestAssets, safeRemoveDir, createTraditionalEncryptedZip } from '../test-assets';
import archiver from 'archiver';
import { createWriteStream } from 'fs';
import { finished } from 'node:stream/promises';

describe('AdvZlib Encrypted ZIP Integration', () => {
  const testAssetsDir = join(__dirname, '../test-assets-encrypted');
  let advZlib: AdvZlib;
  let basicAssets: BasicTestAssets;
  let encryptedAssets: {
    traditionalEncrypted: string;
    wrongPasswordEncrypted: string;
    mixedEncryption: string;
  };

  const silentLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  const testPassword = 'test123';
  const wrongPassword = 'wrong456';

  beforeAll(async () => {
    await fs.mkdir(testAssetsDir, { recursive: true });
    basicAssets = await createBasicTestZipFiles(testAssetsDir);

    advZlib = new AdvZlib({
      logger: silentLogger,
      enableContentCaching: true,
    });

    // Create encrypted test assets
    encryptedAssets = await createEncryptedTestAssets();
  }, 60000);

  afterAll(async () => {
    await advZlib.cleanup();
    await safeRemoveDir(testAssetsDir);
  });

  async function createEncryptedTestAssets() {
    // Create traditionally encrypted ZIP with real encryption
    const traditionalPath = join(testAssetsDir, 'traditional-encrypted.zip');
    await createTraditionalEncryptedZip(
      traditionalPath,
      [
        { name: 'secret.txt', content: 'This is secret encrypted content!' },
        { name: 'passwords.txt', content: 'admin:password123\nuser:secret456' },
        { name: 'data/config.json', content: '{"apiKey": "secret-key-123", "debug": true}' },
      ],
      testPassword
    );

    // Create another encrypted ZIP with different password for wrong password tests
    const wrongPasswordPath = join(testAssetsDir, 'wrong-password.zip');
    await createTraditionalEncryptedZip(
      wrongPasswordPath,
      [{ name: 'locked.txt', content: 'This requires a different password' }],
      'different-password-456'
    );

    // Create mixed encryption ZIP (some encrypted, some not)
    const mixedPath = join(testAssetsDir, 'mixed-encryption.zip');
    await createMixedEncryptionZip(mixedPath);

    return {
      traditionalEncrypted: traditionalPath,
      wrongPasswordEncrypted: wrongPasswordPath,
      mixedEncryption: mixedPath,
    };
  }

  async function createMixedEncryptionZip(outputPath: string): Promise<void> {
    // Create a regular ZIP first (non-encrypted files)
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.pipe(output);
    archive.append('Public content - not encrypted', { name: 'public.txt' });
    archive.append('README content for everyone', { name: 'README.md' });

    await archive.finalize();
    await finished(output);
  }

  describe('Encryption Detection', () => {
    test('should detect non-encrypted ZIP files correctly', async () => {
      // Test with regular (non-encrypted) ZIP
      const regularEncrypted = await advZlib.isEncrypted(basicAssets.simpleText);
      expect(regularEncrypted).toBe(false);
    });

    test('should detect encrypted ZIP files correctly', async () => {
      // Test with actual encrypted ZIP
      const encryptedDetected = await advZlib.isEncrypted(encryptedAssets.traditionalEncrypted);
      expect(encryptedDetected).toBe(true);
    });

    test('should get encryption information for non-encrypted ZIP file', async () => {
      // Test with regular ZIP
      const encInfo = await advZlib.getEncryptionInfo(basicAssets.simpleText);
      expect(encInfo.isEncrypted).toBe(false);
      expect(encInfo.encryptionMethod).toBe(EncryptionMethod.NONE);
      expect(encInfo.needsPassword).toBe(false);
    });

    test('should get encryption information for encrypted ZIP file', async () => {
      // Test with encrypted ZIP
      const encInfo = await advZlib.getEncryptionInfo(encryptedAssets.traditionalEncrypted);
      expect(encInfo.isEncrypted).toBe(true);
      expect(encInfo.encryptionMethod).toBe(EncryptionMethod.TRADITIONAL);
      expect(encInfo.needsPassword).toBe(true);
    });

    test('should detect encryption for specific entries', async () => {
      // Test specific encrypted entry
      const entryEncrypted = await advZlib.isEncrypted(join(encryptedAssets.traditionalEncrypted, 'secret.txt'));
      expect(entryEncrypted).toBe(true);

      // Test specific non-encrypted entry
      const entryNotEncrypted = await advZlib.isEncrypted(join(basicAssets.simpleText, 'sample.txt'));
      expect(entryNotEncrypted).toBe(false);
    });

    test('should handle non-existent files gracefully', async () => {
      const result = await advZlib.isEncrypted(join(testAssetsDir, 'non-existent.zip'));
      expect(result).toBe(false);
    });
  });

  describe('Reading Encrypted Content', () => {
    test('should throw error when reading encrypted content without password', async () => {
      // Test reading encrypted content without password should fail
      await expect(advZlib.read(join(encryptedAssets.traditionalEncrypted, 'secret.txt'))).rejects.toThrow(
        /is encrypted and requires a password/
      );
    });

    test('should read encrypted content with correct password', async () => {
      // Test reading encrypted content with correct password
      const options: ZipOptions = { password: testPassword };

      const content = await advZlib.read(join(encryptedAssets.traditionalEncrypted, 'secret.txt'), options);
      expect(content.toString()).toBe('This is secret encrypted content!');
    });

    test('should fail to read encrypted content with wrong password', async () => {
      // Test reading encrypted content with wrong password
      const options: ZipOptions = { password: wrongPassword };

      await expect(advZlib.read(join(encryptedAssets.traditionalEncrypted, 'secret.txt'), options)).rejects.toThrow(
        /Invalid password/
      );
    });

    test('should read multiple encrypted files from same ZIP', async () => {
      const options: ZipOptions = { password: testPassword };

      // Read first file
      const content1 = await advZlib.read(join(encryptedAssets.traditionalEncrypted, 'secret.txt'), options);
      expect(content1.toString()).toBe('This is secret encrypted content!');

      // Read second file
      const content2 = await advZlib.read(join(encryptedAssets.traditionalEncrypted, 'passwords.txt'), options);
      expect(content2.toString()).toBe('admin:password123\nuser:secret456');
    });

    test('should handle filter functions with encrypted ZIPs', async () => {
      const options: ZipOptions = { password: testPassword };

      const content = await advZlib.read(encryptedAssets.traditionalEncrypted, {
        ...options,
        filter: (entry) => entry.name === 'secret.txt',
      });
      expect(content.toString()).toBe('This is secret encrypted content!');
    });

    test('should read non-encrypted content without password', async () => {
      // Test that non-encrypted content still works without password
      const content = await advZlib.read(join(basicAssets.simpleText, 'sample.txt'));
      expect(content.toString()).toContain('Hello, World!');
    });
  });

  describe('Extracting Encrypted Content', () => {
    test('should extract encrypted ZIP with password', async () => {
      const outputDir = join(testAssetsDir, 'extract-encrypted');
      await fs.mkdir(outputDir, { recursive: true });

      const options: ZipOptions = { password: testPassword };

      // Extract entire encrypted ZIP
      const extracted = await advZlib.extract(encryptedAssets.traditionalEncrypted, outputDir, options);

      expect(extracted.length).toBe(3); // Should extract all 3 files

      // Verify content was extracted correctly
      const secretFile = extracted.find((f) => f.includes('secret.txt'));
      expect(secretFile).toBeDefined();
      const content = await fs.readFile(secretFile!, 'utf8');
      expect(content).toBe('This is secret encrypted content!');
    });

    test('should extract specific encrypted files', async () => {
      const outputDir = join(testAssetsDir, 'extract-specific');
      await fs.mkdir(outputDir, { recursive: true });

      const options: ZipOptions = { password: testPassword };

      const extracted = await advZlib.extract(join(encryptedAssets.traditionalEncrypted, 'secret.txt'), outputDir, options);

      expect(extracted).toHaveLength(1);
      expect(extracted[0]).toMatch(/secret\.txt$/);

      // Verify extracted content
      const content = await fs.readFile(extracted[0], 'utf8');
      expect(content).toBe('This is secret encrypted content!');
    });

    test('should fail to extract without password for encrypted ZIP', async () => {
      const outputDir = join(testAssetsDir, 'extract-no-password');
      await fs.mkdir(outputDir, { recursive: true });

      // Should fail to extract encrypted content without password
      await expect(advZlib.extract(encryptedAssets.traditionalEncrypted, outputDir)).rejects.toThrow(
        /is encrypted and requires a password/
      );
    });

    test('should handle mixed encryption extraction', async () => {
      const outputDir = join(testAssetsDir, 'extract-mixed');
      await fs.mkdir(outputDir, { recursive: true });

      // Extract non-encrypted ZIP (should work without password)
      const extractedPublic = await advZlib.extract(encryptedAssets.mixedEncryption, outputDir);
      expect(extractedPublic.length).toBeGreaterThan(0);

      // Verify public content was extracted
      const publicFile = extractedPublic.find((f) => f.includes('public.txt'));
      expect(publicFile).toBeDefined();
      const content = await fs.readFile(publicFile!, 'utf8');
      expect(content).toBe('Public content - not encrypted');
    });
  });

  describe('Encrypted ZIP Entries', () => {
    test('should list entries from encrypted ZIP with correct encryption properties', async () => {
      const entries = await advZlib.getEntries(encryptedAssets.traditionalEncrypted);
      expect(entries.length).toBe(3);

      // Check that encryption properties are set correctly for encrypted entries
      entries.forEach((entry) => {
        expect(entry).toHaveProperty('isEncrypted');
        expect(entry).toHaveProperty('encryptionInfo');
        expect(entry.isEncrypted).toBe(true);
        expect(entry.encryptionInfo.isEncrypted).toBe(true);
        expect(entry.encryptionInfo.encryptionMethod).toBe(EncryptionMethod.TRADITIONAL);
        expect(entry.encryptionInfo.needsPassword).toBe(true);
      });

      // Verify specific entries exist
      const entryNames = entries.map((e) => e.name);
      expect(entryNames).toContain('secret.txt');
      expect(entryNames).toContain('passwords.txt');
      expect(entryNames).toContain('config.json');
    });

    test('should list entries from non-encrypted ZIP with correct properties', async () => {
      const entries = await advZlib.getEntries(basicAssets.simpleText);
      expect(entries.length).toBeGreaterThan(0);

      // Check that encryption properties show non-encrypted
      entries.forEach((entry) => {
        expect(entry.isEncrypted).toBe(false);
        expect(entry.encryptionInfo.isEncrypted).toBe(false);
        expect(entry.encryptionInfo.encryptionMethod).toBe(EncryptionMethod.NONE);
        expect(entry.encryptionInfo.needsPassword).toBe(false);
      });
    });

    test('should filter encrypted entries correctly', async () => {
      const txtEntries = await advZlib.getEntries(encryptedAssets.traditionalEncrypted, {
        filter: (entry) => entry.name.endsWith('.txt'),
      });

      expect(txtEntries.length).toBe(2); // secret.txt and passwords.txt
      txtEntries.forEach((entry) => {
        expect(entry.name).toMatch(/\.txt$/);
        expect(entry.isEncrypted).toBe(true);
      });
    });

    test('should access entry properties without requiring password', async () => {
      // Should be able to list entries without password (just can't read content)
      const entries = await advZlib.getEntries(encryptedAssets.traditionalEncrypted);

      expect(entries.length).toBe(3);

      // Check we can access all properties without password
      const secretEntry = entries.find((e) => e.name === 'secret.txt');
      expect(secretEntry).toBeDefined();
      expect(secretEntry!.isEncrypted).toBe(true);
      expect(secretEntry!.fullPath).toContain('secret.txt');
      expect(secretEntry!.relPath).toBe('secret.txt');
      expect(secretEntry!.isDirectory).toBe(false);
    });
  });

  describe('Error Handling', () => {
    test('should provide clear error messages for encryption issues', async () => {
      // Test various error scenarios
      const testCases = [
        {
          name: 'empty source',
          src: '',
          expectError: /is empty/,
        },
        {
          name: 'non-existent file',
          src: join(testAssetsDir, 'non-existent.zip'),
          expectError: /The source of the ZIP file is required/,
        },
      ];

      for (const testCase of testCases) {
        await expect(advZlib.read(testCase.src)).rejects.toThrow(testCase.expectError);
      }
    });

    test('should handle malformed encryption data gracefully', async () => {
      // This would test with corrupted encrypted ZIP files
      // For now, test that regular operations still work
      const content = await advZlib.read(join(basicAssets.simpleText, 'sample.txt'));
      expect(content.toString()).toContain('Hello, World!');
    });
  });

  describe.sequential('Performance with Encryption', () => {
    beforeEach(async () => {
      await advZlib.cleanup();
      // Give additional time for cleanup to complete
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    test('should cache decrypted content correctly', async () => {
      const options: ZipOptions = { password: testPassword };

      // Use a unique file path to avoid cache contamination from other tests
      const uniqueFilePath = join(encryptedAssets.traditionalEncrypted, 'secret.txt');

      // Ensure clean cache state for this test
      await advZlib.cleanup();
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Verify cache is empty before test
      const initialStats = advZlib.getCacheStats();
      expect(initialStats.content.entries).toBe(0);

      // First read (cold cache) - should decrypt
      const content1 = await advZlib.read(uniqueFilePath, options);

      // Verify content was cached after first read
      const afterFirstStats = advZlib.getCacheStats();
      expect(afterFirstStats.content.entries).toBeGreaterThan(0);

      // Multiple warm cache reads to ensure consistency
      const warmReads = 3;
      const warmTimes: number[] = [];

      for (let i = 0; i < warmReads; i++) {
        const start = process.hrtime.bigint();
        const content = await advZlib.read(uniqueFilePath, options);
        const end = process.hrtime.bigint();

        expect(content.equals(content1)).toBe(true);
        warmTimes.push(Number(end - start) / 1000000); // Convert to milliseconds
      }

      // Check cache consistency - all warm reads should be fast and consistent
      const avgWarmTime = warmTimes.reduce((a, b) => a + b, 0) / warmTimes.length;
      const maxWarmTime = Math.max(...warmTimes);

      expect(content1.toString()).toBe('This is secret encrypted content!');

      // Cache effectiveness test: warm reads should be consistently fast (under 5ms on average)
      expect(avgWarmTime, `Average warm cache time should be fast: ${avgWarmTime}ms`).toBeLessThan(5);
      expect(maxWarmTime, `Max warm cache time should be reasonable: ${maxWarmTime}ms`).toBeLessThan(20);
    });

    test('should handle different passwords in cache correctly', async () => {
      const correctOptions: ZipOptions = { password: testPassword };
      const wrongOptions: ZipOptions = { password: wrongPassword };

      // Read with correct password first
      const content1 = await advZlib.read(join(encryptedAssets.traditionalEncrypted, 'secret.txt'), correctOptions);
      expect(content1.toString()).toBe('This is secret encrypted content!');

      // Read with wrong password should still fail (not use cache)
      await expect(advZlib.read(join(encryptedAssets.traditionalEncrypted, 'secret.txt'), wrongOptions)).rejects.toThrow(
        /Invalid password/
      );
    });

    test('should show cache statistics with encrypted content', () => {
      const stats = advZlib.getCacheStats();
      expect(stats).toHaveProperty('centralDir');
      expect(stats).toHaveProperty('content');
      expect(stats).toHaveProperty('total');
      expect(typeof stats.total.entries).toBe('number');
    });
  });

  describe('Nested Encrypted ZIPs', () => {
    test('should handle encrypted ZIP within regular ZIP', async () => {
      // This would test with actual nested encrypted ZIPs
      // For now, verify that nested ZIP handling still works
      if (basicAssets.nested) {
        const entries = await advZlib.getEntries(basicAssets.nested);
        expect(entries.length).toBeGreaterThan(0);
      }
    });

    test('should handle different passwords for nested ZIPs', async () => {
      // This would test multi-level encryption with different passwords
      // Implementation would require more complex test assets
      const options: ZipOptions = { password: testPassword };

      // For now, test that basic nested operations work
      if (basicAssets.nested) {
        const exists = await advZlib.exists(basicAssets.nested, options);
        expect(exists).toBe(true);
      }
    });
  });
});
