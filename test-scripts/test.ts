#!/usr/bin/env tsx

import { AdvZlib } from '../src/adv-zlib';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const SOURCE_PATH =
  '/Users/zowu/Nokia/dev/logs/test_snapshot/can_not_reveal_log/scrambled.zip/Snapshot_MRBTS-988764_AG_HGH522F_GMI_SBTS24R3_ENB_0000_001402_000000_20260109-1052/';
const DEST_BASE = path.join(os.homedir(), 'Downloads', 'tmp');

async function runExtractTest() {
  console.log('='.repeat(80));
  console.log('AdvZlib extract() Test - Folder Prefix Stripping');
  console.log('='.repeat(80));
  console.log();
  console.log(`Source Folder: ${SOURCE_PATH}`);
  console.log(`Destination:   ${DEST_BASE}`);
  console.log();

  const advZlib = new AdvZlib({
    logger: {
      debug: () => {},
      info: console.info,
      warn: console.warn,
      error: console.error,
    },
  });

  // Clean destination for the test
  try {
    await fs.rm(DEST_BASE, { recursive: true, force: true });
    await fs.mkdir(DEST_BASE, { recursive: true });
    console.log(`Target directory cleaned and ready: ${DEST_BASE}`);
  } catch (err) {
    console.error(`Failed to prepare destination: ${err}`);
  }

  console.log('\nStarting extraction (prefix should be stripped)...\n');

  const start = performance.now();
  try {
    await advZlib.extract(SOURCE_PATH, DEST_BASE);
    const end = performance.now();
    
    console.log(`Extraction completed in ${(end - start).toFixed(3)} ms`);
    
    // Verification
    console.log('\nVerifying extraction (expecting items directly in DEST_BASE):');
    
    try {
      const baseFiles = await fs.readdir(DEST_BASE);
      if (baseFiles.length > 0) {
        console.log(`\nSUCCESS: Found ${baseFiles.length} items directly in ${DEST_BASE}`);
        console.log('Sample items:');
        baseFiles.slice(0, 10).forEach(f => console.log(`  - ${f}`));
        if (baseFiles.length > 10) console.log(`  ... and ${baseFiles.length - 10} more`);
        
        // Specifically check for one of the expected files
        if (baseFiles.includes('BTS988764_1011_part_1')) {
            console.log('\nCONFIRMED: "BTS988764_1011_part_1" is present at the root of the destination.');
        }
      } else {
        console.log(`\nFAILED: No files found in ${DEST_BASE}`);
      }
      
      // Check if the old folder still exists (it shouldn't be created at the root)
      const folderName = 'Snapshot_MRBTS-988764_AG_HGH522F_GMI_SBTS24R3_ENB_0000_001402_000000_20260109-1052';
      const extractedFolder = path.join(DEST_BASE, folderName);
      try {
          await fs.access(extractedFolder);
          console.log(`\nNOTE: Subfolder "${folderName}" also exists. This might be because the archive contains it as a directory entry.`);
      } catch (e) {
          console.log(`\nCONFIRMED: No extra subfolder "${folderName}" was created (prefix was stripped).`);
      }

    } catch (e) {
      console.log(`\nFAILED during verification: ${e}`);
    }

  } catch (error) {
    console.error(`\nEXTRACTION ERROR: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) {
        console.error(error.stack);
    }
    process.exit(1);
  }

  console.log();
  console.log('='.repeat(80));
}

runExtractTest();
