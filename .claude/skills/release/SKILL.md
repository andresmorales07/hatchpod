---
name: release
description: Cut a release — bump the package version, rebuild dist, commit, tag, and push. Invoke this when the user wants to create a new version tag (e.g. "release a patch", "bump to minor", "cut a release", "tag a new version").
disable-model-invocation: true
---

Cut a new release by bumping the version, rebuilding dist, committing, tagging, and pushing.

**Why the order matters:** `server/dist/` is tracked in git — the tag must point to a commit that includes both the rebuilt dist and the version bump together, before the tag is created.

## Steps

1. Read the current version from `server/package.json`:
   ```bash
   node -p "require('./server/package.json').version"
   ```

2. Ask the user: patch, minor, or major bump?

3. Bump the version (atomically updates both `package.json` and `package-lock.json`, without creating a git tag):
   ```bash
   cd server && npm version <type> --no-git-tag-version
   ```
   Read back the new version and show it to the user.

4. Rebuild and test — stop if the build or tests fail, do not proceed:
   ```bash
   cd server && npm run build   # compiles TypeScript → dist/
   cd server && npm test        # runs vitest unit tests
   git add server/dist/         # stage the rebuilt dist
   ```

5. Stage the version files:
   ```bash
   git add server/package.json server/package-lock.json
   ```

6. Commit (replace `<new-version>` with the actual version string):
   ```bash
   git commit -m "$(cat <<'EOF'
   chore: bump version to <new-version>

   Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
   EOF
   )"
   ```

7. Tag the commit:
   ```bash
   git tag v<new-version>
   ```

8. Push the commit and the tag:
   ```bash
   git push && git push --tags
   ```

9. Confirm: "Released v`<new-version>`."
