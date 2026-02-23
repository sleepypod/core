# Pull Request Review Process

This document outlines our standard process for handling automated and human code review feedback on pull requests.

## Core Principles

1. **Always review PR feedback** - Never ignore review comments, whether from automated tools (CodeRabbit, ESLint, etc.) or human reviewers
2. **Fix if reasonable** - Address critical and high-priority issues immediately in the PR
3. **File issues for deferred work** - Create GitHub issues for lower-priority improvements that can be addressed later
4. **Respond inline** - Comment on each review comment to acknowledge and document the resolution
5. **Resolve when complete** - Mark conversations as resolved after addressing them

## Process Flow

### 1. Receive Review Feedback

When a PR receives review comments (from CodeRabbit, human reviewers, or CI checks):

1. Read through all comments systematically
2. Categorize by severity:
   - **Critical** (🔴): Blocking issues that must be fixed (data corruption, security, major bugs)
   - **Major** (🟠): Important issues that should be fixed (performance, functionality, ESLint errors)
   - **Minor** (🟡): Nice-to-have improvements (optimization suggestions, code style)
   - **Nitpick** (🔵): Optional suggestions (refactoring, alternative approaches)

### 2. Triage and Prioritize

**Fix Immediately in PR:**
- Critical issues (data integrity, security vulnerabilities)
- Major functional issues
- ESLint/TypeScript errors that block CI
- Issues causing test failures

**File GitHub Issue for Later:**
- Minor improvements that don't affect functionality
- Optimization suggestions
- Refactoring suggestions
- Documentation updates
- Additional features suggested during review

### 3. Address Each Comment

For each review comment:

#### If Fixing in PR:

1. Make the code changes
2. Test the changes
3. Commit with descriptive message
4. Reply to the review comment:
   ```
   ✅ **Fixed** - [Brief description of what was done]
   ```
5. Mark the conversation as resolved (if you have permissions)

**Example:**
```
✅ **Fixed** - Wrapped all seed inserts in db.transaction() for atomicity.
```

#### If Deferring to Issue:

1. Create a GitHub issue with:
   - Clear title describing the improvement
   - Background explaining the context
   - Problem statement
   - Proposed solution
   - Reference to the PR/review comment
2. Reply to the review comment:
   ```
   📋 **Deferred** - Created issue #123 to track this improvement.
   ```
3. Mark the conversation as resolved

**Example:**
```
📋 **Deferred** - Created issue #96 to track adding updatedAt auto-update triggers. This is a valuable improvement but non-blocking for this PR.
```

### 4. Document Summary

After addressing all comments, add a summary comment to the PR:

```markdown
## ✅ Addressed Review Comments

### Fixed in this PR
- Issue 1: Description
- Issue 2: Description
- ...

### Deferred to Issues
- #96: Title and brief context
- #97: Title and brief context
- ...
```

### 5. Push and Verify

1. Push all fixes to the PR branch
2. Verify CI passes
3. Re-request review if needed

## Example Workflow

See [PR #95](https://github.com/sleepypod/core/pull/95) for a complete example of this process:

1. CodeRabbit left 11 actionable comments
2. Critical issues fixed in commit `b80218a`:
   - Database indexes not being created
   - ESLint violations blocking CI
   - Data integrity issues
3. Issues created for minor improvements:
   - #96: updatedAt auto-update triggers
   - #97: DB-level CHECK constraints for enums
   - #98: tapGestures conditional constraints
   - #99: ADR documentation update
4. Each review comment received an inline response
5. PR summary documented all changes

## Tools and Commands

### Viewing PR Comments
```bash
# View all PR comments
gh pr view <PR_NUMBER> --json comments

# View review comments (inline code comments)
gh api repos/<owner>/<repo>/pulls/comments/<comment_id>
```

### Responding to Comments
```bash
# Reply to a specific review comment
gh api repos/<owner>/<repo>/pulls/comments/<comment_id> \
  --method PATCH \
  --field body="✅ **Fixed** - Your response here"
```

### Creating Follow-up Issues
```bash
# Create an issue with context
gh issue create \
  --title "Title here" \
  --body "Description with reference to PR #<number>"
```

### Commenting on PR
```bash
# Add a summary comment
gh pr comment <PR_NUMBER> --body "Summary here"
```

## Response Templates

### Fixed in PR
```
✅ **Fixed** - [Brief description of the fix]
```

### Deferred to Issue
```
📋 **Deferred** - Created issue #<number> to track this improvement. [Optional: Why deferred]
```

### Already Addressed
```
✅ **Already Addressed** - This was fixed in commit <sha>. [Optional: Details]
```

### Won't Fix
```
❌ **Won't Fix** - [Clear explanation of why this isn't the right approach]
```

### Question/Clarification
```
❓ **Question** - [Ask for clarification on the suggestion]
```

## Best Practices

1. **Respond promptly** - Address review comments within 24 hours
2. **Be specific** - Reference commit SHAs or line numbers when applicable
3. **Stay organized** - Use the emoji prefixes for quick scanning
4. **Link context** - Always link to related issues or commits
5. **Test thoroughly** - Verify all fixes work before pushing
6. **Keep scope focused** - Don't expand PR scope with unrelated fixes
7. **Acknowledge good suggestions** - Thank reviewers for valuable feedback
8. **Document decisions** - Explain why something was deferred or won't be fixed

## Review Checklist

Before marking PR as ready for merge:

- [ ] All critical and major comments addressed
- [ ] Issues created for deferred improvements
- [ ] All review comments have responses
- [ ] Resolved conversations marked as resolved
- [ ] Summary comment added to PR
- [ ] CI passing
- [ ] Changes tested locally
- [ ] Commit messages are descriptive

## Related Documentation

- [Contributing Guidelines](../../CONTRIBUTING.md)
- [Code Review Guidelines](.claude/docs/CODE_REVIEW.md)
- [Git Workflow](.claude/docs/GIT_WORKFLOW.md)
