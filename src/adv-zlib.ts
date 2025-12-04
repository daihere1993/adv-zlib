import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Logger } from './types';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

import pLimit from 'p-limit';
import { CentralDirectory, llzlib, ZipEntry, ZipEntryMetadata } from './llzlib';

export interface AdvZlibOptions {
  logger?: Logger;
  defaultSize?: number;
  retry?: number;
}
export class AdvZlib {
  private logger!: Logger;
  private defaultSize: number;
  private retry: number;

  constructor(options: AdvZlibOptions = {}) {
    this.logger = options.logger ?? console;
    this.defaultSize = options.defaultSize ?? 64 * 1024; // 64KB default
    this.retry = options.retry ?? 1;
  }

  /**
   * Check if a file exists in a ZIP file
   * @param src The path of the zip file which can be:
   * - Normal: `/a/b.zip/c.txt`
   * - Folder: `/a/b.zip/c/`
   * - Nested zip: `/a/b.zip/c.zip`
   * @returns A promise that resolves to a boolean indicating whether the file exists in the ZIP file.
   */
  public async exists(filePath: string): Promise<boolean> {
    this.logger.debug(`Checking if file exists: ${path.basename(filePath)}`);

    const tmpFiles: string[] = [];
    try {
      const normalizedPath = this.normalizePath(filePath);
      const pathParts = this.parseNestedPath(normalizedPath);

      if (pathParts.length === 0) return false;

      // Check if this is a simple zip file path (not nested)
      // If we have one part with empty innerPath, it's a direct zip file
      if (pathParts.length === 1 && pathParts[0].innerPath === '') {
        return await this.isExistingFileOrFolder(pathParts[0].zipPath);
      }

      return await this.existsInNestedZip(pathParts, tmpFiles);
    } finally {
      for (const tmpFile of tmpFiles) {
        try {
          await fs.unlink(tmpFile);
        } catch (error) {
          // Ignore errors if file doesn't exist or can't be deleted
          this.logger.debug(`Failed to delete temp file ${tmpFile}: ${error}`);
        }
      }
    }
  }

  public async getEntryMetadatas(filePath: string): Promise<ZipEntryMetadata[]> {
    this.logger.debug(`Getting entry metadatas: ${path.basename(filePath)}`);

    const tmpFiles: string[] = [];
    try {
      const normalizedPath = this.normalizePath(filePath);
      const pathParts = this.parseNestedPath(normalizedPath);

      if (pathParts.length === 0) return [];

      return await this.getEntryMetadatasInNestedZip(pathParts, tmpFiles);
    } finally {
      for (const tmpFile of tmpFiles) {
        try {
          await fs.unlink(tmpFile);
        } catch (error) {
          // Ignore errors if file doesn't exist or can't be deleted
          this.logger.debug(`Failed to delete temp file ${tmpFile}: ${error}`);
        }
      }
    }
  }

