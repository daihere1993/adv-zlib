import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AdvZlib } from "../src/adv-zlib";
import { formatBytes, testMemoryUsage } from "../src/utils";

const BASE_DIR = path.join(__dirname, "performance");
const CACHE_DIR = path.join(BASE_DIR, "cache");
const EXTRACT_FOLDER = path.join(BASE_DIR, "assets/extract");
const BIG_SIZE_ZIP = path.join(process.cwd(), "assets/big_size.zip");
const BIG_NESTED_ZIP = path.join(process.cwd(), "assets/big_nested.zip");
const BIG_SIZE_WITH_MANY_ENTRIES_ZIP = path.join(
  process.cwd(),
  "assets/big_size_with_many_entries.zip"
);

const advZlib = new AdvZlib({ cacheDir: CACHE_DIR });
const testSuitWithDifferLargeSizeFiles = [
  {
    label: "big_size_zip(1.04G)",
    src: BIG_SIZE_ZIP,
    readFile: path.join(BIG_SIZE_ZIP, "snapshot_file_list.txt"),
    peakMemoUsage: {
      getEntries: 10 * 1024 * 1024, // 10MB
      read: 10 * 1024 * 1024, // 10MB
      extract: 10 * 1024 * 1024, // 10MB
      exists: 10 * 1024 * 1024, // 10MB
    },
    // Unit: ms
    consumingTime: {
      getEntries: 500,
      read: 500,
      extract: 500,
      exists: 500,
    },
  },
  {
    label: "big_nested_zip(1.04G)",
    src: path.join(
      BIG_NESTED_ZIP,
      "Snapshot_MRBTS-1932_TL1932_SBTS24R2_ENB_0000_000709_1220923_20240806-2244.zip"
    ),
    readFile: path.join(
      BIG_NESTED_ZIP,
      "Snapshot_MRBTS-1932_TL1932_SBTS24R2_ENB_0000_000709_1220923_20240806-2244.zip",
      "snapshot_file_list.txt"
    ),
    peakMemoUsage: {
      getEntries: 1 * 1024 * 1024, // 1MB
      read: 10 * 1024 * 1024, // 10MB
      extract: 10 * 1024 * 1024, // 10MB
      exists: 10 * 1024 * 1024, // 10MB
    },
    consumingTime: {
      getEntries: 25000,
      read: 25000,
      extract: 25000,
      exists: 25000,
    },
  },
  {
    label: "big_size_with_many_entries_zip(1.62G)",
    src: BIG_SIZE_WITH_MANY_ENTRIES_ZIP,
    readFile: path.join(
      BIG_SIZE_WITH_MANY_ENTRIES_ZIP,
      "Pre_Snapshot_MRBTS-80584_CGG51368I_SBTS24R1_ENB_0000_000962_100016_20240816-1656",
      "snapshot_file_list.txt"
    ),
    peakMemoUsage: {
      getEntries: 500 * 1024 * 1024, // 500MB
      read: 500 * 1024 * 1024, // 100MB
      extract: 500 * 1024 * 1024, // 300MB
      exists: 500 * 1024 * 1024, // 500MB
    },
    consumingTime: {
      getEntries: 35000,
      read: 35000,
      extract: 35000,
      exists: 35000,
    },
  },
];

function wrapWithTiming<T extends object>(
  instance: T,
  methodsToTrack: (keyof T)[],
  timings: Record<string, string[]>
): T {
  for (const method of methodsToTrack) {
    if (typeof instance[method] === "function") {
      const originalMethod = instance[method] as (
        ...args: any[]
      ) => Promise<any>;

      // Wrap the original method to track execution time
      instance[method] = async function (...args: any[]) {
        const start = performance.now();
        const result = await originalMethod.apply(instance, args);
        const end = performance.now();

        if (timings[method as string]) {
          timings[method as string].push((end - start).toFixed(2));
        } else {
          timings[method as string] = [(end - start).toFixed(2)];
        }

        return result;
      } as T[keyof T]; // Cast back to original type
    }
  }
  return instance;
}

const timings: Record<string, string[]> = {};
const proxyInstance = wrapWithTiming(
  advZlib,
  ["getEntries", "read", "extract", "exists"],
  timings
);

