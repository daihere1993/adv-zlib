import { ZipEntry } from "./entry";
import { Logger } from "./types";
export interface AdvZlibOptions {
    logger?: Logger;
    cacheDir?: string;
    maxCacheSize?: number;
    maxCacheEntries?: number;
}
export declare class AdvZlib {
    private logger;
    private maxCacheSize;
    private maxCacheEntries;
    private cacheDir;
    private cachedCentralDirs;
    private cachedExistenceInfos;
    constructor(opts?: AdvZlibOptions);
    /**
     * Get the list of entries in a ZIP file
     * @param src The path of the zip file which can be:
     * - Normal: `/a/b.zip`
     * - Nested zip: `/a/b.zip/c.zip` or `/a/b.zip/c/d.zip`
     * @param filterFn An optional callback function to filter entries
     * @returns A promise that resolves to the list of filtered entries in the ZIP file.
     */
    getEntries(src: string, filterFn?: (entry: ZipEntry) => boolean): Promise<ZipEntry[]>;
    /**
     * Check if a file exists in a ZIP file
     * @param src The path of the zip file which can be:
     * - Normal: `/a/b.zip/c.txt`
     * - Folder: `/a/b.zip/c/`
     * - Nested zip: `/a/b.zip/c.zip`
     * @returns A promise that resolves to a boolean indicating whether the file exists in the ZIP file.
     */
    exists(src: string): Promise<boolean>;
    /**
     * Extracts selected entries from a ZIP file to a specified destination directory.
     *
     * @param src The source path to the ZIP file. Can represent a simple ZIP file or a nested path within a ZIP file.
     * @param dest There several cases:
     * - Case1: src is a zip(whatever nested or not) file, then `dest` must be a directory and this directory must exist.
     * - Case2: src is a particular file within a zip file, then `dest` can either be a directory(where the content will be extracted)
     *   or a file path(indicating where the extracted content will be saved).
     * @param filterFn An optional filter function that determines which entries to extract.
     *                   If provided, only entries for which the function returns `true` will be extracted.
     * @returns A promise that resolves to an array of full paths of the extracted files.
     * @throws Will throw an error if the `src` ZIP file does not exist or if the `dest` directory does not exist.
     */
    extract(src: string, dest: string, filterFn?: (entry: ZipEntry) => boolean): Promise<string[]>;
    /**
     * Reads the content of a specific file within a ZIP file.
     *
     * @param src - The path to the ZIP file or an entry within it. Accepted formats include:
     *   - Type 1: `/a/b.zip` - Reads using a `filterFn` function to filter entries.
     *   - Type 2: `/a/b.zip/c.txt` - Directly specifies a file entry to read, without a `filterFn`.
     *   - Type 3: `/a/b.zip/c.zip` - Specifies a nested ZIP entry, read with a `filterFn` function.
     *   - Type 4: `/a/b.zip/c.zip/d.txt` - Directly specifies a file entry within a nested ZIP, without a `filterFn`.
     * @param filterFn - An optional filter function to select entries within the ZIP file.
     *                   If provided, only entries for which the function returns `true` are considered.
     * @returns A promise that resolves to a `Buffer` containing the file's contents, or an empty `Buffer`
     *          if no matching entry is found or if multiple entries match.
     * @throws Will throw an error if the `src` file does not exist.
     */
    read(src: string, filterFn?: (entry: ZipEntry) => boolean): Promise<Buffer>;
    cleanup(): Promise<void>;
    /**
     * Get the central directory of a ZIP file if it cached or initialize it if not
     * @param src The path of the zip file which can be:
     * - Normal: `/a/b.zip`
     * - Nested zip: `/a/b.zip/c.zip` or `/a/b.zip/c/d.zip`
     * @returns A promise that resolves to the central directory
     */
    private getOrInitCentralDir;
    /**
     * Initialize or retrieve a cached central directory
     * @param src The path to the ZIP file
     * @param dataSource Optional buffer data for nested ZIPs
     * @returns A promise that resolves to the central directory
     */
    private _getOrInitCentralDir;
    private getRelatedEntries;
    /**
     * Split a ZIP path into its ZIP segments
     * E.g., '/a/b.zip/c.zip/d/e.zip/f.txt' to ['/a/b.zip', '/c.zip', '/d/e.zip', '/f.txt']
     * @param src The source ZIP path
     * @returns An array of path segments
     */
    private splitZipPathIntoSegs;
    /**
     * Get the last entry relative path, e.g., '/a/b.zip/c/d.txt' to 'c/d.txt'
     * @param src The source ZIP path
     * @returns The last entry relative path
     */
    private getLastEntryRelPath;
    /**
     * Get the deepest zip path, e.g., '/a/b.zip/c/d.zip/e.txt' to '/a/b.zip/c/d.zip'
     * @param src The source ZIP path
     * @returns The deepest zip path
     */
    private getDeepestZipPath;
    /**
     * Check if a file exists asynchronously
     * @param filePath The path to the file
     * @returns A promise that resolves to true if exists, false otherwise
     */
    private checkFileExists;
    /**
     * Find a ZIP entry within the central directory
     * @param centralDir The central directory to search
     * @param zipFilePath The current ZIP file path
     * @returns The found entry or null
     */
    private findZipEntry;
    /**
     * Handle reading and caching of a ZIP entry
     * @param entry The ZIP entry to handle
     * @param zipFilePath The current ZIP file path
     * @returns The entry data buffer or null if cached to disk
     */
    private handleEntryData;
}
