import fs from 'node:fs';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';
import { Logger, MemoryUsage } from './types.js';

/**
 * Ensure that a directory exists, creating it if necessary
 * @param dirPath The path to the directory
 */
export async function ensureDirectoryExists(dirPath: string): Promise<void> {
  try {
    // check if dirPath is a directory
    await fsPromises.mkdir(dirPath, { recursive: true });
  } catch (err: any) {
    return;
  }
}

/**
 * Check if a file exists asynchronously
 * @param filePath The path to the file
 * @returns A promise that resolves to true if exists, false otherwise
 */
export async function fileOrDirExists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function formatBytes(bytes: number) {
  if (bytes < 1024 ** 2) {
    return (bytes / 1024).toFixed(2) + ' KB';
  } else if (bytes < 1024 ** 3) {
    return (bytes / 1024 ** 2).toFixed(2) + ' MB';
  } else {
    return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  }
}

export async function testMemoryUsage<T>(
  label: string,
  fn: () => Promise<T>,
  logger: Logger,
  expectFn?: (memoryUsage: MemoryUsage) => void
): Promise<T> {
  const startMemoryUsage: MemoryUsage = {
    heapUsed: process.memoryUsage().heapUsed,
    external: process.memoryUsage().external,
  };

  logger.debug(
    `[Memory]${label}() start: startHeapUsed ${formatBytes(startMemoryUsage.heapUsed)}, startExternal ${formatBytes(
      startMemoryUsage.external
    )}`
  );

  const result = await fn();
  if (global.gc) global.gc();

  const endMemoryUsage: MemoryUsage = {
    heapUsed: process.memoryUsage().heapUsed,
    external: process.memoryUsage().external,
  };

  logger.debug(
    `[Memory]${label}() end: endHeapUsed ${formatBytes(endMemoryUsage.heapUsed)}, endExternal ${formatBytes(
      endMemoryUsage.external
    )}`
  );

  const realHeapUsed = endMemoryUsage.heapUsed - startMemoryUsage.heapUsed;
  const realExternal = endMemoryUsage.external - startMemoryUsage.external;
  if (expectFn) expectFn({ heapUsed: realHeapUsed, external: realExternal });

  return result;
}

/**
 * Find or create a cache directory under node_modules/.cache
 * @param options.name The name of the cache directory
 * @returns The absolute path to the cache directory
 */
export function findCacheDirectory(options: { name: string }): string {
  const { name } = options;
  
  // Start from the current directory and look up for node_modules
  let currentDir = process.cwd();
  let prevDir = '';
  
  while (currentDir !== prevDir) {
    const nodeModulesDir = path.join(currentDir, 'node_modules');
    if (fs.existsSync(nodeModulesDir)) {
      const cacheDir = path.join(nodeModulesDir, '.cache', name);
      
      // Create cache directory if it doesn't exist
      fs.mkdirSync(cacheDir, { recursive: true });
      
      return cacheDir;
    }
    
    prevDir = currentDir;
    currentDir = path.dirname(currentDir);
  }
  
  // Fallback to OS temp directory if no node_modules found
  const tempDir = path.join(process.env.TMPDIR || '/tmp', name);
  fs.mkdirSync(tempDir, { recursive: true });
  
  return tempDir;
}
