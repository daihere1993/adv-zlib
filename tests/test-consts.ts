import path from 'node:path';

interface PerformanceTestCase {
  label: string;
  src: string;
  getEntriesPath?: string;
  readFilePath: string;
  expectations: {
    memoryUsage: number;
    consumingTime: number;
  };
}

const BIG_SIZE_ZIP = path.join(process.cwd(), 'assets/big_size.zip');
const BIG_SIZE_NESTED_ZIP = path.join(process.cwd(), 'assets/big_nested.zip');
const BIG_SIZE_WITH_MANY_ENTRIES_ZIP = path.join(process.cwd(), 'assets/big_size_with_many_entries.zip');

const bigSizeZip: PerformanceTestCase = {
  label: 'big_size_zip(1.04G)',
  src: BIG_SIZE_ZIP,
  readFilePath: path.join(BIG_SIZE_ZIP, 'snapshot_file_list.txt'),
  expectations: {
    memoryUsage: 50 * 1024 * 1024, // 50MB
    consumingTime: 500, // 0.5s
  },
};

const bigNestedZip: PerformanceTestCase = {
  label: 'big_size_nested_zip(1.04G)',
  src: BIG_SIZE_NESTED_ZIP,
  getEntriesPath: path.join(BIG_SIZE_NESTED_ZIP, 'Snapshot_MRBTS-1932_TL1932_SBTS24R2_ENB_0000_000709_1220923_20240806-2244.zip'),
  readFilePath: path.join(
    BIG_SIZE_NESTED_ZIP,
    'Snapshot_MRBTS-1932_TL1932_SBTS24R2_ENB_0000_000709_1220923_20240806-2244.zip',
    'snapshot_file_list.txt'
  ),
  expectations: {
    memoryUsage: 50 * 1024 * 1024, // 50MB
    consumingTime: 10000, // 10s
  },
};

const bigSizeWithManyEntriesZip: PerformanceTestCase = {
  label: 'big_size_with_many_entries_zip(1.04G)',
  src: BIG_SIZE_WITH_MANY_ENTRIES_ZIP,
  getEntriesPath: path.join(BIG_SIZE_WITH_MANY_ENTRIES_ZIP),
  readFilePath: path.join(
    BIG_SIZE_WITH_MANY_ENTRIES_ZIP,
    'Pre_Snapshot_MRBTS-80584_CGG51368I_SBTS24R1_ENB_0000_000962_100016_20240816-1656',
    'snapshot_file_list.txt'
  ),
  expectations: {
    memoryUsage: 100 * 1024 * 1024, // 100MB
    consumingTime: 10000, // 10s
  },
};

export const performanceTestCases: PerformanceTestCase[] = [bigSizeZip, bigNestedZip, bigSizeWithManyEntriesZip];
