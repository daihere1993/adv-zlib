import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// import { AdvZlib } from "../src/adv-zlib";
import { AdvZlib, ZipEntry } from "../dist/mjs";
// import { ZipEntry } from "../src/entry";
import { createZip, DEFAULT_CONTENT } from "./fixture";

const BASE_DIR = path.join(__dirname, "basic");
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

function sortEntries(entries: ZipEntry[]) {
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function sortFiles(files: string[]) {
  return files.sort((a, b) => a.localeCompare(b));
}

describe("Public APIs", () => {
  describe("getEntries()", () => {
    beforeEach(async () => {
      await setup();
    });

    afterEach(async () => {
      await cleanup();
    });

    it("Normal Case1: Should return all entries when no filter callback is provided", async () => {
      await createZip(ASSET_DIR, "/a/b.zip", ["c.txt", "d.txt"]);
      const entries = await advZlib.getEntries(
        path.join(ASSET_DIR, "/a/b.zip")
      );

      sortEntries(entries);
      expect(entries.length).toBe(2);
      expect(entries[0].name).toBe("c.txt");
      expect(entries[0].relPath).toBe("c.txt");
      expect(entries[0].fullPath).toBe(path.join(ASSET_DIR, "/a/b.zip/c.txt"));

      expect(entries[1].name).toBe("d.txt");
      expect(entries[1].relPath).toBe("d.txt");
      expect(entries[1].fullPath).toBe(path.join(ASSET_DIR, "/a/b.zip/d.txt"));
    });

    it("Normal Case2: Should return only the entries matching the provided filter callback", async () => {
      await createZip(ASSET_DIR, "/a/b.zip", ["c.txt", "d.txt"]);
      const entries = await advZlib.getEntries(
        path.join(ASSET_DIR, "/a/b.zip"),
        (entry: ZipEntry) => {
          return entry.name === "c.txt";
        }
      );

      expect(entries.length).toBe(1);
      expect(entries[0].name).toBe("c.txt");
      expect(entries[0].relPath).toBe("c.txt");
      expect(entries[0].fullPath).toBe(path.join(ASSET_DIR, "/a/b.zip/c.txt"));
    });

    it("Normal Case3: Should return all entries for nested ZIP files when no filter callback is provided", async () => {
      await createZip(ASSET_DIR, "/a/b.zip/c.zip", ["d.txt", "e.txt"]);
      const entries = await advZlib.getEntries(
        path.join(ASSET_DIR, "/a/b.zip/c.zip")
      );

      sortEntries(entries);
      expect(entries.length).toBe(2);
      expect(entries[0].name).toBe("d.txt");
      expect(entries[0].relPath).toBe("d.txt");
      expect(entries[0].fullPath).toBe(
        path.join(ASSET_DIR, "/a/b.zip/c.zip/d.txt")
      );

      expect(entries[1].name).toBe("e.txt");
      expect(entries[1].relPath).toBe("e.txt");
      expect(entries[1].fullPath).toBe(
        path.join(ASSET_DIR, "/a/b.zip/c.zip/e.txt")
      );
    });

    it("Edge Case1: Should return an empty array if no entries match the filter callback", async () => {
      await createZip(ASSET_DIR, "/a/b.zip", ["c.txt", "d.txt"]);
      const entries = await advZlib.getEntries(
        path.join(ASSET_DIR, "/a/b.zip"),
        (entry: ZipEntry) => {
          return entry.name === "e.txt";
        }
      );

      expect(entries.length).toBe(0);
    });

    it("Edge Case2: Should throw an error if the input file is not a valid ZIP file", async () => {
      await expect(
        advZlib.getEntries(path.join(ASSET_DIR, "/a/b.txt"))
      ).rejects.toThrow();
    });

    it("Edge Case3: Should throw an error if the input path is empty", async () => {
      await expect(advZlib.getEntries("")).rejects.toThrow();
    });

    it("Edge Case4: Should return entries under a specific folder within the ZIP file when filtering by path", async () => {
      await createZip(ASSET_DIR, "/a/b.zip", [
        "c/c1.txt",
        "c/c2.txt",
        "d/d1.txt",
      ]);
      const entries = await advZlib.getEntries(
        path.join(ASSET_DIR, "/a/b.zip"),
        (entry: ZipEntry) => {
          return entry.fullPath.startsWith(path.join(ASSET_DIR, "/a/b.zip/c"));
        }
      );

      sortEntries(entries);
      expect(entries.length).toBe(2);
      expect(entries[0].name).toBe("c1.txt");
      expect(entries[0].relPath).toBe(path.join("c/c1.txt"));
      expect(entries[0].fullPath).toBe(
        path.join(ASSET_DIR, "/a/b.zip/c/c1.txt")
      );

      expect(entries[1].name).toBe("c2.txt");
      expect(entries[1].relPath).toBe(path.join("c/c2.txt"));
      expect(entries[1].fullPath).toBe(
        path.join(ASSET_DIR, "/a/b.zip/c/c2.txt")
      );
    });
  });

  describe("exists()", () => {
    beforeEach(async () => {
      await setup();
    });

    afterEach(async () => {
      await cleanup();
    });

    it("Normal Case1: Should return true if the target file exists.", async () => {
      await createZip(ASSET_DIR, "/a/b.zip/c.txt");
      expect(
        await advZlib.exists(path.join(ASSET_DIR, "/a/b.zip/c.txt"))
      ).toBeTruthy();
    });

    it("Normal Case2: Should return false if the target file does not exist.", async () => {
      await createZip(ASSET_DIR, "/a/b.zip/c.txt");
      expect(
        await advZlib.exists(path.join(ASSET_DIR, "/a/b.zip/d.txt"))
      ).toBeFalsy();
    });

    it("Normal Case3: Should return true if nested zip file exists.", async () => {
      await createZip(ASSET_DIR, "/a/b.zip/c.zip/d.txt");
      expect(
        await advZlib.exists(path.join(ASSET_DIR, "/a/b.zip/c.zip"))
      ).toBeTruthy();
    });

    it("Edge Case1: Should throw an error if the source is empty.", async () => {
      await expect(advZlib.exists("")).rejects.toThrow();
    });

    it("Edge Case2: Should throw an error if the source ZIP file does not exist.", async () => {
      await expect(
        advZlib.exists(path.join(ASSET_DIR, "/a/b.zip/c.txt"))
      ).rejects.toThrow();
    });
  });

  describe("extract()", () => {
    beforeEach(async () => {
      await setup();
    });

    afterEach(async () => {
      await cleanup();
    });

    it("Normal Case1: When given the path `/a.zip/b.txt`, should only extract the file `b.txt`.", async () => {
      const extractDir = path.join(ASSET_DIR, "/extract");
      const extractFilePath = path.join(ASSET_DIR, "/extract/b.txt");
      fs.mkdirSync(extractDir, { recursive: true });

      await createZip(ASSET_DIR, "/a.zip", ["b.txt", "c.txt"]);
      const files = await advZlib.extract(
        path.join(ASSET_DIR, "/a.zip/b.txt"),
        extractDir
      );

      expect(files.length).toBe(1);
      expect(files[0]).toBe(extractFilePath);
      expect(fs.existsSync(extractFilePath)).toBeTruthy();
      expect(fs.readFileSync(extractFilePath).toString()).toBe(DEFAULT_CONTENT);
    });

    it("Normal Case2: When given the path `/a.zip/b/c.txt`, should only extract the file `c.txt`.", async () => {
      const extractDir = path.join(ASSET_DIR, "/extract");
      const extractFilePath = path.join(ASSET_DIR, "/extract/c1.txt");
      fs.mkdirSync(extractDir, { recursive: true });

      await createZip(ASSET_DIR, "/a.zip", ["b/c1.txt", "b/c2.txt"]);
      const files = await advZlib.extract(
        path.join(ASSET_DIR, "/a.zip/b/c1.txt"),
        extractDir
      );

      expect(files.length).toBe(1);
      expect(files[0]).toBe(extractFilePath);
      expect(fs.existsSync(extractFilePath)).toBeTruthy();
      expect(fs.readFileSync(extractFilePath).toString()).toBe(DEFAULT_CONTENT);
    });

    it("Normal Case3: When given the path `/a.zip`, should extract all files.", async () => {
      const extractDir = path.join(ASSET_DIR, "/extract");
      const extractFilePath1 = path.join(ASSET_DIR, "/extract/b.txt");
      const extractFilePath2 = path.join(ASSET_DIR, "/extract/c.txt");
      fs.mkdirSync(extractDir, { recursive: true });

      await createZip(ASSET_DIR, "/a.zip", ["b.txt", "c.txt"]);
      const files = await advZlib.extract(
        path.join(ASSET_DIR, "/a.zip"),
        extractDir
      );

      sortFiles(files);
      expect(files.length).toBe(2);
      expect(files[0]).toBe(extractFilePath1);
      expect(files[1]).toBe(extractFilePath2);
      expect(fs.existsSync(extractFilePath1)).toBeTruthy();
      expect(fs.readFileSync(extractFilePath1).toString()).toBe(
        DEFAULT_CONTENT
      );
      expect(fs.existsSync(extractFilePath2)).toBeTruthy();
      expect(fs.readFileSync(extractFilePath2).toString()).toBe(
        DEFAULT_CONTENT
      );
    });

    it("Normal Case4: Should extract all matched files using a filter callback.", async () => {
      const extractDir = path.join(ASSET_DIR, "/extract");
      const extractFilePath1 = path.join(ASSET_DIR, "/extract/b.txt");
      fs.mkdirSync(extractDir, { recursive: true });

      await createZip(ASSET_DIR, "/a.zip", ["b.txt", "c.txt"]);
      const files = await advZlib.extract(
        path.join(ASSET_DIR, "/a.zip"),
        extractDir,
        (entry: ZipEntry) => {
          return entry.name === "b.txt";
        }
      );

      sortFiles(files);
      expect(files.length).toBe(1);
      expect(files[0]).toBe(extractFilePath1);
      expect(fs.existsSync(extractFilePath1)).toBeTruthy();
      expect(fs.readFileSync(extractFilePath1).toString()).toBe(
        DEFAULT_CONTENT
      );
      expect(fs.existsSync(path.join(ASSET_DIR, "/extract/c.txt"))).toBeFalsy();
    });

    it("Normal Case5: Should extract a file to a specific path.", async () => {
      const extractDir = path.join(ASSET_DIR, "/extract");
      const extractFilePath = path.join(ASSET_DIR, "/extract/b.txt");
      fs.mkdirSync(extractDir, { recursive: true });

      await createZip(ASSET_DIR, "/a.zip", ["b.txt", "c.txt"]);
      const files = await advZlib.extract(
        path.join(ASSET_DIR, "/a.zip/b.txt"),
        extractFilePath
      );

      expect(files.length).toBe(1);
      expect(files[0]).toBe(extractFilePath);
      expect(fs.existsSync(extractFilePath)).toBeTruthy();
      expect(fs.readFileSync(extractFilePath).toString()).toBe(DEFAULT_CONTENT);
    });

    it("Edge Case1: Should throw an error if the source does not exist.", async () => {
      const extractDir = path.join(ASSET_DIR, "/extract");
      fs.mkdirSync(extractDir, { recursive: true });

      await expect(
        advZlib.extract(path.join(ASSET_DIR, "/a.zip"), extractDir)
      ).rejects.toThrow();
    });

    it("Edge Case2: Should throw an error if the destination does not exist.", async () => {
      const extractDir = "/not/exist/folder";

      await createZip(ASSET_DIR, "/a.zip", ["b.txt"]);
      await expect(
        advZlib.extract(path.join(ASSET_DIR, "/a.zip"), extractDir)
      ).rejects.toThrow();
    });
  });

  describe("read()", () => {
    beforeEach(async () => {
      await setup();
    });

    afterEach(async () => {
      await cleanup();
    });

    it("Normal Case1: When given the path /a.zip/b.txt, should successfully read the file b.txt.", async () => {
      await createZip(ASSET_DIR, "/a.zip/b.txt");
      const data = await advZlib.read(path.join(ASSET_DIR, "/a.zip/b.txt"));

      expect(data.length).toBeGreaterThan(0);
      expect(data.toString()).toBe(DEFAULT_CONTENT);
    });

    it("Normal Case2: When given the path /a.zip/b/c.txt, should successfully read the file c.txt.", async () => {
      await createZip(ASSET_DIR, "/a.zip/b/c.txt");
      const data = await advZlib.read(path.join(ASSET_DIR, "/a.zip/b/c.txt"));

      expect(data.length).toBeGreaterThan(0);
      expect(data.toString()).toBe(DEFAULT_CONTENT);
    });

    it("Normal Case3: When given the path /a.zip/[b1.txt, b2.txt], should successfully read the file b2.txt using a filter callback.", async () => {
      await createZip(ASSET_DIR, "/a.zip", ["b1.txt", "b2.txt"]);
      const data = await advZlib.read(
        path.join(ASSET_DIR, "/a.zip"),
        (entry: ZipEntry) => {
          return entry.name === "b2.txt";
        }
      );

      expect(data.length).toBeGreaterThan(0);
      expect(data.toString()).toBe(DEFAULT_CONTENT);
    });

    it("Normal Case4: When given the path /a.zip/b.zip/c.txt, should successfully read the file c.txt.", async () => {
      await createZip(ASSET_DIR, "/a.zip/b.zip", ["c.txt", "d.txt"]);
      const data = await advZlib.read(
        path.join(ASSET_DIR, "/a.zip/b.zip/c.txt")
      );

      expect(data.length).toBeGreaterThan(0);
      expect(data.toString()).toBe(DEFAULT_CONTENT);
    });

    it("Edge Case1: Should throw an error if the source not found.", async () => {
      await expect(
        advZlib.read(path.join(ASSET_DIR, "/a.zip/b.txt"))
      ).rejects.toThrow();
    });

    it("Edge Case2: Should return an empty buffer if multiple matched files are found.", async () => {
      await createZip(ASSET_DIR, "/a.zip", ["b/b1.txt", "b/b2.txt"]);
      const data = await advZlib.read(
        path.join(ASSET_DIR, "/a.zip"),
        (entry: ZipEntry) => {
          return entry.relPath.startsWith("b/");
        }
      );

      expect(data.length).toBe(0);
    });
  });
});
