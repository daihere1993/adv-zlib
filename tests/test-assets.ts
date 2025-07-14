import { promises as fs, createWriteStream } from 'fs';
import { join } from 'path';
import archiver from 'archiver';
import { randomBytes, pbkdf2Sync, createCipheriv, createHmac } from 'crypto';
// Simple logging functions for test asset creation
const debug = (msg: string) => process.env.TEST_VERBOSE && console.debug(`[DEBUG] ${msg}`);
const info = (msg: string) => console.info(`[INFO] ${msg}`);
const warn = (msg: string) => console.warn(`[WARN] ${msg}`);
const logError = (msg: string, ...args: any[]) => console.error(`[ERROR] ${msg}`, ...args);

// ===== BASIC TEST ASSETS =====
// These are lightweight assets for functional and backwards compatibility testing
// They focus on correctness, edge cases, and API compatibility rather than performance

export interface BasicTestAssets {
  simpleText: string;        // Simple ZIP with text files
  binaryFiles: string;       // ZIP with binary content (PNG, etc.)
  withDirectories: string;   // ZIP with directory structure
  nested: string;            // ZIP containing another ZIP (basic nesting)
  empty: string;             // Empty ZIP file
  unusualNames: string;      // ZIP with unusual filenames (spaces, unicode, etc.)
}

// ===== PERFORMANCE TEST ASSETS =====
// These are specialized assets for performance testing and benchmarking
// They focus on stress testing, large data, and performance characteristics

export interface PerformanceTestAssets {
  large: string;             // ZIP with larger files (~100KB files, many entries)
  compressed: string;        // ZIP with deflated compression (high compression ratio)
  uncompressed: string;      // ZIP with stored files (no compression)
  deepNested: string;        // ZIP with 3-level nesting (performance stress test)
  manyEntries: string;       // ZIP with 40,000 entries (stress test)
  largeNestedZip: string;    // ZIP with large nested ZIP entry (~2GB decompressed)
}

// ===== COMBINED INTERFACE =====
// For tests that need both basic and performance assets
export interface TestAssets extends BasicTestAssets, PerformanceTestAssets {}

/**
 * Creates basic test ZIP files for functional and backwards compatibility testing.
 * These are lightweight and quick to create, focusing on correctness over performance.
 * 
 * Use these for:
 * - Backwards compatibility tests
 * - API correctness tests
 * - Edge case testing
 * - Functional validation
 */
export async function createBasicTestZipFiles(assetsDir: string): Promise<BasicTestAssets> {
  const basicAssets: BasicTestAssets = {
    simpleText: join(assetsDir, 'simple-text.zip'),
    binaryFiles: join(assetsDir, 'binary-files.zip'),
    withDirectories: join(assetsDir, 'with-directories.zip'),
    nested: join(assetsDir, 'nested-zips.zip'),
    empty: join(assetsDir, 'empty.zip'),
    unusualNames: join(assetsDir, 'unusual-names.zip'),
  };

  info('Creating basic test assets for functional testing...');

  // Create basic test ZIP files in parallel
  const zipCreationPromises = [
    createSimpleTextZip(basicAssets.simpleText),
    createBinaryFilesZip(basicAssets.binaryFiles),
    createDirectoriesZip(basicAssets.withDirectories),
    createBasicNestedZip(basicAssets.nested, assetsDir),
    createEmptyZip(basicAssets.empty),
    createUnusualNamesZip(basicAssets.unusualNames),
  ];

  await Promise.all(zipCreationPromises);
  info('Basic test assets created successfully');

  return basicAssets;
}

/**
 * Creates performance test ZIP files for performance comparison and benchmarking.
 * These may be larger and take longer to create, focusing on performance characteristics.
 * 
 * Use these for:
 * - Performance comparison tests
 * - Stress testing
 * - Cache effectiveness testing
 * - Large data handling
 * - Throughput benchmarks
 */
