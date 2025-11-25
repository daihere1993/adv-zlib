# CI/CD Workflow

This document explains the Continuous Integration and Continuous Deployment (CI/CD) workflow for the `adv-zlib` package.

## Overview

The project uses GitHub Actions to automate testing and publishing:

- **CI (Continuous Integration)**: Runs automated tests on every pull request
- **CD (Continuous Deployment)**: Automatically publishes to npm when changes are merged to `main`

## Workflow Architecture

### CI Workflow (Pull Request Testing)

**Trigger**: Automatically runs on all pull requests to the `main` branch

**Platforms**: Tests run on both:
- Ubuntu Linux (ubuntu-latest)
- Windows (windows-latest)

**Steps**:
1. Checkout code
2. Setup pnpm (v9.12.0) and Node.js (v18.x)
3. Install dependencies
4. Run type checking (`pnpm typecheck`)
5. Run linting (`pnpm lint`)
6. Build the project (`pnpm build`)
7. Run tests (`pnpm test`)

All steps must pass on both platforms before the PR can be merged.

### CD Workflow (Automated Publishing)

**Trigger**: Runs automatically when commits are pushed to the `main` branch (typically after merging a PR)

**Platform**: Ubuntu Linux only

**Steps**:
1. Checkout code with full git history
2. Setup pnpm and Node.js
3. Install dependencies
4. Build the project
5. Run semantic-release, which:
   - Analyzes commit messages since the last release
   - Determines the version bump type (major/minor/patch)
   - Updates `package.json` version
   - Generates changelog
   - Creates a git tag
   - Publishes to npm registry
   - Creates a GitHub release

## Commit Message Convention

