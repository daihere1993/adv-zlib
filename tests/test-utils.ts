import fs from 'node:fs';
import { formatBytes } from '../src/utils';
import { MemoryUsage } from '../src/types.js';

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