  /**
   * Extract a file or entire ZIP contents to a destination path
   *
   * @param source - The path to extract from. Can be:
   *   - A ZIP file: `/path/to/archive.zip` (extracts all contents)
   *   - A file in a ZIP: `/path/to/archive.zip/file.txt`
   *   - A folder in a ZIP: `/path/to/archive.zip/folder/`
   *   - A nested ZIP: `/path/to/outer.zip/inner.zip/file.txt`
   * @param dest - The destination path where files will be extracted
   * @param options - Optional extraction options
   * @param options.noFolders - When true, extracts files using only their base filename,
   *   stripping all folder structure. Only works when extracting a specific file entry.
   *   Will throw an error if used with folder entries or entire ZIP extraction.
   *
   * @example
   * // Extract entire ZIP preserving folder structure
   * await advZlib.extract('/path/to/archive.zip', '/dest');
   * // Result: /dest/folder/file.txt
   *
   * @example
   * // Extract specific file preserving folder structure
   * await advZlib.extract('/path/to/archive.zip/folder/file.txt', '/dest');
   * // Result: /dest/folder/file.txt
   *
   * @example
   * // Extract specific file without folder structure
   * await advZlib.extract('/path/to/archive.zip/folder/file.txt', '/dest', { noFolders: true });
   * // Result: /dest/file.txt
   *
   * @example
   * // Extract from nested ZIP without folder structure
   * await advZlib.extract('/outer.zip/inner.zip/folder/file.txt', '/dest', { noFolders: true });
   * // Result: /dest/file.txt
   *
   * @throws {Error} If source path is invalid or doesn't exist
   * @throws {Error} If noFolders option is used with folder entries or entire ZIP extraction
   * @throws {Error} If the entry to extract is not found
   */
  public async extract(source: string, dest: string, options?: { noFolders?: boolean }): Promise<void> {
    this.logger.debug(`Extracting: ${path.basename(source)} to ${path.basename(dest)}`);

    const tmpFiles: string[] = [];
    try {
      const normalizedSource = this.normalizePath(source);
      const normalizedDest = this.normalizePath(dest);
      const pathParts = this.parseNestedPath(normalizedSource);
      if (pathParts.length === 0) throw new Error('Invalid source path');

      await this.extractInNestedZip(pathParts, normalizedDest, tmpFiles, options);
    } finally {
      for (const tmpFile of tmpFiles) {
        try {
          this.logger.debug(`Deleting temp file: ${tmpFile}`);
          await fs.unlink(tmpFile);
        } catch (error) {
          // Ignore errors if file doesn't exist or can't be deleted
          this.logger.debug(`Failed to delete temp file ${tmpFile}: ${error}`);
        }
      }
    }
  }

  public async read(filePath: string): Promise<Buffer> {
    this.logger.debug(`Reading: ${path.basename(filePath)}`);

    const tmpFiles: string[] = [];
    try {
      const normalizedPath = this.normalizePath(filePath);
      const pathParts = this.parseNestedPath(normalizedPath);
      if (pathParts.length === 0) throw new Error('Invalid file path');

      return await this.readFromNestedZip(pathParts, tmpFiles);
    } finally {
      for (const tmpFile of tmpFiles) {
        try {
          this.logger.debug(`Deleting temp file: ${tmpFile}`);
          await fs.unlink(tmpFile);
        } catch (error) {
          // Ignore errors if file doesn't exist or can't be deleted
          this.logger.debug(`Failed to delete temp file ${tmpFile}: ${error}`);
        }
      }
    }
  }

