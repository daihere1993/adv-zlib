import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, test } from 'vitest';

import { AdvZlib } from '../src/adv-zlib';
import { createZipFromStructure, DEFAULT_CONTENT } from './fixture';

let advZlib: AdvZlib;
const BASE_DIR = path.join(__dirname, 'ut_tmp_fixture');
const CACHE_DIR = path.join(BASE_DIR, 'cache');
const ASSET_DIR = path.join(BASE_DIR, 'assets');

async function setup() {
  if (!fs.existsSync(ASSET_DIR)) {
    await fs.promises.mkdir(ASSET_DIR, { recursive: true });
  }
}

async function cleanup() {
  await fs.promises.rm(ASSET_DIR, { recursive: true, force: true });
  await advZlib.cleanup();
}

describe('Basics', () => {
  beforeAll(() => {
    advZlib = new AdvZlib({ cacheBaseDir: CACHE_DIR });
  });

  afterAll(async () => {
    await fs.promises.rm(BASE_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await setup();
  });

  afterEach(async () => {
    await cleanup();
  });

  test('Format1: normal zip like /a.zip/b.txt', async () => {
    const structure = `
      a.zip
      └── b.txt
    `;
    await createZipFromStructure(ASSET_DIR, structure);

    const zipFile = path.join(ASSET_DIR, 'a.zip');
    expect(fs.existsSync(zipFile)).toBeTruthy();

    const src = path.join(ASSET_DIR, 'a.zip/b.txt');
    expect(await advZlib.exists(src)).toBeTruthy();

    const entries = await advZlib.getEntries(zipFile);
    expect(entries.length).toBe(1);

    const content = (await advZlib.read(src)).toString();
    expect(content).toBe(DEFAULT_CONTENT);
  });

  test('Format2: zip including multiple files', async () => {
    const structure = `
      a.zip
      └──b.txt
      └──c.txt
    `;
    await createZipFromStructure(ASSET_DIR, structure);

    const zipFile = path.join(ASSET_DIR, 'a.zip');
    expect(fs.existsSync(zipFile)).toBeTruthy();

    const entries = await advZlib.getEntries(zipFile);
    expect(entries.length).toBe(2);

    for (const entry of ['b.txt', 'c.txt']) {
      const src = path.join(ASSET_DIR, 'a.zip', entry);
      expect(await advZlib.exists(src)).toBeTruthy();

      const content = (await advZlib.read(src)).toString();
      expect(content).toBe(DEFAULT_CONTENT);
    }
  });

  test('Format3: zip including a subfolder', async () => {
    const structure = `
      a.zip
      └──c
        └──d.txt
        └──e.txt
    `;
    await createZipFromStructure(ASSET_DIR, structure);

    const zipFile = path.join(ASSET_DIR, 'a.zip');
    expect(fs.existsSync(zipFile)).toBeTruthy();

    const src = path.join(ASSET_DIR, 'a.zip/c/d.txt');
    expect(await advZlib.exists(src)).toBeTruthy();

    const entries = await advZlib.getEntries(zipFile);
    expect(entries.length).toBe(3);

    // one of the entry should be a directory
    const directory = entries.find((entry) => entry.isDirectory);
    expect(!!directory).toBeTruthy();

    const content = (await advZlib.read(src)).toString();
    expect(content).toBe(DEFAULT_CONTENT);
  });

  test('Case4: normal nested zip like /a.zip/b.zip/c.txt', async () => {
    const structure = `
      a.zip
      └──b.zip
        └──c.txt
    `;
    await createZipFromStructure(ASSET_DIR, structure);

    const zipFile = path.join(ASSET_DIR, 'a.zip');
    expect(fs.existsSync(zipFile)).toBeTruthy();

    const src = path.join(ASSET_DIR, 'a.zip/b.zip/c.txt');
    expect(await advZlib.exists(src)).toBeTruthy();

    const entries = await advZlib.getEntries(zipFile);
    expect(entries.length).toBe(1);

    const content = (await advZlib.read(src)).toString();
    expect(content).toBe(DEFAULT_CONTENT);
  });

  test('Format5: conbine nested folder and nested zip', async () => {
    const structure = `
      a.zip
      └──b
        └──c
          └──d.zip
            └──e.txt
    `;
    await createZipFromStructure(ASSET_DIR, structure);

    const zipFile = path.join(ASSET_DIR, 'a.zip');
    expect(fs.existsSync(zipFile)).toBeTruthy();

    const src = path.join(ASSET_DIR, 'a.zip/b/c/d.zip/e.txt');
    expect(await advZlib.exists(src)).toBeTruthy();

    const entries = await advZlib.getEntries(zipFile);
    expect(entries.length).toBe(3);

    // Should have two directories
    const directories = entries.filter((entry) => entry.isDirectory);
    expect(directories.length).toBe(2);

    const content = (await advZlib.read(src)).toString();
    expect(content).toBe(DEFAULT_CONTENT);
  });
});
