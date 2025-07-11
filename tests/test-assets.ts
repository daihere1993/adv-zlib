import { promises as fs, createWriteStream } from 'fs';
import { join } from 'path';
import archiver from 'archiver';

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

  console.log('📦 Creating basic test assets for functional testing...');

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
  console.log('✅ Basic test assets created successfully');

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

  console.log('🏃 Creating performance test assets for benchmarking...');

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
    console.log(`✅ Large nested ZIP created: ${(largeNestedStats.size / 1024 / 1024).toFixed(1)}MB`);
    
    if (largeNestedStats.size < 1024 * 1024) { // Less than 1MB is suspicious
      console.warn(`⚠️ Large nested ZIP seems unusually small: ${(largeNestedStats.size / 1024).toFixed(1)}KB`);
    }
  } catch (error) {
    console.error(`❌ Failed to verify large nested ZIP creation:`, error);
    throw error;
  }

  console.log('✅ Performance test assets created successfully');
  return performanceAssets;
}

/**
 * Creates a comprehensive set of test ZIP files for testing (both basic and performance).
 * @deprecated Use createBasicTestZipFiles() or createPerformanceTestZipFiles() instead
 * This function is kept for backwards compatibility but is not recommended for new tests.
 */
export async function createTestZipFiles(assetsDir: string): Promise<TestAssets> {
  console.log('📦 Creating comprehensive test assets (deprecated - use specific asset creators)...');
  
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
  console.log(`🏗️ Creating large nested ZIP at: ${outputPath}`);
  
  // First create a large inner ZIP (simulated large content)
  const largeInnerZipPath = join(tempDir, 'large-inner.zip');
  
  try {
    console.log(`📦 Creating large inner ZIP at: ${largeInnerZipPath}`);
    await createLargeInnerZip(largeInnerZipPath);
    
    // Verify the inner ZIP was created successfully
    const innerStats = await fs.stat(largeInnerZipPath);
    console.log(`✅ Large inner ZIP created: ${(innerStats.size / 1024 / 1024).toFixed(1)}MB`);
  } catch (error) {
    console.error(`❌ Failed to create large inner ZIP:`, error);
    throw error;
  }

  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', async () => {
      console.log(`✅ Large nested ZIP created successfully at: ${outputPath}`);
      
      // Verify the outer ZIP was created
      try {
        const outerStats = await fs.stat(outputPath);
        console.log(`📊 Final ZIP size: ${(outerStats.size / 1024 / 1024).toFixed(1)}MB`);
      } catch (e) {
        console.warn(`⚠️ Could not verify final ZIP size: ${e}`);
      }
      
      // Clean up temporary large inner ZIP
      try {
        await fs.unlink(largeInnerZipPath);
        console.log(`🧹 Cleaned up temporary inner ZIP`);
      } catch (e) {
        console.warn(`⚠️ Could not clean up temporary file: ${e}`);
      }
      resolve();
    });
    
    archive.on('error', (error) => {
      console.error(`❌ Archive error during large nested ZIP creation:`, error);
      reject(error);
    });

    archive.on('warning', (warn) => {
      console.warn(`⚠️ Archive warning:`, warn);
    });

    archive.pipe(output);

    console.log(`📁 Adding large inner ZIP to outer ZIP with name: large-content.zip`);
    
    // Add the large inner ZIP and some other files
    archive.file(largeInnerZipPath, { name: 'large-content.zip' });
    archive.append('Outer file for testing', { name: 'outer.txt' });
    archive.append('Another outer file', { name: 'metadata.txt' });

    console.log(`🔄 Finalizing large nested ZIP...`);
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
  
  console.log(`📦 Creating large inner ZIP (~${sizeInMB}MB with ${filesCount} files)...`);
  console.log(`📝 Each file will be approximately ${mbPerFile}MB`);
  console.log(`⏱️  This may take several minutes for large sizes.`);

  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    
    let totalSizeAdded = 0;

    output.on('close', () => {
      console.log(`✅ Large inner ZIP created successfully (${sizeInMB}MB target, ${totalSizeAdded}MB content added)`);
      resolve();
    });
    
    output.on('error', (error) => {
      console.error(`❌ Output stream error:`, error);
      reject(error);
    });
    
    archive.on('error', (error) => {
      console.error(`❌ Archive error during large inner ZIP creation:`, error);
      reject(error);
    });

    archive.on('warning', (warn) => {
      console.warn(`⚠️ Archive warning:`, warn);
    });

    archive.pipe(output);

    try {
      // Create the large files
      for (let i = 0; i < filesCount; i++) {
        console.log(`📝 Creating large file ${i + 1}/${filesCount} (~${mbPerFile}MB)...`);
        
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

      console.log(`📦 Finalizing large inner ZIP... (${totalSizeAdded.toFixed(1)}MB content added)`);
      archive.finalize();
    } catch (error) {
      console.error(`❌ Error during large inner ZIP creation:`, error);
      reject(error);
    }
  });
}

// ===== UTILITY FUNCTIONS =====

/**
 * Cleanup utility to remove test assets
 */
export async function cleanupTestAssets(assetsDir: string): Promise<void> {
  try {
    await fs.rm(assetsDir, { recursive: true, force: true });
  } catch (error) {
    // Ignore cleanup errors
    console.warn('Failed to cleanup test assets:', error);
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