  private async readFromNestedZip(
    pathParts: Array<{ zipPath: string; innerPath: string }>,
    tmpFiles: string[],
  ): Promise<Buffer> {
    // Check if the zip file exists first
    if (!(await this.isExistingFileOrFolder(pathParts[0].zipPath))) {
      throw new Error(`Source zip file ${pathParts[0].zipPath} does not exist`);
    }

    let selectedEntry: ZipEntry | null = null;
    let currentZipSourcePath = pathParts[0].zipPath;
    let currentInnerPath = pathParts[0].innerPath;
    const isNonNested = pathParts.length === 1;

    // Check if we're trying to read a ZIP file itself (not allowed)
    if (currentInnerPath === '' || this.isZipFile(currentInnerPath)) {
      throw new Error(`Cannot read ZIP file itself. Please specify a text file inside the ZIP.`);
    }

    // Determine what we're searching for
    // For nested ZIPs, search for the full path to the nested ZIP file (e.g., "subdir/file.zip")
    const searchFileName = isNonNested ? currentInnerPath : pathParts[1]?.zipPath || currentInnerPath;

    // 1. Get the zipfile of the first level and find the entry
    const zipFile = await llzlib.open(currentZipSourcePath);

    try {
      if (isNonNested) {
        // Read the file directly
        const cd = await zipFile.getCentralDirectory();
        const entryMetadatas = await cd.getAllEntryMetadatas();
        const foundMetadata = entryMetadatas.find((m) => m.fileName === currentInnerPath);
        if (foundMetadata) {
          selectedEntry = ZipEntry.fromMetadata(zipFile.getReader(), foundMetadata);
        }
        if (!selectedEntry) {
          throw new Error(`File ${currentInnerPath} not found in ${currentZipSourcePath}`);
        }

        // Read the content from the stream
        const readStream = await selectedEntry.createReadStream();
        const chunks: Buffer[] = [];

        // Use event-based pattern instead of for-await to properly handle errors
        // This is especially important for piped streams (deflated files)
        const buffer = await new Promise<Buffer>((resolve, reject) => {
          readStream.on('data', (chunk: Buffer) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });

          readStream.on('error', (err: Error) => {
            reject(err);
          });

          readStream.on('end', () => {
            resolve(Buffer.concat(chunks));
          });
        });

        return buffer;
      }

      // Find the entry for the nested path
      const cd = await zipFile.getCentralDirectory();
      const entryMetadatas = await cd.getAllEntryMetadatas();
      const foundMetadata = entryMetadatas.find((m) => m.fileName === searchFileName);
      if (foundMetadata) {
        selectedEntry = ZipEntry.fromMetadata(zipFile.getReader(), foundMetadata);
      }

      if (!selectedEntry) {
        throw new Error(`Entry ${searchFileName} not found in ${currentZipSourcePath}`);
      }

      // 2. For reading from nested ZIPs, extract to a temp file and recurse
      const tempFilePath = path.join(os.tmpdir(), `temp-${Date.now()}.zip`);
      tmpFiles.push(tempFilePath);
      const readStream = await selectedEntry.createReadStream();
      const writeStream = createWriteStream(tempFilePath);
      this.logger.debug(`Extracting entry ${selectedEntry.fileName} to temp file: ${tempFilePath}`);
      await pipeline(readStream, writeStream);

      pathParts.shift();
      pathParts[0].zipPath = tempFilePath;
      return await this.readFromNestedZip(pathParts, tmpFiles);
    } finally {
      zipFile.close(); // Always close the file, even on errors
    }
  }

  private async extractInNestedZip(
    pathParts: Array<{ zipPath: string; innerPath: string }>,
    dest: string,
    tmpFiles: string[],
    options: { noFolders?: boolean } = {},
  ): Promise<void> {
    // Check if the zip file exists first
    if (!(await this.isExistingFileOrFolder(pathParts[0].zipPath))) {
      throw new Error(`Source zip file ${pathParts[0].zipPath} does not exist`);
    }

    let selectedEntry: ZipEntry | null = null;
    let currentZipSourcePath = pathParts[0].zipPath;
    let currentInnerPath = pathParts[0].innerPath;
    const isNonNested = pathParts.length === 1;

    // Determine what we're searching for
    // For nested ZIPs, search for the full path to the nested ZIP file (e.g., "subdir/file.zip")
    const searchFileName = isNonNested ? currentInnerPath : pathParts[1]?.zipPath || currentInnerPath;

    // 1. Get the zipfile of the first level and find the entry
    const zipFile = await llzlib.open(currentZipSourcePath);

    try {
      if (isNonNested) {
        if (currentInnerPath === '') {
          // If inner path is empty, then extract all entries in the zip file
          if (options.noFolders) {
            throw new Error('noFolders option cannot be used when extracting entire ZIP contents');
          }
          const cd = await zipFile.getCentralDirectory();
          const entryMetadatas = await cd.getAllEntryMetadatas();
          const entries = entryMetadatas.map((metadata) => ZipEntry.fromMetadata(zipFile.getReader(), metadata));

          const limit = pLimit(8); // means at most 8 concurrent extract operations
          const tasks = entries.map((entry) =>
            limit(async () => {
              const targetPath = path.join(dest, entry.fileName);
              const targetDir = path.dirname(targetPath);
              await fs.mkdir(targetDir, { recursive: true });
              const readStream = await entry.createReadStream();
              const writeStream = createWriteStream(targetPath);
              return pipeline(readStream, writeStream);
            }),
          );
          await Promise.all(tasks);
          return;
        } else {
          // If inner path is not empty, then extract the entry
          const cd = await zipFile.getCentralDirectory();
          const entryMetadatas = await cd.getAllEntryMetadatas();
          const foundMetadata = entryMetadatas.find((m) => m.fileName === currentInnerPath);
          if (foundMetadata) {
            selectedEntry = ZipEntry.fromMetadata(zipFile.getReader(), foundMetadata);
          }
          if (!selectedEntry) {
            throw new Error(`Entry ${currentInnerPath} not found in ${currentZipSourcePath}`);
          }
          // Check if extracting a folder entry with noFolders option
          if (options.noFolders && selectedEntry.fileName.endsWith('/')) {
            throw new Error('noFolders option cannot be used when extracting folder entries');
          }
          // Use basename if noFolders is true, otherwise use full path
          const fileName = options.noFolders ? path.basename(selectedEntry.fileName) : selectedEntry.fileName;
          const targetPath = path.join(dest, fileName);
          const targetDir = path.dirname(targetPath);
          await fs.mkdir(targetDir, { recursive: true });
          const readStream = await selectedEntry.createReadStream();
          const writeStream = createWriteStream(targetPath);
          await pipeline(readStream, writeStream);
          return;
        }
      }

      // Find the entry for the inner path
      const cd = await zipFile.getCentralDirectory();
      const entryMetadatas = await cd.getAllEntryMetadatas();
      const foundMetadata = entryMetadatas.find((m) => m.fileName === searchFileName);
      if (foundMetadata) {
        if (isNonNested) {
          return;
        }
        selectedEntry = ZipEntry.fromMetadata(zipFile.getReader(), foundMetadata);
      }

      if (!selectedEntry) {
        throw new Error(`Entry ${searchFileName} not found in ${currentZipSourcePath}`);
      }

      // 2. For extracting entries in nested ZIPs, we need to extract to a temp file and recurse
      const tempFilePath = path.join(os.tmpdir(), `temp-${Date.now()}.zip`);
      tmpFiles.push(tempFilePath);
      const readStream = await selectedEntry.createReadStream();
      const writeStream = createWriteStream(tempFilePath);
      this.logger.debug(`Extracting entry ${selectedEntry.fileName} to temp file: ${tempFilePath}`);
      await pipeline(readStream, writeStream);

      pathParts.shift();
      pathParts[0].zipPath = tempFilePath;
      return await this.extractInNestedZip(pathParts, dest, tmpFiles, options);
    } finally {
      zipFile.close(); // Always close the file, even on errors
    }
  }

  private async getEntryMetadatasInNestedZip(
    pathParts: Array<{ zipPath: string; innerPath: string }>,
    tmpFiles: string[],
  ): Promise<ZipEntryMetadata[]> {
    // Check if the zip file exists first
    if (!(await this.isExistingFileOrFolder(pathParts[0].zipPath))) {
      return [];
    }

    let selectedEntry: ZipEntry | null = null;
    const isNonNested = pathParts.length === 1;
    const currentInnerPath = pathParts[0].innerPath;

    // Determine what we're searching for
    // For nested ZIPs, we need to search for the full path to the nested ZIP file
    // For example, if path is "a.zip/subdir/c.zip", we need to search for "subdir/c.zip" in a.zip
    // pathParts[0].innerPath contains the full remaining path, which includes the nested ZIP path
    // We need to extract just the zip file portion (everything up to and including the first .zip)
    let searchFileName: string;
    if (isNonNested) {
      searchFileName = currentInnerPath;
    } else {
      // For nested ZIPs, we need to search for the full path to the nested ZIP file
      // pathParts[1].zipPath contains the correctly parsed nested ZIP path from parseNestedPath
      // This includes the full path like "subdir/file.zip" not just "file.zip"
      searchFileName = pathParts[1]?.zipPath || currentInnerPath;
    }

    // 1. Get the zipfile of the first level and get the entry metadatas
    const zipFile = await llzlib.open(pathParts[0].zipPath);
    try {
      // If non-nested (pathParts.length === 1)
      if (isNonNested) {
        // If innerPath is empty, we're pointing to the ZIP file itself
        if (currentInnerPath === '') {
          const cd = await zipFile.getCentralDirectory();
          return await cd.getAllEntryMetadatas();
        }
        // If innerPath is not empty and not a ZIP file, we're pointing to a regular file/folder
        // In this case, return empty array since we only return metadatas for ZIP files
        if (!this.isZipFile(currentInnerPath)) {
          return [];
        }
        // If innerPath is a ZIP file but pathParts.length === 1, this shouldn't happen
        // with the new parseNestedPath logic, but handle it defensively
        return [];
      }

      // 2. If nested, find the entry for the inner path
      const cd = await zipFile.getCentralDirectory();
      const entryMetadatas = await cd.getAllEntryMetadatas();
      const foundMetadata = entryMetadatas.find((m) => m.fileName === searchFileName);
      if (foundMetadata) {
        selectedEntry = ZipEntry.fromMetadata(zipFile.getReader(), foundMetadata);
      }

      // 3. If not found, return empty array
      if (!selectedEntry) {
        return [];
      }

      // 4. For nested ZIPs, check if this is the last level (2-level nesting)
      // If so, we can just read the Central Directory in memory (optimal!)
      // But only if the second level's innerPath is empty (no further nesting)
      const isLastLevel = pathParts.length === 2 && pathParts[1].innerPath === '';
      if (isLastLevel) {
        const result = await llzlib.createCdFromInflatedStream(
          () => selectedEntry!.createReadStream(),
          selectedEntry.uncompressedSize,
          {
            defaultSize: this.defaultSize,
            retry: this.retry,
            logger: this.logger,
          },
        );
        const secondZipCd = result.cd;
        if (!secondZipCd) {
          return [];
        }

        return await secondZipCd.getAllEntryMetadatas();
      }

      // 5. For deeply nested ZIPs (3+ levels), extract to temp file and recurse
      // This minimizes temp files - we only create them when absolutely necessary
      const tempFilePath = path.join(os.tmpdir(), `temp-${Date.now()}.zip`);
      tmpFiles.push(tempFilePath);
      const readStream = await selectedEntry.createReadStream();
      const writeStream = createWriteStream(tempFilePath);
      await pipeline(readStream, writeStream);

      pathParts.shift();
      pathParts[0].zipPath = tempFilePath;

      return await this.getEntryMetadatasInNestedZip(pathParts, tmpFiles);
    } finally {
      zipFile.close(); // Always close the file, even on errors
    }
  }

  private async existsInNestedZip(
    pathParts: Array<{ zipPath: string; innerPath: string }>,
    tmpFiles: string[],
  ): Promise<boolean> {
    // Check if the zip file exists first
    if (!(await this.isExistingFileOrFolder(pathParts[0].zipPath))) {
      return false;
    }

    let selectedEntry: ZipEntry | null = null;
    let currentZipSourcePath = pathParts[0].zipPath;
    let currentInnerPath = pathParts[0].innerPath;
    const isNonNested = pathParts.length === 1;

    // Determine what we're searching for
    // For nested ZIPs, search for the full path to the nested ZIP file (e.g., "subdir/file.zip")
    const searchFileName = isNonNested ? currentInnerPath : pathParts[1]?.zipPath || currentInnerPath;

    // 1. Get the zipfile of the first level and find the entry
    const zipFile = await llzlib.open(currentZipSourcePath);

    try {
      // Optimized: Read Central Directory into memory and search in-memory
      const cd = await zipFile.getCentralDirectory();
      const entryMetadatas = await cd.getAllEntryMetadatas();

      // Search in-memory for the matching filename
      let foundMetadata: ZipEntryMetadata | null = null;
      let cdOffset = cd.centralDirOffset; // Track CD offset as we iterate

      for (const metadata of entryMetadatas) {
        if (metadata.fileName === searchFileName) {
          foundMetadata = metadata;
          break;
        }
        // Track the CD offset for the next entry
        cdOffset += metadata.size;
      }

      // 2. If entry not found, return false
      if (!foundMetadata) {
        return false;
      }

      // 3. If non-nested, we found it, return true
      if (isNonNested) {
        return true;
      }

      // 4. For nested ZIPs, we need the full ZipEntry object
      // Convert the metadata to a ZipEntry
      selectedEntry = ZipEntry.fromMetadata(zipFile.getReader(), foundMetadata);

      // 3. For nested ZIPs, check if this is the last level (2-level nesting)
      // If so, we can just read the Central Directory in memory (optimal!)
      const isLastLevel = pathParts.length === 2;

      if (isLastLevel) {
        // If innerPath is empty, we're checking if the nested ZIP file itself exists
        // Since we already found it (selectedEntry is not null), return true
        if (pathParts[1].innerPath === '') {
          return true;
        }

        // Optimal path: Read only the Central Directory in memory
        const result = await llzlib.createCdFromInflatedStream(
          () => selectedEntry!.createReadStream(),
          selectedEntry.uncompressedSize,
          {
            defaultSize: this.defaultSize,
            retry: this.retry,
            logger: this.logger,
          },
        );
        const secondZipCd = result.cd;

        if (!secondZipCd) {
          return false;
        }

        // Search in the Central Directory (fast, in-memory)
        return await this.existsInCentralDirectory(secondZipCd, pathParts[1].innerPath);
      }

      // 4. For deeply nested ZIPs (3+ levels), extract to temp file and recurse
      // This minimizes temp files - we only create them when absolutely necessary
      const tempFilePath = path.join(os.tmpdir(), `temp-${Date.now()}.zip`);
      tmpFiles.push(tempFilePath);
      const readStream = await selectedEntry.createReadStream();
      const writeStream = createWriteStream(tempFilePath);
      await pipeline(readStream, writeStream);

      // Recurse to check the nested ZIP
      pathParts.shift();
      pathParts[0].zipPath = tempFilePath;

      return await this.existsInNestedZip(pathParts, tmpFiles);
    } finally {
      // Always close the file, even on errors
      zipFile.close();
    }
  }

  private async existsInCentralDirectory(cd: CentralDirectory, searchPath: string): Promise<boolean> {
    const entryMetadatas = await cd.getAllEntryMetadatas();
    for (const entryMetadata of entryMetadatas) {
      if (entryMetadata.fileName === searchPath) {
        return true;
      }
    }
    return false;
  }

  private normalizePath(input: string): string {
    // Convert all backslashes to forward slashes for cross-platform consistency
    // Node.js accepts forward slashes as path separators on all platforms, including Windows
    let normalized = input.replace(/\\/g, '/');

    // Remove duplicate slashes while preserving:
    // - Leading slash for absolute Unix paths (e.g., /home/user)
    // - Drive letter colon for Windows absolute paths (e.g., C:/Users)
    // The regex ([^:]) ensures we don't collapse slashes after colons (C://)
    normalized = normalized.replace(/([^:])\/+/g, '$1/');

    // Fix Windows paths that have a leading slash before the drive letter
    // This can happen when backslash paths like '\C:\Users\...' are converted to '/C:/Users/...'
    // Windows drive letters are a single letter followed by a colon (e.g., C:, D:)
    normalized = normalized.replace(/^\/([a-zA-Z]:\/)/, '$1');

    // Handle edge case where path starts with multiple slashes (but not after colon)
    if (!normalized.includes(':')) {
      normalized = normalized.replace(/^\/+/, '/');
    }

    return normalized;
  }

  private async isExistingFileOrFolder(path: string): Promise<boolean> {
    try {
      const stats = await fs.stat(path);
      return stats.isFile() || stats.isDirectory();
    } catch (error) {
      return false;
    }
  }

  /**
   * Parse a path that may contain nested ZIP files and extract the hierarchy
   *
   * @param filePath - The file path to parse (should be normalized with forward slashes)
   * @returns An array of objects representing the ZIP hierarchy, where each object contains:
   *   - `zipPath`: The path to the ZIP file
   *   - `innerPath`: The remaining path inside that ZIP file (includes all subsequent segments)
   *
   * Note: Every ZIP file in the path will have an entry, even if innerPath is empty.
   * This ensures that pathParts.length === 1 truly means "no nested ZIPs".
   *
   * @example
   * // Simple ZIP file with a file inside
   * parseNestedPath('/a/b.zip/c.txt')
   * // Returns: [{ zipPath: '/a/b.zip', innerPath: 'c.txt' }]
   *
   * @example
   * // Simple ZIP file with a folder inside
   * parseNestedPath('/a/b.zip/folder/')
   * // Returns: [{ zipPath: '/a/b.zip', innerPath: 'folder/' }]
   *
   * @example
   * // Just a ZIP file (no inner path)
   * parseNestedPath('/a/b.zip')
   * // Returns: [{ zipPath: '/a/b.zip', innerPath: '' }]
   *
   * @example
   * // Nested ZIP files (2 levels)
   * parseNestedPath('/a/b.zip/c.zip')
   * // Returns: [
   * //   { zipPath: '/a/b.zip', innerPath: 'c.zip' },
   * //   { zipPath: 'c.zip', innerPath: '' }
   * // ]
   *
   * @example
   * // Nested ZIP files with file inside (2 levels)
   * parseNestedPath('/a/b.zip/c.zip/d.txt')
   * // Returns: [
   * //   { zipPath: '/a/b.zip', innerPath: 'c.zip/d.txt' },
   * //   { zipPath: 'c.zip', innerPath: 'd.txt' }
   * // ]
   *
   * @example
   * // Nested ZIP files with folder in between
   * parseNestedPath('a/b.zip/c/d.zip/e.txt')
   * // Returns: [
   * //   { zipPath: 'a/b.zip', innerPath: 'c/d.zip/e.txt' },
   * //   { zipPath: 'c/d.zip', innerPath: 'e.txt' }
   * // ]
   *
   * @example
   * // Deeply nested ZIP files (3 levels)
   * parseNestedPath('/a/b.zip/c.zip/d.zip')
   * // Returns: [
   * //   { zipPath: '/a/b.zip', innerPath: 'c.zip/d.zip' },
   * //   { zipPath: 'c.zip', innerPath: 'd.zip' },
   * //   { zipPath: 'd.zip', innerPath: '' }
   * // ]
   *
   * @example
   * // Non-ZIP path (no ZIP files detected)
   * parseNestedPath('/a/b/c.txt')
   * // Returns: []
   */
  private parseNestedPath(filePath: string): Array<{ zipPath: string; innerPath: string }> {
    const parts: Array<{ zipPath: string; innerPath: string }> = [];
    const segments = filePath.split('/');

    let pathSoFar: string[] = [];

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      pathSoFar.push(segment);

      if (this.isZipFile(segment)) {
        const zipPath = pathSoFar.join('/');
        const remainingSegments = segments.slice(i + 1);
        const hasTrailingSlash = remainingSegments[remainingSegments.length - 1] === '';
        const filteredSegments = remainingSegments.filter((s) => s !== '');
        const innerPath = filteredSegments.join('/') + (hasTrailingSlash && filteredSegments.length > 0 ? '/' : '');

        // Always push the ZIP entry, even if innerPath is empty
        // This makes isNonNested truly mean "no nested ZIPs"
        parts.push({ zipPath, innerPath });
        pathSoFar = [];
      }
    }

    return parts;
  }

  private isZipFile(input: string): boolean {
    return input.toLowerCase().endsWith('.zip');
  }
}
