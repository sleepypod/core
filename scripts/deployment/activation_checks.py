"""Read-only gates for the first permanent activation of an imported controller."""
from contextlib import closing
import hashlib
import json
import math
import re
import sqlite3
import stat


SOURCE_FILES = {
    'lowdb/settingsDB.json': True,
    'lowdb/schedulesDB.json': True,
    'left_cap_baseline.json': False,
    'right_cap_baseline.json': False,
    'analytics/comfort.json': False,
    'analytics/journal.json': False,
}

HISTORY_DATABASE = 'free-sleep-history.db'


def database_checksum(path):
    """Hash snapshots in bounded memory on the Pod rather than loading a full history file."""
    checksum = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            checksum.update(chunk)
    return checksum.hexdigest()


def require_imported_history(data, report):
    """Reject partial or mismatched promotions before any retained service is stopped."""
    metadata = report.get('importedHistory')
    hashes = report.get('databaseHashes')
    if (not isinstance(metadata, dict) or metadata.get('format') != 'sleepypod-imported-history/1'
            or metadata.get('source') != 'free-sleep' or not isinstance(hashes, dict)):
        raise ValueError('Imported history evidence is missing; reimport before activation')
    expected = hashes.get(HISTORY_DATABASE)
    source_hash = metadata.get('sourceSha256')
    if any(not isinstance(value, str) or not re.fullmatch('[a-f0-9]{64}', value)
           for value in (expected, source_hash)):
        raise ValueError('Imported history checksums are missing or invalid')
    history = data / HISTORY_DATABASE
    original = data / 'legacy/free-sleep.db'
    if (data.is_symlink() or (data / 'legacy').is_symlink()
            or any(path.is_symlink() or not path.is_file() for path in (history, original))):
        raise ValueError('Expected regular imported history and preserved original database files')
    for suffix in ('-wal', '-shm', '-journal'):
        sidecar = history.with_name(history.name + suffix)
        if sidecar.exists() or sidecar.is_symlink():
            raise ValueError('Imported history must be a complete standalone snapshot without SQLite sidecars')
    if database_checksum(history) != expected or database_checksum(original) != source_hash:
        raise ValueError('Imported history differs from its report or preserved original database')
    try:
        with closing(sqlite3.connect(history.resolve().as_uri() + '?mode=ro&immutable=1', uri=True)) as database:
            if (database.execute('PRAGMA integrity_check').fetchall() != [('ok',)]
                    or database.execute('PRAGMA foreign_key_check').fetchall()
                    or database.execute('PRAGMA journal_mode').fetchone() != ('delete',)):
                raise ValueError('Imported history integrity or standalone snapshot check failed')
            rows = database.execute('SELECT id, document FROM imported_history_metadata').fetchall()
            if len(rows) != 1 or rows[0][0] != 1 or json.loads(rows[0][1]) != metadata:
                raise ValueError('Imported history metadata differs from its report')
    except (sqlite3.Error, json.JSONDecodeError, TypeError) as error:
        raise ValueError('Imported history database or metadata cannot be read') from error


def source_digest(root, filename, required):
    path = root / filename
    for candidate in (root, *(root / parent for parent in path.relative_to(root).parents)):
        if candidate.is_symlink():
            raise ValueError('Retained source contains a symlink')
    if not path.exists() and not path.is_symlink() and not required:
        return None
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError('Retained source must be a regular file: ' + filename)
    return hashlib.sha256(path.read_bytes()).hexdigest()


def unchanged_source(data, legacy):
    """Compare configuration twice around stopping writers; never overwrite new user edits."""
    if not legacy.is_absolute() or not legacy.is_dir():
        raise ValueError('Use the absolute existing retained data directory')
    retained = data / 'legacy'
    if (data.resolve() == legacy.resolve() or legacy.resolve() in data.resolve().parents
            or data.resolve() in legacy.resolve().parents):
        raise ValueError('Core and retained data must be separate')
    hashes = {}
    for filename, required in SOURCE_FILES.items():
        expected = source_digest(retained, filename, required)
        actual = source_digest(legacy, filename, required)
        if expected != actual:
            raise ValueError('Retained configuration changed since import: ' + filename)
        hashes[filename] = expected
    return hashes


