import fs from 'node:fs';

// Simple utility functions since the original imports don't exist
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

interface MemoryUsage {
  heapUsed: number;
  external: number;
  heapTotal: number;
  rss: number;
}

export interface TimingStats {
  mean: number;
  median: number;
  stdDev: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
}

export interface PerformanceResult {
  operation: string;
  timings: number[];
  result: number;
}

export const DEFAULT_TIMEOUT = 30000; // 30 seconds
export const EXTENDED_TIMEOUT = 60000; // 60 seconds

export interface TimedFunction<T> {
  (...args: any[]): Promise<T>;
}

export async function measurePerformance<T>(
  operation: string,
  fn: TimedFunction<T>,
): Promise<PerformanceResult> {
  const timings: number[] = [];

  const start = performance.now();
  await fn();
  const end = performance.now();
  timings.push(end - start);

  return {
    operation,
    timings,
    result: end - start
  };
}

export function validateTestData(paths: string[]): boolean {
  for (const path of paths) {
    if (!fs.existsSync(path)) {
      return false;
    }
  }
  return true;
}

export async function measureMemoryWithBaseline(
  operation: string,
  fn: () => Promise<any>,
  logger: Console
): Promise<MemoryUsage> {
  if (global.gc) {
    global.gc();
  }

  const baseline = process.memoryUsage();
  await fn();
  const after = process.memoryUsage();

  const delta = {
    heapUsed: after.heapUsed - baseline.heapUsed,
    external: after.external - baseline.external,
    heapTotal: after.heapTotal - baseline.heapTotal,
    rss: after.rss - baseline.rss,
  };

  logger.log(`[Memory Delta ${operation}]`, {
    heapUsedDelta: formatBytes(delta.heapUsed),
    externalDelta: formatBytes(delta.external),
    totalDelta: formatBytes(delta.heapUsed + delta.external),
  });

  return delta;
}

export async function detectMemoryLeak(operation: string, fn: () => Promise<any>, iterations: number = 5): Promise<boolean> {
  const memoryMeasurements: number[] = [];

  for (let i = 0; i < iterations; i++) {
    if (global.gc) {
      global.gc();
    }

    const before = process.memoryUsage().heapUsed;
    await fn();
    if (global.gc) {
      global.gc();
    }
    const after = process.memoryUsage().heapUsed;
    memoryMeasurements.push(after - before);
  }

  // Check if memory usage is consistently increasing
  let isIncreasing = true;
  for (let i = 1; i < memoryMeasurements.length; i++) {
    if (memoryMeasurements[i] <= memoryMeasurements[i - 1]) {
      isIncreasing = false;
      break;
    }
  }

  return isIncreasing;
}

/**
 * Configurable test logger for controlling console output during tests
 */
export class TestLogger {
  private static instance: TestLogger;
  private verbose: boolean;
  private silent: boolean;

  private constructor() {
    this.verbose = process.env.TEST_VERBOSE === 'true';
    this.silent = process.env.TEST_SILENT === 'true';
  }

  static getInstance(): TestLogger {
    if (!TestLogger.instance) {
      TestLogger.instance = new TestLogger();
    }
    return TestLogger.instance;
  }

  log(message: string, ...args: any[]): void {
    if (!this.silent) {
      console.log(message, ...args);
    }
  }

  warn(message: string, ...args: any[]): void {
    if (!this.silent) {
      console.warn(message, ...args);
    }
  }

  error(message: string, ...args: any[]): void {
    if (!this.silent) {
      console.error(message, ...args);
    }
  }

  debug(message: string, ...args: any[]): void {
    if (this.verbose && !this.silent) {
      console.log(`[DEBUG] ${message}`, ...args);
    }
  }

  info(message: string, ...args: any[]): void {
    if (this.verbose && !this.silent) {
      console.log(`[INFO] ${message}`, ...args);
    }
  }

  progress(message: string): void {
    if (this.verbose && !this.silent) {
      process.stdout.write(`\r${message}`);
    }
  }

  clearProgress(): void {
    if (this.verbose && !this.silent) {
      process.stdout.write('\n');
    }
  }
}

// Convenience functions
export const testLogger = TestLogger.getInstance();

export const log = (message: string, ...args: any[]) => testLogger.log(message, ...args);
export const warn = (message: string, ...args: any[]) => testLogger.warn(message, ...args);
export const error = (message: string, ...args: any[]) => testLogger.error(message, ...args);
export const debug = (message: string, ...args: any[]) => testLogger.debug(message, ...args);
export const info = (message: string, ...args: any[]) => testLogger.info(message, ...args);
export const progress = (message: string) => testLogger.progress(message);
export const clearProgress = () => testLogger.clearProgress();
