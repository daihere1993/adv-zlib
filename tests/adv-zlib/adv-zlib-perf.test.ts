import { describe, it, expect, beforeAll } from 'vitest';
import { AdvZlib } from '../../src/adv-zlib';
import { mkdir, access, stat, readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import archiver from 'archiver';
import { createWriteStream } from 'node:fs';
import os from 'node:os';

// Get the directory of this test file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Test configuration - use fixtures directory in the project
const fixturesDir = join(__dirname, 'fixtures');
const metadataPath = join(fixturesDir, 'metadata.json');
let parentZipPath: string;
let nestedZipPath: string;
let testEntryName: string; // Store the entry name we'll test
let lastEntryName: string; // Store the last entry name for worst-case testing

const ENTRY_COUNT = 150000;
const MIN_ENTRY_NAME_LENGTH = 100;
const TARGET_SIZE_GB = 1;
const TARGET_SIZE_BYTES = TARGET_SIZE_GB * 1024 * 1024 * 1024;

/**
 * Generate a random string of specified length for entry names
 */
function generateLongName(baseName: string, minLength: number): string {
  const randomSuffix = randomBytes(Math.ceil((minLength - baseName.length) / 2))
    .toString('hex')
    .slice(0, minLength - baseName.length);
  return `${baseName}-${randomSuffix}`;
}

/**
 * Create a zip file with specified entries
 */
async function createZip(zipPath: string, files: Record<string, Buffer | string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', {
      zlib: { level: 9 },
    });

    output.on('close', () => resolve());
    output.on('error', reject);
    archive.on('error', reject);

    archive.pipe(output);

    for (const [filename, content] of Object.entries(files)) {
      archive.append(content, { name: filename });
    }

    archive.finalize();
  });
}

/**
 * Generate a large nested zip file with 150k entries
 * Returns the names of the middle and last entries for testing
 */
async function generateLargeNestedZip(
  nestZipPath: string,
  entryCount: number,
): Promise<{ middleEntry: string; lastEntry: string }> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(nestZipPath);
    const archive = archiver('zip', {
      zlib: { level: 9 },
    });

    let processedEntries = 0;
    const logInterval = 1000; // Log every 1000 entries
    let middleEntryName = '';
    let lastEntryName = '';
    const middleIndex = Math.floor(entryCount / 2);

    output.on('close', () => {
      console.log(`\nCompleted: Generated ${entryCount} entries in nested zip`);
      resolve({ middleEntry: middleEntryName, lastEntry: lastEntryName });
    });
    output.on('error', reject);
    archive.on('error', reject);

    archive.pipe(output);

    // Calculate entry size to reach target (1GB+)
    // With 150k entries, we need ~7KB per entry to reach 1GB
    const entrySize = Math.ceil(TARGET_SIZE_BYTES / entryCount);

    console.log(`Generating ${entryCount} entries (each ~${Math.ceil(entrySize / 1024)}KB of random data)...`);

    for (let i = 0; i < entryCount; i++) {
      const longName = generateLongName(`file-${i}`, MIN_ENTRY_NAME_LENGTH);

      // Use random data for each entry to prevent compression
      // This ensures the zip reaches the target size
      const entryContent = randomBytes(entrySize);

      const fileName = `${longName}.txt`;
      archive.append(entryContent, { name: fileName });

      // Store the middle entry name for testing
      if (i === middleIndex) {
        middleEntryName = fileName;
      }
      // Store the last entry name for worst-case testing
      if (i === entryCount - 1) {
        lastEntryName = fileName;
      }

      processedEntries++;
      if (processedEntries % logInterval === 0) {
        process.stdout.write(`\rProgress: ${processedEntries}/${entryCount} entries`);
      }
    }

    archive.finalize();
  });
}

