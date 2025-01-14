import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AdvZlib } from "../src/adv-zlib";
import { createZip, DEFAULT_CONTENT } from "./fixture";

const BASE_DIR = path.join(__dirname, "fixture");
const CACHE_DIR = path.join(BASE_DIR, "cache");
const ASSET_DIR = path.join(BASE_DIR, "assets");
const advZlib = new AdvZlib({ cacheDir: CACHE_DIR });

async function setup() {
  if (!fs.existsSync(ASSET_DIR)) {
    await fs.promises.mkdir(ASSET_DIR, { recursive: true });
  }
}

async function cleanup() {
  await fs.promises.rm(BASE_DIR, { recursive: true, force: true });
  await advZlib.cleanup();
}

describe("Basics", () => {
  beforeEach(async () => {
    await setup();
  });

  afterEach(async () => {
    await cleanup();
  });

  const testCases = [
    { format: "Format1", filePath: "a/b.zip/c.txt" },
    {
      format: "Format2",
      filePath: "a/b.zip",
      expectedFiles: ["c.txt", "d.txt"],
    },
    { format: "Format3", filePath: "a/b.zip/c/d.txt" },
    {
      format: "Format4",
      filePath: "a/b.zip/c/",
      expectedFiles: ["d.txt", "e.txt"],
    },
    { format: "Format5", filePath: "a/b.zip/c.zip/d.txt" },
    { format: "Format6", filePath: "a/b.zip/c/d/e.zip/f.txt" },
    {
      format: "Format7",
      filePath: "a/b.zip/c",
      expectedFiles: ["c1.txt", "d/d1.txt", "d/d2.txt"],
    },
  ];

  testCases.forEach(({ format, filePath, expectedFiles }) => {
    it(`${format}: supporting ${format}`, async () => {
      await createZip(ASSET_DIR, filePath, expectedFiles);

      const src = path.join(ASSET_DIR, filePath);
      if (expectedFiles) {
        await expectFilesExistAndContent(
          advZlib,
          src,
          expectedFiles,
          DEFAULT_CONTENT
        );
      } else {
        await expectFileExistsAndContent(advZlib, src, DEFAULT_CONTENT);
      }
    });
  });
});

async function expectFileExistsAndContent(
  advZlib: AdvZlib,
  filePath: string,
  expectedContent: string
) {
  expect(await advZlib.exists(filePath)).toBeTruthy();
  expect((await advZlib.read(filePath)).toString()).toBe(expectedContent);
}

async function expectFilesExistAndContent(
  advZlib: AdvZlib,
  basePath: string,
  files: string[],
  expectedContent: string
) {
  for (const file of files) {
    const fullPath = path.join(basePath, file);
    await expectFileExistsAndContent(advZlib, fullPath, expectedContent);
  }
}