describe("Performance", () => {
  describe("Consuming time", () => {
    describe.each(testSuitWithDifferLargeSizeFiles)(
      "$label",
      ({ src, readFile, consumingTime }) => {
        beforeEach(async () => {
          await fs.promises.mkdir(EXTRACT_FOLDER, { recursive: true });
        });

        afterEach(async () => {
          await proxyInstance.cleanup();
          await fs.promises.rm(BASE_DIR, { recursive: true });

          for (const key in timings) {
            for (const time of timings[key]) {
              console.log(`[Performance] ${key}: ${time}ms`);
            }
          }
        });

        test(`getEntries(): Should retrieve all entries within ${consumingTime.getEntries}ms`, async () => {
          const start = Date.now();
          const entries = await proxyInstance.getEntries(src);
          const end = Date.now();
          expect(end - start).toBeLessThan(consumingTime.getEntries);
          expect(entries.length).toBeGreaterThan(0);
        }, 60000);

        test(`getEntries(): Shoulde run 10 times constantly with ${consumingTime.getEntries}ms`, async () => {
          const start = Date.now();
          for (let i = 0; i < 10; i++) {
            const entries = await proxyInstance.getEntries(src);
            expect(entries.length).toBeGreaterThan(0);
          }
          const end = Date.now();
          expect(end - start).toBeLessThan(consumingTime.getEntries);
        }, 60000);

        test(`read(): Should read the file within ${consumingTime.read}ms`, async () => {
          const start = Date.now();
          const data = await proxyInstance.read(readFile);
          const end = Date.now();
          expect(end - start).toBeLessThan(consumingTime.read);
          expect(data.length).toBeLessThan(100 * 1024 * 1024); // 'snapshot_file_list.txt' would less than 100MB
        }, 60000);

        test(`read(): Should run 10 times constantly with ${consumingTime.read}ms`, async () => {
          const start = Date.now();
          for (let i = 0; i < 10; i++) {
            const data = await proxyInstance.read(readFile);
            expect(data.length).toBeLessThan(100 * 1024 * 1024); // 'snapshot_file_list.txt' would less than 100MB
          }
          const end = Date.now();
          expect(end - start).toBeLessThan(consumingTime.read);
        }, 60000);

        test(`extract(): Should extract one file within ${consumingTime.extract}ms`, async () => {
          const start = Date.now();
          await proxyInstance.extract(readFile, EXTRACT_FOLDER);
          const end = Date.now();
          expect(end - start).toBeLessThan(consumingTime.extract);
        }, 60000);

        test(`exists(): Should check the existence of the file within ${consumingTime.exists}ms`, async () => {
          const start = Date.now();
          const exists = await proxyInstance.exists(readFile);
          const end = Date.now();
          expect(end - start).toBeLessThan(consumingTime.exists);
          expect(exists).toBeTruthy();
        }, 60000);

        test(`exists(): Should run 10 times constantly with ${consumingTime.exists}ms`, async () => {
          const start = Date.now();
          for (let i = 0; i < 10; i++) {
            const exists = await proxyInstance.exists(readFile);
            expect(exists).toBeTruthy();
          }
          const end = Date.now();
          expect(end - start).toBeLessThan(consumingTime.exists);
        }, 60000);
      }
    );
  });

  describe("Memory usage", () => {
    async function testPeakMemoUsage(
      fn: (...args: any[]) => Promise<any>,
      expectedPeakMemoUsage: number
    ) {
      await testMemoryUsage(
        "Unit Test",
        async () => await fn(),
        console,
        (memoryUsage) => {
          console.log(
            `[Performance] Real: ${formatBytes(
              memoryUsage.heapUsed + memoryUsage.external
            )}(${formatBytes(memoryUsage.heapUsed)} + ${formatBytes(
              memoryUsage.external
            )}), Expected: ${formatBytes(expectedPeakMemoUsage)}`
          );
          expect(
            memoryUsage.heapUsed + memoryUsage.external
          ).toBeLessThanOrEqual(expectedPeakMemoUsage);
        }
      );
    }

    describe.each(testSuitWithDifferLargeSizeFiles)(
      "$label",
      ({ src, readFile, peakMemoUsage }) => {
        beforeEach(async () => {
          await fs.promises.mkdir(EXTRACT_FOLDER, { recursive: true });
        });

        afterEach(async () => {
          await advZlib.cleanup();
          await fs.promises.rm(BASE_DIR, { recursive: true });
        }, 60000);

        test(`getEntries(): memory usage should not over ${formatBytes(
          peakMemoUsage.getEntries
        )}`, async () => {
          await testPeakMemoUsage(
            advZlib.getEntries.bind(advZlib, src),
            peakMemoUsage.getEntries
          );
        }, 30000);

        test(`read(): memory usage should not over ${formatBytes(
          peakMemoUsage.read
        )}`, async () => {
          await testPeakMemoUsage(
            advZlib.read.bind(advZlib, readFile),
            peakMemoUsage.read
          );
        }, 60000);

        test(`extract(): memory usage should not over ${formatBytes(
          peakMemoUsage.extract
        )}`, async () => {
          await testPeakMemoUsage(
            advZlib.extract.bind(advZlib, readFile, EXTRACT_FOLDER),
            peakMemoUsage.extract
          );
        }, 30000);
      }
    );
  });
});