def require_trial(journal, revision, now):
    """An old API-only trial or a future/stale receipt cannot authorize activation."""
    ended = journal.get('trialEndedAt')
    started = journal.get('trialStartedAt')
    if any(type(value) not in (int, float) or not math.isfinite(value) for value in (started, ended)):
        raise ValueError('A dated successful idle trial is required')
    if not 0 <= now - ended <= 24 * 60 * 60 or not 0 <= ended - started <= 600:
        raise ValueError('Repeat the idle trial; its receipt is stale or has invalid dates')
    observation = journal.get('observation') or {}
    observed_revision = observation.get('controller', {}).get('revision')
    if not isinstance(observed_revision, str) or len(observed_revision) < 7 or not revision.startswith(observed_revision):
        raise ValueError('Trial did not observe this release')
    settle = journal.get('settleSeconds')
    if (journal.get('phase') != 'trial_restored' or journal.get('trialSucceeded') is not True
            or journal.get('requireIdle') is not True or journal.get('restoredIdleVerified') is not True
            or type(settle) not in (int, float) or not 30 <= settle <= 60
            or observation.get('device', {}).get('freshness') != 'fresh'
            or observation.get('temperatureRuntime') != 'ready'):
        raise ValueError('A restored idle trial with at least 30 settled seconds is required')


def candidate_ready(data):
    """Keep first activation passive apart from the explicitly imported daily routines."""
    report = json.loads((data / 'migration-report.json').read_text())
    if not isinstance(report, dict) or report.get('format') != 'sleepypod-free-sleep-import/1':
        raise ValueError('Expected a separately imported candidate')
    require_imported_history(data, report)
    for filename in ('sleepypod.db', 'biometrics.db'):
        path = data / filename
        if path.is_symlink() or not path.is_file():
            raise ValueError('Expected a regular candidate database')
        with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)) as database:
            if database.execute('PRAGMA integrity_check').fetchall() != [('ok',)] or database.execute('PRAGMA foreign_key_check').fetchall():
                raise ValueError('Candidate database integrity check failed')
            if filename != 'sleepypod.db':
                continue
            flags = database.execute('''SELECT autopilot_enabled, prime_pod_daily, reboot_daily,
                homekit_enabled, mqtt_enabled, pump_stall_protection_enabled,
                pump_stall_auto_recovery_enabled FROM device_settings''').fetchall()
            if flags != [(0, 0, 0, 0, 0, 0, 0)]:
                raise ValueError('Initial activation requires automation, integrations and automatic maintenance off')
            sides = database.execute('SELECT side, always_on, auto_on_enabled, auto_off_enabled FROM side_settings ORDER BY side').fetchall()
            if sides != [('left', 0, 0, 0), ('right', 0, 0, 0)]:
                raise ValueError('Initial activation requires presence-based and always-on behavior off')
            comfort = database.execute('SELECT side,state FROM comfort_states ORDER BY side').fetchall()
            if [row[0] for row in comfort] != ['left', 'right'] or any(json.loads(row[1]).get('config', {}).get('mode') not in ('off', 'preview') for row in comfort):
                raise ValueError('Personal comfort must start Off or Preview on both sides')
            for query in ("SELECT COUNT(*) FROM base_schedules WHERE enabled != 0",
                          "SELECT COUNT(*) FROM run_once_sessions WHERE status = 'active'",
                          "SELECT COUNT(*) FROM automations WHERE enabled != 0"):
                if database.execute(query).fetchone()[0] != 0:
                    raise ValueError('Active base schedules, temporary sessions or house rules require separate review')