/**
 * Check if a file exists
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('AdvZlib Performance Tests', () => {
  beforeAll(
    async () => {
      // Define paths
      nestedZipPath = join(fixturesDir, 'nest.zip');
      parentZipPath = join(fixturesDir, 'a.zip');

      // Check if fixtures already exist
      const nestedExists = await fileExists(nestedZipPath);
      const parentExists = await fileExists(parentZipPath);
      const metadataExists = await fileExists(metadataPath);

      if (nestedExists && parentExists && metadataExists) {
        console.log('\n✓ Found existing test fixtures in:', fixturesDir);

        // Validate the existing fixtures
        const nestedStats = await stat(nestedZipPath);
        console.log(`  - nest.zip: ${(nestedStats.size / 1024 / 1024).toFixed(2)} MB`);

        const parentStats = await stat(parentZipPath);
        console.log(`  - a.zip: ${(parentStats.size / 1024 / 1024).toFixed(2)} MB`);

        console.log('Skipping fixture generation (delete fixtures folder to regenerate)\n');

        // Read the test entry name from metadata file
        const metadataContent = await readFile(metadataPath, 'utf-8');
        const metadata = JSON.parse(metadataContent);
        testEntryName = metadata.testEntryName;
        lastEntryName = metadata.lastEntryName;
        console.log(`Test entry name loaded from metadata: ${testEntryName}`);
        console.log(`Last entry name loaded from metadata: ${lastEntryName}\n`);

        return;
      }

      // Create fixtures directory
      await mkdir(fixturesDir, { recursive: true });
      console.log('\nFixtures directory:', fixturesDir);

      // Generate the large nested zip (this will take several minutes)
      console.log('Generating large nested zip file (this may take several minutes)...');
      const entryNames = await generateLargeNestedZip(nestedZipPath, ENTRY_COUNT);
      testEntryName = entryNames.middleEntry;
      lastEntryName = entryNames.lastEntry;
      console.log(`Test entry name stored: ${testEntryName}`);
      console.log(`Last entry name stored: ${lastEntryName}`);

      // Save metadata to file for subsequent runs
      await writeFile(
        metadataPath,
        JSON.stringify(
          {
            testEntryName,
            lastEntryName,
            entryCount: ENTRY_COUNT,
            generatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      console.log('Metadata saved to:', metadataPath);

      // Create the parent zip containing the nested zip
      console.log('Creating parent zip file...');
      await createZip(parentZipPath, {
        'nest.zip': await readFile(nestedZipPath),
      });

      console.log('Test fixtures ready! (Cached for future test runs)\n');
    },
    10 * 60 * 1000,
  ); // 10 minute timeout for beforeAll

  it(
    'should check exists() in nested zip under 10 seconds with minimal memory',
    async () => {
      // Initialize AdvZlib with optimized configuration
      const advZlib = new AdvZlib({
        defaultSize: 30 * 1024 * 1024, // 30MB - optimized to avoid re-inflation
        retry: 3,
        logger: console,
      });

      // Construct the nested path to check
      const nestedPath = `${parentZipPath}/nest.zip/${testEntryName}`;
      console.log(`\nChecking existence of: ${nestedPath}`);

      // Capture memory usage before operation
      if (global.gc) {
        global.gc(); // Force garbage collection if --expose-gc flag is set
      }
      const memBefore = process.memoryUsage();
      console.log(`\n📊 Before operation:`);
      console.log(`  Heap Used: ${(memBefore.heapUsed / 1024 / 1024).toFixed(2)} MB`);

      // Start performance timer
      const startTime = performance.now();

      // Call exists() method
      const exists = await advZlib.exists(nestedPath);

      // Stop timer and calculate elapsed time
      const elapsed = performance.now() - startTime;

      // Capture memory usage after operation
      if (global.gc) {
        global.gc();
      }
      const memAfter = process.memoryUsage();
      const heapUsedDelta = (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024;

      // Log results
      console.log(`\n✓ exists() completed in ${(elapsed / 1000).toFixed(3)} seconds`);
      console.log(`✓ Result: ${exists}`);
      console.log(`\n📊 After operation:`);
      console.log(`  Heap Used: ${(memAfter.heapUsed / 1024 / 1024).toFixed(2)} MB`);
      console.log(`\n📊 Delta:`);
      console.log(`  Heap Used Delta: ${heapUsedDelta.toFixed(2)} MB`);

      // Verify the entry exists
      expect(exists).toBe(true);

      // Assert execution time < 10 seconds
      expect(elapsed).toBeLessThan(10000); // 10 seconds in milliseconds

      // Calculate expected memory usage
      // CD size is approximately 22MB for 150k entries
      // Each entry metadata: ~100 bytes for name + 50 bytes for object + 8 bytes for pointer
      const estimatedCdSizeMB = 22;
      const entryMetadatasSizeMB = (ENTRY_COUNT * (100 + 50 + 8)) / 1024 / 1024;
      const maxAllowedMemoryMB = estimatedCdSizeMB + entryMetadatasSizeMB;

      console.log(
        `\n⚠️  Memory assertion: heapUsedDelta (${heapUsedDelta.toFixed(2)} MB) should be < ${maxAllowedMemoryMB.toFixed(2)} MB (estimatedCdSizeMB: ${estimatedCdSizeMB.toFixed(2)} MB + entryMetadatasSizeMb: ${entryMetadatasSizeMB.toFixed(2)} MB)`,
      );
      expect(heapUsedDelta).toBeLessThan(maxAllowedMemoryMB);
    },
    30 * 1000,
  ); // 30 second timeout for the test

  it(
    'should check exists() for non-existent entry in large zip under 500ms',
    async () => {
      // Initialize AdvZlib with default configuration
      const advZlib = new AdvZlib({
        logger: console,
      });

      // Construct test path for non-nested zip (directly using nest.zip)
      const testPath = `${nestedZipPath}/non-existent-entry-xyz123.txt`;
      console.log(`\nChecking existence of non-existent entry: ${testPath}`);
      console.log(`Searching in zip with ${ENTRY_COUNT} entries`);

      // Capture memory usage before operation
      if (global.gc) {
        global.gc(); // Force garbage collection if --expose-gc flag is set
      }
      const memBefore = process.memoryUsage();
      console.log(`\n📊 Before operation:`);
      console.log(`  Heap Used: ${(memBefore.heapUsed / 1024 / 1024).toFixed(2)} MB`);

      // Start performance timer
      const startTime = performance.now();

      // Call exists() method
      const exists = await advZlib.exists(testPath);

      // Stop timer and calculate elapsed time
      const elapsed = performance.now() - startTime;

      // Capture memory usage after operation
      if (global.gc) {
        global.gc();
      }
      const memAfter = process.memoryUsage();
      const heapUsedDelta = (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024;

      // Log results
      console.log(`\n✓ exists() completed in ${elapsed.toFixed(3)} ms`);
      console.log(`✓ Result: ${exists}`);
      console.log(`✓ Searched ${ENTRY_COUNT} entries`);
      console.log(`\n📊 After operation:`);
      console.log(`  Heap Used: ${(memAfter.heapUsed / 1024 / 1024).toFixed(2)} MB`);
      console.log(`\n📊 Delta:`);
      console.log(`  Heap Used Delta: ${heapUsedDelta.toFixed(2)} MB`);

      // Verify the entry does not exist
      expect(exists).toBe(false);

      // Log baseline performance (current implementation is slow)
      console.log(`\n📊 Performance:`);
      console.log(`  Baseline: ${elapsed.toFixed(3)} ms`);

      // Assert execution time < 500ms
      expect(elapsed).toBeLessThan(500);

      // Assert memory usage should not exceed 50MB
      const maxAllowedMemoryMB = 50;
      console.log(
        `\n⚠️  Memory assertion: heapUsedDelta (${heapUsedDelta.toFixed(2)} MB) should be < ${maxAllowedMemoryMB} MB`,
      );
      expect(heapUsedDelta).toBeLessThan(maxAllowedMemoryMB);
    },
    30 * 1000,
  ); // 30 second timeout for the test

  it(
    'should get entry metadatas from nested zip under 10 seconds with minimal memory',
    async () => {
      // Initialize AdvZlib with optimized configuration
      const advZlib = new AdvZlib({
        defaultSize: 30 * 1024 * 1024, // 30MB - optimized to avoid re-inflation
        retry: 3,
        logger: console,
      });

      // Construct the nested path to get metadatas from
      const nestedPath = `${parentZipPath}/nest.zip`;
      console.log(`\nGetting entry metadatas from: ${nestedPath}`);

      // Capture memory usage before operation
      if (global.gc) {
        global.gc(); // Force garbage collection if --expose-gc flag is set
      }
      const memBefore = process.memoryUsage();
      console.log(`\n📊 Before operation:`);
      console.log(`  Heap Used: ${(memBefore.heapUsed / 1024 / 1024).toFixed(2)} MB`);

      // Start performance timer
      const startTime = performance.now();

      // Call getEntryMetadatas() method
      const metadatas = await advZlib.getEntryMetadatas(nestedPath);

      // Stop timer and calculate elapsed time
      const elapsed = performance.now() - startTime;

      // Capture memory usage after operation
      if (global.gc) {
        global.gc();
      }
      const memAfter = process.memoryUsage();
      const heapUsedDelta = (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024;

      // Log results
      console.log(`\n✓ getEntryMetadatas() completed in ${(elapsed / 1000).toFixed(3)} seconds`);
      console.log(`✓ Retrieved ${metadatas.length} entries`);
      console.log(`\n📊 After operation:`);
      console.log(`  Heap Used: ${(memAfter.heapUsed / 1024 / 1024).toFixed(2)} MB`);
      console.log(`\n📊 Delta:`);
      console.log(`  Heap Used Delta: ${heapUsedDelta.toFixed(2)} MB`);

      // Verify we got all entries
      expect(metadatas.length).toBe(ENTRY_COUNT);

      // Verify entries have valid metadata properties
      expect(metadatas[0]).toHaveProperty('fileName');
      expect(metadatas[0]).toHaveProperty('compressedSize');
      expect(metadatas[0]).toHaveProperty('uncompressedSize');
      expect(metadatas[0]).toHaveProperty('crc32');
      expect(metadatas[0]).toHaveProperty('compressionMethod');

      // Verify at least one entry has the expected long name pattern
      const hasLongNames = metadatas.some((m) => m.fileName.length >= MIN_ENTRY_NAME_LENGTH);
      expect(hasLongNames).toBe(true);

      // Assert execution time < 10 seconds
      expect(elapsed).toBeLessThan(10000); // 10 seconds in milliseconds

      // Calculate expected memory usage
      // CD size is approximately 22MB for 150k entries
      // Each entry metadata object: ~158 bytes (100 for name + 50 for object + 8 for pointer)
      const estimatedCdSizeMB = 22;
      const entryMetadatasSizeMB = (ENTRY_COUNT * 158) / 1024 / 1024;
      const maxAllowedMemoryMB = estimatedCdSizeMB + entryMetadatasSizeMB + 5; // +5MB buffer

      console.log(
        `\n⚠️  Memory assertion: heapUsedDelta (${heapUsedDelta.toFixed(2)} MB) should be < ${maxAllowedMemoryMB.toFixed(2)} MB (estimatedCdSizeMB: ${estimatedCdSizeMB.toFixed(2)} MB + entryMetadatasSizeMb: ${entryMetadatasSizeMB.toFixed(2)} MB + 5MB buffer)`,
      );
      expect(heapUsedDelta).toBeLessThan(maxAllowedMemoryMB);
    },
    30 * 1000,
  ); // 30 second timeout for the test

  it(
    'should get entry metadatas from non-nested zip under 1 seconds with minimal memory',
    async () => {
      // Initialize AdvZlib with default configuration
      const advZlib = new AdvZlib({
        logger: console,
      });

      // Test directly on nest.zip (non-nested case)
      console.log(`\nGetting entry metadatas from non-nested zip: ${nestedZipPath}`);

      // Capture memory usage before operation
      if (global.gc) {
        global.gc(); // Force garbage collection if --expose-gc flag is set
      }
      const memBefore = process.memoryUsage();
      console.log(`\n📊 Before operation:`);
      console.log(`  Heap Used: ${(memBefore.heapUsed / 1024 / 1024).toFixed(2)} MB`);

      // Start performance timer
      const startTime = performance.now();

      // Call getEntryMetadatas() method
      const metadatas = await advZlib.getEntryMetadatas(nestedZipPath);

      // Stop timer and calculate elapsed time
      const elapsed = performance.now() - startTime;

      // Capture memory usage after operation
      if (global.gc) {
        global.gc();
      }
      const memAfter = process.memoryUsage();
      const heapUsedDelta = (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024;

      // Log results
      console.log(`\n✓ getEntryMetadatas() completed in ${(elapsed / 1000).toFixed(3)} seconds`);
      console.log(`✓ Retrieved ${metadatas.length} entries`);
      console.log(`\n📊 After operation:`);
      console.log(`  Heap Used: ${(memAfter.heapUsed / 1024 / 1024).toFixed(2)} MB`);
      console.log(`\n📊 Delta:`);
      console.log(`  Heap Used Delta: ${heapUsedDelta.toFixed(2)} MB`);

      // Verify we got all entries
      expect(metadatas.length).toBe(ENTRY_COUNT);

      // Verify entries have valid metadata properties
      expect(metadatas[0]).toHaveProperty('fileName');
      expect(metadatas[0]).toHaveProperty('compressedSize');
      expect(metadatas[0]).toHaveProperty('uncompressedSize');
      expect(metadatas[0]).toHaveProperty('crc32');
      expect(metadatas[0]).toHaveProperty('compressionMethod');

      // Verify at least one entry has the expected long name pattern
      const hasLongNames = metadatas.some((m) => m.fileName.length >= MIN_ENTRY_NAME_LENGTH);
      expect(hasLongNames).toBe(true);

      // Assert execution time < 1 seconds (faster than nested case)
      expect(elapsed).toBeLessThan(1000); // 1 seconds in milliseconds

      // Calculate expected memory usage
      // CD size is approximately 22MB for 150k entries
      // Each entry metadata object: ~158 bytes (100 for name + 50 for object + 8 for pointer)
      const estimatedCdSizeMB = 22;
      const entryMetadatasSizeMB = (ENTRY_COUNT * 158) / 1024 / 1024;
      const maxAllowedMemoryMB = estimatedCdSizeMB + entryMetadatasSizeMB + 5; // +5MB buffer

      console.log(
        `\n⚠️  Memory assertion: heapUsedDelta (${heapUsedDelta.toFixed(2)} MB) should be < ${maxAllowedMemoryMB.toFixed(2)} MB (estimatedCdSizeMB: ${estimatedCdSizeMB.toFixed(2)} MB + entryMetadatasSizeMb: ${entryMetadatasSizeMB.toFixed(2)} MB + 5MB buffer)`,
      );
      expect(heapUsedDelta).toBeLessThan(maxAllowedMemoryMB);
    },
    30 * 1000,
  ); // 30 second timeout for the test

  it(
    'should read() last entry from non-nested zip under 1 seconds',
    async () => {
      const advZlib = new AdvZlib({ logger: console });
      const filePath = `${nestedZipPath}/${lastEntryName}`;

      console.log(`\nReading last entry from non-nested zip: ${filePath}`);

      const startTime = performance.now();
      const buffer = await advZlib.read(filePath);
      const elapsed = performance.now() - startTime;

      console.log(`\n✓ read() completed in ${(elapsed / 1000).toFixed(3)} seconds`);
      console.log(`✓ Buffer size: ${(buffer.length / 1024).toFixed(2)} KB`);

      // Verify we got a buffer with data
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(0);

      // Assert execution time < 1 seconds
      expect(elapsed).toBeLessThan(1000); // 1 seconds in milliseconds
    },
    30 * 1000,
  ); // 30 second timeout for the test

  it(
    'should extract() last entry from non-nested zip under 1 seconds',
    async () => {
      const advZlib = new AdvZlib({ logger: console });
      const filePath = `${nestedZipPath}/${lastEntryName}`;
      const tempDir = join(os.tmpdir(), `adv-zlib-extract-test-${Date.now()}`);

      try {
        await mkdir(tempDir, { recursive: true });
        console.log(`\nExtracting last entry from non-nested zip: ${filePath}`);
        console.log(`Extracting to temp directory: ${tempDir}`);

        const startTime = performance.now();
        await advZlib.extract(filePath, tempDir);
        const elapsed = performance.now() - startTime;

        console.log(`\n✓ extract() completed in ${(elapsed / 1000).toFixed(3)} seconds`);

        // Verify file was extracted
        const extractedPath = join(tempDir, lastEntryName);
        const extractedExists = await fileExists(extractedPath);
        expect(extractedExists).toBe(true);

        const stats = await stat(extractedPath);
        console.log(`✓ Extracted file size: ${(stats.size / 1024).toFixed(2)} KB`);

        // Assert execution time < 1 seconds
        expect(elapsed).toBeLessThan(1000); // 1 seconds in milliseconds
      } finally {
        // Cleanup temp directory
        await rm(tempDir, { recursive: true, force: true });
        console.log(`Cleaned up temp directory: ${tempDir}`);
      }
    },
    30 * 1000,
  ); // 30 second timeout for the test
});
