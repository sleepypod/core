#!/usr/bin/env python3
"""Prepare a verified, inert Linux ARM64 runtime bundle without touching a Pod."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import urllib.request

NODE_VERSION = '24.22.1'
NODE_ARCHIVE = f'node-v{NODE_VERSION}-linux-arm64.tar.gz'
NODE_SHA256 = '33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3'
SQLITE_VERSION = '12.11.1'
SQLITE_ARCHIVE = f'better-sqlite3-v{SQLITE_VERSION}-node-v137-linux-arm64.tar.gz'
SQLITE_SHA256 = '60da4cbe1b1714c8db62f2ee71a9928cde5303dab57bde14c02debd12a784439'
PNPM_VERSION = '10.34.6'


def checksum(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def download(url, destination, expected):
    """Retain a downloaded artifact only after checking the reviewed digest."""
    if destination.exists():
        if checksum(destination) != expected:
            raise ValueError(f'Cached checksum mismatch: {destination.name}')
        return
    temporary = destination.with_suffix(destination.suffix + '.partial')
    try:
        with urllib.request.urlopen(url, timeout=60) as response, temporary.open('xb') as output:
            shutil.copyfileobj(response, output)
        if checksum(temporary) != expected:
            raise ValueError(f'Download checksum mismatch: {destination.name}')
        temporary.rename(destination)
    finally:
        temporary.unlink(missing_ok=True)


def extract_verified(archive, destination, prefix):
    """Extract regular files/directories, then contained relative symlinks; never follow archive links."""
    with tarfile.open(archive) as source:
        members = source.getmembers()
        names = set()
        links = set()
        for member in members:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != prefix:
                raise ValueError('Unsafe archive path')
            if member.name in names:
                raise ValueError('Duplicate archive path')
            names.add(member.name)
            if not (member.isfile() or member.isdir() or member.issym()):
                raise ValueError('Unsupported archive member')
            if member.issym():
                links.add(path)
                target = (destination / member.name).parent / member.linkname
                if Path(member.linkname).is_absolute() or not target.resolve().is_relative_to(destination.resolve()):
                    raise ValueError('Escaping archive link')
        for member in members:
            path = PurePosixPath(member.name)
            if any(parent in links for parent in path.parents):
                raise ValueError('Archive member descends through a link')
        for member in members:
            target = destination / member.name
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as content, target.open('xb') as output:
                    shutil.copyfileobj(content, output)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
        for member in members:
            if member.issym():
                target = destination / member.name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.symlink_to(member.linkname)


def excluded(name):
    """Next tracing may include development databases; none belong in a release."""
    return (name in {'node_modules', '.git', '.codex', '.venv', '__pycache__', 'test-results', '.DS_Store'}
            or name.startswith('.env') or '.db' in name or name.endswith(('.sqlite', '.sqlite3', '.pem', '.key')))


def copy_build(source, destination):
    for entry in source.iterdir():
        if excluded(entry.name):
            continue
        target = destination / entry.name
        if entry.is_symlink():
            raise ValueError(f'Unexpected build symlink: {entry.name}')
        if entry.is_dir():
            target.mkdir()
            copy_build(entry, target)
        elif entry.is_file():
            shutil.copy2(entry, target)
        else:
            raise ValueError(f'Unexpected build entry: {entry.name}')


def inventory(directory):
    """Verify all links stay in the bundle and every native binary targets Linux ARM64."""
    records = []
    for current, directories, files in os.walk(directory, followlinks=False):
        for name in sorted(directories + files):
            path = Path(current) / name
            relative = path.relative_to(directory).as_posix()
            if path.is_symlink():
                if not path.resolve(strict=True).is_relative_to(directory.resolve()):
                    raise ValueError(f'Escaping bundle link: {relative}')
                records.append({'path': relative, 'link': os.readlink(path)})
            elif path.is_file():
                if re.search(r'\.(?:node|dylib|so(?:\.\d+)*)$', path.name):
                    with path.open('rb') as binary:
                        header = binary.read(20)
                    if len(header) < 20 or header[:5] != b'\x7fELF\x02' or header[5] != 1 or int.from_bytes(header[18:20], 'little') != 183:
                        raise ValueError(f'Non-ARM64 native binary: {relative}')
                records.append({'path': relative, 'sha256': checksum(path), 'mode': oct(path.stat().st_mode & 0o777)})
    return sorted(records, key=lambda record: record['path'])


def prepare(repo, output):
    """Use a clean committed build; install target dependencies without running install scripts."""
    if output.exists() or output.is_symlink():
        raise ValueError('Output must be a new directory')
    if output.is_relative_to(repo):
        raise ValueError('Output must be outside the source checkout')
    if subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=all'], cwd=repo).strip():
        raise ValueError('Commit the reviewed source before packaging')
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
    standalone = repo / '.next/standalone'
    build = json.loads((standalone / '.git-info').read_text())
    if not re.fullmatch(r'[a-f0-9]{7,40}', build.get('commitHash', '')) or not commit.startswith(build['commitHash']):
        raise ValueError('Rebuild after committing; build identity does not match HEAD')
    config = json.loads((repo / '.next/required-server-files.json').read_text())['config']
    if config.get('env', {}).get('NEXT_PUBLIC_DEMO'):
        raise ValueError('A demo build cannot become a Pod runtime')
    if subprocess.check_output(['pnpm', '--version'], text=True).strip() != PNPM_VERSION:
        raise ValueError(f'Use pnpm {PNPM_VERSION} for the release bundle')
    for required in ['server.js', '.next/BUILD_ID', 'public/vendor/three.module.min.js',
                     'src/db/migrations/meta/_journal.json', 'src/db/biometrics-migrations/meta/_journal.json',
                     'biometrics-worker/worker.cjs']:
        if not (standalone / required).is_file():
            raise ValueError(f'Build is missing {required}')
    output.mkdir(mode=0o700)
    try:
        application = output / 'app'
        application.mkdir()
        copy_build(standalone, application)
        probe = application / 'scripts/deployment'
        probe.mkdir(parents=True, exist_ok=True)
        shutil.copy2(repo / 'scripts/deployment/probe_runtime.mjs', probe / 'probe_runtime.mjs')
        shutil.copy2(repo / 'scripts/deployment/maintenance_broker.py', probe / 'maintenance_broker.py')
        shutil.copy2(repo / 'pnpm-lock.yaml', application / 'pnpm-lock.yaml')
        package = json.loads((repo / 'package.json').read_text())
        package.pop('scripts', None)
        for relative in package.get('pnpm', {}).get('patchedDependencies', {}).values():
            patch = PurePosixPath(relative)
            if patch.is_absolute() or '..' in patch.parts or excluded(patch.name):
                raise ValueError('Unsafe dependency patch path')
            target = application / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(repo / relative, target)
        (application / 'package.json').write_text(json.dumps(package, indent=2) + '\n')
        (application / 'pnpm-workspace.yaml').write_text('supportedArchitectures:\n  os: [linux]\n  cpu: [arm64]\n  libc: [glibc]\nonlyBuiltDependencies: []\n')
        subprocess.run(['pnpm', 'install', '--prod', '--frozen-lockfile', '--ignore-scripts'], cwd=application, check=True)
        sqlite = (application / 'node_modules/better-sqlite3').resolve(strict=True)
        if json.loads((sqlite / 'package.json').read_text())['version'] != SQLITE_VERSION:
            raise ValueError('Review and pin the new SQLite prebuild before packaging')
        artifacts = output / 'artifacts'
        artifacts.mkdir()
        download(f'https://nodejs.org/dist/v{NODE_VERSION}/{NODE_ARCHIVE}', artifacts / NODE_ARCHIVE, NODE_SHA256)
        download(f'https://github.com/WiseLibs/better-sqlite3/releases/download/v{SQLITE_VERSION}/{SQLITE_ARCHIVE}', artifacts / SQLITE_ARCHIVE, SQLITE_SHA256)
        runtime = output / 'runtime'
        runtime.mkdir()
        extract_verified(artifacts / NODE_ARCHIVE, runtime, f'node-v{NODE_VERSION}-linux-arm64')
        extract_verified(artifacts / SQLITE_ARCHIVE, sqlite, 'build')
        with (output / 'source.tar.gz').open('xb') as source:
            subprocess.run(['git', 'archive', '--format=tar.gz', commit], cwd=repo, stdout=source, check=True)
        shutil.copy2(repo / 'LICENSE', output / 'LICENSE')
        current = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
        if current != commit or subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=all'], cwd=repo).strip():
            raise ValueError('Source changed during packaging; rebuild the committed revision')
        manifest = {'format': 'sleepypod-offline-runtime/1', 'sourceCommit': commit,
                    'maintenanceProtocol': 1,
                    'node': {'version': NODE_VERSION, 'sha256': NODE_SHA256},
                    'sqlite': {'version': SQLITE_VERSION, 'sha256': SQLITE_SHA256},
                    'pnpm': PNPM_VERSION, 'controllerStarted': False,
                    'application': inventory(application), 'runtime': inventory(runtime),
                    'sourceSha256': checksum(output / 'source.tar.gz')}
        (output / 'bundle-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        archive = output / 'sleepypod-runtime.tar.gz'
        with tarfile.open(archive, 'w:gz', dereference=False) as bundle:
            for name in ['app', 'runtime', 'source.tar.gz', 'LICENSE', 'bundle-manifest.json']:
                bundle.add(output / name, arcname=name)
        (output / 'sleepypod-runtime.sha256').write_text(f'{checksum(archive)}  {archive.name}\n')
        print(json.dumps({'archive': str(archive), 'sourceCommit': commit, 'controllerStarted': False}))
    except BaseException:
        # Only this newly created directory is removed; existing output was refused above.
        shutil.rmtree(output)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    prepare(Path(__file__).resolve().parents[2], args.output.absolute())


if __name__ == '__main__':
    main()