export async function createPerformanceTestZipFiles(assetsDir: string): Promise<PerformanceTestAssets> {
  const performanceAssets: PerformanceTestAssets = {
    large: join(assetsDir, 'large-files.zip'),
    compressed: join(assetsDir, 'compressed.zip'),
    uncompressed: join(assetsDir, 'uncompressed.zip'),
    deepNested: join(assetsDir, 'deep-nested.zip'),
    manyEntries: join(assetsDir, 'many-entries.zip'),
    largeNestedZip: join(assetsDir, 'large-nested-zip.zip'),
  };

  info('Creating performance test assets for benchmarking...');

  // Create performance test ZIP files in parallel
  const zipCreationPromises = [
    createLargeFilesZip(performanceAssets.large),
    createCompressedZip(performanceAssets.compressed),
    createUncompressedZip(performanceAssets.uncompressed),
    createDeepNestedZip(performanceAssets.deepNested, assetsDir),
    createManyEntriesZip(performanceAssets.manyEntries),
    createLargeNestedZip(performanceAssets.largeNestedZip, assetsDir),
  ];

  await Promise.all(zipCreationPromises);

  // Verify the large nested ZIP was created correctly
  try {
    const largeNestedStats = await fs.stat(performanceAssets.largeNestedZip);
    info(`Large nested ZIP created: ${(largeNestedStats.size / 1024 / 1024).toFixed(1)}MB`);
    
    if (largeNestedStats.size < 1024 * 1024) { // Less than 1MB is suspicious
      warn(`Large nested ZIP seems unusually small: ${(largeNestedStats.size / 1024).toFixed(1)}KB`);
    }
  } catch (error) {
    logError(`Failed to verify large nested ZIP creation:`, error);
    throw error;
  }

  info('Performance test assets created successfully');
  return performanceAssets;
}

/**
 * Creates a comprehensive set of test ZIP files for testing (both basic and performance).
 * @deprecated Use createBasicTestZipFiles() or createPerformanceTestZipFiles() instead
 * This function is kept for backwards compatibility but is not recommended for new tests.
 */
export async function createTestZipFiles(assetsDir: string): Promise<TestAssets> {
  info('Creating comprehensive test assets (deprecated - use specific asset creators)...');
  
  const [basicAssets, performanceAssets] = await Promise.all([
    createBasicTestZipFiles(assetsDir),
    createPerformanceTestZipFiles(assetsDir),
  ]);

  return { ...basicAssets, ...performanceAssets };
}

// ===== BASIC TEST ASSET CREATION FUNCTIONS =====

/**
 * Creates a simple ZIP with text files for basic functionality testing
 */
async function createSimpleTextZip(outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', resolve);
    archive.on('error', reject);

    archive.pipe(output);

    // Add simple text files
    archive.append('Hello, World!', { name: 'sample.txt' });
    archive.append('This is another file.', { name: 'another.txt' });
    archive.append('README content here.', { name: 'README.md' });

    archive.finalize();
  });
}

/**
 * Creates a ZIP with binary files (simulated PNG) for binary content testing
 */
async function createBinaryFilesZip(outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', resolve);
    archive.on('error', reject);

    archive.pipe(output);

    // Create a minimal PNG header (8 bytes PNG signature + IHDR chunk start)
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
      0x00, 0x00, 0x00, 0x0d, // IHDR chunk length
      0x49, 0x48, 0x44, 0x52, // IHDR
      0x00, 0x00, 0x00, 0x01, // Width: 1
      0x00, 0x00, 0x00, 0x01, // Height: 1
      0x08, 0x06, 0x00, 0x00, 0x00, // Bit depth, color type, compression, filter, interlace
    ]);

    archive.append(pngHeader, { name: 'sample.png' });
    archive.append(Buffer.from('Binary data here'), { name: 'data.bin' });
    archive.append('Text and binary mixed', { name: 'mixed.txt' });

    archive.finalize();
  });
}

/**
 * Creates a ZIP with directory structure for directory handling testing
 */
async function createDirectoriesZip(outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', resolve);
    archive.on('error', reject);

    archive.pipe(output);

    // Add files in various directories
    archive.append('Root file content', { name: 'root.txt' });
    archive.append('File in folder', { name: 'folder/nested.txt' });
    archive.append('Deep nested file', { name: 'folder/subfolder/deep.txt' });
    archive.append('Another folder file', { name: 'another-folder/file.txt' });

    // Add empty directories
    archive.append('', { name: 'empty-dir/' });
    archive.append('', { name: 'folder/empty-subdir/' });

    archive.finalize();
  });
}

/**
 * Creates a ZIP containing another ZIP (basic nesting) for nested ZIP testing
 */
async function createBasicNestedZip(outputPath: string, tempDir: string): Promise<void> {
  // First create the inner ZIP
  const innerZipPath = join(tempDir, 'inner.zip');
  await createSimpleInnerZip(innerZipPath);

  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', async () => {
      // Clean up temporary inner ZIP
      try {
        await fs.unlink(innerZipPath);
      } catch (e) {
        // Ignore cleanup errors
      }
      resolve();
    });
    archive.on('error', reject);

    archive.pipe(output);

    // Add the inner ZIP and some other files
    archive.file(innerZipPath, { name: 'inner.zip' });
    archive.append('Outer file content', { name: 'outer.txt' });
    archive.append('Another outer file', { name: 'outer-folder/file.txt' });

    archive.finalize();
  });
}

