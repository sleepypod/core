#!/usr/bin/env python3
"""Stage a verified Free Sleep backup offline; refuse to replace existing paths."""

import argparse
from contextlib import closing
from datetime import date, datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import tarfile
import tempfile
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

if __package__:
    from . import imported_history
else:
    import imported_history

ROOT = Path(__file__).resolve().parents[2]
DAYS = ('sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday')
SIDES = ('left', 'right')
MAX_ARCHIVE_BYTES = 8 * 1024**3
CLOCK = re.compile(r'^([01]\d|2[0-3]):[0-5]\d$')


def checksum(filename):
    digest = hashlib.sha256()
    with Path(filename).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(filename):
    def invalid_constant(_value):
        raise ValueError('Non-finite JSON value')
    def unique_object(pairs):
        result = {}
        for name, value in pairs:
            require(name not in result, 'Duplicate JSON field')
            result[name] = value
        return result
    return json.loads(Path(filename).read_text(), parse_constant=invalid_constant, object_pairs_hook=unique_object)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_timezone(zone):
    """Check the source timezone before creating databases or stopping writers."""
    require(isinstance(zone, str) and bool(zone), 'Missing device timezone')
    try:
        ZoneInfo(zone)
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise ValueError('Device timezone is unavailable or invalid; run the importer '
                         'in its locked scripts/migration environment and verify the source timezone') from error
    return zone


def number(value, minimum, maximum, label, integer=False):
    require(type(value) in (int, float) and math.isfinite(value)
            and minimum <= value <= maximum and (not integer or int(value) == value),
            'Invalid ' + label)
    return int(value) if integer else value


def boolean(value, label):
    require(type(value) is bool, 'Invalid ' + label)
    return value


def clock(value):
    require(isinstance(value, str) and CLOCK.fullmatch(value), 'Invalid schedule clock')
    return value


