"""Build a separate query snapshot; never change the byte-preserved legacy database."""
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3

FORMAT = 'sleepypod-imported-history/1'
FILENAME = 'free-sleep-history.db'
MAX_SECONDS = 253402300799
MAX_ID = 9007199254740991
TABLES = {
    'vitals': ('id', 'side', 'timestamp', 'heart_rate', 'hrv', 'breathing_rate'),
    'movement': ('id', 'side', 'timestamp', 'total_movement'),
    'sleep_records': ('id', 'side', 'entered_bed_at', 'left_bed_at', 'sleep_period_seconds',
                      'times_exited_bed', 'present_intervals', 'not_present_intervals'),
}
KINDS = {'vitals': 'vitals', 'movement': 'movement', 'presence': 'sleep_records'}
SCHEMA = '''
CREATE TABLE vitals (id INTEGER PRIMARY KEY, side TEXT, timestamp INTEGER,
  heart_rate REAL, hrv REAL, breathing_rate REAL);
CREATE TABLE movement (id INTEGER PRIMARY KEY, side TEXT, timestamp INTEGER, total_movement INTEGER);
CREATE TABLE sleep_records (id INTEGER PRIMARY KEY, side TEXT, entered_bed_at INTEGER, left_bed_at INTEGER,
  sleep_period_seconds INTEGER, times_exited_bed INTEGER, present_intervals TEXT, not_present_intervals TEXT);
CREATE INDEX vitals_history_order ON vitals(side, timestamp DESC, id DESC);
CREATE INDEX movement_history_order ON movement(side, timestamp DESC, id DESC);
CREATE INDEX presence_history_order ON sleep_records(side, entered_bed_at DESC, id DESC);
CREATE TABLE imported_history_metadata (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL);
'''


def checksum(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as source:
        for chunk in iter(lambda: source.read(1024*1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def readable_rows(kind):
    """Match the reader's timestamp/identity rules; retain excluded rows in both archives."""
    timestamp = 'entered_bed_at' if kind == 'presence' else 'timestamp'
    clause = (f"typeof(id)='integer' AND id BETWEEN 1 AND {MAX_ID} "
              f"AND typeof({timestamp})='integer' AND {timestamp} BETWEEN 0 AND {MAX_SECONDS}")
    if kind == 'presence':
        clause += (f" AND typeof(left_bed_at)='integer' AND left_bed_at>entered_bed_at"
                   f" AND left_bed_at<={MAX_SECONDS}")
    return clause


def prepare(source, destination, timezone, imported_at):
    """Copy supported columns in bounded batches into a DELETE-journal read model."""
    if destination.exists() or destination.is_symlink():
        raise ValueError('Imported history destination already exists')
    source_hash = checksum(source)
    snapshot_id = hashlib.sha256(f'{FORMAT}\n{source_hash}\n{timezone}'.encode()).hexdigest()
    document = {'format': FORMAT, 'source': 'free-sleep', 'snapshotId': snapshot_id,
                'sourceSha256': source_hash, 'timeZone': timezone, 'importedAt': imported_at,
                'sides': {}, 'unassignedRecords': 0}
    with closing(sqlite3.connect(source.resolve().as_uri()+'?mode=ro&immutable=1', uri=True)) as original:
        with closing(sqlite3.connect(destination)) as history:
            history.execute('PRAGMA journal_mode=DELETE')
            history.executescript(SCHEMA)
            for table, columns in TABLES.items():
                rows = original.execute(f'SELECT {",".join(columns)} FROM {table}')
                insert = f'INSERT INTO {table} VALUES ({",".join("?" for _ in columns)})'
                while batch := rows.fetchmany(500):
                    history.executemany(insert, batch)
                document['unassignedRecords'] += history.execute(
                    f"SELECT COUNT(*) FROM {table} WHERE side IS NULL OR side NOT IN ('left','right')").fetchone()[0]
            for side in ('left', 'right'):
                document['sides'][side] = {}
                for kind, table in KINDS.items():
                    timestamp = 'entered_bed_at' if kind == 'presence' else 'timestamp'
                    end = 'left_bed_at' if kind == 'presence' else 'timestamp'
                    total = history.execute(f'SELECT COUNT(*) FROM {table} WHERE side=?', (side,)).fetchone()[0]
                    count, first, last = history.execute(
                        f'SELECT COUNT(*),MIN({timestamp}),MAX({end}) FROM {table} WHERE side=? AND {readable_rows(kind)}',
                        (side,)).fetchone()
                    document['sides'][side][kind] = {'records': total, 'readableRecords': count,
                                                    'firstAt': first, 'lastAt': last}
            history.execute('INSERT INTO imported_history_metadata VALUES (1,?)',
                            (json.dumps(document, allow_nan=False, separators=(',', ':')),))
            history.commit()
            if history.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                raise ValueError('Imported history integrity failure')
    if checksum(source) != source_hash:
        raise ValueError('Legacy database changed while building history')
    return document