/**
 * Creates an empty ZIP file for edge case testing
 */
async function createEmptyZip(outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', resolve);
    archive.on('error', reject);

    archive.pipe(output);

    // Don't add any files - just finalize to create empty ZIP
    archive.finalize();
  });
}

/**
 * Creates a ZIP with unusual filenames for edge case testing
 */
async function createUnusualNamesZip(outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', resolve);
    archive.on('error', reject);

    archive.pipe(output);

    // Add files with various unusual names
    archive.append('Space file content', { name: 'file with spaces.txt' });
    archive.append('Hyphen file content', { name: 'file-with-hyphens.txt' });
    archive.append('Underscore file content', { name: 'file_with_underscores.txt' });
    archive.append('Dot file content', { name: 'file.with.dots.txt' });
    archive.append('Unicode content', { name: 'файл.txt' }); // Cyrillic
    archive.append('Emoji content', { name: '📁folder/📄file.txt' });

    archive.finalize();
  });
}

/**
 * Helper to create a simple inner ZIP for nesting tests
 */
async function createSimpleInnerZip(outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', resolve);
    archive.on('error', reject);

    archive.pipe(output);

    archive.append('Inner file content', { name: 'inner.txt' });
    archive.append('Another inner file', { name: 'inner-folder/nested.txt' });

    archive.finalize();
  });
}

// ===== PERFORMANCE TEST ASSET CREATION FUNCTIONS =====

/**
 * Creates a ZIP with larger files for performance testing
 */
async function createLargeFilesZip(outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', resolve);
    archive.on('error', reject);

    archive.pipe(output);

    // Create moderately large content (not huge to keep tests fast)
    const largeContent = 'A'.repeat(100 * 1024); // 100KB
    const mediumContent = 'B'.repeat(50 * 1024); // 50KB

    archive.append(largeContent, { name: 'large-file.txt' });
    archive.append(mediumContent, { name: 'medium-file.txt' });

    // Add many small files
    for (let i = 0; i < 100; i++) {
      archive.append(`File ${i} content`, { name: `small-files/file-${i.toString().padStart(3, '0')}.txt` });
    }

    archive.finalize();
  });
}

/**
 * Creates a ZIP with deflated compression for compression testing
 */
async function createCompressedZip(outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } }); // Maximum compression

    output.on('close', resolve);
    archive.on('error', reject);

    archive.pipe(output);

    // Add repetitive content that compresses well
    const repetitiveContent = 'This line repeats many times.\n'.repeat(1000);
    archive.append(repetitiveContent, { name: 'compressed.txt' });
    archive.append('Small compressed file', { name: 'small.txt' });

    archive.finalize();
  });
}

/**
 * Creates a ZIP with stored (uncompressed) files for compression testing
 */
async function createUncompressedZip(outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', {
      zlib: { level: 0 }, // No compression
      store: true,
    });

    output.on('close', resolve);
    archive.on('error', reject);

    archive.pipe(output);

    archive.append('Uncompressed content here', { name: 'stored.txt' });
    archive.append('Another uncompressed file', { name: 'also-stored.txt' });

    archive.finalize();
  });
}

/**
 * Creates a deeply nested ZIP (3 levels) for nested ZIP performance testing
 */
async function createDeepNestedZip(outputPath: string, tempDir: string): Promise<void> {
  // Create innermost ZIP
  const level3ZipPath = join(tempDir, 'level3.zip');
  await createSimpleInnerZip(level3ZipPath);

  // Create level 2 ZIP containing level 3
  const level2ZipPath = join(tempDir, 'level2.zip');
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(level2ZipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', resolve);
    archive.on('error', reject);

    archive.pipe(output);
    archive.file(level3ZipPath, { name: 'level3.zip' });
    archive.append('Level 2 content', { name: 'level2.txt' });
    archive.finalize();
  });

  // Create level 1 ZIP containing level 2
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', async () => {
      // Clean up temporary files
      try {
        await fs.unlink(level2ZipPath);
        await fs.unlink(level3ZipPath);
      } catch (e) {
        // Ignore cleanup errors
      }
      resolve();
    });
    archive.on('error', reject);

    archive.pipe(output);
    archive.file(level2ZipPath, { name: 'level2.zip' });
    archive.append('Level 1 content', { name: 'level1.txt' });
    archive.finalize();
  });
}

