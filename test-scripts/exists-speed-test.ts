#!/usr/bin/env tsx

import { AdvZlib } from '../src/adv-zlib';
import { performance } from 'node:perf_hooks';

const TEST_PATH =
  '/Users/zowu/Downloads/Rain-04956542-Snapshot_MRBTS-1062339_NMW04632B_SBTS25R2_ENB_0000_000297_000069_20250907-1402.zip.scrambled.zip-20p4py.zip/Snapshot_MRBTS-1062339_NMW04632B_SBTS25R2_ENB_0000_000297_000069_20250907-1402.zip.scrambled.zip';

async function runSpeedTest() {
  console.log('='.repeat(80));
  console.log('AdvZlib exists() Speed Test (TypeScript - Direct Source Import)');
  console.log('='.repeat(80));
  console.log();
  console.log(`Test Path: ${TEST_PATH}`);
  console.log();

  const advZlib = new AdvZlib({
    logger: console,
  });

  const times: number[] = [];
  let result = false;

  console.log('Running test...\n');

  const start = performance.now();
  try {
    // result = await advZlib.exists(TEST_PATH);
    const metadatas = await advZlib.getEntryMetadatas(TEST_PATH);
    const end = performance.now();
    const duration = end - start;
    times.push(duration);

    console.log(`${duration.toFixed(3)} ms - ${metadatas.length} entries`);
    // console.log(`${duration.toFixed(3)} ms - File ${result ? 'EXISTS' : 'NOT FOUND'}`);
  } catch (error) {
    console.error(`ERROR - ${error instanceof Error ? error.message : String(error)}`);
  }

  if (times.length > 0) {
    console.log();
    console.log('-'.repeat(80));
    console.log('Result:');
    console.log('-'.repeat(80));
    console.log(`Execution time: ${times[0].toFixed(3)} ms`);
    console.log(`File ${result ? 'EXISTS' : 'DOES NOT EXIST'}`);
  }

  console.log();
  console.log('='.repeat(80));
}

// Run the test
runSpeedTest().catch((error) => {
  console.error('Test failed with error:');
  console.error(error);
  process.exit(1);
});
