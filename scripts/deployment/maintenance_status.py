"""Validate the small administrative status contract without recording personal data."""
from datetime import datetime
import re
import time

PATH = '/api/v1/maintenance/status'
FORMAT = 'sleepypod-maintenance-status'
FIELDS = {'apiVersion', 'kind', 'generatedAt', 'controller', 'device',
          'temperatureRuntime', 'thermalIdle', 'privacyBoundary'}


def require_current(generated_at, now=None):
    if not isinstance(generated_at, str) or not generated_at.endswith('Z'):
        raise ValueError('Maintenance observation has no valid UTC timestamp')
    try:
        observed = datetime.fromisoformat(generated_at[:-1] + '+00:00').timestamp()
    except (ValueError, OverflowError) as error:
        raise ValueError('Maintenance observation has no valid UTC timestamp') from error
    if not 0 <= (time.time() if now is None else now) - observed < 15:
        raise ValueError('Maintenance observation is stale or in the future')


def parse(value, expected_revision, now=None):
    """Reject unknown protocol shapes; never journal an unexpected server payload."""
    if not isinstance(value, dict) or set(value) != FIELDS:
        raise ValueError('Unexpected maintenance status fields')
    if type(value['apiVersion']) is not int or value['apiVersion'] != 1 or value['kind'] != FORMAT:
        raise ValueError('Unsupported maintenance status protocol')
    controller, device = value['controller'], value['device']
    if (not isinstance(controller, dict) or set(controller) != {'id', 'revision'}
            or controller['id'] != 'sleepypod-core'):
        raise ValueError('Unexpected maintenance controller')
    revision = controller['revision']
    if (not isinstance(revision, str) or not re.fullmatch('[a-f0-9]{7,40}', revision)
            or not isinstance(expected_revision, str) or not re.fullmatch('[a-f0-9]{40}', expected_revision)
            or not expected_revision.startswith(revision)):
        raise ValueError('Controller revision differs from the staged release')
    if not isinstance(device, dict) or set(device) != {'freshness'} or device['freshness'] not in ('fresh', 'stale', 'unavailable'):
        raise ValueError('Invalid maintenance device observation')
    if (value['temperatureRuntime'] not in ('ready', 'not_ready')
            or value['privacyBoundary'] not in ('legacy', 'personal_required', 'unavailable')
            or (value['thermalIdle'] is not None and type(value['thermalIdle']) is not bool)):
        raise ValueError('Invalid maintenance readiness')
    if ((device['freshness'] != 'fresh' or value['privacyBoundary'] == 'unavailable')
            and (value['thermalIdle'] is not None or value['temperatureRuntime'] != 'not_ready')):
        raise ValueError('Unavailable observations cannot assert maintenance readiness')
    require_current(value['generatedAt'], now)
    return {'controller': controller, 'device': device, 'temperatureRuntime': value['temperatureRuntime'],
            'maintenanceProtocol': 1, 'generatedAt': value['generatedAt'],
            'thermalIdle': value['thermalIdle'], 'privacyBoundary': value['privacyBoundary']}


def require_idle(observation):
    """Idle covers heating countdowns and priming, not occupancy, vibration or base motion."""
    require_current(observation.get('generatedAt'))
    if (type(observation.get('maintenanceProtocol')) is not int or observation['maintenanceProtocol'] != 1
            or observation.get('device', {}).get('freshness') != 'fresh'
            or observation.get('temperatureRuntime') != 'ready'
            or observation.get('privacyBoundary') not in ('legacy', 'personal_required')
            or observation.get('thermalIdle') is not True):
        raise RuntimeError('Maintenance requires a fresh, available, thermally idle controller')