def calendar_date(value, allow_empty=False):
    if allow_empty and value == '':
        return value
    require(isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', value), 'Invalid local date')
    require(date.fromisoformat(value).isoformat() == value, 'Invalid local date')
    return value


def json_text(value):
    return json.dumps(value, allow_nan=False, separators=(',', ':'))


def write_private(filename, value):
    Path(filename).write_text(json.dumps(value, indent=2, allow_nan=False) + '\n')
    os.chmod(filename, 0o600)


def verify_backup(backup, staging):
    """Verify exact archive membership/hashes and extract only regular data files."""
    require(not (backup / 'manifest.json').is_symlink(), 'Manifest must be a regular file')
    manifest_hash = checksum(backup / 'manifest.json')
    manifest = read_json(backup / 'manifest.json')
    require(manifest.get('format') == 'free-sleep-migration/1', 'Unsupported backup format')
    expected = manifest.get('files')
    require(isinstance(expected, dict), 'Missing backup file manifest')
    require(set(manifest.get('archives', {})) == {'data.tar.gz', 'private.tar.gz'}, 'Invalid archive manifest')
    require(all(isinstance(name, str) and isinstance(digest, str) and re.fullmatch(r'[0-9a-f]{64}', digest)
                for name, digest in expected.items()), 'Invalid member checksum manifest')
    observed = {}
    for category in ('data', 'private'):
        filename = category + '.tar.gz'
        archive_path = backup / filename
        require(not archive_path.is_symlink() and archive_path.is_file(), 'Missing regular backup archive')
        require(checksum(archive_path) == manifest.get('archives', {}).get(filename), 'Archive checksum mismatch')
        total_size = 0
        names = set()
        with tarfile.open(archive_path, 'r:gz') as archive:
            for member in archive:
                member_path = PurePosixPath(member.name)
                require(not member_path.is_absolute() and '..' not in member_path.parts
                        and member_path.parts and member_path.parts[0] == category
                        and '\\' not in member.name and str(member_path) == member.name
                        and member.name not in names,
                        'Unsafe or duplicate backup member')
                names.add(member.name)
                require(len(names) <= 100_000, 'Too many backup members')
                require(member.isdir() or member.isfile(), 'Backup links and special files are unsupported')
                if member.isdir():
                    continue
                total_size += member.size
                require(0 <= member.size <= MAX_ARCHIVE_BYTES and total_size <= MAX_ARCHIVE_BYTES,
                        'Backup exceeds staging size limit')
                require(member.name in expected, 'Unmanifested backup member')
                digest = hashlib.sha256()
                target = staging / 'legacy' / Path(*member_path.parts[1:]) if category == 'data' else None
                if target:
                    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with closing(archive.extractfile(member)) as stream:
                    output = target.open('xb') if target else None
                    try:
                        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                            digest.update(chunk)
                            if output:
                                output.write(chunk)
                    finally:
                        if output:
                            output.close()
                            os.chmod(target, 0o600)
                observed[member.name] = digest.hexdigest()
                require(observed[member.name] == expected[member.name], 'Backup member checksum mismatch')
    require(observed == expected, 'Backup manifest membership mismatch')
    # Keep the exact private archive for recovery; do not put credentials in Core settings.
    source = staging / 'source'
    source.mkdir(mode=0o700)
    for name in ('manifest.json', 'data.tar.gz', 'private.tar.gz'):
        shutil.copyfile(backup / name, source / name)
        os.chmod(source / name, 0o600)
        expected_hash = manifest_hash if name == 'manifest.json' else manifest['archives'][name]
        require(checksum(source / name) == expected_hash, 'Backup changed during staging')
    return manifest


def create_database(filename, migrations):
    """Use the checked-in Drizzle SQL and ledger so Core can resume normal migrations."""
    connection = sqlite3.connect(filename)
    try:
        connection.execute('CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)')
        previous = -1
        for entry in read_json(migrations / 'meta/_journal.json')['entries']:
            require(entry['when'] > previous, 'Migration journal is not ordered')
            previous = entry['when']
            sql = (migrations / (entry['tag'] + '.sql')).read_text()
            connection.executescript(sql)
            connection.execute('INSERT INTO __drizzle_migrations(hash,created_at) VALUES (?,?)',
                               (hashlib.sha256(sql.encode()).hexdigest(), entry['when']))
            connection.commit()
        os.chmod(filename, 0o600)
        return connection
    except BaseException:
        connection.close()
        raise


def map_settings(settings, database, report, now):
    require(isinstance(settings, dict), 'Invalid settings document')
    zone = validate_timezone(settings.get('timeZone'))
    unit = {'fahrenheit': 'F', 'celsius': 'C'}.get(settings.get('temperatureFormat'))
    require(unit is not None, 'Invalid temperature preference')
    prime = settings['primePodDaily']
    prime_time = clock(prime['time'])
    prime_enabled = boolean(prime['enabled'], 'prime enabled')
    reboot_requested = boolean(settings['rebootDaily'], 'reboot enabled')
    # Free Sleep never registers its reboot job when daily priming is disabled.
    reboot_enabled = reboot_requested and prime_enabled
    if reboot_requested and not prime_enabled:
        report['reviewRequired'].append('Daily reboot retained disabled because Free Sleep gated it on daily priming')
    # Free Sleep reboots one hour before its priming clock.
    reboot_time = f"{(int(prime_time[:2]) - 1) % 24:02d}{prime_time[2:]}"
    database.execute('''INSERT INTO device_settings(id,timezone,temperature_unit,prime_pod_daily,
        prime_pod_time,reboot_daily,reboot_time,autopilot_enabled,homekit_enabled,mqtt_enabled)
        VALUES (1,?,?,?,?,?,?,0,0,0)''', (zone, unit, prime_enabled, prime_time, reboot_enabled, reboot_time))
    for side in SIDES:
        preference = settings[side]
        require(isinstance(preference['name'], str) and 1 <= len(preference['name']) <= 20, 'Invalid side name')
        away = boolean(preference['awayMode'], 'away mode')
        database.execute('INSERT INTO side_settings(side,name,away_mode) VALUES (?,?,?)', (side, preference['name'], away))
        database.execute('INSERT INTO device_state(side,is_powered,is_alarm_vibrating) VALUES (?,0,0)', (side,))
        for gesture in ('doubleTap', 'tripleTap', 'quadTap'):
            tap = preference['taps'][gesture]
            require(tap['type'] in ('temperature', 'alarm'), 'Unsupported gesture action')
            if tap['type'] == 'temperature':
                require(tap['change'] in ('increment', 'decrement'), 'Invalid gesture change')
                amount = number(tap['amount'], 0, 10, 'gesture amount', integer=True)
                values = (side, gesture, 'temperature', tap['change'], amount, None, None, None)
            else:
                require(tap['behavior'] in ('snooze', 'dismiss') and tap['inactiveAlarmBehavior'] in ('power', 'none'), 'Invalid alarm gesture')
                duration = number(tap['snoozeDuration'], 60, 600, 'snooze duration', integer=True)
                values = (side, gesture, 'alarm', None, None, tap['behavior'], duration, tap['inactiveAlarmBehavior'])
            database.execute('''INSERT INTO tap_gestures(side,tap_type,action_type,temperature_change,
                temperature_amount,alarm_behavior,alarm_snooze_duration,alarm_inactive_behavior)
                VALUES (?,?,?,?,?,?,?,?)''', values)
        for name, override in preference.get('scheduleOverrides', {}).items():
            expires = override.get('expiresAt')
            if expires:
                expiry = datetime.fromisoformat(expires.replace('Z', '+00:00'))
                require(expiry.tzinfo is not None, 'Override expiry lacks timezone')
                if expiry.timestamp() * 1000 > now:
                    report['reviewRequired'].append(f'{side}: active {name} override retained in legacy settings; no Core override was invented')
    return zone


def event_day(day, at, start):
    return DAYS[(DAYS.index(day) + int(at < start)) % 7]


def map_schedules(schedules, database, report):
    """Translate routine-relative weekdays into the actual Core calendar events."""
    require(set(schedules) == set(SIDES), 'Incomplete schedule sides')
    for side in SIDES:
        snooze_rows = database.execute("""SELECT alarm_snooze_duration FROM tap_gestures
            WHERE side=? AND action_type='alarm' AND alarm_behavior='snooze' AND alarm_snooze_duration IS NOT NULL
            ORDER BY CASE tap_type WHEN 'doubleTap' THEN 0 WHEN 'tripleTap' THEN 1 ELSE 2 END""", (side,)).fetchall()
        snooze_duration = snooze_rows[0][0] if snooze_rows else 300
        if len({row[0] for row in snooze_rows}) > 1:
            report['reviewRequired'].append(f'{side}: alarms use the first snoozing tap duration; differing legacy tap durations require review')
        require(set(schedules[side]) == set(DAYS), 'Incomplete schedule week')
        for day in DAYS:
            routine = schedules[side][day]
            require(isinstance(routine['temperatures'], dict) and len(routine['temperatures']) <= 96,
                    'A bedtime routine supports at most 96 temperature phases; review the original before migration')
            power = routine['power']
            start, end = clock(power['on']), clock(power['off'])
            enabled = boolean(power['enabled'], 'power enabled')
            require(start != end or not enabled, 'Enabled routine has equal start and end times')
            temperature = number(power['onTemperature'], 55, 110, 'power temperature', integer=True)
            power_id = database.execute('''INSERT INTO power_schedules(side,day_of_week,on_time,off_time,off_day_offset,
                end_action,on_temperature,enabled) VALUES (?,?,?,?,?,'turn_off',?,?)''',
                (side, day, start, end, int(end < start), temperature, enabled)).lastrowid
            duration = (minutes(end) - minutes(start)) % 1440
            phase_ids, phases = [], []
            for at, target in sorted(routine['temperatures'].items(), key=lambda item: (minutes(clock(item[0])) - minutes(start)) % 1440):
                clock(at)
                target = number(target, 55, 110, 'routine target', integer=True)
                offset = (minutes(at) - minutes(start)) % 1440
                active = enabled and 0 < offset < duration
                phase_id = database.execute('''INSERT INTO temperature_schedules(side,day_of_week,time,temperature,enabled)
                    VALUES (?,?,?,?,?)''', (side, event_day(day, at, start), at, target, active)).lastrowid
                phase_ids.append(phase_id)
                phases.append({'time': at, 'temperature': target, 'enabled': 0 < offset < duration})
                if not 0 < offset < duration:
                    report['reviewRequired'].append(f'{side}/{day}: inactive out-of-window target retained disabled')
            alarm = routine['alarm']
            at = clock(alarm['time'])
            alarm_enabled = boolean(alarm['enabled'], 'alarm enabled') and enabled
            intensity = number(alarm['vibrationIntensity'], 1, 100, 'alarm intensity', integer=True)
            length = number(alarm['duration'], 0, 180, 'alarm duration', integer=True)
            require(alarm['vibrationPattern'] in ('rise', 'double'), 'Invalid alarm pattern')
            alarm_temperature = number(alarm['alarmTemperature'], 55, 110, 'alarm temperature', integer=True)
            alarm_id = database.execute('''INSERT INTO alarm_schedules(side,day_of_week,time,vibration_intensity,
                vibration_pattern,duration,alarm_temperature,wake_window,snooze_duration,snooze_taper,enabled) VALUES (?,?,?,?,?,?,?,0,?,0,?)''',
                (side, event_day(day, at, start), at, intensity, alarm['vibrationPattern'], max(10, length), alarm_temperature, snooze_duration, alarm_enabled)).lastrowid
            draft = {
                'power': {'onTime': start, 'offTime': end, 'onTemperature': temperature, 'enabled': enabled, 'endAction': 'turn_off'},
                'temperatures': phases,
                'alarm': {'time': at, 'vibrationIntensity': intensity, 'vibrationPattern': alarm['vibrationPattern'],
                          'duration': max(10, length), 'alarmTemperature': alarm_temperature, 'wakeWindow': 0, 'snoozeDuration': snooze_duration, 'snoozeTaper': 0, 'enabled': alarm['enabled']},
                'notes': '',
            }
            database.execute('INSERT INTO bedtime_routines(side,day_of_week,configuration,schedule_ids) VALUES (?,?,?,?)',
                             (side, day, json.dumps(draft), json.dumps({'power': [power_id], 'temperature': phase_ids, 'alarm': [alarm_id]})))
            if alarm_enabled:
                report['reviewRequired'].append(f'{side}/{day}: Core alarm warm-up and post-alarm hold require review before enabling this candidate')
    report['scheduleSemantics'] = 'Calendar events with explicit bedtime ownership and next-day power-off; original routines retained under legacy/lowdb'


def minutes(value):
    return int(value[:2]) * 60 + int(value[3:])


def map_comfort(legacy, database, report, now, zone):
    filename = legacy / 'analytics/comfort.json'
    document = read_json(filename) if filename.exists() else {}
    require(isinstance(document, dict) and (not document or set(document) == set(SIDES)), 'Invalid comfort document')
    for side in SIDES:
        original = document.get(side, {})
        config = original.get('config', {'mode': 'off', 'minimumF': 70, 'maximumF': 95})
        require(config['mode'] in ('off', 'preview', 'active'), 'Invalid comfort mode')
        lower = number(config['minimumF'], 55, 110, 'comfort minimum', integer=True)
        upper = number(config['maximumF'], lower, 110, 'comfort maximum', integer=True)
        for option in ('sensorAware', 'followBedtime'):
            if option in config:
                boolean(config[option], option)
        state = {
            'config': {'mode': 'off', 'minimumF': lower, 'maximumF': upper, 'sensorAware': False, 'followBedtime': False},
            'offsetF': number(original.get('offsetF', 0), -3, 3, 'learned offset', integer=True),
            'feedbackThrough': calendar_date(original.get('feedbackThrough', ''), allow_empty=True),
            'learnedSession': original.get('learnedSession', ''),
            'pausedUntil': number(original.get('pausedUntil', 0), 0, 8_640_000_000_000_000, 'manual pause', integer=True),
            'lastAppliedAt': number(original.get('lastAppliedAt', 0), 0, now, 'last application', integer=True),
            'lastTargetF': original.get('lastTargetF'),
            'lastSegment': original.get('lastSegment', ''),
        }
        require(isinstance(state['learnedSession'], str) and len(state['learnedSession']) <= 500
                and isinstance(state['lastSegment'], str) and len(state['lastSegment']) <= 1000, 'Invalid learning cursor')
        if state['lastTargetF'] is not None:
            number(state['lastTargetF'], 55, 110, 'last target')
        database.execute('INSERT INTO comfort_states(side,state) VALUES (?,?)', (side, json_text(state)))
        # Old activity lacks reported-state/ownership evidence; keep it as legacy history.
        history = original.get('history', [])
        require(isinstance(history, list) and len(history) <= 60, 'Invalid comfort history')
        for entry in history:
            number(entry['at'], 0, 8_640_000_000_000_000, 'legacy activity time', integer=True)
            require(isinstance(entry['message'], str), 'Invalid legacy activity message')
            if entry['targetF'] is not None:
                number(entry['targetF'], 55, 110, 'legacy activity target')
        if 'phaseShiftMinutes' in original:
            number(original['phaseShiftMinutes'], -30, 30, 'learned timing offset', integer=True)
        if 'timingSession' in original:
            require(isinstance(original['timingSession'], str), 'Invalid timing cursor')
        if config['mode'] != 'off' or config.get('sensorAware') or config.get('followBedtime'):
            report['reviewRequired'].append(f'{side}: previous comfort configuration preserved; Core starts Off with unsupported adapters disabled')
    journal_path = legacy / 'analytics/journal.json'
    entries = read_json(journal_path) if journal_path.exists() else []
    require(isinstance(entries, list) and len(entries) <= 7300, 'Invalid comfort journal')
    seen = set()
    for entry in entries:
        require(isinstance(entry, dict), 'Invalid journal entry')
        side, recorded_date = entry.get('side'), calendar_date(entry.get('date'))
        require(side in SIDES and (side, recorded_date) not in seen, 'Duplicate or invalid journal side/date')
        require(entry.get('comfort') in ('warm', 'cold', 'comfortable'), 'Invalid comfort check-in')
        number(entry['restfulness'], 1, 5, 'restfulness', integer=True)
        for field in ('caffeine', 'alcohol', 'exercise'):
            boolean(entry[field], field)
        require(isinstance(entry.get('notes', ''), str) and len(entry.get('notes', '').encode('utf-16-le')) // 2 <= 500, 'Invalid journal notes')
        seen.add((side, recorded_date))
        fields = {key: entry[key] for key in ('restfulness', 'comfort', 'caffeine', 'alcohol', 'exercise')}
        fields['notes'] = entry.get('notes', '').strip()
        record = {'side': side, 'date': recorded_date, 'fields': fields, 'timeZone': zone,
                  'origin': 'free-sleep', 'createdAt': None, 'updatedAt': None, 'importedAt': now}
        database.execute('INSERT INTO journal_entries(side,local_date,revision,record) VALUES (?,?,?,?)',
                         (side, recorded_date, str(uuid4()), json_text(record)))
        database.execute('INSERT INTO comfort_feedback(side,local_date,comfort,recorded_at) VALUES (?,?,?,?)',
                         (side, recorded_date, entry['comfort'], now))
    report['journalEntries'] = len(entries)
    report['legacyComfortHistory'] = {side: len(document.get(side, {}).get('history', [])) for side in SIDES}


def preserve_biometrics(legacy, biometrics, report, now):
    """Keep legacy metric definitions intact; do not relabel five-minute HRV as Core HRV."""
    source = legacy / 'free-sleep.db'
    require(source.is_file(), 'Missing legacy biometric database')
    with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as database:
        require(database.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'Legacy SQLite integrity failure')
        report['legacyMetricRows'] = {}
        columns = {
            'vitals': {'id', 'side', 'timestamp', 'heart_rate', 'hrv', 'breathing_rate'},
            'movement': {'id', 'side', 'timestamp', 'total_movement'},
            'sleep_records': {'id', 'side', 'entered_bed_at', 'left_bed_at', 'sleep_period_seconds',
                              'times_exited_bed', 'present_intervals', 'not_present_intervals'},
        }
        for table, required_columns in columns.items():
            require(database.execute("SELECT type FROM sqlite_master WHERE name=?", (table,)).fetchone() == ('table',), 'Missing legacy metric table')
            actual_columns = {row[1] for row in database.execute(f'PRAGMA table_info({table})')}
            require(required_columns <= actual_columns, 'Unsupported legacy metric schema')
            report['legacyMetricRows'][table] = database.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
    for side in SIDES:
        filename = legacy / f'{side}_cap_baseline.json'
        if not filename.exists():
            report['reviewRequired'].append(f'{side}: no legacy capacitance baseline')
            continue
        baseline = read_json(filename)
        require(isinstance(baseline, dict) and 'format' not in baseline, 'Tagged capacitance needs an explicit format adapter')
        channels = {}
        for channel in ('out', 'cen', 'in'):
            values = baseline[f'{side}_{channel}']
            channels[channel] = {
                'mean': number(values['mean'], 0, 1e15, 'calibration mean'),
                'std': number(values['std'], 1e-12, 1e15, 'calibration noise'),
            }
        # Pending is intentional: Free Sleep used normalized deviations, Core raw units.
        parameters = {'format': 'capSense', 'channels': channels, 'migrationSource': 'free-sleep',
                      'qualification': 'required', 'legacyAlgorithm': 'summed-z-score'}
        biometrics.execute('''INSERT INTO calibration_profiles(side,sensor_type,status,parameters,created_at)
            VALUES (?,'capacitance','pending',?,?)''', (side, json_text(parameters), now // 1000))
        report['reviewRequired'].append(f'{side}: baseline preserved pending occupancy qualification; no quality score or raw-unit threshold inferred')
    report['legacyMetricsPath'] = 'legacy/free-sleep.db'
    report['legacyMetricSemantics'] = 'Original tables/units retained; not mixed with Core live metrics or used as Preview nights'


def stage_backup(backup, output, now=None):
    backup = Path(backup).resolve(strict=True)
    output = Path(output).absolute()
    require(not output.exists() and not output.is_symlink(), 'Output must be a new directory')
    output = output.parent.resolve(strict=True) / output.name
    require(output.parent.is_dir(), 'Output parent must exist')
    require(backup != output and backup not in output.parents, 'Output must be outside the backup')
    now = int(datetime.now(timezone.utc).timestamp() * 1000) if now is None else now
    report = {'format': 'sleepypod-free-sleep-import/1', 'createdAt': now, 'readyForCutover': False,
              'reviewRequired': [], 'controllersChanged': False}
    staging = Path(tempfile.mkdtemp(prefix='.free-sleep-import-', dir=output.parent))
    os.chmod(staging, 0o700)
    try:
        manifest = verify_backup(backup, staging)
        report['sourceArchives'] = manifest['archives']
        legacy = staging / 'legacy'
        settings = read_json(legacy / 'lowdb/settingsDB.json')
        require(isinstance(settings, dict), 'Invalid settings document')
        validate_timezone(settings.get('timeZone'))
        with closing(create_database(staging / 'sleepypod.db', ROOT / 'src/db/migrations')) as database:
            with closing(create_database(staging / 'biometrics.db', ROOT / 'src/db/biometrics-migrations')) as biometrics:
                map_settings(settings, database, report, now)
                map_schedules(read_json(legacy / 'lowdb/schedulesDB.json'), database, report)
                map_comfort(legacy, database, report, now, settings['timeZone'])
                preserve_biometrics(legacy, biometrics, report, now)
                report['importedHistory'] = imported_history.prepare(
                    legacy / 'free-sleep.db', staging / imported_history.FILENAME, settings['timeZone'], now)
                report['importedRows'] = {table: database.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
                    for table in ('power_schedules', 'temperature_schedules', 'alarm_schedules', 'tap_gestures', 'comfort_states', 'comfort_feedback', 'journal_entries')}
                for connection in (database, biometrics):
                    connection.commit()
                    require(connection.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'Imported SQLite integrity failure')
                    require(not connection.execute('PRAGMA foreign_key_check').fetchall(), 'Imported SQLite foreign-key failure')
        report['requiredGates'] = ['Complete installation/service/SSH rollback artifact', 'Native compatibility and overnight editor qualification',
                                  'Attended hardware and sensor qualification', 'Reviewed activation and seven actual Preview nights']
        report['databaseHashes'] = {name: checksum(staging / name)
                                   for name in ('sleepypod.db', 'biometrics.db', imported_history.FILENAME)}
        write_private(staging / 'migration-report.json', report)
        for path in staging.rglob('*'):
            os.chmod(path, 0o700 if path.is_dir() else 0o600)
        require(not output.exists() and not output.is_symlink(), 'Output appeared during import')
        staging.rename(output)
        return report
    finally:
        if staging.exists():
            shutil.rmtree(staging)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backup', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--check-timezone', help='Validate the source timezone without reading a backup or writing files')
    arguments = parser.parse_args()
    if arguments.check_timezone is not None:
        if arguments.backup is not None or arguments.output is not None:
            parser.error('--check-timezone cannot be combined with --backup or --output')
        try:
            validate_timezone(arguments.check_timezone)
        except ValueError as error:
            parser.error(str(error))
        print(json.dumps({'status': 'timezone_available', 'timezone': arguments.check_timezone}))
        raise SystemExit(0)
    if arguments.backup is None or arguments.output is None:
        parser.error('--backup and --output are required for an import')
    os.umask(0o077)
    result = stage_backup(arguments.backup, arguments.output)
    print(json.dumps({'status': 'staged_for_review', 'readyForCutover': False,
                      'importedRows': result['importedRows'], 'reviewItems': len(result['reviewRequired'])}))
