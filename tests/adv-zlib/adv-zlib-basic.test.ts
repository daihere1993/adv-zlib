import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { AdvZlib } from '../../src/adv-zlib';
import { mkdir, rm, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import archiver from 'archiver';
import { createWriteStream } from 'node:fs';
import { existsSync, readdirSync } from 'node:fs';

// Helper function to create a test zip file
async function createTestZip(
  zipPath: string,
  files: Record<string, string | null>,
  options?: { useStore?: boolean; forceZip64?: boolean },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
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

describe('AdvZlib', () => {
  const testDir = join(tmpdir(), `adv-zlib-test-${Date.now()}-${Math.random().toString(36).substring(7)}`);
  let advZlib: AdvZlib;

  beforeAll(async () => {
    await mkdir(testDir, { recursive: true });
    advZlib = new AdvZlib();
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('exists() method', () => {
    let simpleZipPath: string;
    let folderZipPath: string;
    let outerZipPath: string;
    let level1ZipPath: string;

    beforeAll(async () => {
      // Create simple ZIP with files
      simpleZipPath = join(testDir, 'test.zip');
      await createTestZip(simpleZipPath, {
        'file1.txt': 'Hello, World!',
        'file2.txt': 'This is file 2',
        'dir/nested.txt': 'Nested file content',
      });

      // Create ZIP with folders
      folderZipPath = join(testDir, 'folders.zip');
      await createTestZip(folderZipPath, {
        'folder/': null,
        'empty/': null,
        'folder/file.txt': 'File in folder',
      });

      // Create nested ZIP (outer.zip contains inner.zip)
      const innerZipPath = join(testDir, 'inner.zip');
      await createTestZip(innerZipPath, {
        'content.txt': 'Content in inner zip',
        'another.txt': 'Another file',
      });

      outerZipPath = join(testDir, 'outer.zip');
      // Note: archiver doesn't handle binary buffers well for nested zips
      // We need to use a different approach - store the file itself
      await createTestZip(outerZipPath, {
        'outer-file.txt': 'File in outer zip',
      });

      // Now add the inner.zip file using writeFile (direct copy won't work with archiver)
      // Instead, let's use the archiver's file method by recreating it properly
      const { readFile } = await import('node:fs/promises');
      const innerZipBuffer = await readFile(innerZipPath);

      // Re-create outer.zip with proper binary handling
      const archiver = (await import('archiver')).default;
      const { createWriteStream } = await import('node:fs');

      await new Promise<void>((resolve, reject) => {
        const output = createWriteStream(outerZipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve());
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);

        // Add the inner ZIP as a buffer
        archive.append(innerZipBuffer, { name: 'inner.zip' });
        archive.append('File in outer zip', { name: 'outer-file.txt' });
        archive.finalize();
      });

      // Create deeply nested ZIP (level1.zip → level2.zip → level3.zip)
      const level3ZipPath = join(testDir, 'level3.zip');
      await createTestZip(level3ZipPath, {
        'deep.txt': 'Deep nested content',
      });

      const level2ZipPath = join(testDir, 'level2.zip');
      const level3Buffer = await readFile(level3ZipPath);
      await new Promise<void>((resolve, reject) => {
        const output = createWriteStream(level2ZipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve());
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);

        archive.append(level3Buffer, { name: 'level3.zip' });
        archive.finalize();
      });

      level1ZipPath = join(testDir, 'level1.zip');
      const level2Buffer = await readFile(level2ZipPath);
      await new Promise<void>((resolve, reject) => {
        const output = createWriteStream(level1ZipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve());
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);

        archive.append(level2Buffer, { name: 'level2.zip' });
        archive.finalize();
      });
    });

    describe('Simple File Existence Tests', () => {
      it('should return true for file at root of ZIP', async () => {
        const exists = await advZlib.exists(`${simpleZipPath}/file1.txt`);
        expect(exists).toBe(true);
      });

      it('should return true for file in subdirectory', async () => {
        const exists = await advZlib.exists(`${simpleZipPath}/dir/nested.txt`);
        expect(exists).toBe(true);
      });

      it('should return false for non-existent file', async () => {
        const exists = await advZlib.exists(`${simpleZipPath}/nonexistent.txt`);
        expect(exists).toBe(false);
      });

      it('should return false for file with wrong case', async () => {
        const exists = await advZlib.exists(`${simpleZipPath}/FILE1.TXT`);
        expect(exists).toBe(false);
      });

      it('should return true for multiple files in same ZIP', async () => {
        const exists1 = await advZlib.exists(`${simpleZipPath}/file1.txt`);
        const exists2 = await advZlib.exists(`${simpleZipPath}/file2.txt`);
        expect(exists1).toBe(true);
        expect(exists2).toBe(true);
      });
    });

    describe('Folder Existence Tests', () => {
      it('should return true for folder with trailing slash', async () => {
        const exists = await advZlib.exists(`${folderZipPath}/folder/`);
        expect(exists).toBe(true);
      });

      it('should return false for folder without trailing slash', async () => {
        const exists = await advZlib.exists(`${folderZipPath}/folder`);
        expect(exists).toBe(false);
      });

      it('should return true for empty folder with trailing slash', async () => {
        const exists = await advZlib.exists(`${folderZipPath}/empty/`);
        expect(exists).toBe(true);
      });

      it('should return false for non-existent folder', async () => {
        const exists = await advZlib.exists(`${folderZipPath}/nonexistent/`);
        expect(exists).toBe(false);
      });
    });

    describe('Direct ZIP File Tests', () => {
      it('should return true for existing ZIP file', async () => {
        const exists = await advZlib.exists(simpleZipPath);
        expect(exists).toBe(true);
      });

      it('should return false for non-existent ZIP file', async () => {
        const nonExistentPath = join(testDir, 'nonexistent.zip');
        const exists = await advZlib.exists(nonExistentPath);
        expect(exists).toBe(false);
      });
    });

    describe('Nested ZIP Tests', () => {
      it('should return true for file in nested ZIP', async () => {
        const exists = await advZlib.exists(`${outerZipPath}/inner.zip/content.txt`);
        expect(exists).toBe(true);
      });

      it('should return true for nested ZIP itself', async () => {
        const exists = await advZlib.exists(`${outerZipPath}/inner.zip`);
        expect(exists).toBe(true);
      });

      it('should return false for non-existent file in nested ZIP', async () => {
        const exists = await advZlib.exists(`${outerZipPath}/inner.zip/missing.txt`);
        expect(exists).toBe(false);
      });

      it('should return true for deeply nested file (3 levels)', async () => {
        const exists = await advZlib.exists(`${level1ZipPath}/level2.zip/level3.zip/deep.txt`);
        expect(exists).toBe(true);
      });

      it('should return true for file in outer ZIP', async () => {
        const exists = await advZlib.exists(`${outerZipPath}/outer-file.txt`);
        expect(exists).toBe(true);
      });

      it('should return true for multiple files in nested ZIP', async () => {
        const exists1 = await advZlib.exists(`${outerZipPath}/inner.zip/content.txt`);
        const exists2 = await advZlib.exists(`${outerZipPath}/inner.zip/another.txt`);
        expect(exists1).toBe(true);
        expect(exists2).toBe(true);
      });
    });

    describe('ZIP in Directory Tests (a.zip/subdir/c.zip pattern)', () => {
      let dirNestedZipPath: string;

      beforeAll(async () => {
        // Create ZIP with directory containing a nested ZIP (a.zip/subdir/c.zip pattern)
        // This tests the bug where searchFileName used .split('/').pop() which only got
        // the filename, but when nested ZIP is in a subdirectory, the full path is needed
        const nestedInDirZipPath = join(testDir, 'nested-in-subdir.zip');
        await createTestZip(nestedInDirZipPath, {
          'deep-file.txt': 'Deep file in nested zip',
          'another.txt': 'Another file',
        });

        dirNestedZipPath = join(testDir, 'outer-with-subdir.zip');
        const nestedInDirBuffer = await readFile(nestedInDirZipPath);

        const archiver = (await import('archiver')).default;
        const { createWriteStream } = await import('node:fs');

        await new Promise<void>((resolve, reject) => {
          const output = createWriteStream(dirNestedZipPath);
          const archive = archiver('zip', { zlib: { level: 9 } });

          output.on('close', () => resolve());
          output.on('error', reject);
          archive.on('error', reject);
          archive.pipe(output);

          // Add the nested zip inside a subdirectory - this is the key pattern
          archive.append(nestedInDirBuffer, { name: 'symptomreport/log_data/logs.zip' });
          archive.append('Outer file', { name: 'outer-file.txt' });
          archive.finalize();
        });
      });

      it('should return true for nested ZIP inside subdirectory', async () => {
        const exists = await advZlib.exists(`${dirNestedZipPath}/symptomreport/log_data/logs.zip`);
        expect(exists).toBe(true);
      });

      it('should return true for file inside nested ZIP that is in subdirectory', async () => {
        const exists = await advZlib.exists(`${dirNestedZipPath}/symptomreport/log_data/logs.zip/deep-file.txt`);
        expect(exists).toBe(true);
      });

      it('should return true for another file inside nested ZIP in subdirectory', async () => {
        const exists = await advZlib.exists(`${dirNestedZipPath}/symptomreport/log_data/logs.zip/another.txt`);
        expect(exists).toBe(true);
      });

      it('should return false for non-existent file in nested ZIP in subdirectory', async () => {
        const exists = await advZlib.exists(`${dirNestedZipPath}/symptomreport/log_data/logs.zip/nonexistent.txt`);
        expect(exists).toBe(false);
      });

      it('should return false when searching with just filename (verifies full path is used)', async () => {
        // This tests that we search for "symptomreport/log_data/logs.zip" not just "logs.zip"
        const exists = await advZlib.exists(`${dirNestedZipPath}/logs.zip`);
        expect(exists).toBe(false);
      });
    });

    describe('Path Normalization Tests', () => {
      it('should handle backslashes converted to forward slashes', async () => {
        // Create a path with backslashes
        const pathWithBackslashes = simpleZipPath.replace(/\//g, '\\') + '\\file1.txt';
        const exists = await advZlib.exists(pathWithBackslashes);
        expect(exists).toBe(true);
      });

      it('should handle mixed slashes', async () => {
        // Mix forward and backward slashes
        const parts = simpleZipPath.split('/');
        const mixedPath = parts.slice(0, -1).join('/') + '\\' + parts[parts.length - 1] + '\\file1.txt';
        const exists = await advZlib.exists(mixedPath);
        expect(exists).toBe(true);
      });

      it('should support relative paths', async () => {
        // Create a test zip in current directory context
        const relativeZipPath = join(testDir, 'relative.zip');
        await createTestZip(relativeZipPath, {
          'test.txt': 'Test content',
        });

        // Test with relative path
        const exists = await advZlib.exists(`${relativeZipPath}/test.txt`);
        expect(exists).toBe(true);
      });
    });

    describe('Edge Cases and Error Handling', () => {
      it('should return false for empty path string', async () => {
        const exists = await advZlib.exists('');
        expect(exists).toBe(false);
      });

      it('should return false for path with no ZIP extension', async () => {
        // Create a regular file (not a zip)
        const regularFilePath = join(testDir, 'regular.txt');
        await writeFile(regularFilePath, 'Regular file content');

        // Try to access it as if it were a zip
        const exists = await advZlib.exists(`${regularFilePath}/inner.txt`);
        expect(exists).toBe(false);
      });

      it('should return false for non-existent parent directories', async () => {
        const nonExistentPath = join(testDir, 'nonexistent', 'test.zip', 'file.txt');
        const exists = await advZlib.exists(nonExistentPath);
        expect(exists).toBe(false);
      });

      it('should return false for path with only slashes', async () => {
        const exists = await advZlib.exists('///');
        expect(exists).toBe(false);
      });

      it('should handle paths with trailing slashes on files correctly', async () => {
        // Files should not have trailing slashes
        const exists = await advZlib.exists(`${simpleZipPath}/file1.txt/`);
        expect(exists).toBe(false);
      });
    });

    describe('Multiple .zip Extensions in Filename Tests', () => {
      let multiZipExtOuterPath: string;
      let threeLeveMultiZipExtPath: string;

      beforeAll(async () => {
        // Create inner ZIP with multiple .zip extensions in filename
        const innerMultiZipPath = join(testDir, 'data.zip.encrypted.zip');
        await createTestZip(innerMultiZipPath, {
          'secret.txt': 'Secret data',
          'info.txt': 'Information',
        });

        // Create outer ZIP containing the multi-extension ZIP
        multiZipExtOuterPath = join(testDir, 'outer-exists-multi-ext.zip');
        const innerMultiZipBuffer = await readFile(innerMultiZipPath);

        const archiver = (await import('archiver')).default;
        const { createWriteStream } = await import('node:fs');

        await new Promise<void>((resolve, reject) => {
          const output = createWriteStream(multiZipExtOuterPath);
          const archive = archiver('zip', { zlib: { level: 9 } });

          output.on('close', () => resolve());
          output.on('error', reject);
          archive.on('error', reject);
          archive.pipe(output);

          archive.append(innerMultiZipBuffer, { name: 'data.zip.encrypted.zip' });
          archive.append('Regular file', { name: 'regular.txt' });
          archive.finalize();
        });

        // Create 3-level nested structure with multiple .zip extensions
        const level3Path = join(testDir, 'file.zip.old.zip');
        await createTestZip(level3Path, {
          'final.txt': 'Final content',
        });

        const level2Path = join(testDir, 'archive.zip.bak.zip');
        const level3Buffer = await readFile(level3Path);
        await new Promise<void>((resolve, reject) => {
          const output = createWriteStream(level2Path);
          const archive = archiver('zip', { zlib: { level: 9 } });

          output.on('close', () => resolve());
          output.on('error', reject);
          archive.on('error', reject);
          archive.pipe(output);

          archive.append(level3Buffer, { name: 'file.zip.old.zip' });
          archive.finalize();
        });

        threeLeveMultiZipExtPath = join(testDir, 'outer-exists-three-level.zip');
        const level2Buffer = await readFile(level2Path);
        await new Promise<void>((resolve, reject) => {
          const output = createWriteStream(threeLeveMultiZipExtPath);
          const archive = archiver('zip', { zlib: { level: 9 } });

          output.on('close', () => resolve());
          output.on('error', reject);
          archive.on('error', reject);
          archive.pipe(output);

          archive.append(level2Buffer, { name: 'archive.zip.bak.zip' });
          archive.finalize();
        });
      });

      it('should return true for nested ZIP with multiple .zip extensions', async () => {
        const exists = await advZlib.exists(`${multiZipExtOuterPath}/data.zip.encrypted.zip`);
        expect(exists).toBe(true);
      });

      it('should return true for file inside nested ZIP with multiple .zip extensions', async () => {
        const exists = await advZlib.exists(`${multiZipExtOuterPath}/data.zip.encrypted.zip/secret.txt`);
        expect(exists).toBe(true);
      });

      it('should return false for non-existent file in multi-extension nested ZIP', async () => {
        const exists = await advZlib.exists(`${multiZipExtOuterPath}/data.zip.encrypted.zip/nonexistent.txt`);
        expect(exists).toBe(false);
      });

      it('should return true for file in 3-level nested ZIPs with multiple .zip extensions', async () => {
        const exists = await advZlib.exists(
          `${threeLeveMultiZipExtPath}/archive.zip.bak.zip/file.zip.old.zip/final.txt`,
        );
        expect(exists).toBe(true);
      });

      it('should return true for 2nd level ZIP in 3-level nested structure with multiple .zip extensions', async () => {
        const exists = await advZlib.exists(`${threeLeveMultiZipExtPath}/archive.zip.bak.zip/file.zip.old.zip`);
        expect(exists).toBe(true);
      });

      it('should return true for 1st level ZIP in 3-level nested structure with multiple .zip extensions', async () => {
        const exists = await advZlib.exists(`${threeLeveMultiZipExtPath}/archive.zip.bak.zip`);
        expect(exists).toBe(true);
      });

      it('should return false for truncated filename (simulating the bug)', async () => {
        // This tests the bug scenario: if we truncate at first .zip, it should not exist
        const exists = await advZlib.exists(`${multiZipExtOuterPath}/data.zip`);
        expect(exists).toBe(false);
      });
    });
  });

  describe('getEntryMetadatas() method', () => {
    let simpleZipPath: string;
    let emptyZipPath: string;
    let folderZipPath: string;
    let outerZipPath: string;
    let level1ZipPath: string;
    let dirNestedZipPath: string;

    beforeAll(async () => {
      // Create simple ZIP with files
      simpleZipPath = join(testDir, 'test-metadata.zip');
      await createTestZip(simpleZipPath, {
        'file1.txt': 'Hello, World!',
        'file2.txt': 'This is file 2',
        'dir/nested.txt': 'Nested file content',
      });

      // Create empty ZIP
      emptyZipPath = join(testDir, 'empty.zip');
      await createTestZip(emptyZipPath, {});

      // Create ZIP with folders
      folderZipPath = join(testDir, 'folders-metadata.zip');
      await createTestZip(folderZipPath, {
        'folder/': null,
        'empty/': null,
        'folder/file.txt': 'File in folder',
      });

      // Create nested ZIP (outer.zip contains inner.zip)
      const innerZipPath = join(testDir, 'inner-metadata.zip');
      await createTestZip(innerZipPath, {
        'content.txt': 'Content in inner zip',
        'another.txt': 'Another file',
        'subdir/deep.txt': 'Deep file',
      });

      outerZipPath = join(testDir, 'outer-metadata.zip');
      const { readFile } = await import('node:fs/promises');
      const innerZipBuffer = await readFile(innerZipPath);

      const archiver = (await import('archiver')).default;
      const { createWriteStream } = await import('node:fs');

      await new Promise<void>((resolve, reject) => {
        const output = createWriteStream(outerZipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve());
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);

        archive.append(innerZipBuffer, { name: 'inner-metadata.zip' });
        archive.append('File in outer zip', { name: 'outer-file.txt' });
        archive.finalize();
      });

      // Create deeply nested ZIP (level1.zip → level2.zip → level3.zip)
      const level3ZipPath = join(testDir, 'level3-metadata.zip');
      await createTestZip(level3ZipPath, {
        'deep.txt': 'Deep nested content',
        'another-deep.txt': 'Another deep file',
      });

      const level2ZipPath = join(testDir, 'level2-metadata.zip');
      const level3Buffer = await readFile(level3ZipPath);
      await new Promise<void>((resolve, reject) => {
        const output = createWriteStream(level2ZipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve());
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);

        archive.append(level3Buffer, { name: 'level3-metadata.zip' });
        archive.finalize();
      });

      level1ZipPath = join(testDir, 'level1-metadata.zip');
      const level2Buffer = await readFile(level2ZipPath);
      await new Promise<void>((resolve, reject) => {
        const output = createWriteStream(level1ZipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve());
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);

        archive.append(level2Buffer, { name: 'level2-metadata.zip' });
        archive.finalize();
      });

      // Create ZIP with directory containing a nested ZIP (a.zip/dir/c.zip pattern)
      const nestedInDirZipPath = join(testDir, 'nested-in-dir-metadata.zip');
      await createTestZip(nestedInDirZipPath, {
        'file-in-nested.zip': 'File in nested zip',
        'another.txt': 'Another file',
      });

      dirNestedZipPath = join(testDir, 'dir-nested-metadata.zip');
      const nestedInDirBuffer = await readFile(nestedInDirZipPath);
      await new Promise<void>((resolve, reject) => {
        const output = createWriteStream(dirNestedZipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve());
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);

        // Add the nested zip inside a directory
        archive.append(nestedInDirBuffer, { name: 'subdir/nested-in-dir-metadata.zip' });
        archive.append('File in outer zip', { name: 'outer-file.txt' });
        archive.finalize();
      });
    });

    describe('Simple ZIP File Tests', () => {
      it('should return all entry metadatas for a simple ZIP', async () => {
        const metadatas = await advZlib.getEntryMetadatas(simpleZipPath);
        expect(metadatas).toHaveLength(3);

        const fileNames = metadatas.map((m) => m.fileName).sort();
        expect(fileNames).toEqual(['dir/nested.txt', 'file1.txt', 'file2.txt']);
      });

      it('should return correct metadata properties', async () => {
        const metadatas = await advZlib.getEntryMetadatas(simpleZipPath);
        const file1Metadata = metadatas.find((m) => m.fileName === 'file1.txt');

        expect(file1Metadata).toBeDefined();
        expect(file1Metadata!.fileName).toBe('file1.txt');
        expect(file1Metadata!.uncompressedSize).toBe(13); // "Hello, World!"
        expect(file1Metadata!.compressedSize).toBeGreaterThan(0);
        expect(file1Metadata!.crc32).toBeGreaterThan(0);
        expect(typeof file1Metadata!.compressionMethod).toBe('number');
      });

      it('should return entries with subdirectories', async () => {
        const metadatas = await advZlib.getEntryMetadatas(simpleZipPath);
        const nestedFile = metadatas.find((m) => m.fileName === 'dir/nested.txt');

        expect(nestedFile).toBeDefined();
        expect(nestedFile!.fileName).toBe('dir/nested.txt');
        expect(nestedFile!.uncompressedSize).toBe(19); // "Nested file content"
      });

      it('should return empty array for empty ZIP', async () => {
        const metadatas = await advZlib.getEntryMetadatas(emptyZipPath);
        expect(metadatas).toEqual([]);
      });

      it('should return metadatas including folders', async () => {
        const metadatas = await advZlib.getEntryMetadatas(folderZipPath);
        expect(metadatas.length).toBeGreaterThanOrEqual(2);

        const folderEntry = metadatas.find((m) => m.fileName === 'folder/');
        expect(folderEntry).toBeDefined();
      });
    });

    describe('Non-Existent Path Tests', () => {
      it('should return empty array for non-existent ZIP file', async () => {
        const nonExistentPath = join(testDir, 'nonexistent-metadata.zip');
        const metadatas = await advZlib.getEntryMetadatas(nonExistentPath);
        expect(metadatas).toEqual([]);
      });

      it('should return empty array for empty path string', async () => {
        const metadatas = await advZlib.getEntryMetadatas('');
        expect(metadatas).toEqual([]);
      });

      it('should return empty array for path with no ZIP extension', async () => {
        const regularFilePath = join(testDir, 'regular-metadata.txt');
        await writeFile(regularFilePath, 'Regular file content');

        const metadatas = await advZlib.getEntryMetadatas(regularFilePath);
        expect(metadatas).toEqual([]);
      });

      it('should return empty array for path pointing to file inside ZIP', async () => {
        // Path points to a file inside ZIP, not the ZIP itself
        const metadatas = await advZlib.getEntryMetadatas(`${simpleZipPath}/file1.txt`);
        expect(metadatas).toEqual([]);
      });

      it('should return empty array for path pointing to folder inside ZIP', async () => {
        // Path points to a folder inside ZIP, not the ZIP itself
        const metadatas = await advZlib.getEntryMetadatas(`${folderZipPath}/folder/`);
        expect(metadatas).toEqual([]);
      });
    });

    describe('Nested ZIP Tests (2-level)', () => {
      it('should return all metadatas from nested ZIP', async () => {
        const metadatas = await advZlib.getEntryMetadatas(`${outerZipPath}/inner-metadata.zip`);
        expect(metadatas).toHaveLength(3);

        const fileNames = metadatas.map((m) => m.fileName).sort();
        expect(fileNames).toEqual(['another.txt', 'content.txt', 'subdir/deep.txt']);
      });

      it('should verify correct entry count for nested ZIP', async () => {
        const metadatas = await advZlib.getEntryMetadatas(`${outerZipPath}/inner-metadata.zip`);
        expect(metadatas.length).toBe(3);
      });

      it('should return metadata with correct properties from nested ZIP', async () => {
        const metadatas = await advZlib.getEntryMetadatas(`${outerZipPath}/inner-metadata.zip`);
        const contentFile = metadatas.find((m) => m.fileName === 'content.txt');

        expect(contentFile).toBeDefined();
        expect(contentFile!.fileName).toBe('content.txt');
        expect(contentFile!.uncompressedSize).toBe(20); // "Content in inner zip"
      });

      it('should return empty array for non-existent nested ZIP', async () => {
        const metadatas = await advZlib.getEntryMetadatas(`${outerZipPath}/nonexistent.zip`);
        expect(metadatas).toEqual([]);
      });

      it('should return entries from outer ZIP when not specifying nested ZIP', async () => {
        const metadatas = await advZlib.getEntryMetadatas(outerZipPath);
        expect(metadatas).toHaveLength(2);

        const fileNames = metadatas.map((m) => m.fileName).sort();
        expect(fileNames).toEqual(['inner-metadata.zip', 'outer-file.txt']);
      });
    });

    describe('Deeply Nested ZIP Tests (3+ levels)', () => {
      it('should return metadatas from 3-level nested ZIP', async () => {
        const metadatas = await advZlib.getEntryMetadatas(`${level1ZipPath}/level2-metadata.zip/level3-metadata.zip`);
        expect(metadatas).toHaveLength(2);

        const fileNames = metadatas.map((m) => m.fileName).sort();
        expect(fileNames).toEqual(['another-deep.txt', 'deep.txt']);
      });

      it('should return correct metadata from deeply nested file', async () => {
        const metadatas = await advZlib.getEntryMetadatas(`${level1ZipPath}/level2-metadata.zip/level3-metadata.zip`);
        const deepFile = metadatas.find((m) => m.fileName === 'deep.txt');

        expect(deepFile).toBeDefined();
        expect(deepFile!.fileName).toBe('deep.txt');
        expect(deepFile!.uncompressedSize).toBe(19); // "Deep nested content"
      });

      it('should return metadatas from second level ZIP', async () => {
        const metadatas = await advZlib.getEntryMetadatas(`${level1ZipPath}/level2-metadata.zip`);
        expect(metadatas).toHaveLength(1);
        expect(metadatas[0].fileName).toBe('level3-metadata.zip');
      });
    });

    describe('ZIP in Directory Tests (a.zip/dir/c.zip pattern)', () => {
      it('should return metadatas from ZIP inside a directory', async () => {
        const metadatas = await advZlib.getEntryMetadatas(`${dirNestedZipPath}/subdir/nested-in-dir-metadata.zip`);
        expect(metadatas).toHaveLength(2);

        const fileNames = metadatas.map((m) => m.fileName).sort();
        expect(fileNames).toEqual(['another.txt', 'file-in-nested.zip']);
      });

      it('should return correct metadata from ZIP inside directory', async () => {
        const metadatas = await advZlib.getEntryMetadatas(`${dirNestedZipPath}/subdir/nested-in-dir-metadata.zip`);
        const fileInNested = metadatas.find((m) => m.fileName === 'file-in-nested.zip');

        expect(fileInNested).toBeDefined();
        expect(fileInNested!.fileName).toBe('file-in-nested.zip');
        expect(fileInNested!.uncompressedSize).toBe(18); // "File in nested zip"
      });

      it('should return entries from outer ZIP when not specifying nested ZIP in directory', async () => {
        const metadatas = await advZlib.getEntryMetadatas(dirNestedZipPath);
        expect(metadatas).toHaveLength(2);

        const fileNames = metadatas.map((m) => m.fileName).sort();
        expect(fileNames).toEqual(['outer-file.txt', 'subdir/nested-in-dir-metadata.zip']);
      });
    });

    describe('Path Normalization Tests', () => {
      it('should handle backslashes converted to forward slashes', async () => {
        const pathWithBackslashes = simpleZipPath.replace(/\//g, '\\');
        const metadatas = await advZlib.getEntryMetadatas(pathWithBackslashes);
        expect(metadatas).toHaveLength(3);
      });

      it('should handle mixed slashes', async () => {
        const parts = simpleZipPath.split('/');
        const mixedPath = parts.slice(0, -1).join('/') + '\\' + parts[parts.length - 1];
        const metadatas = await advZlib.getEntryMetadatas(mixedPath);
        expect(metadatas).toHaveLength(3);
      });

      it('should handle nested ZIP with backslashes', async () => {
        const pathWithBackslashes = `${outerZipPath}\\inner-metadata.zip`.replace(/\//g, '\\');
        const metadatas = await advZlib.getEntryMetadatas(pathWithBackslashes);
        expect(metadatas).toHaveLength(3);
      });
    });

    describe('Error Handling & Cleanup', () => {
      it('should not throw error for corrupted path', async () => {
        const metadatas = await advZlib.getEntryMetadatas('///invalid///path///.zip');
        expect(metadatas).toEqual([]);
      });

      it('should handle path with only slashes', async () => {
        const metadatas = await advZlib.getEntryMetadatas('///');
        expect(metadatas).toEqual([]);
      });

      it('should handle non-existent parent directories', async () => {
        const nonExistentPath = join(testDir, 'nonexistent', 'test-metadata.zip');
        const metadatas = await advZlib.getEntryMetadatas(nonExistentPath);
        expect(metadatas).toEqual([]);
      });
    });

    describe('Multiple .zip Extensions in Filename Tests', () => {
      let multiZipExtOuterPath: string;
      let threeLeveMultiZipExtPath: string;

      beforeAll(async () => {
        // Create inner ZIP with multiple .zip extensions in filename
        const innerMultiZipPath = join(testDir, 'file.zip.scrambled.zip');
        await createTestZip(innerMultiZipPath, {
          'content.txt': 'Content in multi-extension zip',
          'data.txt': 'More data',
          'subfolder/nested.txt': 'Nested content',
        });

        // Create outer ZIP containing the multi-extension ZIP
        multiZipExtOuterPath = join(testDir, 'outer-multi-ext.zip');
        const innerMultiZipBuffer = await readFile(innerMultiZipPath);

        const archiver = (await import('archiver')).default;
        const { createWriteStream } = await import('node:fs');

        await new Promise<void>((resolve, reject) => {
          const output = createWriteStream(multiZipExtOuterPath);
          const archive = archiver('zip', { zlib: { level: 9 } });

          output.on('close', () => resolve());
          output.on('error', reject);
          archive.on('error', reject);
          archive.pipe(output);

          archive.append(innerMultiZipBuffer, { name: 'file.zip.scrambled.zip' });
          archive.append('Outer file', { name: 'outer.txt' });
          archive.finalize();
        });

        // Create 3-level nested structure with multiple .zip extensions
        // Level 3: innermost.zip.test.zip
        const level3MultiZipPath = join(testDir, 'innermost.zip.test.zip');
        await createTestZip(level3MultiZipPath, {
          'deep-content.txt': 'Deeply nested content',
        });

        // Level 2: middle.zip.backup.zip containing innermost.zip.test.zip
        const level2MultiZipPath = join(testDir, 'middle.zip.backup.zip');
        const level3MultiBuffer = await readFile(level3MultiZipPath);
        await new Promise<void>((resolve, reject) => {
          const output = createWriteStream(level2MultiZipPath);
          const archive = archiver('zip', { zlib: { level: 9 } });

          output.on('close', () => resolve());
          output.on('error', reject);
          archive.on('error', reject);
          archive.pipe(output);

          archive.append(level3MultiBuffer, { name: 'innermost.zip.test.zip' });
          archive.finalize();
        });

        // Level 1: outer-three-level.zip containing middle.zip.backup.zip
        threeLeveMultiZipExtPath = join(testDir, 'outer-three-level.zip');
        const level2MultiBuffer = await readFile(level2MultiZipPath);
        await new Promise<void>((resolve, reject) => {
          const output = createWriteStream(threeLeveMultiZipExtPath);
          const archive = archiver('zip', { zlib: { level: 9 } });

          output.on('close', () => resolve());
          output.on('error', reject);
          archive.on('error', reject);
          archive.pipe(output);

          archive.append(level2MultiBuffer, { name: 'middle.zip.backup.zip' });
          archive.finalize();
        });
      });

      it('should return metadatas from nested ZIP with multiple .zip extensions', async () => {
        const metadatas = await advZlib.getEntryMetadatas(`${multiZipExtOuterPath}/file.zip.scrambled.zip`);
        expect(metadatas).toHaveLength(3);

        const fileNames = metadatas.map((m) => m.fileName).sort();
        expect(fileNames).toEqual(['content.txt', 'data.txt', 'subfolder/nested.txt']);
      });

      it('should return correct metadata properties for multi-extension ZIP', async () => {
        const metadatas = await advZlib.getEntryMetadatas(`${multiZipExtOuterPath}/file.zip.scrambled.zip`);
        const contentFile = metadatas.find((m) => m.fileName === 'content.txt');

        expect(contentFile).toBeDefined();
        expect(contentFile!.fileName).toBe('content.txt');
        expect(contentFile!.uncompressedSize).toBe(30); // "Content in multi-extension zip"
      });

      it('should return metadatas from 3-level nested ZIPs with multiple .zip extensions', async () => {
        const metadatas = await advZlib.getEntryMetadatas(
          `${threeLeveMultiZipExtPath}/middle.zip.backup.zip/innermost.zip.test.zip`,
        );
        expect(metadatas).toHaveLength(1);

        const fileNames = metadatas.map((m) => m.fileName);
        expect(fileNames).toEqual(['deep-content.txt']);
      });

      it('should verify correct metadata from deeply nested multi-extension ZIP', async () => {
        const metadatas = await advZlib.getEntryMetadatas(
          `${threeLeveMultiZipExtPath}/middle.zip.backup.zip/innermost.zip.test.zip`,
        );
        const deepFile = metadatas.find((m) => m.fileName === 'deep-content.txt');

        expect(deepFile).toBeDefined();
        expect(deepFile!.fileName).toBe('deep-content.txt');
        expect(deepFile!.uncompressedSize).toBe(21); // "Deeply nested content"
      });

      it('should return metadatas from second level multi-extension ZIP', async () => {
        const metadatas = await advZlib.getEntryMetadatas(`${threeLeveMultiZipExtPath}/middle.zip.backup.zip`);
        expect(metadatas).toHaveLength(1);
        expect(metadatas[0].fileName).toBe('innermost.zip.test.zip');
      });
    });
  });

  describe('extract() method', () => {
    let extractSimpleZipPath: string;
    let extractFolderZipPath: string;
    let extractOuterZipPath: string;
    let extractLevel1ZipPath: string;
    let extractBinaryZipPath: string;
    let extractDestDir: string;

    beforeAll(async () => {
      // Create simple ZIP with files
      extractSimpleZipPath = join(testDir, 'test-extract.zip');
      await createTestZip(extractSimpleZipPath, {
        'file1.txt': 'Hello, World!',
        'file2.txt': 'This is file 2',
        'dir/nested.txt': 'Nested file content',
        'special file.txt': 'File with spaces',
      });

      // Create ZIP with folders
      extractFolderZipPath = join(testDir, 'folders-extract.zip');
      await createTestZip(extractFolderZipPath, {
        'folder/': null,
        'empty/': null,
        'folder/file.txt': 'File in folder',
        'folder/sub/deep.txt': 'Deep file',
      });

      // Create nested ZIP (outer.zip contains inner.zip)
      const innerExtractZipPath = join(testDir, 'inner-extract.zip');
      await createTestZip(innerExtractZipPath, {
        'content.txt': 'Content in inner zip',
        'another.txt': 'Another file',
        'subdir/deep.txt': 'Deep file in inner zip',
      });

      extractOuterZipPath = join(testDir, 'outer-extract.zip');
      const { readFile: rf } = await import('node:fs/promises');
      const innerZipBuffer = await rf(innerExtractZipPath);

      const archiver = (await import('archiver')).default;
      const { createWriteStream: cws } = await import('node:fs');

      await new Promise<void>((resolve, reject) => {
        const output = cws(extractOuterZipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve());
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);

        archive.append(innerZipBuffer, { name: 'inner-extract.zip' });
        archive.append('File in outer zip', { name: 'outer-file.txt' });
        archive.finalize();
      });

      // Create deeply nested ZIP (level1.zip → level2.zip → level3.zip)
      const level3ExtractZipPath = join(testDir, 'level3-extract.zip');
      await createTestZip(level3ExtractZipPath, {
        'deep.txt': 'Deep nested content',
        'another-deep.txt': 'Another deep file',
      });

      const level2ExtractZipPath = join(testDir, 'level2-extract.zip');
      const level3Buffer = await rf(level3ExtractZipPath);
      await new Promise<void>((resolve, reject) => {
        const output = cws(level2ExtractZipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve());
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);

        archive.append(level3Buffer, { name: 'level3-extract.zip' });
        archive.finalize();
      });

      extractLevel1ZipPath = join(testDir, 'level1-extract.zip');
      const level2Buffer = await rf(level2ExtractZipPath);
      await new Promise<void>((resolve, reject) => {
        const output = cws(extractLevel1ZipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve());
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);

        archive.append(level2Buffer, { name: 'level2-extract.zip' });
        archive.finalize();
      });

      // Create binary content ZIP
      extractBinaryZipPath = join(testDir, 'binary-extract.zip');
      const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG header
      await new Promise<void>((resolve, reject) => {
        const output = cws(extractBinaryZipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve());
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);

        archive.append(binaryData, { name: 'image.png' });
        archive.append(Buffer.from('text content'), { name: 'text.txt' });
        archive.finalize();
      });

      // Create extraction destination directory
      extractDestDir = join(testDir, 'extract-dest');
      await mkdir(extractDestDir, { recursive: true });
    });

    afterEach(async () => {
      // Clean up extracted files after each test
      try {
        await rm(extractDestDir, { recursive: true, force: true });
        await mkdir(extractDestDir, { recursive: true });
      } catch (error) {
        // Ignore cleanup errors
      }
    });

    describe('Simple File Extraction Tests', () => {
      it('should extract single file from root of ZIP', async () => {
        const dest = join(extractDestDir, 'single-file');
        await mkdir(dest, { recursive: true });

        await advZlib.extract(`${extractSimpleZipPath}/file1.txt`, dest);

        const extractedPath = join(dest, 'file1.txt');
        const content = await readFile(extractedPath, 'utf-8');
        expect(content).toBe('Hello, World!');
      });

      it('should extract file from subdirectory', async () => {
        const dest = join(extractDestDir, 'subdir-file');
        await mkdir(dest, { recursive: true });

        await advZlib.extract(`${extractSimpleZipPath}/dir/nested.txt`, dest);

        const extractedPath = join(dest, 'dir/nested.txt');
        const content = await readFile(extractedPath, 'utf-8');
        expect(content).toBe('Nested file content');
      });

      it('should extract entire ZIP contents (empty innerPath)', async () => {
        const dest = join(extractDestDir, 'entire-zip');
        await mkdir(dest, { recursive: true });

        await advZlib.extract(extractSimpleZipPath, dest);

        // Verify all files are extracted
        const file1 = await readFile(join(dest, 'file1.txt'), 'utf-8');
        const file2 = await readFile(join(dest, 'file2.txt'), 'utf-8');
        const nested = await readFile(join(dest, 'dir/nested.txt'), 'utf-8');
        const special = await readFile(join(dest, 'special file.txt'), 'utf-8');

        expect(file1).toBe('Hello, World!');
        expect(file2).toBe('This is file 2');
        expect(nested).toBe('Nested file content');
        expect(special).toBe('File with spaces');
      });

      it('should extract file with special characters in name', async () => {
        const dest = join(extractDestDir, 'special-chars');
        await mkdir(dest, { recursive: true });

        await advZlib.extract(`${extractSimpleZipPath}/special file.txt`, dest);

        const extractedPath = join(dest, 'special file.txt');
        const content = await readFile(extractedPath, 'utf-8');
        expect(content).toBe('File with spaces');
      });
    });

    describe('Nested ZIP Extraction Tests (2-level)', () => {
      it('should extract file from nested ZIP', async () => {
        const dest = join(extractDestDir, 'nested-file');
        await mkdir(dest, { recursive: true });

        await advZlib.extract(`${extractOuterZipPath}/inner-extract.zip/content.txt`, dest);

        const extractedPath = join(dest, 'content.txt');
        const content = await readFile(extractedPath, 'utf-8');
        expect(content).toBe('Content in inner zip');
      });

      it('should extract entire nested ZIP', async () => {
        const dest = join(extractDestDir, 'entire-nested');
        await mkdir(dest, { recursive: true });

        await advZlib.extract(`${extractOuterZipPath}/inner-extract.zip`, dest);

        // Verify all files from inner ZIP are extracted
        const content = await readFile(join(dest, 'content.txt'), 'utf-8');
        const another = await readFile(join(dest, 'another.txt'), 'utf-8');
        const deep = await readFile(join(dest, 'subdir/deep.txt'), 'utf-8');

        expect(content).toBe('Content in inner zip');
        expect(another).toBe('Another file');
        expect(deep).toBe('Deep file in inner zip');
      });

      it('should extract multiple files from nested ZIP sequentially', async () => {
        const dest1 = join(extractDestDir, 'nested-multi-1');
        const dest2 = join(extractDestDir, 'nested-multi-2');
        await mkdir(dest1, { recursive: true });
        await mkdir(dest2, { recursive: true });

        await advZlib.extract(`${extractOuterZipPath}/inner-extract.zip/content.txt`, dest1);
        await advZlib.extract(`${extractOuterZipPath}/inner-extract.zip/another.txt`, dest2);

        const content1 = await readFile(join(dest1, 'content.txt'), 'utf-8');
        const content2 = await readFile(join(dest2, 'another.txt'), 'utf-8');

        expect(content1).toBe('Content in inner zip');
        expect(content2).toBe('Another file');
      });

      it('should extract file from outer ZIP', async () => {
        const dest = join(extractDestDir, 'outer-file');
        await mkdir(dest, { recursive: true });

        await advZlib.extract(`${extractOuterZipPath}/outer-file.txt`, dest);

        const extractedPath = join(dest, 'outer-file.txt');
        const content = await readFile(extractedPath, 'utf-8');
        expect(content).toBe('File in outer zip');
      });
    });

    describe('Deeply Nested ZIP Tests (3+ levels)', () => {
      it('should extract file from 3-level nested ZIP', async () => {
        const dest = join(extractDestDir, 'deep-nested');
        await mkdir(dest, { recursive: true });

        await advZlib.extract(`${extractLevel1ZipPath}/level2-extract.zip/level3-extract.zip/deep.txt`, dest);

        const extractedPath = join(dest, 'deep.txt');
        const content = await readFile(extractedPath, 'utf-8');
        expect(content).toBe('Deep nested content');
      });

      it('should extract entire 3-level nested ZIP', async () => {
        const dest = join(extractDestDir, 'entire-deep-nested');
        await mkdir(dest, { recursive: true });

        await advZlib.extract(`${extractLevel1ZipPath}/level2-extract.zip/level3-extract.zip`, dest);

        const deep = await readFile(join(dest, 'deep.txt'), 'utf-8');
        const anotherDeep = await readFile(join(dest, 'another-deep.txt'), 'utf-8');

        expect(deep).toBe('Deep nested content');
        expect(anotherDeep).toBe('Another deep file');
      });
    });

    describe('Path Normalization Tests', () => {
      it('should extract with backslashes in path', async () => {
        const dest = join(extractDestDir, 'backslash-path');
        await mkdir(dest, { recursive: true });

        const pathWithBackslashes = extractSimpleZipPath.replace(/\//g, '\\') + '\\file1.txt';
        await advZlib.extract(pathWithBackslashes, dest);

        const extractedPath = join(dest, 'file1.txt');
        const content = await readFile(extractedPath, 'utf-8');
        expect(content).toBe('Hello, World!');
      });

      it('should extract with mixed slashes', async () => {
        const dest = join(extractDestDir, 'mixed-slash-path');
        await mkdir(dest, { recursive: true });

        const parts = extractSimpleZipPath.split('/');
        const mixedPath = parts.slice(0, -1).join('/') + '\\' + parts[parts.length - 1] + '\\file2.txt';
        await advZlib.extract(mixedPath, dest);

        const extractedPath = join(dest, 'file2.txt');
        const content = await readFile(extractedPath, 'utf-8');
        expect(content).toBe('This is file 2');
      });
    });

    describe('Error Handling & Edge Cases', () => {
      it('should throw error for non-existent ZIP file', async () => {
        const dest = join(extractDestDir, 'nonexistent-zip');
        await mkdir(dest, { recursive: true });

        const nonExistentPath = join(testDir, 'nonexistent.zip');
        await expect(advZlib.extract(nonExistentPath, dest)).rejects.toThrow();
      });

      it('should throw error for non-existent entry in ZIP', async () => {
        const dest = join(extractDestDir, 'nonexistent-entry');
        await mkdir(dest, { recursive: true });

        await expect(advZlib.extract(`${extractSimpleZipPath}/nonexistent.txt`, dest)).rejects.toThrow(/not found/);
      });

      it('should throw error with invalid source path (empty string)', async () => {
        const dest = join(extractDestDir, 'invalid-source');
        await mkdir(dest, { recursive: true });

        await expect(advZlib.extract('', dest)).rejects.toThrow(/Invalid source path/);
      });

      it('should handle destination file already exists (overwrite)', async () => {
        const dest = join(extractDestDir, 'overwrite');
        await mkdir(dest, { recursive: true });

        // First extraction
        await advZlib.extract(`${extractSimpleZipPath}/file1.txt`, dest);
        const firstContent = await readFile(join(dest, 'file1.txt'), 'utf-8');
        expect(firstContent).toBe('Hello, World!');

        // Second extraction (should overwrite)
        await advZlib.extract(`${extractSimpleZipPath}/file1.txt`, dest);
        const secondContent = await readFile(join(dest, 'file1.txt'), 'utf-8');
        expect(secondContent).toBe('Hello, World!');
      });
    });

    describe('Cleanup Tests', () => {
      it('should cleanup temp files after successful extraction', async () => {
        const dest = join(extractDestDir, 'cleanup-success');
        await mkdir(dest, { recursive: true });

        // Count temp files before
        const tempDir = tmpdir();
        const beforeFiles = readdirSync(tempDir).filter((f) => f.startsWith('temp-'));

        // Perform nested extraction (creates temp files)
        await advZlib.extract(`${extractOuterZipPath}/inner-extract.zip/content.txt`, dest);

        // Count temp files after
        const afterFiles = readdirSync(tempDir).filter((f) => f.startsWith('temp-'));

        // Temp files should be cleaned up
        expect(afterFiles.length).toBe(beforeFiles.length);
      });

      it('should cleanup temp files after failed extraction', async () => {
        const dest = join(extractDestDir, 'cleanup-failure');
        await mkdir(dest, { recursive: true });

        // Count temp files before
        const tempDir = tmpdir();
        const beforeFiles = readdirSync(tempDir).filter((f) => f.startsWith('temp-'));

        // Perform extraction that will fail
        try {
          await advZlib.extract(`${extractOuterZipPath}/inner-extract.zip/nonexistent.txt`, dest);
        } catch (error) {
          // Expected to fail
        }

        // Count temp files after
        const afterFiles = readdirSync(tempDir).filter((f) => f.startsWith('temp-'));

        // Temp files should still be cleaned up even after failure
        expect(afterFiles.length).toBe(beforeFiles.length);
      });
    });

    describe('Content Verification Tests', () => {
      it('should extract and verify file content matches original', async () => {
        const dest = join(extractDestDir, 'content-verify');
        await mkdir(dest, { recursive: true });

        await advZlib.extract(`${extractSimpleZipPath}/file1.txt`, dest);

        const extractedContent = await readFile(join(dest, 'file1.txt'), 'utf-8');
        expect(extractedContent).toBe('Hello, World!');
      });

      it('should extract and verify file size', async () => {
        const dest = join(extractDestDir, 'size-verify');
        await mkdir(dest, { recursive: true });

        await advZlib.extract(`${extractSimpleZipPath}/file2.txt`, dest);

        const stats = await stat(join(dest, 'file2.txt'));
        expect(stats.size).toBe('This is file 2'.length);
      });

      it('should extract binary files correctly', async () => {
        const dest = join(extractDestDir, 'binary-verify');
        await mkdir(dest, { recursive: true });

        await advZlib.extract(`${extractBinaryZipPath}/image.png`, dest);

        const extractedData = await readFile(join(dest, 'image.png'));
        const expected = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        expect(extractedData.equals(expected)).toBe(true);
      });

      it('should extract entire binary ZIP correctly', async () => {
        const dest = join(extractDestDir, 'binary-entire');
        await mkdir(dest, { recursive: true });

        await advZlib.extract(extractBinaryZipPath, dest);

        const imageData = await readFile(join(dest, 'image.png'));
        const textData = await readFile(join(dest, 'text.txt'), 'utf-8');

        const expectedImage = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        expect(imageData.equals(expectedImage)).toBe(true);
        expect(textData).toBe('text content');
      });
    });
  });

  describe('extract() method with noFolders option', () => {
    let noFoldersSimpleZipPath: string;
    let noFoldersOuterZipPath: string;
    let noFoldersFolderZipPath: string;
    let noFoldersDestDir: string;

    beforeAll(async () => {
      // Create simple ZIP with files in folders
      noFoldersSimpleZipPath = join(testDir, 'test-nofolders.zip');
      await createTestZip(noFoldersSimpleZipPath, {
        'file1.txt': 'Root file',
        'folder1/file2.txt': 'File in folder1',
        'folder1/folder2/file3.txt': 'File in nested folders',
        'deep/nested/structure/file4.txt': 'Deeply nested file',
      });

      // Create ZIP with folder entry
      noFoldersFolderZipPath = join(testDir, 'test-nofolders-folder.zip');
      await createTestZip(noFoldersFolderZipPath, {
        'myfolder/': null,
        'myfolder/file.txt': 'File in folder',
      });

      // Create nested ZIP for testing noFolders with nested ZIPs
      const innerNoFoldersZipPath = join(testDir, 'inner-nofolders.zip');
      await createTestZip(innerNoFoldersZipPath, {
        'inner-folder/content.txt': 'Content in inner folder',
        'another-folder/deep/file.txt': 'Deep file in inner',
      });

      noFoldersOuterZipPath = join(testDir, 'outer-nofolders.zip');
      const { readFile: rf } = await import('node:fs/promises');
      const innerZipBuffer = await rf(innerNoFoldersZipPath);

      const archiver = (await import('archiver')).default;
      const { createWriteStream: cws } = await import('node:fs');

      await new Promise<void>((resolve, reject) => {
        const output = cws(noFoldersOuterZipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve());
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);

        archive.append(innerZipBuffer, { name: 'nested/inner-nofolders.zip' });
        archive.append('Outer file', { name: 'outer.txt' });
        archive.finalize();
      });

      // Create destination directory
      noFoldersDestDir = join(testDir, 'nofolders-dest');
      await mkdir(noFoldersDestDir, { recursive: true });
    });

    afterEach(async () => {
      // Clean up extracted files after each test
      try {
        await rm(noFoldersDestDir, { recursive: true, force: true });
        await mkdir(noFoldersDestDir, { recursive: true });
      } catch (error) {
        // Ignore cleanup errors
      }
    });

    describe('Basic noFolders Functionality', () => {
      it('should extract file from folder without creating folder structure', async () => {
        const dest = join(noFoldersDestDir, 'basic');
        await mkdir(dest, { recursive: true });

        await advZlib.extract(`${noFoldersSimpleZipPath}/folder1/file2.txt`, dest, { noFolders: true });

        // File should be at dest/file2.txt, not dest/folder1/file2.txt
        const extractedPath = join(dest, 'file2.txt');
        const content = await readFile(extractedPath, 'utf-8');
        expect(content).toBe('File in folder1');

        // Verify folder was not created
        const folderPath = join(dest, 'folder1');
        await expect(stat(folderPath)).rejects.toThrow();
      });

      it('should extract file from nested folders without creating folder structure', async () => {
        const dest = join(noFoldersDestDir, 'nested-folders');
        await mkdir(dest, { recursive: true });

        await advZlib.extract(`${noFoldersSimpleZipPath}/folder1/folder2/file3.txt`, dest, { noFolders: true });

        // File should be at dest/file3.txt
        const extractedPath = join(dest, 'file3.txt');
        const content = await readFile(extractedPath, 'utf-8');
        expect(content).toBe('File in nested folders');

        // Verify folders were not created
        const folder1Path = join(dest, 'folder1');
        await expect(stat(folder1Path)).rejects.toThrow();
      });

      it('should extract file from deeply nested structure', async () => {
        const dest = join(noFoldersDestDir, 'deep');
        await mkdir(dest, { recursive: true });

        await advZlib.extract(`${noFoldersSimpleZipPath}/deep/nested/structure/file4.txt`, dest, { noFolders: true });

        // File should be at dest/file4.txt
        const extractedPath = join(dest, 'file4.txt');
        const content = await readFile(extractedPath, 'utf-8');
        expect(content).toBe('Deeply nested file');
      });

      it('should work with file at root level (no folders to strip)', async () => {
        const dest = join(noFoldersDestDir, 'root-file');
        await mkdir(dest, { recursive: true });

        await advZlib.extract(`${noFoldersSimpleZipPath}/file1.txt`, dest, { noFolders: true });

        const extractedPath = join(dest, 'file1.txt');
        const content = await readFile(extractedPath, 'utf-8');
        expect(content).toBe('Root file');
      });
    });

    describe('noFolders with Nested ZIPs', () => {
      it('should extract file from nested ZIP without folder structure', async () => {
        const dest = join(noFoldersDestDir, 'nested-zip');
        await mkdir(dest, { recursive: true });

        await advZlib.extract(`${noFoldersOuterZipPath}/nested/inner-nofolders.zip/inner-folder/content.txt`, dest, {
          noFolders: true,
        });

        // File should be at dest/content.txt
        const extractedPath = join(dest, 'content.txt');
        const content = await readFile(extractedPath, 'utf-8');
        expect(content).toBe('Content in inner folder');
      });

      it('should extract deeply nested file from nested ZIP', async () => {
        const dest = join(noFoldersDestDir, 'nested-zip-deep');
        await mkdir(dest, { recursive: true });

        await advZlib.extract(
          `${noFoldersOuterZipPath}/nested/inner-nofolders.zip/another-folder/deep/file.txt`,
          dest,
          { noFolders: true },
        );

        // File should be at dest/file.txt
        const extractedPath = join(dest, 'file.txt');
        const content = await readFile(extractedPath, 'utf-8');
        expect(content).toBe('Deep file in inner');
      });
    });

    describe('Default Behavior (noFolders: false or undefined)', () => {
      it('should preserve folder structure when noFolders is false', async () => {
        const dest = join(noFoldersDestDir, 'preserve-false');
        await mkdir(dest, { recursive: true });

        await advZlib.extract(`${noFoldersSimpleZipPath}/folder1/file2.txt`, dest, { noFolders: false });

        // File should be at dest/folder1/file2.txt
        const extractedPath = join(dest, 'folder1', 'file2.txt');
        const content = await readFile(extractedPath, 'utf-8');
        expect(content).toBe('File in folder1');
      });

      it('should preserve folder structure when options is undefined', async () => {
        const dest = join(noFoldersDestDir, 'preserve-undefined');
        await mkdir(dest, { recursive: true });

        await advZlib.extract(`${noFoldersSimpleZipPath}/folder1/folder2/file3.txt`, dest);

        // File should be at dest/folder1/folder2/file3.txt
        const extractedPath = join(dest, 'folder1', 'folder2', 'file3.txt');
        const content = await readFile(extractedPath, 'utf-8');
        expect(content).toBe('File in nested folders');
      });

      it('should preserve folder structure when options object is empty', async () => {
        const dest = join(noFoldersDestDir, 'preserve-empty');
        await mkdir(dest, { recursive: true });

        await advZlib.extract(`${noFoldersSimpleZipPath}/folder1/file2.txt`, dest, {});

        // File should be at dest/folder1/file2.txt
        const extractedPath = join(dest, 'folder1', 'file2.txt');
        const content = await readFile(extractedPath, 'utf-8');
        expect(content).toBe('File in folder1');
      });
    });

    describe('Error Cases', () => {
      it('should throw error when using noFolders with entire ZIP extraction', async () => {
        const dest = join(noFoldersDestDir, 'error-entire');
        await mkdir(dest, { recursive: true });

        await expect(advZlib.extract(noFoldersSimpleZipPath, dest, { noFolders: true })).rejects.toThrow(
          /noFolders option cannot be used when extracting entire ZIP contents/,
        );
      });

      it('should throw error when using noFolders with folder entry', async () => {
        const dest = join(noFoldersDestDir, 'error-folder');
        await mkdir(dest, { recursive: true });

        await expect(advZlib.extract(`${noFoldersFolderZipPath}/myfolder/`, dest, { noFolders: true })).rejects.toThrow(
          /noFolders option cannot be used when extracting folder entries/,
        );
      });
    });

    describe('Content Verification', () => {
      it('should extract correct content with noFolders option', async () => {
        const dest = join(noFoldersDestDir, 'content-verify');
        await mkdir(dest, { recursive: true });

        await advZlib.extract(`${noFoldersSimpleZipPath}/folder1/file2.txt`, dest, { noFolders: true });

        const extractedPath = join(dest, 'file2.txt');
        const content = await readFile(extractedPath, 'utf-8');
        expect(content).toBe('File in folder1');

        const stats = await stat(extractedPath);
        expect(stats.size).toBe('File in folder1'.length);
      });

      it('should handle multiple extractions with noFolders', async () => {
        const dest1 = join(noFoldersDestDir, 'multi-1');
        const dest2 = join(noFoldersDestDir, 'multi-2');
        await mkdir(dest1, { recursive: true });
        await mkdir(dest2, { recursive: true });

        await advZlib.extract(`${noFoldersSimpleZipPath}/folder1/file2.txt`, dest1, { noFolders: true });
        await advZlib.extract(`${noFoldersSimpleZipPath}/folder1/folder2/file3.txt`, dest2, { noFolders: true });

        const content1 = await readFile(join(dest1, 'file2.txt'), 'utf-8');
        const content2 = await readFile(join(dest2, 'file3.txt'), 'utf-8');

        expect(content1).toBe('File in folder1');
        expect(content2).toBe('File in nested folders');
      });
    });
  });

  describe('read() method', () => {
    let readSimpleZipPath: string;
    let readOuterZipPath: string;
    let readLevel1ZipPath: string;
    let readBinaryZipPath: string;
    let readMultilineZipPath: string;

    beforeAll(async () => {
      // Create simple ZIP with text files
      readSimpleZipPath = join(testDir, 'test-read.zip');
      await createTestZip(readSimpleZipPath, {
        'file1.txt': 'Hello, World!',
        'file2.txt': 'This is file 2',
        'dir/nested.txt': 'Nested file content',
        'special file.txt': 'File with spaces',
        'empty.txt': '',
      });

      // Create nested ZIP (outer.zip contains inner.zip)
      const innerReadZipPath = join(testDir, 'inner-read.zip');
      await createTestZip(innerReadZipPath, {
        'content.txt': 'Content in inner zip',
        'another.txt': 'Another file',
        'subdir/deep.txt': 'Deep file in inner zip',
      });

      readOuterZipPath = join(testDir, 'outer-read.zip');
      const { readFile: rf } = await import('node:fs/promises');
      const innerZipBuffer = await rf(innerReadZipPath);

      const archiver = (await import('archiver')).default;
      const { createWriteStream: cws } = await import('node:fs');

      await new Promise<void>((resolve, reject) => {
        const output = cws(readOuterZipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve());
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);

        archive.append(innerZipBuffer, { name: 'inner-read.zip' });
        archive.append('File in outer zip', { name: 'outer-file.txt' });
        archive.finalize();
      });

      // Create deeply nested ZIP (level1.zip → level2.zip → level3.zip)
      const level3ReadZipPath = join(testDir, 'level3-read.zip');
      await createTestZip(level3ReadZipPath, {
        'deep.txt': 'Deep nested content',
        'another-deep.txt': 'Another deep file',
      });

      const level2ReadZipPath = join(testDir, 'level2-read.zip');
      const level3Buffer = await rf(level3ReadZipPath);
      await new Promise<void>((resolve, reject) => {
        const output = cws(level2ReadZipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve());
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);

        archive.append(level3Buffer, { name: 'level3-read.zip' });
        archive.finalize();
      });

      readLevel1ZipPath = join(testDir, 'level1-read.zip');
      const level2Buffer = await rf(level2ReadZipPath);
      await new Promise<void>((resolve, reject) => {
        const output = cws(readLevel1ZipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve());
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);

        archive.append(level2Buffer, { name: 'level2-read.zip' });
        archive.finalize();
      });

      // Create binary content ZIP
      readBinaryZipPath = join(testDir, 'binary-read.zip');
      const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG header
      await new Promise<void>((resolve, reject) => {
        const output = cws(readBinaryZipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve());
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);

        archive.append(binaryData, { name: 'image.png' });
        archive.append(Buffer.from('text content'), { name: 'text.txt' });
        archive.finalize();
      });

      // Create multiline content ZIP
      readMultilineZipPath = join(testDir, 'multiline-read.zip');
      await createTestZip(readMultilineZipPath, {
        'multiline.txt': 'Line 1\nLine 2\nLine 3\nLine 4',
        'unicode.txt': 'Hello 世界 🌍',
      });
    });

    describe('Simple File Reading Tests', () => {
      it('should read file from root of ZIP', async () => {
        const content = await advZlib.read(`${readSimpleZipPath}/file1.txt`);
        expect(content.toString('utf-8')).toBe('Hello, World!');
      });

      it('should read file from subdirectory within ZIP', async () => {
        const content = await advZlib.read(`${readSimpleZipPath}/dir/nested.txt`);
        expect(content.toString('utf-8')).toBe('Nested file content');
      });

      it('should read multiple files sequentially', async () => {
        const content1 = await advZlib.read(`${readSimpleZipPath}/file1.txt`);
        const content2 = await advZlib.read(`${readSimpleZipPath}/file2.txt`);

        expect(content1.toString('utf-8')).toBe('Hello, World!');
        expect(content2.toString('utf-8')).toBe('This is file 2');
      });

      it('should read file with special characters in name', async () => {
        const content = await advZlib.read(`${readSimpleZipPath}/special file.txt`);
        expect(content.toString('utf-8')).toBe('File with spaces');
      });

      it('should read empty text file', async () => {
        const content = await advZlib.read(`${readSimpleZipPath}/empty.txt`);
        expect(content.toString('utf-8')).toBe('');
      });
    });

    describe('Nested ZIP Tests (2-level)', () => {
      it('should read file from nested ZIP', async () => {
        const content = await advZlib.read(`${readOuterZipPath}/inner-read.zip/content.txt`);
        expect(content.toString('utf-8')).toBe('Content in inner zip');
      });

      it('should read multiple files from same nested ZIP', async () => {
        const content1 = await advZlib.read(`${readOuterZipPath}/inner-read.zip/content.txt`);
        const content2 = await advZlib.read(`${readOuterZipPath}/inner-read.zip/another.txt`);

        expect(content1.toString('utf-8')).toBe('Content in inner zip');
        expect(content2.toString('utf-8')).toBe('Another file');
      });

      it('should read from outer and inner ZIPs in sequence', async () => {
        const outerContent = await advZlib.read(`${readOuterZipPath}/outer-file.txt`);
        const innerContent = await advZlib.read(`${readOuterZipPath}/inner-read.zip/content.txt`);

        expect(outerContent.toString('utf-8')).toBe('File in outer zip');
        expect(innerContent.toString('utf-8')).toBe('Content in inner zip');
      });

      it('should read file from subdirectory in nested ZIP', async () => {
        const content = await advZlib.read(`${readOuterZipPath}/inner-read.zip/subdir/deep.txt`);
        expect(content.toString('utf-8')).toBe('Deep file in inner zip');
      });

      it('should read deflated file from 2-level nested ZIP (tests stream error handling fix)', async () => {
        // This test specifically targets the bug fix for reading deflated files from nested ZIPs.
        // The legacy code using 'for await' would hang when reading deflated files due to
        // improper error propagation in piped streams. This test verifies the fix works.
        // All files created by createTestZip are deflated (compression method 8) by default.
        const content = await advZlib.read(`${readOuterZipPath}/inner-read.zip/content.txt`);
        expect(content.toString('utf-8')).toBe('Content in inner zip');
        expect(Buffer.isBuffer(content)).toBe(true);
        expect(content.length).toBeGreaterThan(0);
      });
    });

    describe('Deeply Nested ZIP Tests (3+ levels)', () => {
      it('should read file from 3-level nested ZIP', async () => {
        const content = await advZlib.read(`${readLevel1ZipPath}/level2-read.zip/level3-read.zip/deep.txt`);
        expect(content.toString('utf-8')).toBe('Deep nested content');
      });

      it('should verify content correctness from deeply nested file', async () => {
        const content = await advZlib.read(`${readLevel1ZipPath}/level2-read.zip/level3-read.zip/another-deep.txt`);
        expect(content.toString('utf-8')).toBe('Another deep file');
      });

      it('should read deflated file from 3-level nested ZIP (tests stream error handling)', async () => {
        // This test specifically targets the bug where reading deflated files from nested ZIPs
        // would hang due to improper error handling in piped streams with for-await loops.
        // The file is deflated (compression method 8) and nested 3 levels deep.
        const content = await advZlib.read(`${readLevel1ZipPath}/level2-read.zip/level3-read.zip/deep.txt`);
        expect(content.toString('utf-8')).toBe('Deep nested content');
        expect(content.length).toBeGreaterThan(0);
      });
    });

    describe('Error Handling Tests', () => {
      it('should throw error for non-existent ZIP file', async () => {
        const nonExistentPath = join(testDir, 'nonexistent-read.zip');
        await expect(advZlib.read(`${nonExistentPath}/file.txt`)).rejects.toThrow(/does not exist/);
      });

      it('should throw error for non-existent file within ZIP', async () => {
        await expect(advZlib.read(`${readSimpleZipPath}/nonexistent.txt`)).rejects.toThrow(/not found/);
      });

      it('should throw error when pointing to ZIP itself (empty innerPath)', async () => {
        await expect(advZlib.read(readSimpleZipPath)).rejects.toThrow(/Cannot read ZIP file itself/);
      });

      it('should throw error when pointing to another nested ZIP file', async () => {
        await expect(advZlib.read(`${readOuterZipPath}/inner-read.zip`)).rejects.toThrow(/Cannot read ZIP file itself/);
      });

      it('should read binary files as Buffer', async () => {
        const content = await advZlib.read(`${readBinaryZipPath}/image.png`);
        expect(Buffer.isBuffer(content)).toBe(true);
        const expected = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        expect(content.equals(expected)).toBe(true);
      });

      it('should throw error for empty path string', async () => {
        await expect(advZlib.read('')).rejects.toThrow(/Invalid file path/);
      });

      it('should throw error for invalid source path', async () => {
        await expect(advZlib.read('/invalid/path.zip/file.txt')).rejects.toThrow(/does not exist/);
      });

      it('should throw error for path with no ZIP extension', async () => {
        const regularFilePath = join(testDir, 'regular-read.txt');
        await writeFile(regularFilePath, 'Regular file content');

        await expect(advZlib.read(regularFilePath)).rejects.toThrow(/Invalid file path/);
      });
    });

    describe('Path Normalization Tests', () => {
      it('should handle backslashes converted to forward slashes', async () => {
        const pathWithBackslashes = readSimpleZipPath.replace(/\//g, '\\') + '\\file1.txt';
        const content = await advZlib.read(pathWithBackslashes);
        expect(content.toString('utf-8')).toBe('Hello, World!');
      });

      it('should handle mixed slashes', async () => {
        const parts = readSimpleZipPath.split('/');
        const mixedPath = parts.slice(0, -1).join('/') + '\\' + parts[parts.length - 1] + '\\file2.txt';
        const content = await advZlib.read(mixedPath);
        expect(content.toString('utf-8')).toBe('This is file 2');
      });

      it('should handle nested ZIP paths with backslashes', async () => {
        const pathWithBackslashes = `${readOuterZipPath}\\inner-read.zip\\content.txt`.replace(/\//g, '\\');
        const content = await advZlib.read(pathWithBackslashes);
        expect(content.toString('utf-8')).toBe('Content in inner zip');
      });
    });

    describe('Content Verification Tests', () => {
      it('should verify exact content matches', async () => {
        const content = await advZlib.read(`${readSimpleZipPath}/file1.txt`);
        expect(content.toString('utf-8')).toBe('Hello, World!');
        expect(content.length).toBe(13);
      });

      it('should verify content length', async () => {
        const content = await advZlib.read(`${readSimpleZipPath}/file2.txt`);
        expect(content.length).toBe('This is file 2'.length);
      });

      it('should read files with multi-line content', async () => {
        const content = await advZlib.read(`${readMultilineZipPath}/multiline.txt`);
        expect(content.toString('utf-8')).toBe('Line 1\nLine 2\nLine 3\nLine 4');
        expect(content.toString('utf-8').split('\n')).toHaveLength(4);
      });

      it('should read files with Unicode characters', async () => {
        const content = await advZlib.read(`${readMultilineZipPath}/unicode.txt`);
        expect(content.toString('utf-8')).toBe('Hello 世界 🌍');
      });

      it('should read text file from binary ZIP', async () => {
        const content = await advZlib.read(`${readBinaryZipPath}/text.txt`);
        expect(content.toString('utf-8')).toBe('text content');
      });
    });

    describe('Cleanup Tests', () => {
      it('should cleanup temp files after successful read', async () => {
        // Count temp files before
        const tempDir = tmpdir();
        const beforeFiles = readdirSync(tempDir).filter((f) => f.startsWith('temp-'));

        // Perform nested read (creates temp files)
        const content = await advZlib.read(`${readOuterZipPath}/inner-read.zip/content.txt`);
        expect(content.toString('utf-8')).toBe('Content in inner zip');

        // Count temp files after
        const afterFiles = readdirSync(tempDir).filter((f) => f.startsWith('temp-'));

        // Temp files should be cleaned up
        expect(afterFiles.length).toBe(beforeFiles.length);
      });

      it('should cleanup temp files after failed read', async () => {
        // Count temp files before
        const tempDir = tmpdir();
        const beforeFiles = readdirSync(tempDir).filter((f) => f.startsWith('temp-'));

        // Perform read that will fail
        try {
          await advZlib.read(`${readOuterZipPath}/inner-read.zip/nonexistent.txt`);
        } catch (error) {
          // Expected to fail
        }

        // Count temp files after
        const afterFiles = readdirSync(tempDir).filter((f) => f.startsWith('temp-'));

        // Temp files should still be cleaned up even after failure
        expect(afterFiles.length).toBe(beforeFiles.length);
      });

      it('should cleanup temp files from deeply nested read', async () => {
        // Count temp files before
        const tempDir = tmpdir();
        const beforeFiles = readdirSync(tempDir).filter((f) => f.startsWith('temp-'));

        // Perform deeply nested read (creates multiple temp files)
        const content = await advZlib.read(`${readLevel1ZipPath}/level2-read.zip/level3-read.zip/deep.txt`);
        expect(content.toString('utf-8')).toBe('Deep nested content');

        // Count temp files after
        const afterFiles = readdirSync(tempDir).filter((f) => f.startsWith('temp-'));

        // All temp files should be cleaned up
        expect(afterFiles.length).toBe(beforeFiles.length);
      });
    });
  });
});