/**
 * Creates a ZIP with many entries (40,000 small files) for performance stress testing
 */
async function createManyEntriesZip(outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', resolve);
    archive.on('error', reject);

    archive.pipe(output);

    // Create 40,000 small files
    for (let i = 0; i < 40000; i++) {
      const fileName = `files/file-${i.toString().padStart(5, '0')}.txt`;
      const content = `This is file number ${i}. Content for testing many entries performance.`;
      archive.append(content, { name: fileName });
    }

    archive.finalize();
  });
}

/**
 * Creates a ZIP with a large nested ZIP entry for testing large content caching
 */
async function createLargeNestedZip(outputPath: string, tempDir: string): Promise<void> {
  debug(`Creating large nested ZIP at: ${outputPath}`);
  
  // First create a large inner ZIP (simulated large content)
  const largeInnerZipPath = join(tempDir, 'large-inner.zip');
  
  try {
    debug(`Creating large inner ZIP at: ${largeInnerZipPath}`);
    await createLargeInnerZip(largeInnerZipPath);
    
    // Verify the inner ZIP was created successfully
    const innerStats = await fs.stat(largeInnerZipPath);
    debug(`Large inner ZIP created: ${(innerStats.size / 1024 / 1024).toFixed(1)}MB`);
  } catch (error) {
          logError(`Failed to create large inner ZIP:`, error);
    throw error;
  }

  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', async () => {
      debug(`Large nested ZIP created successfully at: ${outputPath}`);
      
      // Verify the outer ZIP was created
      try {
        const outerStats = await fs.stat(outputPath);
        debug(`Final ZIP size: ${(outerStats.size / 1024 / 1024).toFixed(1)}MB`);
      } catch (e) {
                  warn(`Could not verify final ZIP size: ${e}`);
      }
      
      // Clean up temporary large inner ZIP
      try {
        await fs.unlink(largeInnerZipPath);
        debug(`Cleaned up temporary inner ZIP`);
      } catch (e) {
                  warn(`Could not clean up temporary file: ${e}`);
      }
      resolve();
    });
    
          archive.on('error', (err) => {
        logError(`Archive error during large nested ZIP creation:`, err);
        reject(err);
      });

    archive.on('warning', (warn) => {
      console.warn(`⚠️ Archive warning:`, warn);
    });

    archive.pipe(output);

          debug(`Adding large inner ZIP to outer ZIP with name: large-content.zip`);
    
    // Add the large inner ZIP and some other files
    archive.file(largeInnerZipPath, { name: 'large-content.zip' });
    archive.append('Outer file for testing', { name: 'outer.txt' });
    archive.append('Another outer file', { name: 'metadata.txt' });

          debug(`Finalizing large nested ZIP...`);
    archive.finalize();
  });
}

/**
 * Creates a large inner ZIP with substantial content for testing large content caching
 * Target size: ~2GB to test disk caching with large decompressed content
 * 
 * Note: This creates a very large file that may take several minutes to generate
 * and will use significant disk space. The size is configurable via environment.
 */
