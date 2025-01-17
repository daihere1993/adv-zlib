import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';

export const DEFAULT_CONTENT = 'TEST';

/**
 * Function to create a ZIP file based on a given structure and base directory.
 * @param {string} baseDir - The base directory where the ZIP file should be created.
 * @param {string} structure - The hierarchical structure of files and folders.
 */
export async function createZipFromStructure(baseDir: string, structure: string): Promise<void> {
  // Helper function to recursively add entries to the ZIP
  const processStructure = async (archive: archiver.Archiver, lines: string[]): Promise<void> => {
    const indentPattern: RegExp = /^(\s*)(.+)$/;
    let stack: { indent: number; path: string }[] = [{ indent: 0, path: '' }];

    while (lines.length > 0) {
      const line: string = lines.shift()!;
      if (!line.trim()) continue; // Skip empty or whitespace-only lines

      const match = line.match(indentPattern);
      if (!match) continue;

      const indent: number = match[1].length;
      const name: string = match[2]
        .trim()
        .replace(/^└──\s*/, '')
        .trim(); // Remove visual markers like "└──"

      // Navigate the stack to the correct parent path based on indentation
      while (stack.length && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }

      const parent = stack[stack.length - 1] || { path: '' };
      const fullPath: string = `${parent.path}${parent.path && !parent.path.endsWith('/') ? '/' : ''}${name}`;

      // if no extension that is a directory
      if (!name.includes('.')) {
        // Directory
        archive.append('', { name: fullPath.endsWith('/') ? fullPath : `${fullPath}/` });
        stack.push({ indent, path: fullPath });
      } else if (name.endsWith('.zip') && stack.length > 0) {
        // Nested ZIP
        const nestedArchive = archiver('zip', { zlib: { level: 9 } });
        const nestedBuffer = await new Promise<Buffer>((resolve, reject) => {
          const buffers: Buffer[] = [];
          nestedArchive.on('data', (chunk) => buffers.push(chunk));
          nestedArchive.on('end', () => resolve(Buffer.concat(buffers)));
          nestedArchive.on('error', reject);

          // Extract lines belonging to this nested ZIP based on indentation
          const startIdx = lines.indexOf(line) + 1;
          const nestedLines: string[] = [];
          let i = startIdx;
          while (i < lines.length) {
            const nestedLine = lines[i];
            const currentIndent = nestedLine.match(indentPattern)?.[1].length ?? 0;
            if (currentIndent <= indent) break; // Stop when no longer nested
            nestedLines.push(lines.splice(i, 1)[0]); // Remove the line from `lines` and add to `nestedLines`
          }

          processStructure(nestedArchive, nestedLines)
            .then(() => nestedArchive.finalize())
            .catch(reject);
        });
        archive.append(nestedBuffer, { name: fullPath });
        stack.push({ indent, path: fullPath });
      } else if (name.endsWith('.txt')) {
        // Text file
        archive.append(DEFAULT_CONTENT, { name: fullPath });
      }
    }
  };

  // Parse structure to find the main ZIP file name
  const lines: string[] = structure.split('\n').filter((line) => line.trim().length > 0);
  const zipFileNameMatch = lines[0].match(/(.+\.zip)$/);

  if (!zipFileNameMatch) {
    throw new Error('Invalid structure: Root ZIP file name not found');
  }

  const zipFileName: string = zipFileNameMatch[1].trim();
  const outputPath: string = path.join(baseDir, zipFileName);

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      console.log(`ZIP file created at ${outputPath} (${archive.pointer()} bytes)`);
      resolve();
    });

    archive.on('error', (err) => reject(err));

    archive.pipe(output);

    // Add entries to the ZIP
    processStructure(archive, lines.splice(1))
      .then(() => archive.finalize())
      .catch(reject);
  });
}
