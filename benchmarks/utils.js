import archiver from 'archiver';
import fs from 'node:fs';
import crypto from 'node:crypto';

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

/**
 * Creates a zip file with specified number of entries and target total size
 * @param {Object} options Configuration options for generating the zip file
 * @param {number} options.targetSizeInBytes Total size of all files combined
 * @param {number} options.entriesCount Number of entries to create
 * @param {string} options.outputPath Path where to save the zip file
 * @returns {Promise<void>} Promise that resolves when the zip file is created
 */
export async function generateManyEntriesZipFile(options) {
  const { targetSizeInBytes, entriesCount, outputPath } = options;

  console.log(`Starting zip file generation:
  - Target Size: ${(targetSizeInBytes / 1024 / 1024).toFixed(2)} MB
  - Entries Count: ${entriesCount.toLocaleString()}
  - Output Path: ${outputPath}
`);

  // Calculate average file size to achieve target total size
  const averageFileSize = Math.floor(targetSizeInBytes / entriesCount);
  console.log(`Average file size will be: ${(averageFileSize / 1024).toFixed(2)} KB`);

  try {
    // Create output stream
    console.log('Creating output stream...');
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', {
      zlib: { level: 6 },
    });

    // Set up archive error handling
    archive.on('error', (err) => {
      console.error('Error during archiving:', err);
      throw err;
    });

    // Log archive progress
    archive.on('progress', (progress) => {
      const entriesProcessed = progress.entries.processed;
      console.log(`Progress: ${entriesProcessed.toLocaleString()}/${entriesCount.toLocaleString()} entries`);
    });

    // Pipe archive data to the output file
    archive.pipe(output);

    console.log('Starting to add files to archive...');
    const progressInterval = Math.max(1, Math.floor(entriesCount / 20)); // Log every 5% progress

    // Create specified number of entries
    for (let i = 0; i < entriesCount; i++) {
      const fileName = generateRandomFileName('.txt');
      const content = generateRandomContent(averageFileSize);
      archive.append(content, { name: fileName });

      // Log progress every 5%
      if ((i + 1) % progressInterval === 0) {
        const percentage = (((i + 1) / entriesCount) * 100).toFixed(1);
        console.log(`Added ${(i + 1).toLocaleString()} files (${percentage}%)`);
      }
    }

    console.log('All files added, finalizing archive...');

    // Finalize the archive
    await archive.finalize();

    // Wait for the output stream to finish
    await new Promise((resolve, reject) => {
      output.on('close', () => {
        const finalSize = fs.statSync(outputPath).size;
        console.log(`
Zip file generation completed successfully:
- Final Size: ${(finalSize / 1024 / 1024).toFixed(2)} MB
- Total Entries: ${entriesCount.toLocaleString()}
- Location: ${outputPath}
`);
        resolve();
      });
      output.on('error', reject);
    });
  } catch (error) {
    console.error('Failed to generate zip file:', error);
    throw error;
  }
}
