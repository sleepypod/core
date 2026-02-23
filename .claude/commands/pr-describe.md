---
model: claude-haiku-4-5
---

Review the current branch's diff against the base branch and update the GitHub PR with a clear title and description.

## Instructions

1. Determine the current branch and its base branch (usually `develop`). Run:
   - `gh pr view --json number,title,body,baseRefName` to get the existing PR number and base branch
   - `git log --oneline develop..HEAD` to see all commits on this branch
   - `git diff develop...HEAD --stat` to see which files changed and by how much

   **Token-saving rule:** Do NOT read the full diff (`git diff` without `--stat`). Commit messages + stat summary are sufficient. Only read the full diff for a specific file if the commit messages are unclear about what changed there.

2. Analyze the commit messages and file stats. Focus on **intent and impact**, not just file names.

3. Generate a PR title using conventional commits style:
   - `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`
   - Keep it under 70 characters
   - Be specific about the scope, e.g. `feat(auth): support magic link login`

4. Generate a PR body using this exact structure:

```
## Summary

- Bullet point summary of major changes
- Focus on *what* changed and *why*
- Use emojis sparingly to improve scannability

## Scope Breakdown

| Area | Summary |
|------|---------|
| relevant/path/ | Brief description of changes in that area |

## Test plan

- [ ] Checklist of what should be tested
```

5. Update the PR using `gh pr edit <number> --title "..." --body "..."`. Use a HEREDOC for the body to preserve formatting.

6. Return the PR URL when done.

**Rules:**
- Never fabricate changes — only describe what's in the diff
- If there's no open PR for the current branch, inform the user instead of creating one
- Keep the summary concise (3-8 bullet points)
- Only include the Scope Breakdown table if changes span 2+ distinct areas
