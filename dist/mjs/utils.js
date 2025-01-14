import { promises as fsPromises } from 'node:fs';
/**
 * Ensure that a directory exists, creating it if necessary
 * @param dirPath The path to the directory
 */
export async function ensureDirectoryExists(dirPath) {
    try {
        await fsPromises.mkdir(dirPath, { recursive: true });
    }
    catch (err) {
        throw err;
    }
}
export function formatBytes(bytes) {
    if (bytes < 1024 ** 2) {
        return (bytes / 1024).toFixed(2) + ' KB';
    }
    else if (bytes < 1024 ** 3) {
        return (bytes / 1024 ** 2).toFixed(2) + ' MB';
    }
    else {
        return (bytes / 1024 ** 3).toFixed(2) + ' GB';
    }
}
export async function testMemoryUsage(label, fn, logger, expectFn) {
    const startMemoryUsage = {
        heapUsed: process.memoryUsage().heapUsed,
        external: process.memoryUsage().external,
    };
    logger.debug(`[Memory]${label}() start: startHeapUsed ${formatBytes(startMemoryUsage.heapUsed)}, startExternal ${formatBytes(startMemoryUsage.external)}`);
    const result = await fn();
    if (global.gc)
        global.gc();
    const endMemoryUsage = {
        heapUsed: process.memoryUsage().heapUsed,
        external: process.memoryUsage().external,
    };
    logger.debug(`[Memory]${label}() end: endHeapUsed ${formatBytes(endMemoryUsage.heapUsed)}, endExternal ${formatBytes(endMemoryUsage.external)}`);
    const realHeapUsed = endMemoryUsage.heapUsed - startMemoryUsage.heapUsed;
    const realExternal = endMemoryUsage.external - startMemoryUsage.external;
    if (expectFn)
        expectFn({ heapUsed: realHeapUsed, external: realExternal });
    return result;
}
//# sourceMappingURL=utils.js.map