# Large ZIP Testing and Disk Caching

This document describes the enhanced testing capabilities and disk caching features added to RefactoredAdvZlib.

## Overview

The RefactoredAdvZlib implementation includes a new **DecompressedContentCache** that provides:

1. **Hybrid Memory/Disk Caching** - Large decompressed content is stored on disk to avoid memory exhaustion
2. **Configurable Thresholds** - Fine-tune when content should be cached in memory vs disk
3. **LRU Eviction** - Intelligent cache management for both memory and disk entries
4. **Performance Optimization** - Significant speedup for repeated access to large content

## Test Assets

### Many Entries ZIP
- **Purpose**: Tests performance with ZIP files containing many entries (40,000 small files)
- **Benefits**: Validates CentralDir caching effectiveness with large file counts
- **Use Case**: Simulates applications that work with ZIPs containing many small files

### Large Nested ZIP
- **Purpose**: Tests decompressed content caching with large nested ZIP files
- **Default Size**: 2GB (configurable via environment variable)
- **Structure**: Contains multiple large files (200MB each) for comprehensive testing
- **Use Case**: Simulates real-world scenarios with large ZIP entries that benefit from disk caching

## Configuration Options

### RefactoredAdvZlib Options

```typescript
const advZlib = new RefactoredAdvZlib({
  // Content caching configuration
  enableContentCaching: true,              // Enable/disable content caching
  maxContentCacheCount: 100,               // Maximum number of cached entries
  maxContentCacheMemoryMB: 50,             // Memory limit for in-memory cache
  maxContentCacheFileSizeMB: 10,           // Files larger than this go to disk
  tempDir: '/custom/temp/path',            // Custom temp directory for disk cache
  
  // Central directory caching
  maxCentralDirCount: 10,                  // Maximum cached central directories
  maxCacheMemoryMB: 100,                   // Memory limit for central dir cache
});
```

### Environment Variables

- **TEST_LARGE_ZIP_SIZE_MB**: Controls the size of the large nested ZIP test asset
  - Default: `2048` (2GB)
  - Quick tests: `100` (100MB)
  - Stress tests: `5120` (5GB)

## Running Performance Tests

### Using the Test Runner Script

```bash
# Quick test (100MB large ZIP, ~2 minutes)
node scripts/test-performance.cjs quick

# Medium test (500MB large ZIP, ~5 minutes)
node scripts/test-performance.cjs medium

# Full test (2GB large ZIP, ~15 minutes)
node scripts/test-performance.cjs full

# Extreme test (5GB large ZIP, ~30 minutes)
node scripts/test-performance.cjs extreme
```

### Using Environment Variables Directly

```bash
# Custom size (1GB)
TEST_LARGE_ZIP_SIZE_MB=1024 npm test -- tests/refactor/02-performance-comparison.test.ts

# Quick development test
TEST_LARGE_ZIP_SIZE_MB=50 npm test -- tests/refactor/02-performance-comparison.test.ts
```

## Performance Benefits

### Memory Efficiency
- Large decompressed content (>10MB default) is cached on disk
- Prevents memory exhaustion with large ZIP entries
- Configurable memory/disk thresholds

### Speed Improvements
- **Cold Cache**: Comparable performance to legacy implementation
- **Warm Cache**: 2-10x speedup for repeated operations
- **Large Content**: Significant improvement for large nested ZIP scenarios

### Cache Statistics
The `getCacheStats()` method provides detailed information:

```typescript
const stats = advZlib.getCacheStats();
console.log(`Central Directory: ${stats.centralDir.entries} entries, ${stats.centralDir.memoryMB}MB`);
console.log(`Content Cache: ${stats.content.entries} total (${stats.content.memoryEntries} memory, ${stats.content.diskEntries} disk)`);
console.log(`Total Memory: ${stats.total.memoryMB}MB`);
```

## Use Cases

### 1. Large ZIP Archives
- **Scenario**: Working with ZIP files containing large individual entries (>100MB)
- **Benefit**: Decompressed content is cached on disk, avoiding repeated decompression
- **Example**: Processing large log files, database dumps, or media files within ZIPs

### 2. Many Small Files
- **Scenario**: ZIP files with thousands of small entries
- **Benefit**: Central directory caching avoids repeated parsing
- **Example**: Application packages, documentation archives, web assets

### 3. Nested ZIP Processing
- **Scenario**: ZIP files containing other ZIP files
- **Benefit**: Both outer and inner ZIP structures are cached
- **Example**: Software distributions, backup archives, multi-level packaging

## Best Practices

### Configuration
1. **Set appropriate memory limits** based on your application's memory constraints
2. **Configure disk cache location** for optimal I/O performance
3. **Tune file size thresholds** based on your typical content sizes

### Testing
1. **Start with quick tests** during development (`TEST_LARGE_ZIP_SIZE_MB=100`)
2. **Run full tests** before deployment to validate performance
3. **Use extreme tests** for stress testing and capacity planning

### Production
1. **Monitor cache statistics** to optimize configuration
2. **Clean up cache** when no longer needed to free resources
3. **Consider disk space** for applications processing many large ZIPs

## Technical Implementation

### Cache Architecture
```
RefactoredAdvZlib
├── CentralDirCache (in-memory)
│   ├── LRU eviction by access time
│   └── Memory limit enforcement
└── DecompressedContentCache (hybrid)
    ├── Small files: in-memory storage
    ├── Large files: disk storage
    └── Unified LRU eviction strategy
```

### Disk Cache Management
- **Location**: Configurable temp directory (default: OS temp)
- **Cleanup**: Automatic on cache eviction or explicit cleanup
- **Security**: Files created with appropriate permissions
- **Concurrency**: Thread-safe operation

### Performance Monitoring
- **Cache hit rates**: Track effectiveness of caching strategy
- **Memory usage**: Monitor and control memory consumption
- **Disk usage**: Track disk space used by cache files
- **Access patterns**: LRU statistics for optimization

## Troubleshooting

### High Memory Usage
1. Reduce `maxContentCacheMemoryMB`
2. Decrease `maxContentCacheFileSizeMB` to force more disk caching
3. Lower `maxContentCacheCount`

### Slow Performance
1. Increase memory limits if available
2. Ensure temp directory is on fast storage (SSD)
3. Check cache hit rates in statistics

### Disk Space Issues
1. Configure `tempDir` to location with sufficient space
2. Reduce cache limits to control disk usage
3. Implement regular cache cleanup in your application

## Migration Guide

### From Legacy AdvZlib
The RefactoredAdvZlib is a drop-in replacement with identical API:

```typescript
// Before
const legacyLib = new AdvZlib();

// After - with enhanced caching
const newLib = new RefactoredAdvZlib({
  enableContentCaching: true,
  maxContentCacheFileSizeMB: 10,
});

// Same API calls work identically
const entries = await newLib.getEntries('archive.zip');
const content = await newLib.read('archive.zip/file.txt');
```

### Performance Testing
Compare performance using the included test suite:

```bash
# Test with your typical ZIP sizes
TEST_LARGE_ZIP_SIZE_MB=500 npm test -- tests/refactor/02-performance-comparison.test.ts
```

The test suite will show performance improvements and validate that the new implementation maintains backwards compatibility while providing significant performance benefits. 