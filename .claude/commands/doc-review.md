# Documentation Review Command

Reviews code documentation quality against project guidelines.

## Usage

```
Use the general-purpose Task agent to review documentation in [files/directories]
against .claude/docs/documentation-best-practices.md guidelines.
```

## What It Does

1. Reads documentation-best-practices.md to understand standards
2. Reviews code comments and docstrings in specified files
3. Identifies:
   - Missing documentation (WHY not WHAT)
   - Bad documentation (restates code)
   - Unclear behavior, constraints, or edge cases
   - Hardware timing requirements not documented
   - Error handling behavior not clear

4. Provides specific, actionable suggestions with line numbers

## Review Criteria

Based on `.claude/docs/documentation-best-practices.md`:

**Always Document:**
- Public APIs (functions, classes, exports)
- Complex logic and algorithms
- Workarounds and edge cases
- Hardware timing requirements
- Magic numbers with rationale
- Error handling behavior

**Never Document:**
- Self-explanatory code
- Information already in TypeScript types
- Implementation details that match function name

## Example Output Format

```
## [file-path]

### Missing Documentation
- Line X: Why does this fetch from hardware vs database?
- Line Y: Hardware timing - how long does this take?

### Bad Documentation
- Line Z: Comment "Set temperature" just restates function name
  Suggest: Explain heating rate, constraints, duration behavior
```

## When to Run

- After implementing new features
- Before creating PRs
- When code review feedback mentions unclear behavior
- After adding hardware integrations
- Periodically on core modules

## Related

- `.claude/docs/documentation-best-practices.md` - Documentation standards
- `.claude/docs/trpc-api-architecture.md` - Example of good documentation
