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

export interface ExtractResult {
  source: string;
  success: boolean;
  error?: Error;
}

/**
 * Internal interface for batch extraction tree node
 */
interface BatchExtractNode {
  zipPath: string;
  filesToExtract: Array<{
    originalSource: string;
    innerPath: string;
  }>;
  children: Map<string, BatchExtractNode>;
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
   * @param source - The path(s) to extract from. Can be a single string or array of strings:
   *   - A ZIP file: `/path/to/archive.zip` (extracts all contents)
   *   - A file in a ZIP: `/path/to/archive.zip/file.txt`
   *   - A folder in a ZIP: `/path/to/archive.zip/folder/`
   *   - A nested ZIP: `/path/to/outer.zip/inner.zip/file.txt`
   *   - An array of paths for batch extraction with shared nested ZIP optimization
   * @param dest - The destination path where files will be extracted
   * @param options - Optional extraction options
   * @param options.noFolders - When true, extracts files using only their base filename,
   *   stripping all folder structure. Works for all extraction scenarios:
   *   - Entire ZIP: `/archive.zip` → all files extracted with base names only
   *   - A specific file entry: `/archive.zip/folder/file.txt` → `/dest/file.txt`
   *   - Folder contents (trailing slash): `/archive.zip/folder/` → all files extracted with base names only
   *   Directory entries are automatically skipped (only files are extracted).
   * @param options.asFile - When true, extracts a nested ZIP file as a file itself rather
   *   than extracting its contents. Only applies when the target path ends with `.zip`.
   *
   * @example
   * // Extract entire ZIP preserving folder structure
   * await advZlib.extract('/path/to/archive.zip', '/dest');
   * // Result: /dest/folder/file.txt
   *
   * @example
   * // Extract entire ZIP without folder structure (all files with base names only)
   * await advZlib.extract('/path/to/archive.zip', '/dest', { noFolders: true });
   * // If archive contains: folder/a.txt, folder/sub/b.txt
   * // Result: /dest/a.txt, /dest/b.txt (base names only, no folder structure)
   *
   * @example
   * // Extract specific file preserving folder structure
   * await advZlib.extract('/path/to/archive.zip/folder/file.txt', '/dest');
   * // Result: /dest/folder/file.txt
   *
   * @example
   * // Extract all entries under a folder (note trailing slash)
   * await advZlib.extract('/path/to/archive.zip/folder/', '/dest');
   * // Result: /dest/file1.txt, /dest/sub/file2.txt, etc. (folder prefix is stripped)
   *
   * @example
   * // Extract specific file without folder structure
   * await advZlib.extract('/path/to/archive.zip/folder/file.txt', '/dest', { noFolders: true });
   * // Result: /dest/file.txt
   *
   * @example
   * // Extract folder contents without folder structure (all files extracted with base names only)
   * await advZlib.extract('/path/to/archive.zip/folder1/folder2/', '/dest', { noFolders: true });
   * // If archive contains: folder1/folder2/a.txt, folder1/folder2/sub/b.txt
   * // Result: /dest/a.txt, /dest/b.txt (base names only, no folder structure)
   *
   * @example
   * // Extract from nested ZIP preserving folder structure
   * await advZlib.extract('/outer.zip/inner.zip/folder/file.txt', '/dest');
   * // Result: /dest/folder/file.txt
   *
   * @example
   * // Extract folder from nested ZIP (note trailing slash)
   * await advZlib.extract('/outer.zip/inner.zip/folder/', '/dest');
   * // Result: /dest/file.txt, /dest/sub/file2.txt, etc. (folder prefix is stripped)
   *
   * @example
   * // Extract from nested ZIP without folder structure
   * await advZlib.extract('/outer.zip/inner.zip/folder/file.txt', '/dest', { noFolders: true });
   * // Result: /dest/file.txt
   *
   * @example
   * // Extract nested ZIP as a file (instead of extracting its contents)
   * await advZlib.extract('/outer.zip/inner.zip', '/dest', { asFile: true });
   * // Result: /dest/inner.zip (the ZIP file itself, not its contents)
   *
   * @example
   * // Batch extract multiple files from nested ZIPs (optimized - inflates shared ZIPs only once)
   * const results = await advZlib.extract([
   *   '/outer.zip/inner.zip/file1.txt',
   *   '/outer.zip/inner.zip/file2.txt'
   * ], '/dest');
   * // Returns: ExtractResult[] with success/failure for each source
   *
   * @throws {Error} If source path is invalid or doesn't exist (single source mode)
   * @throws {Error} If the entry to extract is not found (single source mode)
   * @returns {Promise<void>} When source is a string
   * @returns {Promise<ExtractResult[]>} When source is an array - results for each source
   */
  public async extract(
    source: string,
    dest: string,
    options?: { noFolders?: boolean; asFile?: boolean },
  ): Promise<void>;
  public async extract(
    source: string[],
    dest: string,
    options?: { noFolders?: boolean; asFile?: boolean },
  ): Promise<ExtractResult[]>;
  public async extract(
    source: string | string[],
    dest: string,
    options?: { noFolders?: boolean; asFile?: boolean },
  ): Promise<void | ExtractResult[]> {
    if (typeof source === 'string') {
      return this.extractSingle(source, dest, options);
    }
    return this.extractBatch(source, dest, options);
  }

