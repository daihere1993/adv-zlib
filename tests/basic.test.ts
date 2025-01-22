import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AdvZlib } from '../src/adv-zlib';
import { ZipEntry } from '../src/entry';
import { createZipFromStructure, DEFAULT_CONTENT } from './fixture';

const BASE_DIR = path.join(__dirname, 'ut_tmp_basic');
const CACHE_DIR = path.join(BASE_DIR, 'cache');
const ASSET_DIR = path.join(BASE_DIR, 'assets');

let advZlib: AdvZlib;

async function setup() {
  if (!fs.existsSync(ASSET_DIR)) {
    await fs.promises.mkdir(ASSET_DIR, { recursive: true });
  }
}

async function cleanup() {
  await advZlib.cleanup();
  await fs.promises.rm(ASSET_DIR, { recursive: true, force: true });
}

function sortEntries(entries: ZipEntry[]) {
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function sortFiles(files: string[]) {
  return files.sort((a, b) => a.localeCompare(b));
}

describe('Public APIs', () => {
  beforeAll(() => {
    advZlib = new AdvZlib({ cacheDir: CACHE_DIR });
  });

  afterAll(async () => {
    await fs.promises.rm(BASE_DIR, { recursive: true, force: true });
  });

  describe('getEntries()', () => {
    beforeEach(async () => {
      await setup();
    });

    afterEach(async () => {
      await cleanup();
    });

    it('Normal Case1: Should return all entries when no filter callback is provided', async () => {
      const structure = `
        a.zip
        └──b.txt
        └──c.txt
      `;
      await createZipFromStructure(ASSET_DIR, structure);
      const entries = await advZlib.getEntries(path.join(ASSET_DIR, '/a.zip'));

      sortEntries(entries);
      expect(entries.length).toBe(2);
      expect(entries[0].name).toBe('b.txt');
      expect(entries[0].relPath).toBe('b.txt');
      expect(entries[0].fullPath).toBe(path.join(ASSET_DIR, '/a.zip/b.txt'));

      expect(entries[1].name).toBe('c.txt');
      expect(entries[1].relPath).toBe('c.txt');
      expect(entries[1].fullPath).toBe(path.join(ASSET_DIR, '/a.zip/c.txt'));
    });

    it('Normal Case2: Should return only the entries matching the provided filter callback', async () => {
      const structure = `
        a.zip
        └──b.txt
        └──c.txt
      `;
      await createZipFromStructure(ASSET_DIR, structure);
      const entries = await advZlib.getEntries(path.join(ASSET_DIR, '/a.zip'), (entry: ZipEntry) => {
        return entry.name === 'c.txt';
      });

      expect(entries.length).toBe(1);
      expect(entries[0].name).toBe('c.txt');
      expect(entries[0].relPath).toBe('c.txt');
      expect(entries[0].fullPath).toBe(path.join(ASSET_DIR, '/a.zip/c.txt'));
    });

    it('Normal Case3: Should return all entries for nested ZIP files when no filter callback is provided', async () => {
      const structure = `
        a.zip
        └──b.zip
          └──c.txt
          └──d.txt
      `;
      await createZipFromStructure(ASSET_DIR, structure);
      const entries = await advZlib.getEntries(path.join(ASSET_DIR, '/a.zip/b.zip'));

      sortEntries(entries);
      expect(entries.length).toBe(2);
      expect(entries[0].name).toBe('c.txt');
      expect(entries[0].relPath).toBe('c.txt');
      expect(entries[0].fullPath).toBe(path.join(ASSET_DIR, '/a.zip/b.zip/c.txt'));

      expect(entries[1].name).toBe('d.txt');
      expect(entries[1].relPath).toBe('d.txt');
      expect(entries[1].fullPath).toBe(path.join(ASSET_DIR, '/a.zip/b.zip/d.txt'));
    });

    it('Edge Case1: Should return an empty array if no entries match the filter callback', async () => {
      const structure = `
        a.zip
        └──b.txt
        └──c.txt
      `;
      await createZipFromStructure(ASSET_DIR, structure);
      const entries = await advZlib.getEntries(path.join(ASSET_DIR, '/a.zip'), (entry: ZipEntry) => {
        return entry.name === 'e.txt';
      });

      expect(entries.length).toBe(0);
    });

    it('Edge Case2: Should throw an error if the input file is not a valid ZIP file', async () => {
      await expect(advZlib.getEntries(path.join(ASSET_DIR, '/a/b.txt'))).rejects.toThrow();
    });

    it('Edge Case3: Should throw an error if the input path is empty', async () => {
      await expect(advZlib.getEntries('')).rejects.toThrow();
    });

    it('Edge Case4: Should return entries under a specific folder within the ZIP file when filtering by path', async () => {
      const structure = `
        a.zip
        └──b
          └──b1.txt
          └──b2.txt
        └──c
          └──c1.txt
      `;
      await createZipFromStructure(ASSET_DIR, structure);
      const entries = await advZlib.getEntries(path.join(ASSET_DIR, 'a.zip'), (entry: ZipEntry) => {
        return entry.fullPath.startsWith(path.join(ASSET_DIR, '/a.zip/b/')) && !entry.isDirectory;
      });

      sortEntries(entries);
      expect(entries.length).toBe(2);
      expect(entries[0].name).toBe('b1.txt');
      expect(entries[0].relPath).toBe(path.join('b/b1.txt'));
      expect(entries[0].fullPath).toBe(path.join(ASSET_DIR, '/a.zip/b/b1.txt'));

      expect(entries[1].name).toBe('b2.txt');
      expect(entries[1].relPath).toBe(path.join('b/b2.txt'));
      expect(entries[1].fullPath).toBe(path.join(ASSET_DIR, '/a.zip/b/b2.txt'));
    });
  });

  describe('exists()', () => {
    beforeEach(async () => {
      await setup();
    });

    afterEach(async () => {
      await cleanup();
    });

    it('Normal Case1: Should return true if the target file exists.', async () => {
      const structure = `
        a.zip
        └──b.txt
      `;
      await createZipFromStructure(ASSET_DIR, structure);
      expect(await advZlib.exists(path.join(ASSET_DIR, '/a.zip/b.txt'))).toBeTruthy();
    });

    it('Normal Case2: Should return false if the target file does not exist.', async () => {
      const structure = `
        a.zip
        └──b.txt
      `;
      await createZipFromStructure(ASSET_DIR, structure);
      expect(await advZlib.exists(path.join(ASSET_DIR, '/a.zip/d.txt'))).toBeFalsy();
    });

    it('Normal Case3: Should return true if nested zip file exists.', async () => {
      const structure = `
        a.zip
        └──b.zip
          └──d.txt
      `;
      await createZipFromStructure(ASSET_DIR, structure);
      expect(await advZlib.exists(path.join(ASSET_DIR, '/a.zip/b.zip'))).toBeTruthy();
    });

    it('Edge Case1: Should throw an error if the source is empty.', async () => {
      await expect(advZlib.exists('')).rejects.toThrow();
    });

    it('Edge Case2: Should return false if the source ZIP file does not exist.', async () => {
      expect(await advZlib.exists(path.join(ASSET_DIR, '/a/b.zip/c.txt'))).toBeFalsy();
    });
  });

  describe('extract()', () => {
    beforeEach(async () => {
      await setup();
    });

    afterEach(async () => {
      await cleanup();
    });

    it('Normal Case1: When given the path `/a.zip/b.txt`, should only extract the file `b.txt`.', async () => {
      const extractDir = path.join(ASSET_DIR, '/extract');
      const extractFilePath = path.join(ASSET_DIR, '/extract/b.txt');
      fs.mkdirSync(extractDir, { recursive: true });

      const structure = `
        a.zip
        └──b.txt
        └──c.txt
      `;
      await createZipFromStructure(ASSET_DIR, structure);
      const files = await advZlib.extract(path.join(ASSET_DIR, '/a.zip/b.txt'), extractDir);

      expect(files.length).toBe(1);
      expect(files[0]).toBe(extractFilePath);
      expect(fs.existsSync(extractFilePath)).toBeTruthy();
      expect(fs.readFileSync(extractFilePath).toString()).toBe(DEFAULT_CONTENT);
    });

    it('Normal Case2: When given the path `/a.zip/b/c.txt`, should only extract the file `c.txt`.', async () => {
      const extractDir = path.join(ASSET_DIR, '/extract');
      const extractFilePath = path.join(ASSET_DIR, '/extract/c1.txt');
      fs.mkdirSync(extractDir, { recursive: true });

      const structure = `
        a.zip
        └──b
          └──c1.txt
          └──c2.txt
      `;
      await createZipFromStructure(ASSET_DIR, structure);
      const files = await advZlib.extract(path.join(ASSET_DIR, '/a.zip/b/c1.txt'), extractDir);

      expect(files.length).toBe(1);
      expect(files[0]).toBe(extractFilePath);
      expect(fs.existsSync(extractFilePath)).toBeTruthy();
      expect(fs.readFileSync(extractFilePath).toString()).toBe(DEFAULT_CONTENT);
    });

    it('Normal Case3: When given the path `/a.zip`, should extract all files.', async () => {
      const extractDir = path.join(ASSET_DIR, '/extract');
      const extractFilePath1 = path.join(ASSET_DIR, '/extract/b.txt');
      const extractFilePath2 = path.join(ASSET_DIR, '/extract/c.txt');
      fs.mkdirSync(extractDir, { recursive: true });

      const structure = `
        a.zip
        └──b.txt
        └──c.txt
      `;
      await createZipFromStructure(ASSET_DIR, structure);
      const files = await advZlib.extract(path.join(ASSET_DIR, '/a.zip'), extractDir);

      sortFiles(files);
      expect(files.length).toBe(2);
      expect(files[0]).toBe(extractFilePath1);
      expect(files[1]).toBe(extractFilePath2);
      expect(fs.existsSync(extractFilePath1)).toBeTruthy();
      expect(fs.readFileSync(extractFilePath1).toString()).toBe(DEFAULT_CONTENT);
      expect(fs.existsSync(extractFilePath2)).toBeTruthy();
      expect(fs.readFileSync(extractFilePath2).toString()).toBe(DEFAULT_CONTENT);
    });

    it('Normal Case4: Should extract all matched files using a filter callback.', async () => {
      const extractDir = path.join(ASSET_DIR, '/extract');
      const extractFilePath1 = path.join(ASSET_DIR, '/extract/b.txt');
      fs.mkdirSync(extractDir, { recursive: true });

      const structure = `
        a.zip
        └──b.txt
        └──c.txt
      `;
      await createZipFromStructure(ASSET_DIR, structure);
      const files = await advZlib.extract(path.join(ASSET_DIR, '/a.zip'), extractDir, (entry: ZipEntry) => {
        return entry.name === 'b.txt';
      });

      sortFiles(files);
      expect(files.length).toBe(1);
      expect(files[0]).toBe(extractFilePath1);
      expect(fs.existsSync(extractFilePath1)).toBeTruthy();
      expect(fs.readFileSync(extractFilePath1).toString()).toBe(DEFAULT_CONTENT);
      expect(fs.existsSync(path.join(ASSET_DIR, '/extract/c.txt'))).toBeFalsy();
    });

    it('Normal Case5: Should extract a file to a specific path.', async () => {
      const extractDir = path.join(ASSET_DIR, '/extract');
      const extractFilePath = path.join(ASSET_DIR, '/extract/b.txt');
      fs.mkdirSync(extractDir, { recursive: true });

      const structure = `
        a.zip
        └──b.txt
        └──c.txt
      `;
      await createZipFromStructure(ASSET_DIR, structure);
      const files = await advZlib.extract(path.join(ASSET_DIR, '/a.zip/b.txt'), extractFilePath);

      expect(files.length).toBe(1);
      expect(files[0]).toBe(extractFilePath);
      expect(fs.existsSync(extractFilePath)).toBeTruthy();
      expect(fs.readFileSync(extractFilePath).toString()).toBe(DEFAULT_CONTENT);
    });

    it('Edge Case1: Should throw an error if the source does not exist.', async () => {
      const extractDir = path.join(ASSET_DIR, '/extract');
      fs.mkdirSync(extractDir, { recursive: true });

      await expect(advZlib.extract(path.join(ASSET_DIR, '/a.zip'), extractDir)).rejects.toThrow();
    });

    it('Edge Case2: Should throw an error if the destination does not exist.', async () => {
      const extractDir = '/not/exist/folder';

      const structure = `
        a.zip
        └──b.txt
        └──c.txt
      `;
      await createZipFromStructure(ASSET_DIR, structure);
      await expect(advZlib.extract(path.join(ASSET_DIR, '/a.zip'), extractDir)).rejects.toThrow();
    });
  });

  describe('read()', () => {
    beforeEach(async () => {
      await setup();
    });

    afterEach(async () => {
      await cleanup();
    });

    it('Normal Case1: When given the path /a.zip/b.txt, should successfully read the file b.txt.', async () => {
      const structure = `
        a.zip
        └──b.txt
      `;
      await createZipFromStructure(ASSET_DIR, structure);
      const data = await advZlib.read(path.join(ASSET_DIR, '/a.zip/b.txt'));

      expect(data.toString()).toBe(DEFAULT_CONTENT);
    });

    it('Normal Case2: When given the path /a.zip/b/c.txt, should successfully read the file c.txt.', async () => {
      const structure = `
        a.zip
        └──b
          └──c.txt
      `;
      await createZipFromStructure(ASSET_DIR, structure);
      const data = await advZlib.read(path.join(ASSET_DIR, '/a.zip/b/c.txt'));

      expect(data.length).toBeGreaterThan(0);
      expect(data.toString()).toBe(DEFAULT_CONTENT);
    });

    it('Normal Case3: When given the path /a.zip/[b1.txt, b2.txt], should successfully read the file b2.txt using a filter callback.', async () => {
      const structure = `
        a.zip
        └──b1.txt
        └──b2.txt
      `;
      await createZipFromStructure(ASSET_DIR, structure);
      const data = await advZlib.read(path.join(ASSET_DIR, '/a.zip'), (entry: ZipEntry) => {
        return entry.name === 'b2.txt';
      });

      expect(data.length).toBeGreaterThan(0);
      expect(data.toString()).toBe(DEFAULT_CONTENT);
    });

    it('Normal Case4: When given the path /a.zip/b.zip/c.txt, should successfully read the file c.txt.', async () => {
      const structure = `
        a.zip
        └──b.zip
          └──c.txt
          └──d.txt
      `;
      await createZipFromStructure(ASSET_DIR, structure);
      const data = await advZlib.read(path.join(ASSET_DIR, '/a.zip/b.zip/c.txt'));

      expect(data.length).toBeGreaterThan(0);
      expect(data.toString()).toBe(DEFAULT_CONTENT);
    });

    it('Normal Case5: Read folder unter a zip file with a filter callback', async () => {
      const structure = `
        a.zip
        └──b
          └──b1.txt
          └──b2.txt
      `;
      await createZipFromStructure(ASSET_DIR, structure);
      const data = await advZlib.read(path.join(ASSET_DIR, '/a.zip/b'), (entry: ZipEntry) => {
        return entry.name === 'b1.txt';
      });

      expect(data.toString()).toBe(DEFAULT_CONTENT);
    });

    it('Edge Case1: Should throw an error if the source not found.', async () => {
      await expect(advZlib.read(path.join(ASSET_DIR, '/a.zip/b.txt'))).rejects.toThrow();
    });

    it('Edge Case2: Should return an empty buffer if multiple matched files are found.', async () => {
      const structure = `
        a.zip
        └──b
          └──b1.txt
          └──b2.txt
      `;
      await createZipFromStructure(ASSET_DIR, structure);
      const data = await advZlib.read(path.join(ASSET_DIR, '/a.zip'), (entry: ZipEntry) => {
        return entry.relPath.startsWith('b/');
      });

      expect(data.length).toBe(0);
    });
  });
});
