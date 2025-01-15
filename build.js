import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function build() {
  try {
    // Build MJS version
    console.log('Building ESM version...');
    await execAsync('npx tsc -p tsconfig.esm.json');
    
    // Build CJS version
    console.log('Building CJS version...');
    await execAsync('npx tsc -p tsconfig.cjs.json');
    
    console.log('Build completed successfully');
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build();
