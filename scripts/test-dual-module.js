import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function runTest(command, args) {
  return new Promise((resolve, reject) => {
    console.log(`\nRunning: ${command} ${args.join(' ')}`);
    console.log('-'.repeat(50));

    const child = spawn(command, args, {
      stdio: 'inherit',
      cwd: projectRoot
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Test failed with exit code ${code}`));
      }
    });
  });
}

async function main() {
  try {
    // Test CommonJS
    await runTest('node', ['./examples/dual-module-support/cjs/test-cjs.cjs']);
    
    // Test ESM
    await runTest('node', ['./examples/dual-module-support/esm/test-esm.js']);
    
    console.log('\nAll tests passed successfully! ✨');
  } catch (error) {
    console.error('\nTest failed:', error.message);
    process.exit(1);
  }
}

main();