async function createLargeInnerZip(outputPath: string): Promise<void> {
  // Allow configuring the size via environment variable for different test scenarios
  const sizeInMB = parseInt(process.env.TEST_LARGE_ZIP_SIZE_MB || '2048', 10); // Default 2GB
  const filesCount = Math.min(10, Math.max(1, sizeInMB / 200)); // ~200MB per file, max 10 files
  const mbPerFile = Math.ceil(sizeInMB / filesCount);
  
  debug(`Creating large inner ZIP (~${sizeInMB}MB with ${filesCount} files)...`);
  debug(`Each file will be approximately ${mbPerFile}MB`);
  debug(`This may take several minutes for large sizes.`);

  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    
    let totalSizeAdded = 0;

    output.on('close', () => {
      debug(`Large inner ZIP created successfully (${sizeInMB}MB target, ${totalSizeAdded}MB content added)`);
      resolve();
    });
    
          output.on('error', (err) => {
        logError(`Output stream error:`, err);
        reject(err);
      });
    
          archive.on('error', (err) => {
        logError(`Archive error during large inner ZIP creation:`, err);
        reject(err);
      });

    archive.on('warning', (warn) => {
      console.warn(`⚠️ Archive warning:`, warn);
    });

    archive.pipe(output);

    try {
      // Create the large files
      for (let i = 0; i < filesCount; i++) {
        debug(`Creating large file ${i + 1}/${filesCount} (~${mbPerFile}MB)...`);
        
        // Create content in manageable chunks to avoid memory issues
        const repeatCount = mbPerFile * 1024 * 20; // ~50 bytes per repeat = ~1MB per 20K repeats
        const baseContent = `Large content block ${i} - This is test data for performance testing of large ZIP entries. `;
        const largeContent = baseContent.repeat(repeatCount);
        
        archive.append(largeContent, { name: `large-file-${i.toString().padStart(2, '0')}.txt` });
        totalSizeAdded += largeContent.length / 1024 / 1024; // Convert to MB
      }

      // Add some regular files for variety and testing different cache scenarios
      archive.append('Regular file content for testing', { name: 'regular.txt' });
      archive.append('Another regular file', { name: 'small.txt' });
      archive.append('Metadata file with timestamp: ' + new Date().toISOString(), { name: 'metadata.txt' });

      // Add a few medium-sized files (1MB each) for testing different cache scenarios
      for (let i = 0; i < 5; i++) {
        const mediumContent = `Medium content file ${i} - This is test data for medium-sized cache testing. `.repeat(20000); // ~1MB per file
        archive.append(mediumContent, { name: `medium-file-${i}.txt` });
        totalSizeAdded += mediumContent.length / 1024 / 1024; // Convert to MB
      }

      // Add small test files for quick access testing
      for (let i = 0; i < 10; i++) {
        archive.append(`Small test file ${i} content`, { name: `small-files/test-${i}.txt` });
      }

      debug(`Finalizing large inner ZIP... (${totalSizeAdded.toFixed(1)}MB content added)`);
      archive.finalize();
          } catch (err) {
        logError(`Error during large inner ZIP creation:`, err);
        reject(err);
      }
  });
}

// ===== UTILITY FUNCTIONS =====

/**
 * Windows-safe cleanup utility to remove test assets with retry logic
 */
export async function cleanupTestAssets(assetsDir: string): Promise<void> {
  await safeRemoveDir(assetsDir);
}

/**
 * Safe directory removal with Windows-specific retry logic for ENOTEMPTY errors
 */
export async function safeRemoveDir(dirPath: string, maxRetries: number = 3, delayMs: number = 100): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await fs.rm(dirPath, { recursive: true, force: true });
      return; // Success - exit early
    } catch (error: any) {
      const isLastAttempt = attempt === maxRetries;
      const isWindowsError = error?.code === 'ENOTEMPTY' || error?.code === 'EBUSY' || error?.code === 'EPERM';
      
      if (isLastAttempt || !isWindowsError) {
        // Log warning but don't throw - test cleanup failures shouldn't break tests
        console.warn(`Failed to cleanup directory ${dirPath} after ${attempt} attempts:`, error?.message || error);
        return;
      }
      
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
    }
  }
}

/**
 * Verify that a ZIP file exists and is readable
 */
