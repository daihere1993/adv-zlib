import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AdvZlib } from '../src/adv-zlib';
import { performanceTestCases } from './test-consts';
import {
  DEFAULT_TIMEOUT,
  EXTENDED_TIMEOUT,
  PerformanceResult,
  measurePerformance,
  measureMemoryWithBaseline,
  detectMemoryLeak,
  validateTestData,
} from './test-utils';
import { formatBytes } from '../src/utils';

const BASE_DIR = path.join(__dirname, 'ut_tmp_performance');
const BASE_CACHE_DIR = path.join(BASE_DIR, 'cache');
const EXTRACT_FOLDER = path.join(BASE_DIR, 'extract');

let advZlib: AdvZlib;

describe('Performance', () => {
  const results: PerformanceResult[] = [];

  beforeAll(async () => {
    await fs.promises.mkdir(BASE_CACHE_DIR, { recursive: true });
    await fs.promises.mkdir(EXTRACT_FOLDER, { recursive: true });
  });

  afterAll(async () => {
    await fs.promises.rm(BASE_DIR, { recursive: true });
  });

  describe('Single Operation Performance', () => {
    describe.each(performanceTestCases)('$label', ({ src, getEntriesPath, readFilePath, expectations }) => {
      const isValid = validateTestData([src]);
      const cacheDir = path.join(BASE_CACHE_DIR, `1_${path.basename(src)}`);

      beforeAll(async () => {
        advZlib = new AdvZlib({ cacheDir });
      });

      afterEach(async () => {
        await advZlib.cleanup();
      });

      test.runIf(isValid)(
        `getEntries(): Should retrieve all entries within ${expectations.consumingTime}ms`,
        async () => {
          const result = await measurePerformance('getEntries', async () => {
            const entries = await advZlib.getEntries(getEntriesPath || src);
            expect(entries.length).toBeGreaterThan(0);
          });
          results.push(result);
          expect(result.result).toBeLessThan(expectations.consumingTime);
        },
        DEFAULT_TIMEOUT
      );

      test.runIf(isValid)(
        `read(): Should read the file within ${expectations.consumingTime}ms`,
        async () => {
          const result = await measurePerformance('read', async () => {
            const data = await advZlib.read(readFilePath);
            expect(data.length).toBeLessThan(100 * 1024 * 1024);
          });
          results.push(result);
          expect(result.result).toBeLessThan(expectations.consumingTime);
        },
        DEFAULT_TIMEOUT
      );

      test.runIf(isValid)(
        `extract(): Should extract one file within ${expectations.consumingTime}ms`,
        async () => {
          const result = await measurePerformance('extract', async () => {
            await advZlib.extract(readFilePath, EXTRACT_FOLDER);
          });
          results.push(result);
          expect(result.result).toBeLessThan(expectations.consumingTime);
        },
        DEFAULT_TIMEOUT
      );
    });
  });

  describe('Memory Management', () => {
    describe.each(performanceTestCases)('$label', ({ src, readFilePath: readFile, expectations }) => {
      const isValid = validateTestData([src]);

      describe.runIf(isValid)('Memory Usage', async () => {
        const cacheDir = path.join(BASE_CACHE_DIR, `2_${path.basename(src)}`);

        beforeAll(async () => {
          advZlib = new AdvZlib({ cacheDir });
        });

        afterEach(async () => {
          await advZlib.cleanup();
        });

        test(
          `getEntries() should not use more than ${formatBytes(expectations.memoryUsage)}`,
          async () => {
            const memDelta = await measureMemoryWithBaseline('getEntries', async () => await advZlib.getEntries(src), console);
            expect(memDelta.heapUsed + memDelta.external).toBeLessThanOrEqual(expectations.memoryUsage);
          },
          DEFAULT_TIMEOUT
        );

        test(
          `read() should not use more than ${formatBytes(expectations.memoryUsage)} MB`,
          async () => {
            const memDelta = await measureMemoryWithBaseline('read', async () => await advZlib.read(readFile), console);
            expect(memDelta.heapUsed + memDelta.external).toBeLessThanOrEqual(expectations.memoryUsage);
          },
          DEFAULT_TIMEOUT
        );

        test(
          `extract() should not use more than ${formatBytes(expectations.memoryUsage)} MB`,
          async () => {
            const memDelta = await measureMemoryWithBaseline(
              'extract',
              async () => await advZlib.extract(readFile, EXTRACT_FOLDER),
              console
            );
            expect(memDelta.heapUsed + memDelta.external).toBeLessThanOrEqual(expectations.memoryUsage);
          },
          DEFAULT_TIMEOUT
        );
      });

      describe.runIf(isValid)('Memory Leaks', async () => {
        const cacheDir = path.join(BASE_CACHE_DIR, `3_${path.basename(src)}`);

        beforeAll(async () => {
          advZlib = new AdvZlib({ cacheDir });
        });

        afterEach(async () => {
          await advZlib.cleanup();
        });

        test(
          `getEntries() should not leak memory over 5 iterations`,
          async () => {
            const hasLeak = await detectMemoryLeak('getEntries', async () => await advZlib.getEntries(src));
            expect(hasLeak).toBe(false);
          },
          EXTENDED_TIMEOUT
        );

        test(
          `read() should not leak memory over 5 iterations`,
          async () => {
            const hasLeak = await detectMemoryLeak('read', async () => await advZlib.read(readFile));
            expect(hasLeak).toBe(false);
          },
          EXTENDED_TIMEOUT
        );

        test(
          `extract() should not leak memory over 5 iterations`,
          async () => {
            const hasLeak = await detectMemoryLeak('extract', async () => await advZlib.extract(readFile, EXTRACT_FOLDER));
            expect(hasLeak).toBe(false);
          },
          EXTENDED_TIMEOUT
        );
      });
    });
  });
});
