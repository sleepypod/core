#!/usr/bin/env python3
"""Stage immutable sensor source from a verified release, reusing unchanged locked environments."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import tarfile

import maintenance_install
import service_plan


def release_files(release):
    """Only regular, bounded source files from the release's hashed archive are eligible."""
    maintenance_install.verify_release(release)
    manifest = json.loads(maintenance_install.owned_bytes(release/'bundle-manifest.json', limit=32*1024*1024))
    archive = maintenance_install.owned_bytes(release/'source.tar.gz', limit=128*1024*1024)
    if hashlib.sha256(archive).hexdigest() != manifest.get('sourceSha256'):
        raise ValueError('Sensor source archive checksum mismatch')
    files = {}
    total = 0
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as source:
        for member in source:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts:
                raise ValueError('Unsafe sensor archive path')
            if not path.parts or path.parts[0] != 'modules':
                continue
            if member.isdir():
                continue
            relative = Path(*path.parts[1:])
            total += member.size
            if (not member.isfile() or '.venv' in relative.parts or not relative.parts
                    or relative in files or member.size > 16*1024*1024 or total > 128*1024*1024):
                raise ValueError('Unsupported or excessive sensor archive entry')
            files[relative] = source.extractfile(member).read()
    if not files:
        raise ValueError('Release contains no sensor source')
    return files


def check_paths(previous, candidate):
    root = maintenance_install.ROOT/'sensors'
    for directory in (previous, candidate):
        if directory.name != 'modules' or directory.parent.parent != root:
            raise ValueError('Use separate versioned managed sensor directories')
    if previous == candidate:
        raise ValueError('Do not overwrite active sensor source')
    maintenance_install.secure_path(previous)
    maintenance_install.secure_path(candidate.parent)


def environments(previous, files):
    """Dependency upgrades need a new locked install; source-only updates may reuse venvs."""
    result = {}
    for name in service_plan.MODULES:
        for filename in ('pyproject.toml', 'uv.lock'):
            path = previous/name/filename
            maintenance_install.secure_path(path)
            if maintenance_install.owned_bytes(path, limit=8*1024*1024) != files.get(Path(name)/filename):
                raise ValueError('Sensor dependencies changed; prepare a new locked environment: '+name)
        environment = previous/name/'.venv'
        # A previous source-only release may itself reuse an older environment.
        resolved = environment.resolve(strict=True)
        if not resolved.is_relative_to(maintenance_install.ROOT/'sensors'):
            raise ValueError('Sensor environment escapes managed storage')
        maintenance_install.secure_path(resolved)
        if not (resolved/'bin/python').is_file():
            raise ValueError('Sensor interpreter is missing: '+name)
        result[name] = resolved
    return result


def verify(previous, candidate, release):
    """Check the complete new source tree and exact environment links before switching services."""
    check_paths(previous, candidate)
    maintenance_install.secure_path(candidate)
    files = release_files(release)
    runtimes = environments(previous, files)
    expected = set(files)
    for name, runtime in runtimes.items():
        relative = Path(name)/'.venv'
        expected.add(relative)
        link = candidate/relative
        if not link.is_symlink() or os.readlink(link) != str(runtime):
            raise ValueError('Sensor environment link changed: '+name)
    actual = set()
    for folder, directories, names in os.walk(candidate, followlinks=False):
        for name in directories + names:
            path = Path(folder)/name
            if path.is_symlink() or not path.is_dir():
                actual.add(path.relative_to(candidate))
    if actual != expected:
        raise ValueError('Sensor source membership changed')
    for relative, contents in files.items():
        path = candidate/relative
        maintenance_install.secure_path(path)
        if maintenance_install.owned_bytes(path, limit=16*1024*1024) != contents:
            raise ValueError('Sensor source differs from release: '+str(relative))
    return {'verifiedSourceFiles': len(files), 'reusedEnvironments': list(runtimes), 'servicesStarted': False}


def prepare(previous, candidate, release):
    check_paths(previous, candidate)
    if candidate.exists() or candidate.is_symlink():
        raise ValueError('Sensor destination must be new')
    files = release_files(release)
    runtimes = environments(previous, files)
    candidate.mkdir(mode=0o755)
    candidate.chmod(0o755)
    try:
        for relative, contents in files.items():
            target = candidate/relative
            target.parent.mkdir(parents=True, exist_ok=True)
            for parent in target.parents:
                if parent == candidate:
                    break
                parent.chmod(0o755)
            target.write_bytes(contents)
            target.chmod(0o644)
        for name, runtime in runtimes.items():
            (candidate/name/'.venv').symlink_to(runtime)
        return verify(previous, candidate, release)
    except BaseException:
        shutil.rmtree(candidate)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--previous', required=True, type=Path)
    parser.add_argument('--candidate', required=True, type=Path)
    parser.add_argument('--release', required=True, type=Path)
    arguments = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError('Run as root on the Pod')
    print(json.dumps(prepare(arguments.previous, arguments.candidate, arguments.release)))


if __name__ == '__main__':
    main()
