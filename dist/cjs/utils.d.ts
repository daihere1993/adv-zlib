import { Logger, MemoryUsage } from './types/index.js';
/**
 * Ensure that a directory exists, creating it if necessary
 * @param dirPath The path to the directory
 */
export declare function ensureDirectoryExists(dirPath: string): Promise<void>;
export declare function formatBytes(bytes: number): string;
export declare function testMemoryUsage<T>(label: string, fn: () => Promise<T>, logger: Logger, expectFn?: (memoryUsage: MemoryUsage) => void): Promise<T>;
