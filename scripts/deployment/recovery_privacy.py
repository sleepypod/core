"""Hold legacy recovery once personal data exists, pending a durable recovery protocol."""
from contextlib import closing
import sqlite3
import stat

REQUIRED_TABLES = {'device_settings', 'side_settings', 'alarm_schedules', 'power_schedules'}


def require_legacy_recovery_data(directory):
    """Check without reading private rows; even unassigned drafts prohibit legacy recovery."""
    path = directory / 'sleepypod.db'
    try:
        if (not directory.is_absolute() or any(parent.is_symlink() for parent in (directory, *directory.parents))
                or not directory.is_dir() or not stat.S_ISREG(path.lstat().st_mode)):
            raise ValueError('Recovery requires a regular configuration database')
        for suffix in ('-wal', '-shm', '-journal'):
            sidecar = path.with_name(path.name + suffix)
            if sidecar.exists() or sidecar.is_symlink():
                if not stat.S_ISREG(sidecar.lstat().st_mode):
                    raise ValueError('Recovery database has an unsafe sidecar')
        with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=1)) as database:
            # One read transaction includes committed WAL data and pins the schema.
            database.execute('BEGIN')
            tables = [row[0] for row in database.execute("SELECT name FROM sqlite_master WHERE type='table'")]
            if (not REQUIRED_TABLES.issubset(tables)
                    or database.execute('PRAGMA quick_check').fetchall() != [('ok',)]):
                raise ValueError('Cannot verify the household recovery boundary; configuration is incomplete or corrupt')
            for name in tables:
                if name != 'households' and not name.startswith('household_'):
                    continue
                # Legacy browser sessions exist before anyone creates a personal account.
                if name == 'household_browser_scopes':
                    continue
                quoted = '"' + name.replace('"', '""') + '"'
                if database.execute('SELECT 1 FROM ' + quoted + ' LIMIT 1').fetchone():
                    raise ValueError('Personal household data requires qualified recovery; keep the current release and data')
    except (OSError, sqlite3.Error) as error:
        raise ValueError('Cannot verify the household recovery boundary; keep the current release and data') from error
