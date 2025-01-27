import fs from 'node:fs';
import path from 'node:path';
import { generateManyEntriesZipFile } from './utils.js';

const ASSETS_DIR = path.join(__dirname, 'assets');
const MANY_ENTRIES_ZIP_FILE = path.join(ASSETS_DIR, 'many_entries_10k.zip');
const BIG_NESTED_ZIP_FILE = path.join(ASSETS_DIR, 'big_nested.zip');  

async function setupAssets() {
  if (!fs.existsSync(MANY_ENTRIES_ZIP_FILE)) {
    await generateManyEntriesZipFile({
      targetSizeInBytes: 1 * 1024 * 1024 * 1024, // 1GB
      entriesCount: 10000,
      outputPath: MANY_ENTRIES_ZIP_FILE,
    });
  }
}

async function runBenchmark() {
  await setupAssets();
  await run();
}

async function run() {
  const zip = new AdvZlib();
}