This project uses [Conventional Commits](https://www.conventionalcommits.org/) to automatically determine version bumps and generate changelogs.

### Commit Format

```
<type>: <description>

[optional body]

[optional footer]
```

### Common Types and Their Effects

| Type | Version Bump | Example | Result |
|------|--------------|---------|--------|
| `feat:` | **Minor** (0.1.0 → 0.2.0) | `feat: add streaming compression` | New feature |
| `fix:` | **Patch** (0.1.0 → 0.1.1) | `fix: resolve memory leak` | Bug fix |
| `feat!:` or `BREAKING CHANGE:` | **Major** (0.1.0 → 1.0.0) | `feat!: change API signature` | Breaking change |
| `perf:` | **Patch** (0.1.0 → 0.1.1) | `perf: optimize buffer allocation` | Performance improvement |
| `refactor:` | **Patch** (0.1.0 → 0.1.1) | `refactor: simplify compression logic` | Code refactoring |
| `docs:` | No release | `docs: update README` | Documentation only |
| `test:` | No release | `test: add compression tests` | Test changes only |
| `chore:` | No release | `chore: update dependencies` | Maintenance tasks |
| `ci:` | No release | `ci: update GitHub Actions` | CI configuration |

### Examples

#### Feature Addition (Minor Version)
```bash
git commit -m "feat: add support for brotli compression"
```
Result: Version 0.1.0 → 0.2.0

#### Bug Fix (Patch Version)
```bash
git commit -m "fix: handle edge case in decompression"
```
Result: Version 0.1.0 → 0.1.1

#### Breaking Change (Major Version)
```bash
git commit -m "feat!: change compress() to return Promise<Buffer>

BREAKING CHANGE: compress() now returns a Promise instead of Buffer.
Update all usages to await the result."
```
Result: Version 0.1.0 → 1.0.0

#### Multiple Commits
If multiple commits are in a release, the highest version bump wins:
- 1 × `feat:` + 2 × `fix:` → **Minor** release
- 1 × `feat!:` + 5 × `feat:` → **Major** release

## GitHub Setup

### Required: NPM_TOKEN Secret

Before the CD workflow can publish to npm, you must configure an npm authentication token:

1. **Create an npm token**:
   - Log in to [npmjs.com](https://www.npmjs.com/)
   - Go to Account Settings → Access Tokens
   - Click "Generate New Token" → "Automation"
   - Copy the generated token

2. **Add token to GitHub**:
   - Go to your repository on GitHub
   - Navigate to Settings → Secrets and variables → Actions
   - Click "New repository secret"
   - Name: `NPM_TOKEN`
   - Value: Paste your npm token
   - Click "Add secret"

### GITHUB_TOKEN

The `GITHUB_TOKEN` is automatically provided by GitHub Actions and requires no setup. It's used to create releases and tags.

## Complete Development Workflow

### 1. Develop a Feature or Fix

```bash
# Create a feature branch
git checkout -b feat/new-compression-algorithm

# Make your changes
# ... code, test, commit ...

# Use conventional commits
git add .
git commit -m "feat: implement new compression algorithm"
```

### 2. Create a Pull Request

```bash
# Push your branch
git push origin feat/new-compression-algorithm

# Create PR on GitHub
# The CI workflow will automatically start
```

### 3. CI Testing

- Tests run automatically on Windows and Linux
- Review the results in the PR's "Checks" tab
- Fix any failing tests and push new commits
- CI will re-run on each push

### 4. Merge the PR

- Ensure all CI checks are green
- Get code review approval (if required)
- Merge the PR to `main` using:
  - "Squash and merge" (recommended) - combine all commits into one
  - "Merge commit" - preserve all commits
  - Avoid "Rebase and merge" if commits don't follow conventions

### 5. Automatic Publishing

- CD workflow triggers immediately after merge
- semantic-release analyzes commits
- If there are releasable changes:
  - Version is bumped in `package.json`
  - Package is published to npm
  - Git tag is created (e.g., `v0.2.0`)
  - GitHub release is created with changelog
- Check the Actions tab to monitor progress

## Troubleshooting

### CI Fails on Windows but Passes on Linux

**Issue**: Path separators or line endings differ between platforms.

**Solution**:
- Use `path.join()` instead of string concatenation
- Ensure `.gitattributes` is configured for line endings
- Test locally on Windows if possible

### CD Workflow Doesn't Publish

**Possible causes**:

1. **No releasable commits**
   - Check if commits follow conventional commit format
   - Only `feat:`, `fix:`, `perf:`, and `refactor:` trigger releases
   - Commits like `docs:` or `chore:` don't trigger releases

2. **NPM_TOKEN not configured**
   - Verify the secret exists in GitHub Settings → Secrets and variables → Actions
   - Ensure the token has publish permissions
   - Check the Actions log for authentication errors

3. **Version already exists**
   - semantic-release won't publish if the version is already on npm
   - This can happen if you manually published

### How to Test Locally

You cannot run the full CD workflow locally (it requires GitHub and npm credentials), but you can:

```bash
# Test if your commit messages are valid
npx commitlint --from HEAD~1 --to HEAD

# Dry-run semantic-release (no publish)
npx semantic-release --dry-run
```

### Manually Triggering a Release

If needed, you can manually trigger a release by pushing a commit that follows releasable conventions:

1. Ensure your local `main` is up to date:
   ```bash
   git checkout main
   git pull origin main
   ```

2. Create an empty commit with a releasable type:
   ```bash
   # Use fix: for a patch release
   git commit --allow-empty -m "fix: trigger manual release"
   
   # OR use feat: for a minor release
   git commit --allow-empty -m "feat: trigger manual release"
   
   git push origin main
   ```

**Note**: Only commit types that trigger releases (`feat:`, `fix:`, `perf:`, `refactor:`) will work. Using `chore:`, `docs:`, `test:`, or `ci:` will **not** trigger a release because they are configured with `"release": false` in `.releaserc.json`.

## Best Practices

1. **Write clear commit messages**: Use conventional commits consistently
2. **One feature per PR**: Easier to review and generates cleaner changelogs
3. **Squash PRs when merging**: Creates cleaner release notes
4. **Review CI logs**: Fix issues before merging
5. **Monitor CD workflow**: Ensure releases succeed after merging
6. **Use semantic versioning**: Breaking changes should use `feat!:` or `BREAKING CHANGE:`

## Additional Resources

- [Conventional Commits Specification](https://www.conventionalcommits.org/)
- [semantic-release Documentation](https://semantic-release.gitbook.io/)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [npm Token Documentation](https://docs.npmjs.com/creating-and-viewing-access-tokens)


