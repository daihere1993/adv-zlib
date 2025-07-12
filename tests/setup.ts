import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import archiver from 'archiver';
import { debug, info, warn, error } from './test-utils';

/**
 * Generates a random string of specified size
 */
function generateRandomContent(size) {
  return crypto
    .randomBytes(Math.ceil(size / 2))
    .toString('hex')
    .slice(0, size);
}

/**
 * Generates a random file name with extension
 */
function generateRandomFileName(extension = '') {
  const name = crypto.randomBytes(8).toString('hex');
  return `${name}${extension}`;
}

interface GenerateZipOptions {
  targetSizeInBytes: number;
  entriesCount: number;
  outputPath: string;
  specificFiles?: string[];
}

/**
 * Creates a zip file with specified number of entries and target total size
 * @param options Configuration options for generating the zip file
 * @returns Promise that resolves when the zip file is created
 */
export async function generateBigSizeZipFile(options: GenerateZipOptions): Promise<void> {
  const { targetSizeInBytes, entriesCount, outputPath, specificFiles } = options;

  debug(`Starting zip file generation:
  - Target Size: ${(targetSizeInBytes / 1024 / 1024).toFixed(2)} MB
  - Entries Count: ${entriesCount.toLocaleString()}
  - Output Path: ${outputPath}
  ${specificFiles ? `- Specific Files: ${specificFiles.join(', ')}` : ''}
`);

  // Calculate average file size to achieve target total size
  const averageFileSize = Math.floor(targetSizeInBytes / entriesCount);
  debug(`Average file size will be: ${(averageFileSize / 1024).toFixed(2)} KB`);

  try {
    // Create output stream
    debug('Creating output stream...');
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', {
      zlib: { level: 6 },
    });

    // Set up archive error handling
    archive.on('error', (err) => {
      error('Error during archiving:', err);
      throw err;
    });

    // Log archive progress
    archive.on('progress', (progress) => {
      const entriesProcessed = progress.entries.processed;
      debug(`Progress: ${entriesProcessed.toLocaleString()}/${entriesCount.toLocaleString()} entries`);
    });

    // Pipe archive data to the output file
    archive.pipe(output);

    debug('Starting to add files to archive...');
    const progressInterval = Math.max(1, Math.floor(entriesCount / 20)); // Log every 5% progress

    // Generate random positions for specific files
    const specificFilePositions = specificFiles
      ? Array.from({ length: specificFiles.length }, () => Math.floor(Math.random() * entriesCount))
      : [];

    // Sort positions to make lookup faster
    specificFilePositions.sort((a, b) => a - b);

    // Create specified number of entries
    for (let i = 0; i < entriesCount; i++) {
      const positionIndex = specificFilePositions.indexOf(i);
      const fileName = positionIndex !== -1 ? specificFiles![positionIndex] : generateRandomFileName('.txt');
      const content = generateRandomContent(averageFileSize);
      archive.append(content, { name: fileName });

      // Log progress every 5%
      if ((i + 1) % progressInterval === 0) {
        const percentage = (((i + 1) / entriesCount) * 100).toFixed(1);
        debug(`Added ${(i + 1).toLocaleString()} files (${percentage}%)`);
      }
    }

    debug('All files added, finalizing archive...');

    // Finalize the archive
    await archive.finalize();

    // Wait for the output stream to finish
    await new Promise((resolve, reject) => {
      output.on('close', () => {
        const finalSize = fs.statSync(outputPath).size;
        debug(`
Zip file generation completed successfully:
- Final Size: ${(finalSize / 1024 / 1024).toFixed(2)} MB
- Total Entries: ${entriesCount.toLocaleString()}
- Location: ${outputPath}
${specificFiles ? `- Specific Files Positions: ${specificFilePositions.join(', ')}` : ''}
`);
        resolve(null);
      });
      output.on('error', reject);
    });
  } catch (err) {
    error('Error creating zip file:', err);
    throw err;
  }
}


async function createZip64File(path: string) {
  await generateBigSizeZipFile({
    targetSizeInBytes: 1 * 1024 * 1024 * 1024, // 1GB
    entriesCount: 65536,
    outputPath: path,
    specificFiles: ['foo.txt'],
  });
}

export const assetsFiles = {
  zip64: path.join(__dirname, 'assets', 'zip64.zip'),
}

export async function createPermanentAssets() {
  const baseDir = path.join(__dirname, 'assets');

  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  if (!fs.existsSync(assetsFiles.zip64)) {
    await createZip64File(assetsFiles.zip64);
  }
}