<h1 align="center">
🚀 adv-zlib
</h1>

<p align="center">
The go-to package for working with large and nested ZIP files — fast, efficient, and effortlessly.
</p>

<div align="center">
  <a href="https://www.npmjs.com/package/adv-zlib"><img src="https://img.shields.io/npm/v/adv-zlib"></a>
  <a href="https://app.codecov.io/gh/daihere1993/adv-zlib/tree/main/projects">
    <img src="https://codecov.io/gh/daihere1993/adv-zlib/branch/main/graphs/badge.svg" alt="Coverage Status" />
  </a>
  <a href="https://github.com/daihere1993/adv-zlib/actions/workflows/ci.yml"><img src="https://github.com/daihere1993/adv-zlib/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg"></a>
</div>

## Features

- 🔥🔥🔥 **Optimized for large ZIP files**: Handle big size ZIP files with considerable speed and low memory usage.
- 🔥🔥🔥 **Elegant way to handle nested ZIP files**: Providing semantic APIs to work with deeply nested ZIP files like `/a.zip/b.zip/c.txt`.
- 🔥🔥 **ESM-first with CJS compatibility**: Fully embraces ESM, while also providing `.cjs` builds for CommonJS projects.
- 🔥 **Non-blocking**: All I/O operations are implemented with Streams to maximize performance and scalability.
- 🔥 **Modern async/await APIs**: Simplified APIs using async/await, no callbacks required.

## Installation

```bash
npm install adv-zlib
```

Once the package installed, you can import the library using `import` or `require`:
```typescript
// With import
import AdvZlib from 'adv-zlib';

// With require
const AdvZlib = require('adv-zlib');
```
## Usage with Real-World Examples
### Example 1: Extracting Specific Files from a Large ZIP Without Full Decompression

```typescript
import AdvZlib from 'adv-zlib';
const advZlib = new AdvZlib();

const zipFilePath = '/path/to/bigsize.zip';
const targetFile = 'foo.txt';

// 1. Check if target file exist
if (await advZlib.exists(path.join(zipFilePath, targetFile))) {
  // 2. Read target file
  const content = (await advZlib.read(zipFilePath, targetFile)).toString();

  // 3. Do something with the content
  // ...
}
```

#### 💡 Why use adv-zlib?
Unlike traditional extraction methods, adv-zlib reads only the required file, significantly improving performance by avoiding full decompression.

### Example 2:Handling Nested ZIP Files with a Clean and efficient API

```typescript
import AdvZlib from 'adv-zlib';
const advZlib = new AdvZlib();

const zipFilePath = '/path/to/bigsize.zip';
const targetFiles = [
  'nest1.zip/nest2.zip/foo.txt',
  'nest1.zip/nest2.zip/bar.txt'
];

for (const targetFile of targetFiles) {
  // 1. Check if target file exist
  if (await advZlib.exists(path.join(zipFilePath, targetFile))) {
    // 2. Read target file
    const content = (await advZlib.read(zipFilePath, targetFile)).toString();

    // 3. Do something with the content
    // ...
  }
}
```

#### 💡 Optimized Nested ZIP Handling
adv-zlib caches decompressed buffers of nested ZIPs (e.g., nest1.zip and nest2.zip in this example). Once a nested ZIP is decompressed, future operations on the same ZIP reuse the cached data, significantly reducing processing time.


## APIs

### `exists()`: Check if a file exists in a ZIP
- `exists(path: string): Promise<boolean>`

### `read()`: Read content from an specific file within a ZIP file
- `read(path: string): Promise<Buffer>`
- `read(path: string, filter: (entry: ZipEntry) => boolean): Promise<Buffer>`

### `extract()`: Extract a file or a folder from a ZIP file
- `extract(path: string): Promise<void>`
- `extract(path: string, filter: (entry: ZipEntry) => boolean): Promise<void>`

### `cleanup()`: Clean up the caches
- `cleanup(): Promise<void>`

## Cache Mechanism
- To avoid reanalyzing the same ZIP file multiple times, `adv-zlib` caches up to 10 `CentralDir` instances per ZIP file. Each instance consumes very little memory, so there is no need to worry about memory leaks.
- To enhance performance when handling nested ZIP files, `adv-zlib` caches decompressed buffers of nested ZIP files in a designated folder (default: `node_modules/.cache/adv-zlib/`).
- Remember to call `cleanup()` to clear the caches once all ZIP files have been processed.
- Please raise an issue if you find any bugs or have suggestions for improvements.

## Upcoming
- **Compression APIs**: passible based on [archiver](https://github.com/archiverjs/node-archiver) to provide several sementic APIs for zip compression.
- **Encryption APIs**: would provide APIs like `isEncrypted()` and add new arguments `password` to existed APIs to support encrypted zip files.

## Testing

The test suite includes comprehensive tests for functionality, performance, and backwards compatibility. The tests use a configurable logging system to control output verbosity:

### Test Logging Options

- **Default**: Clean output showing only essential information
- **Verbose**: `TEST_VERBOSE=true npm test` - Shows detailed progress and performance metrics
- **Silent**: `TEST_SILENT=true npm test` - Shows only test results and failures

For more details, see [tests/README.md](tests/README.md).

## Report Issue
Feel free to raise an issue if you find any bugs or have suggestions for improvements. I will reponse/fix them as soon as possible.

## License
MIT
