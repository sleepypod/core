#!/usr/bin/env python3
"""Extract surviving mutants for one file from a Stryker mutation.json.

Usage: survivors.py <mutation.json> <source-file-substring>
Prints one line per surviving mutant: location, mutator, replacement.
"""
import json
import sys

if len(sys.argv) != 3:
    sys.exit(__doc__)

report = json.load(open(sys.argv[1]))
needle = sys.argv[2]
matches = [k for k in report['files'] if needle in k]
if not matches:
    sys.exit(f'no file matching {needle!r}; files: {len(report["files"])}')
for key in matches:
    mutants = [m for m in report['files'][key]['mutants'] if m['status'] == 'Survived']
    print(f'{key}: {len(mutants)} surviving')
    for m in sorted(mutants, key=lambda m: (m['location']['start']['line'],
                                            m['location']['start']['column'])):
        loc = m['location']
        repl = m['replacement'][:100].replace('\n', ' ')
        print(f"  L{loc['start']['line']}:{loc['start']['column']}"
              f"-{loc['end']['line']}:{loc['end']['column']}"
              f" {m['mutatorName']}: {repl}")
