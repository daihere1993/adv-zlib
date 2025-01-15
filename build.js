import { exec } from 'child_process';
import { promisify } from 'util';
import { readdir, rename } from 'fs/promises';
import { join } from 'path';

const execAsync = promisify(exec);

async function renameCJSFiles(directory) {
  const files = await readdir(directory);
  for (const file of files) {
    if (file.endsWith('.js')) {
      const oldPath = join(directory, file);
      const newPath = join(directory, file.replace('.js', '.cjs'));
      await rename(oldPath, newPath);
    }
  }
}

async function build() {
  try {
    // Build MJS version
    console.log('Building ESM version...');
    await execAsync('npx tsc -p tsconfig.esm.json');
    
    // Build CJS version
    console.log('Building CJS version...');
    await execAsync('npx tsc -p tsconfig.cjs.json');
    
    // Rename CJS files
    console.log('Renaming CJS files...');
    await renameCJSFiles('./dist/cjs');
    
    console.log('Build completed successfully');
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build();
