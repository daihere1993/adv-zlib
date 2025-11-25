import { describe, it, expect, beforeAll } from 'vitest';
import { llzlib, ZipEntry } from '../../src/llzlib';
import { mkdir, access, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import archiver from 'archiver';
import { createWriteStream } from 'node:fs';

// Get the directory of this test file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Test configuration - use fixtures directory in the project
const fixturesDir = join(__dirname, 'fixtures');
let parentZipPath: string;
let nestedZipPath: string;

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
 */
async function generateLargeNestedZip(nestZipPath: string, entryCount: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(nestZipPath);
    const archive = archiver('zip', {
      zlib: { level: 9 },
    });

    let processedEntries = 0;
    const logInterval = 1000; // Log every 1000 entries

    output.on('close', () => {
      console.log(`\nCompleted: Generated ${entryCount} entries in nested zip`);
      resolve();
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

      archive.append(entryContent, { name: `${longName}.txt` });

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

describe('llzlib Performance Tests', () => {
  beforeAll(
    async () => {
      // Define paths
      nestedZipPath = join(fixturesDir, 'nest.zip');
      parentZipPath = join(fixturesDir, 'a.zip');

      // Check if fixtures already exist
      const nestedExists = await fileExists(nestedZipPath);
      const parentExists = await fileExists(parentZipPath);

      if (nestedExists && parentExists) {
        console.log('\n✓ Found existing test fixtures in:', fixturesDir);

        // Validate the existing fixtures
        const nestedStats = await stat(nestedZipPath);
        console.log(`  - nest.zip: ${(nestedStats.size / 1024 / 1024).toFixed(2)} MB`);

        const parentStats = await stat(parentZipPath);
        console.log(`  - a.zip: ${(parentStats.size / 1024 / 1024).toFixed(2)} MB`);

        console.log('Skipping fixture generation (delete fixtures folder to regenerate)\n');
        return;
      }

      // Create fixtures directory
      await mkdir(fixturesDir, { recursive: true });
      console.log('\nFixtures directory:', fixturesDir);

      // Generate the large nested zip (this will take several minutes)
      console.log('Generating large nested zip file (this may take several minutes)...');
      await generateLargeNestedZip(nestedZipPath, ENTRY_COUNT);

      // Create the parent zip containing the nested zip
      console.log('Creating parent zip file...');
      await createZip(parentZipPath, {
        'nest.zip': await import('node:fs/promises').then((fs) => fs.readFile(nestedZipPath)),
      });

      console.log('Test fixtures ready! (Cached for future test runs)\n');
    },
    10 * 60 * 1000,
  ); // 10 minute timeout for beforeAll

  it(
    'should get all entry metadatas from 1GB+ nested zip with 150k entries under 10 seconds',
    async () => {
      // 1. Open the parent a.zip
      const zipFile = await llzlib.open(parentZipPath);

      try {
        // 2. Find the nest.zip entry
        let nestZipEntry: ZipEntry | null = null;
        for (let i = 0; i < zipFile.entryCount; i++) {
          const entry = await zipFile.nextEntry();
          if (entry.fileName === 'nest.zip') {
            nestZipEntry = entry;
            break;
          }
        }

        expect(nestZipEntry).not.toBeNull();
        if (!nestZipEntry) {
          throw new Error('nest.zip entry not found');
        }

        // 3. Verify nest.zip size is > 1GB
        console.log(
          `nest.zip uncompressed size: ${(nestZipEntry.uncompressedSize / 1024 / 1024 / 1024).toFixed(2)} GB`,
        );
        expect(nestZipEntry.uncompressedSize).toBeGreaterThan(TARGET_SIZE_BYTES);

        // 4. Get file size
        const fileSize = nestZipEntry.uncompressedSize;

        // 5. Capture memory usage before operation
        if (global.gc) {
          global.gc(); // Force garbage collection if --expose-gc flag is set
        }
        const memBefore = process.memoryUsage();
        console.log(`\n📊 Before operation:`);
        console.log(`  Heap Used: ${(memBefore.heapUsed / 1024 / 1024).toFixed(2)} MB`);

        // 6. Start performance timer
        const startTime = performance.now();

        // 7. Call createCdFromInflatedStream with stream factory for dynamic retry
        const retry = 3;
        // The cd size is 22MB, if default size less than it then need to re-inflate twice and each inflation consuming around 4-5s
        // So we use 30MB as default size to avoid re-inflation twice
        const defaultSize = 30 * 1024 * 1024; // 30MB
        const { cd, cdSize } = await llzlib.createCdFromInflatedStream(
          () => nestZipEntry.createReadStream(), // Stream factory allows re-inflation on retry
          fileSize,
          {
            defaultSize,
            retry,
            logger: console,
          },
        );

        // 7.1 Get all entry metadatas
        const entries = await cd.getAllEntryMetadatas();
        expect(entries).toHaveLength(ENTRY_COUNT);

        // 8. Stop timer and calculate elapsed time
        const elapsed = performance.now() - startTime;

        // 9. Capture memory usage after operation
        if (global.gc) {
          global.gc();
        }
        const memAfter = process.memoryUsage();
        const heapUsedDelta = (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024;

        // 10. Verify results
        console.log(`\n✓ CD extraction completed in ${(elapsed / 1000).toFixed(3)} seconds`);
        console.log(`✓ Entry count: ${cd.entryCount}`);
        if (cdSize) {
          console.log(`✓ CD size: ${(cdSize / 1024 / 1024).toFixed(2)} MB`);
        }
        console.log(`\n📊 After operation:`);
        console.log(`  Hepp Used: ${(memAfter.heapUsed / 1024 / 1024).toFixed(2)} MB`);

        console.log(`\n📊 Delta:`);
        console.log(`  Heap Used Delta: ${heapUsedDelta.toFixed(2)} MB`);

        expect(cd.entryCount).toBe(ENTRY_COUNT);
        expect(elapsed).toBeLessThan(10000); // Must complete in under 10 seconds

        // Memory should less than cd.size
        const cdSizeMB = (cd.size / 1024 / 1024).toFixed(2);
        // 100 bytes for name, 50 bytes for each entry object, 8 bytes for each array pointer
        const entryMetadatasSizeMb = ((ENTRY_COUNT * (100 + 50 + 8)) / 1024 / 1024).toFixed(2);
        const maxAllowedMemoryMB = Number(cdSizeMB) + Number(entryMetadatasSizeMb);
        console.log(
          `\n⚠️  Memory assertion: heapUsedDelta (${heapUsedDelta.toFixed(2)} MB) should be < ${maxAllowedMemoryMB} MB(cdSizeMB: ${cdSizeMB} MB + entryMetadatasSizeMb: ${entryMetadatasSizeMb} MB)`,
        );
        expect(heapUsedDelta).toBeLessThan(Number(maxAllowedMemoryMB));
      } finally {
        // 11. Close the zip file
        zipFile.close();
      }
    },
    30 * 1000,
  ); // 30 second timeout for the test
});
