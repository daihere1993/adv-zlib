#!/usr/bin/env tsx

import { AdvZlib } from '../src/adv-zlib';
import { performance } from 'node:perf_hooks';

const TEST_PATH =
  '/Users/zowu/Nokia/dev/logs/test_snapshot/vdu/Snapshot_MRBTS-11162_5gvDU_TL171_vDUCNF25R1_0.300.25526_20240920-fault4261.zip/rcplog_20240920040249.zip/symptomreport/log_data/logs.zip';

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
    result = await advZlib.exists(TEST_PATH);
    // const metadatas = await advZlib.getEntryMetadatas(TEST_PATH);
    const end = performance.now();
    const duration = end - start;
    times.push(duration);

    // console.log(`${duration.toFixed(3)} ms - ${metadatas.length} entries`);
    console.log(`${duration.toFixed(3)} ms - File ${result ? 'EXISTS' : 'NOT FOUND'}`);
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
