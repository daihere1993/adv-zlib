#!/usr/bin/env node

/**
 * Performance Test Runner for RefactoredAdvZlib
 * 
 * This script provides convenient commands for running performance tests
 * with different large ZIP configurations.
 */

const { spawn } = require('child_process');
const path = require('path');

const configurations = {
  quick: {
    size: '100',
    description: 'Quick test with 100MB large ZIP (fast)',
    estimatedTime: '1-2 minutes'
  },
  medium: {
    size: '500', 
    description: 'Medium test with 500MB large ZIP',
    estimatedTime: '3-5 minutes'
  },
  full: {
    size: '2048',
    description: 'Full test with 2GB large ZIP (realistic)',
    estimatedTime: '10-15 minutes'
  },
  extreme: {
    size: '5120',
    description: 'Extreme test with 5GB large ZIP (stress test)',
    estimatedTime: '20-30 minutes'
  }
};

function printUsage() {
  console.log('🧪 RefactoredAdvZlib Performance Test Runner\n');
  console.log('Usage: node scripts/test-performance.cjs <configuration>\n');
  console.log('Available configurations:\n');
  
  Object.entries(configurations).forEach(([name, config]) => {
    console.log(`  ${name.padEnd(8)} - ${config.description}`);
    console.log(`  ${' '.repeat(8)}   Size: ${config.size}MB, Estimated time: ${config.estimatedTime}\n`);
  });
  
  console.log('Examples:');
  console.log('  node scripts/test-performance.cjs quick   # Fast test for development');
  console.log('  node scripts/test-performance.cjs full    # Complete test suite');
  console.log('  node scripts/test-performance.cjs extreme # Stress test\n');
  
  console.log('You can also run tests directly with environment variables:');
  console.log('  TEST_LARGE_ZIP_SIZE_MB=1000 npm test -- tests/refactor/02-performance-comparison.test.ts');
}

function runTest(config) {
  console.log(`🚀 Running ${config.description}`);
  console.log(`📊 Large ZIP size: ${config.size}MB`);
  console.log(`⏱️  Estimated time: ${config.estimatedTime}\n`);
  
  const env = {
    ...process.env,
    TEST_LARGE_ZIP_SIZE_MB: config.size
  };
  
  const testProcess = spawn('npm', ['test', '--', 'tests/refactor/02-performance-comparison.test.ts'], {
    env,
    stdio: 'inherit',
    shell: true
  });
  
  testProcess.on('close', (code) => {
    if (code === 0) {
      console.log('\n✅ Performance tests completed successfully!');
    } else {
      console.log('\n❌ Performance tests failed with exit code:', code);
    }
    process.exit(code);
  });
  
  testProcess.on('error', (error) => {
    console.error('\n❌ Failed to start test process:', error);
    process.exit(1);
  });
}

// Main execution
const configName = process.argv[2];

if (!configName) {
  printUsage();
  process.exit(1);
}

const config = configurations[configName];

if (!config) {
  console.error(`❌ Unknown configuration: ${configName}\n`);
  printUsage();
  process.exit(1);
}

runTest(config); 