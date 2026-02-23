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
