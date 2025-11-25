#!/usr/bin/env tsx

import { AdvZlib } from '../src/adv-zlib';
import { performance } from 'node:perf_hooks';

const TEST_PATH =
  '/Users/zowu/Nokia/dev/repos/p_projects/oam-kit/test-assets/scrambled.zip/Pre_Snapshot_MRBTS-80584_CGG51368I_SBTS24R1_ENB_0000_000962_100016_20240816-1656/snapshot_file_list.txt';

async function runReadTest() {
  console.log('='.repeat(80));
  console.log('AdvZlib read() Test (TypeScript - Direct Source Import)');
  console.log('='.repeat(80));
  console.log();
  console.log(`Test Path: ${TEST_PATH}`);
  console.log();

  const advZlib = new AdvZlib({
    logger: {
      debug: () => {}, // Suppress debug logs for cleaner output
      info: console.info,
      warn: console.warn,
      error: console.error,
    },
  });

  console.log('Running test...\n');

  const start = performance.now();
  try {
    const buffer = await advZlib.read(TEST_PATH);
    const end = performance.now();
    const duration = end - start;

    console.log(`Execution time: ${duration.toFixed(3)} ms`);
    console.log(`Buffer size: ${buffer.length} bytes (${(buffer.length / 1024).toFixed(2)} KB)`);
    console.log();

    // Show first 100 bytes as hex preview
    const previewLength = Math.min(100, buffer.length);
    const preview = buffer.subarray(0, previewLength);
    const hexPreview = Array.from(preview)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');
    console.log(`First ${previewLength} bytes (hex):`);
    console.log(hexPreview);
    console.log();

    // Show first 100 bytes as ASCII preview (if printable)
    const asciiPreview = Array.from(preview)
      .map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.'))
      .join('');
    console.log(`First ${previewLength} bytes (ASCII):`);
    console.log(asciiPreview);
  } catch (error) {
    const end = performance.now();
    const duration = end - start;
    console.error(`ERROR after ${duration.toFixed(3)} ms`);
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }

  console.log();
  console.log('='.repeat(80));
}

// Run the test
runReadTest().catch((error) => {
  console.error('Test failed with error:');
  console.error(error);
  process.exit(1);
});