export async function verifyZipFile(zipPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(zipPath);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

// ===== ENCRYPTED ZIP CREATION FUNCTIONS =====

/**
 * Create a ZIP file with traditional encryption
 */
export async function createTraditionalEncryptedZip(
  outputPath: string,
  files: Array<{ name: string; content: string | Buffer }>,
  password: string
): Promise<void> {
  const zipData = await createEncryptedZipBuffer(files, password, 'traditional');
  await fs.writeFile(outputPath, zipData);
}

/**
 * Create a ZIP file with AES encryption
 */
export async function createAESEncryptedZip(
  outputPath: string,
  files: Array<{ name: string; content: string | Buffer }>,
  password: string,
  aesStrength: 128 | 192 | 256 = 256
): Promise<void> {
  const zipData = await createEncryptedZipBuffer(files, password, 'aes', aesStrength);
  await fs.writeFile(outputPath, zipData);
}

/**
 * Create encrypted ZIP buffer manually implementing ZIP format
 */
async function createEncryptedZipBuffer(
  files: Array<{ name: string; content: string | Buffer }>,
  password: string,
  encryptionType: 'traditional' | 'aes' = 'traditional',
  aesStrength: 128 | 192 | 256 = 256
): Promise<Buffer> {
  const centralDirEntries: Buffer[] = [];
  const fileDataEntries: Buffer[] = [];
  let currentOffset = 0;

  for (const file of files) {
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8');
    const fileName = Buffer.from(file.name, 'utf8');
    
    // Debug: Log each file being processed
    console.log(`Processing file: "${file.name}" -> fileName buffer length: ${fileName.length}`);
    
    // Calculate CRC32
    const crc32 = calculateCRC32(content);
    
    // Encrypt the content
    const encryptedContent = encryptionType === 'traditional' 
      ? encryptTraditional(content, password, crc32)
      : encryptAES(content, password, aesStrength);
    
    // Create Local File Header
    const lfh = createLocalFileHeader(fileName, encryptedContent, crc32, content.length, encryptionType, aesStrength);
    fileDataEntries.push(lfh);
    fileDataEntries.push(encryptedContent);
    
    // Create Central Directory File Header
    const cdfh = createCentralDirFileHeader(fileName, encryptedContent, crc32, content.length, currentOffset, encryptionType, aesStrength);
    centralDirEntries.push(cdfh);
    
    currentOffset += lfh.length + encryptedContent.length;
  }

  // Combine all file data
  const fileData = Buffer.concat(fileDataEntries);
  const centralDir = Buffer.concat(centralDirEntries);
  
  // Create End of Central Directory Record
  const eocd = createEndOfCentralDir(centralDir.length, fileData.length, files.length);
  
  return Buffer.concat([fileData, centralDir, eocd]);
}

/**
 * Create Local File Header with encryption flag
 */
function createLocalFileHeader(
  fileName: Buffer,
  encryptedContent: Buffer,
  crc32: number,
  uncompressedSize: number,
  encryptionType: 'traditional' | 'aes' = 'traditional',
  aesStrength: 128 | 192 | 256 = 256
): Buffer {
  const header = Buffer.alloc(30 + fileName.length);
  let offset = 0;

  // Local file header signature
  header.writeUInt32LE(0x04034b50, offset); offset += 4;
  
  // Version needed to extract
  header.writeUInt16LE(20, offset); offset += 2;
  
  // General purpose bit flag (bit 0 = encrypted, bit 6 = strong encryption for AES)
  const bitFlag = encryptionType === 'aes' ? 0x0041 : 0x0001; // 0x40 = strong encryption
  header.writeUInt16LE(bitFlag, offset); offset += 2;
  
  // Compression method (0 = stored, 99 = AES)
  const compressionMethod = encryptionType === 'aes' ? 99 : 0;
  header.writeUInt16LE(compressionMethod, offset); offset += 2;
  
  // File last modification time & date (dummy values)
  header.writeUInt16LE(0x0000, offset); offset += 2;
  header.writeUInt16LE(0x0021, offset); offset += 2;
  
  // CRC-32
  header.writeUInt32LE(crc32, offset); offset += 4;
  
  // Compressed size (encrypted size)
  header.writeUInt32LE(encryptedContent.length, offset); offset += 4;
  
  // Uncompressed size
  header.writeUInt32LE(uncompressedSize, offset); offset += 4;
  
  // File name length
  header.writeUInt16LE(fileName.length, offset); offset += 2;
  
  // Extra field length (AES needs extra field)
  const extraFieldLength = encryptionType === 'aes' ? 11 : 0;
  header.writeUInt16LE(extraFieldLength, offset); offset += 2;
  
  // File name
  fileName.copy(header, offset);
  
  // Add AES extra field if needed
  if (encryptionType === 'aes') {
    const headerWithExtra = Buffer.alloc(header.length + extraFieldLength);
    header.copy(headerWithExtra);
    
    let extraOffset = header.length;
    // AES extra field header ID (0x9901)
    headerWithExtra.writeUInt16LE(0x9901, extraOffset); extraOffset += 2;
    // Data size (7 bytes)
    headerWithExtra.writeUInt16LE(7, extraOffset); extraOffset += 2;
    // AES version (2)
    headerWithExtra.writeUInt16LE(2, extraOffset); extraOffset += 2;
    // Vendor ID ('AE')
    headerWithExtra.write('AE', extraOffset); extraOffset += 2;
    // AES strength (1=128, 2=192, 3=256)
    const strength = aesStrength === 128 ? 1 : aesStrength === 192 ? 2 : 3;
    headerWithExtra.writeUInt8(strength, extraOffset); extraOffset += 1;
    // Actual compression method (0 = stored)
    headerWithExtra.writeUInt16LE(0, extraOffset);
    
    return headerWithExtra;
  }
  
  return header;
}

/**
 * Create Central Directory File Header with encryption flag
 */
function createCentralDirFileHeader(
  fileName: Buffer,
  encryptedContent: Buffer,
  crc32: number,
  uncompressedSize: number,
  localHeaderOffset: number,
  encryptionType: 'traditional' | 'aes' = 'traditional',
  aesStrength: 128 | 192 | 256 = 256
): Buffer {
  const header = Buffer.alloc(46 + fileName.length);
  let offset = 0;

  // Central directory file header signature
  header.writeUInt32LE(0x02014b50, offset); offset += 4;
  
  // Version made by
  header.writeUInt16LE(20, offset); offset += 2;
  
  // Version needed to extract
  header.writeUInt16LE(20, offset); offset += 2;
  
  // General purpose bit flag (bit 0 = encrypted, bit 6 = strong encryption for AES)
  const bitFlag = encryptionType === 'aes' ? 0x0041 : 0x0001;
  header.writeUInt16LE(bitFlag, offset); offset += 2;
  
  // Compression method (0 = stored, 99 = AES)
  const compressionMethod = encryptionType === 'aes' ? 99 : 0;
  header.writeUInt16LE(compressionMethod, offset); offset += 2;
  
  // File last modification time & date
  header.writeUInt16LE(0x0000, offset); offset += 2;
  header.writeUInt16LE(0x0021, offset); offset += 2;
  
  // CRC-32
  header.writeUInt32LE(crc32, offset); offset += 4;
  
  // Compressed size
  header.writeUInt32LE(encryptedContent.length, offset); offset += 4;
  
  // Uncompressed size
  header.writeUInt32LE(uncompressedSize, offset); offset += 4;
  
  // File name length
  header.writeUInt16LE(fileName.length, offset); offset += 2;
  
  // Extra field length (AES needs extra field)
  const extraFieldLength = encryptionType === 'aes' ? 11 : 0;
  header.writeUInt16LE(extraFieldLength, offset); offset += 2;
  
  // File comment length
  header.writeUInt16LE(0, offset); offset += 2;
  
  // Disk number start
  header.writeUInt16LE(0, offset); offset += 2;
  
  // Internal file attributes
  header.writeUInt16LE(0, offset); offset += 2;
  
  // External file attributes
  header.writeUInt32LE(0, offset); offset += 4;
  
  // Relative offset of local header
  header.writeUInt32LE(localHeaderOffset, offset); offset += 4;
  
  // File name
  fileName.copy(header, offset);
  
  // Add AES extra field if needed
  if (encryptionType === 'aes') {
    const headerWithExtra = Buffer.alloc(header.length + extraFieldLength);
    header.copy(headerWithExtra);
    
    let extraOffset = header.length;
    // AES extra field header ID (0x9901)
    headerWithExtra.writeUInt16LE(0x9901, extraOffset); extraOffset += 2;
    // Data size (7 bytes)
    headerWithExtra.writeUInt16LE(7, extraOffset); extraOffset += 2;
    // AES version (2)
    headerWithExtra.writeUInt16LE(2, extraOffset); extraOffset += 2;
    // Vendor ID ('AE')
    headerWithExtra.write('AE', extraOffset); extraOffset += 2;
    // AES strength (1=128, 2=192, 3=256)
    const strength = aesStrength === 128 ? 1 : aesStrength === 192 ? 2 : 3;
    headerWithExtra.writeUInt8(strength, extraOffset); extraOffset += 1;
    // Actual compression method (0 = stored)
    headerWithExtra.writeUInt16LE(0, extraOffset);
    
    return headerWithExtra;
  }
  
  return header;
}

/**
 * Create End of Central Directory Record
 */
function createEndOfCentralDir(
  centralDirSize: number,
  centralDirOffset: number,
  entryCount: number
): Buffer {
  const eocd = Buffer.alloc(22);
  let offset = 0;

  // End of central dir signature
  eocd.writeUInt32LE(0x06054b50, offset); offset += 4;
  
  // Number of this disk
  eocd.writeUInt16LE(0, offset); offset += 2;
  
  // Number of disk with start of central directory
  eocd.writeUInt16LE(0, offset); offset += 2;
  
  // Total number of entries in central directory on this disk
  eocd.writeUInt16LE(entryCount, offset); offset += 2;
  
  // Total number of entries in central directory
  eocd.writeUInt16LE(entryCount, offset); offset += 2;
  
  // Size of central directory
  eocd.writeUInt32LE(centralDirSize, offset); offset += 4;
  
  // Offset of start of central directory
  eocd.writeUInt32LE(centralDirOffset, offset); offset += 4;
  
  // ZIP file comment length
  eocd.writeUInt16LE(0, offset);
  
  return eocd;
}

/**
 * Encrypt content using traditional ZIP encryption
 */
function encryptTraditional(content: Buffer, password: string, crc32: number): Buffer {
  // Initialize keys
  let key0 = 0x12345678;
  let key1 = 0x23456789;
  let key2 = 0x34567890;

  // Process password to initialize keys
  for (let i = 0; i < password.length; i++) {
    key0 = crc32Update(key0, password.charCodeAt(i));
    key1 = (key1 + (key0 & 0xff)) & 0xffffffff;
    key1 = ((key1 * 134775813 + 1) & 0xffffffff) >>> 0;
    key2 = crc32Update(key2, key1 >>> 24);
  }

  // Create encryption header (12 bytes)
  const header = Buffer.alloc(12);
  for (let i = 0; i < 11; i++) {
    const randomByte = Math.floor(Math.random() * 256);
    header[i] = randomByte ^ decryptByte(key0, key1, key2);
    const keys = updateKeys(key0, key1, key2, randomByte);
    key0 = keys[0]; key1 = keys[1]; key2 = keys[2];
  }
  
  // Last byte should match high byte of CRC
  const lastByte = (crc32 >>> 24) & 0xff;
  header[11] = lastByte ^ decryptByte(key0, key1, key2);
  const keys = updateKeys(key0, key1, key2, lastByte);
  key0 = keys[0]; key1 = keys[1]; key2 = keys[2];

  // Encrypt the actual content
  const encryptedContent = Buffer.alloc(content.length);
  for (let i = 0; i < content.length; i++) {
    const plainByte = content[i];
    encryptedContent[i] = plainByte ^ decryptByte(key0, key1, key2);
    const updatedKeys = updateKeys(key0, key1, key2, plainByte);
    key0 = updatedKeys[0]; key1 = updatedKeys[1]; key2 = updatedKeys[2];
  }

  return Buffer.concat([header, encryptedContent]);
}

function crc32Update(crc: number, byte: number): number {
  return ((crc >>> 8) ^ crc32Table[(crc ^ byte) & 0xff]) >>> 0;
}

function decryptByte(key0: number, key1: number, key2: number): number {
  const temp = (key2 | 2) >>> 0;
  return ((temp * (temp ^ 1)) >>> 8) & 0xff;
}

function updateKeys(key0: number, key1: number, key2: number, c: number): [number, number, number] {
  key0 = crc32Update(key0, c);
  key1 = (key1 + (key0 & 0xff)) & 0xffffffff;
  key1 = ((key1 * 134775813 + 1) & 0xffffffff) >>> 0;
  key2 = crc32Update(key2, key1 >>> 24);
  
  return [key0, key1, key2];
}

/**
 * Calculate CRC32 checksum
 */
function calculateCRC32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = ((crc >>> 8) ^ crc32Table[(crc ^ buffer[i]) & 0xff]) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// CRC32 table
const crc32Table = new Array(256).fill(0).map((_, i) => {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  return c >>> 0;
});

/**
 * Encrypt content using AES encryption (WinZip format)
 */
function encryptAES(content: Buffer, password: string, aesStrength: 128 | 192 | 256 = 256): Buffer {
  // Determine key length
  const keyLength = aesStrength / 8; // 16, 24, or 32 bytes
  const saltLength = keyLength / 2; // Salt is half the key length
  
  // Generate salt
  const salt = randomBytes(saltLength);
  
  // Derive encryption and authentication keys using PBKDF2
  const keyMaterial = pbkdf2Sync(password, salt, 1000, keyLength + keyLength + 2, 'sha1');
  const encryptionKey = keyMaterial.subarray(0, keyLength);
  const authenticationKey = keyMaterial.subarray(keyLength, keyLength + keyLength);
  const passwordVerification = keyMaterial.subarray(keyLength + keyLength, keyLength + keyLength + 2);
  
  // Encrypt content using AES-CTR mode
  const iv = Buffer.alloc(16); // AES-CTR uses 16-byte IV, initialized to 0
  const cipherName = `aes-${aesStrength}-ctr`;
  const cipher = createCipheriv(cipherName, encryptionKey, iv);
  
  let encryptedContent = cipher.update(content);
  const final = cipher.final();
  if (final.length > 0) {
    encryptedContent = Buffer.concat([encryptedContent, final]);
  }
  
  // Calculate HMAC authentication
  const hmac = createHmac('sha1', authenticationKey);
  hmac.update(encryptedContent);
  const authenticationCode = hmac.digest().subarray(0, 10); // Truncate to 10 bytes
  
  // Combine: salt + password verification + encrypted content + authentication code
  return Buffer.concat([salt, passwordVerification, encryptedContent, authenticationCode]);
}