  /**
   * Extract a single source (original extract implementation)
   */
  private async extractSingle(
    source: string,
    dest: string,
    options?: { noFolders?: boolean; asFile?: boolean },
  ): Promise<void> {
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

  /**
   * Extract multiple sources with optimization for shared nested ZIP paths
   */
  private async extractBatch(
    sources: string[],
    dest: string,
    options?: { noFolders?: boolean; asFile?: boolean },
  ): Promise<ExtractResult[]> {
    if (sources.length === 0) {
      return [];
    }

    this.logger.debug(`Batch extracting ${sources.length} files to ${path.basename(dest)}`);

    const results: ExtractResult[] = [];
    const tmpFiles: string[] = [];

    try {
      const normalizedDest = this.normalizePath(dest);

      // Build the batch extraction tree grouped by common ZIP paths
      const rootNodes = this.buildBatchExtractTree(sources);

      // Process each root ZIP node
      for (const [, node] of rootNodes) {
        await this.extractBatchFromNode(node, normalizedDest, tmpFiles, results, options ?? {});
      }

      return results;
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

  /**
   * Extract files from a batch extraction node
   */
  private async extractBatchFromNode(
    node: BatchExtractNode,
    dest: string,
    tmpFiles: string[],
    results: ExtractResult[],
    options: { noFolders?: boolean; asFile?: boolean },
  ): Promise<void> {
    // Check if the zip file exists first
    if (!(await this.isExistingFileOrFolder(node.zipPath))) {
      // Fail all sources in this node and its children
      const error = new Error(`Source zip file ${node.zipPath} does not exist`);
      this.collectAllSourcesFromNode(node, results, error);
      return;
    }

    const zipFile = await llzlib.open(node.zipPath);

    try {
      const cd = await zipFile.getCentralDirectory();
      const entryMetadatas = await cd.getAllEntryMetadatas();

      // Create a map for fast lookup
      const metadataMap = new Map<string, ZipEntryMetadata>();
      for (const metadata of entryMetadatas) {
        metadataMap.set(metadata.fileName, metadata);
      }

      // Extract direct files at this level
      const limit = pLimit(8);
      const extractTasks = node.filesToExtract.map((fileToExtract) =>
        limit(async () => {
          const { originalSource, innerPath } = fileToExtract;

          // Handle empty innerPath (extract entire ZIP)
          if (innerPath === '') {
            try {
              // Filter out directory entries when extracting
              const fileMetadatas = entryMetadatas.filter((m) => !m.fileName.endsWith('/'));
              const entries = fileMetadatas.map((metadata) => ZipEntry.fromMetadata(zipFile.getReader(), metadata));
              const entryLimit = pLimit(8);
              const entryTasks = entries.map((entry) =>
                entryLimit(async () => {
                  // When noFolders is true, use only the basename of each file
                  // Otherwise, strip the folder prefix (if any)
                  const fileName = options.noFolders
                    ? path.basename(entry.fileName)
                    : entry.fileName.slice(innerPath.length);
                  const targetPath = path.join(dest, fileName);
                  const targetDir = path.dirname(targetPath);
                  await fs.mkdir(targetDir, { recursive: true });
                  const readStream = await entry.createReadStream();
                  const writeStream = createWriteStream(targetPath);
                  return pipeline(readStream, writeStream);
                }),
              );
              await Promise.all(entryTasks);
              results.push({ source: originalSource, success: true });
            } catch (error) {
              results.push({
                source: originalSource,
                success: false,
                error: error instanceof Error ? error : new Error(String(error)),
              });
            }
            return;
          }

          // Handle folder extraction (innerPath ends with '/')
          if (innerPath.endsWith('/')) {
            try {
              // Find all entries that start with the folder prefix, excluding directory entries
              const matchingMetadatas = entryMetadatas.filter(
                (m) => m.fileName.startsWith(innerPath) && !m.fileName.endsWith('/'),
              );

              if (matchingMetadatas.length === 0) {
                results.push({
                  source: originalSource,
                  success: false,
                  error: new Error(`No entries found under folder ${innerPath} in ${node.zipPath}`),
                });
                return;
              }

              const entries = matchingMetadatas.map((metadata) => ZipEntry.fromMetadata(zipFile.getReader(), metadata));
              const entryLimit = pLimit(8);
              const entryTasks = entries.map((entry) =>
                entryLimit(async () => {
                  // When noFolders is true, use only the basename of each file
                  // Otherwise, strip the folder prefix
                  const fileName = options.noFolders
                    ? path.basename(entry.fileName)
                    : entry.fileName.slice(innerPath.length);
                  const targetPath = path.join(dest, fileName);
                  const targetDir = path.dirname(targetPath);
                  await fs.mkdir(targetDir, { recursive: true });
                  const readStream = await entry.createReadStream();
                  const writeStream = createWriteStream(targetPath);
                  return pipeline(readStream, writeStream);
                }),
              );
              await Promise.all(entryTasks);
              results.push({ source: originalSource, success: true });
            } catch (error) {
              results.push({
                source: originalSource,
                success: false,
                error: error instanceof Error ? error : new Error(String(error)),
              });
            }
            return;
          }

          // Find the entry
          const metadata = metadataMap.get(innerPath);
          if (!metadata) {
            results.push({
              source: originalSource,
              success: false,
              error: new Error(`Entry ${innerPath} not found in ${node.zipPath}`),
            });
            return;
          }

          try {
            const entry = ZipEntry.fromMetadata(zipFile.getReader(), metadata);

            // Skip folder entries (directories) - they have no content to extract
            if (entry.fileName.endsWith('/')) {
              results.push({ source: originalSource, success: true });
              return;
            }

            // Use basename if noFolders is true, otherwise use full path
            const fileName = options.noFolders ? path.basename(entry.fileName) : entry.fileName;
            const targetPath = path.join(dest, fileName);
            const targetDir = path.dirname(targetPath);
            await fs.mkdir(targetDir, { recursive: true });
            const readStream = await entry.createReadStream();
            const writeStream = createWriteStream(targetPath);
            await pipeline(readStream, writeStream);

            results.push({ source: originalSource, success: true });
          } catch (error) {
            results.push({
              source: originalSource,
              success: false,
              error: error instanceof Error ? error : new Error(String(error)),
            });
          }
        }),
      );

      await Promise.all(extractTasks);

      // Process nested ZIPs (children)
      for (const [nestedZipPath, childNode] of node.children) {
        const nestedMetadata = metadataMap.get(nestedZipPath);
        if (!nestedMetadata) {
          // Nested ZIP not found - fail all sources under this child
          const error = new Error(`Entry ${nestedZipPath} not found in ${node.zipPath}`);
          this.collectAllSourcesFromNode(childNode, results, error);
          continue;
        }

        // Check if asFile option is set and child targets the nested ZIP itself (empty innerPath)
        // In this case, extract the nested ZIP as a file instead of recursing
        const asFileTargets = options.asFile ? childNode.filesToExtract.filter((f) => f.innerPath === '') : [];

        if (asFileTargets.length > 0) {
          try {
            const entry = ZipEntry.fromMetadata(zipFile.getReader(), nestedMetadata);
            // Use basename if noFolders is true, otherwise use full path
            const fileName = options.noFolders ? path.basename(entry.fileName) : entry.fileName;
            const targetPath = path.join(dest, fileName);
            const targetDir = path.dirname(targetPath);
            await fs.mkdir(targetDir, { recursive: true });
            const readStream = await entry.createReadStream();
            const writeStream = createWriteStream(targetPath);
            this.logger.debug(`Batch: Extracting nested ZIP as file: ${nestedZipPath} to ${targetPath}`);
            await pipeline(readStream, writeStream);

            // Mark all asFile targets as successful
            for (const target of asFileTargets) {
              results.push({ source: target.originalSource, success: true });
            }
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            for (const target of asFileTargets) {
              results.push({ source: target.originalSource, success: false, error: err });
            }
          }

          // Remove the asFile targets from filesToExtract and continue processing remaining
          childNode.filesToExtract = childNode.filesToExtract.filter((f) => f.innerPath !== '');

          // If no more files to extract and no children, skip this child
          if (childNode.filesToExtract.length === 0 && childNode.children.size === 0) {
            continue;
          }
        }

        // Extract nested ZIP to temp file (only once!)
        const tempFilePath = path.join(os.tmpdir(), `temp-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
        tmpFiles.push(tempFilePath);

        try {
          const entry = ZipEntry.fromMetadata(zipFile.getReader(), nestedMetadata);
          const readStream = await entry.createReadStream();
          const writeStream = createWriteStream(tempFilePath);
          this.logger.debug(`Batch: Extracting nested ZIP ${nestedZipPath} to temp file: ${tempFilePath}`);
          await pipeline(readStream, writeStream);

          // Update child node's zipPath to the temp file and recurse
          childNode.zipPath = tempFilePath;
          await this.extractBatchFromNode(childNode, dest, tmpFiles, results, options);
        } catch (error) {
          // Failed to extract nested ZIP - fail all sources under this child
          const err = error instanceof Error ? error : new Error(String(error));
          this.collectAllSourcesFromNode(childNode, results, err);
        }
      }
    } finally {
      zipFile.close();
    }
  }

  /**
   * Collect all sources from a node and its children, marking them as failed
   */
  private collectAllSourcesFromNode(node: BatchExtractNode, results: ExtractResult[], error: Error): void {
    // Add all direct files
    for (const fileToExtract of node.filesToExtract) {
      results.push({
        source: fileToExtract.originalSource,
        success: false,
        error,
      });
    }

    // Recurse into children
    for (const [, childNode] of node.children) {
      this.collectAllSourcesFromNode(childNode, results, error);
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
    options: { noFolders?: boolean; asFile?: boolean } = {},
  ): Promise<void> {
    // Check if the zip file exists first
    if (!(await this.isExistingFileOrFolder(pathParts[0].zipPath))) {
      throw new Error(`Source zip file ${pathParts[0].zipPath} does not exist`);
    }

    let selectedEntry: ZipEntry | null = null;
    let currentZipSourcePath = pathParts[0].zipPath;
    let currentInnerPath = pathParts[0].innerPath;
    const isNonNested = pathParts.length === 1;

    // Check if we should extract the nested ZIP as a file (asFile option)
    // This applies when: asFile is true, we have nested ZIPs, and the target is the ZIP itself (empty innerPath in next level)
    const shouldExtractAsFile = options.asFile && pathParts.length > 1 && pathParts[1].innerPath === '';

    // Determine what we're searching for
    // For nested ZIPs, search for the full path to the nested ZIP file (e.g., "subdir/file.zip")
    const searchFileName = isNonNested ? currentInnerPath : pathParts[1]?.zipPath || currentInnerPath;

    // 1. Get the zipfile of the first level and find the entry
    const zipFile = await llzlib.open(currentZipSourcePath);

    try {
      if (isNonNested) {
        if (currentInnerPath === '') {
          // If inner path is empty, then extract all entries in the zip file
          const cd = await zipFile.getCentralDirectory();
          const entryMetadatas = await cd.getAllEntryMetadatas();
          // Filter out directory entries when extracting
          const fileMetadatas = entryMetadatas.filter((m) => !m.fileName.endsWith('/'));
          const entries = fileMetadatas.map((metadata) => ZipEntry.fromMetadata(zipFile.getReader(), metadata));

          const limit = pLimit(8); // means at most 8 concurrent extract operations
          const tasks = entries.map((entry) =>
            limit(async () => {
              // When noFolders is true, use only the basename of each file
              // Otherwise, strip the folder prefix (if any)
              const fileName = options.noFolders
                ? path.basename(entry.fileName)
                : entry.fileName.slice(currentInnerPath.length);
              const targetPath = path.join(dest, fileName);
              const targetDir = path.dirname(targetPath);
              await fs.mkdir(targetDir, { recursive: true });
              const readStream = await entry.createReadStream();
              const writeStream = createWriteStream(targetPath);
              return pipeline(readStream, writeStream);
            }),
          );
          await Promise.all(tasks);
          return;
        } else if (currentInnerPath.endsWith('/')) {
          // If inner path ends with '/', extract all entries under that folder
          const cd = await zipFile.getCentralDirectory();
          const entryMetadatas = await cd.getAllEntryMetadatas();
          // Find all entries that start with the folder prefix, excluding directory entries
          const matchingMetadatas = entryMetadatas.filter(
            (m) => m.fileName.startsWith(currentInnerPath) && !m.fileName.endsWith('/'),
          );

          if (matchingMetadatas.length === 0) {
            throw new Error(`No entries found under folder ${currentInnerPath} in ${currentZipSourcePath}`);
          }

          const entries = matchingMetadatas.map((metadata) => ZipEntry.fromMetadata(zipFile.getReader(), metadata));

          const limit = pLimit(8);
          const tasks = entries.map((entry) =>
            limit(async () => {
              // When noFolders is true, use only the basename of each file
              // Otherwise, strip the folder prefix
              const fileName = options.noFolders
                ? path.basename(entry.fileName)
                : entry.fileName.slice(currentInnerPath.length);
              const targetPath = path.join(dest, fileName);
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
          // Skip folder entries (directories) - they have no content to extract
          if (selectedEntry.fileName.endsWith('/')) {
            return;
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

      // If asFile option is set and we're targeting the nested ZIP itself, extract it as a file
      if (shouldExtractAsFile) {
        // Use basename if noFolders is true, otherwise use full path
        const fileName = options.noFolders ? path.basename(selectedEntry.fileName) : selectedEntry.fileName;
        const targetPath = path.join(dest, fileName);
        const targetDir = path.dirname(targetPath);
        await fs.mkdir(targetDir, { recursive: true });
        const readStream = await selectedEntry.createReadStream();
        const writeStream = createWriteStream(targetPath);
        this.logger.debug(`Extracting nested ZIP as file: ${selectedEntry.fileName} to ${targetPath}`);
        await pipeline(readStream, writeStream);
        return;
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

  /**
   * Build a tree structure grouping sources by their nested ZIP hierarchy.
   * This allows extracting multiple files from the same nested ZIP with only one inflation.
   */
  private buildBatchExtractTree(sources: string[]): Map<string, BatchExtractNode> {
    const rootNodes = new Map<string, BatchExtractNode>();

    for (const source of sources) {
      const normalizedSource = this.normalizePath(source);
      const pathParts = this.parseNestedPath(normalizedSource);

      if (pathParts.length === 0) {
        // Invalid source - will be handled during extraction
        continue;
      }

      // Get or create root node for the outermost ZIP
      const rootZipPath = pathParts[0].zipPath;
      if (!rootNodes.has(rootZipPath)) {
        rootNodes.set(rootZipPath, {
          zipPath: rootZipPath,
          filesToExtract: [],
          children: new Map(),
        });
      }

      const rootNode = rootNodes.get(rootZipPath)!;
      this.addSourceToNode(rootNode, pathParts, source, 0);
    }

    return rootNodes;
  }

  /**
   * Recursively add a source to the batch extraction tree
   */
  private addSourceToNode(
    node: BatchExtractNode,
    pathParts: Array<{ zipPath: string; innerPath: string }>,
    originalSource: string,
    level: number,
  ): void {
    const currentPart = pathParts[level];

    // If this is the last level (no more nested ZIPs)
    if (level === pathParts.length - 1) {
      // The innerPath at this level is what we need to extract
      node.filesToExtract.push({
        originalSource,
        innerPath: currentPart.innerPath,
      });
      return;
    }

    // There are more nested ZIPs - we need to recurse
    const nextPart = pathParts[level + 1];
    const nextZipPath = nextPart.zipPath;

    // Get or create child node for the next nested ZIP
    if (!node.children.has(nextZipPath)) {
      node.children.set(nextZipPath, {
        zipPath: nextZipPath,
        filesToExtract: [],
        children: new Map(),
      });
    }

    const childNode = node.children.get(nextZipPath)!;
    this.addSourceToNode(childNode, pathParts, originalSource, level + 1);
  }
}
