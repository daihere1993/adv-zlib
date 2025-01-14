import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import { assert } from 'node:console';

export const DEFAULT_CONTENT = 'TEST';

/**
 * Case1: ['a.txt'] => ['/a.txt']
 * Case2: ['a/b.txt'] => ['/a/b.txt']
 * Case3: ['a/b.txt', 'a/c.txt'] => ['a/']
 */
function createEntries(baseDir: string, files: string[]): Set<string> {
  const entries = new Set<string>();
  for (const file of files) {
    let entry: string | undefined = undefined, baseDir_ = baseDir;
    const segs = file.split('/');

    for (const seg of segs) {
      const isFile = seg.includes('.');
      const isFolder = !isFile;

      if (isFolder) {
        const folderDir = path.join(baseDir_, seg);
        if (!fs.existsSync(folderDir)) {
          fs.mkdirSync(folderDir);
        }
        entry = folderDir;
        baseDir_ = folderDir;
      } else if (isFile) {
        const filePath = path.join(baseDir_, seg);
        entry = entry || filePath;
        fs.writeFileSync(filePath, DEFAULT_CONTENT);
        entries.add(entry);
        break;
      } else {
        throw new Error(`Invalid file path: ${file}`);
      }
    }
  }
  return entries;
}

function createFolder(baseDir: string, folder: string, childEntries: Set<string>) {
  assert(folder, 'The folder name should not be empty');
  
  const folderPath = path.join(baseDir, folder);

  if (fs.existsSync(folderPath)) {
    fs.rmSync(folderPath, { recursive: true });
  }

  fs.mkdirSync(folderPath, { recursive: true });
  for (const childEntry of childEntries) {
    assert(fs.existsSync(childEntry), `The child entry ${childEntry} does not exist`);
    fs.renameSync(childEntry, path.join(folderPath, path.basename(childEntry)));
  }
  return folderPath;
}

function createZipFile(baseDir: string, zipFile: string, childEntries: Set<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const zipFilePath = path.join(baseDir, zipFile);
    const archive = archiver('zip', { zlib: { level: 9 } });
    const output = fs.createWriteStream(zipFilePath);

    output.on('close', () => {
      childEntries.forEach((entry) => {
        fs.rmSync(entry, { recursive: true });
      });
      resolve(zipFilePath);
    });

    output.on('error', (err) => {
      reject(err);
    });

    archive.pipe(output);

    for (const entry of childEntries) {
      assert(fs.existsSync(entry), `The child entry ${entry} does not exist`);
      if (fs.statSync(entry).isDirectory()) {
        archive.directory(entry, path.basename(entry));
      } else {
        archive.file(entry, { name: path.basename(entry) });
      }
    }

    archive.finalize();
  });
}

/**
 * Summary: create zip assets quickly and easily for testing
 * Supported formats:
 *  - '/b.zip/c.txt'
 *  - '/b.zip', ['c.txt', 'd.txt']
 *  - '/b.zip/c/d.txt'
 *  - '/b.zip/c/', ['d.txt', 'e.txt']
 *  - '/b.zip/c.zip/d.txt'
 *  - '/b.zip/c/d/e.zip/f.txt'
 *  - '/b.zip', ['c/c1.txt', 'c/c2.txt'] 
 */
export async function createZip(baseDir: string, src: string, subEntries: string[] = []) {
  let childEntries = createEntries(baseDir, subEntries);
  
  const segs = src.split('/');
  for (let i = segs.length - 1; i >= 0; i--) {
    const entry = segs[i];

    if (!entry) {
      continue;
    }

    const isFolder = !entry.includes('.');
    if (entry.endsWith('.zip')) {
      const zipFilePath = await createZipFile(baseDir, entry, childEntries);
      childEntries.clear();
      childEntries.add(zipFilePath);
    } else if (isFolder) {
      const folderPath = createFolder(baseDir, entry, childEntries);
      childEntries.clear();
      childEntries.add(folderPath);
    } else {
      childEntries = createEntries(baseDir, [entry]);
    }
  }
}
