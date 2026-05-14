# pr review process

## triage review comments

**fix immediately:**
- Critical/blocking issues (data integrity, security, CI errors)
- Major functional issues
- Test failures

**file github issue:**
- Minor improvements
- Optimizations
- Refactoring suggestions
- Documentation updates

## response format

**fixed in pr:**
```
✅ Fixed - [description]
```

**deferred to issue:**
```
📋 Deferred - Created issue #123 to track this improvement.
```

## verification before merge

- All critical comments addressed
- Issues created for deferred work
- CI passing
- Changes tested

## merge strategy

- **Feature/fix PRs into `dev`** — squash. One PR = one commit on dev.
- **Release PRs (`dev` → `main`)** — merge commit (`gh pr merge --merge`). NEVER squash. Squashing collapses every `feat:` / `fix:` / `chore:` commit on dev into one generic commit, which destroys the semver/changelog signal that downstream release tooling reads from the git log between main tags.
