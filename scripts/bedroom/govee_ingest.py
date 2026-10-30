#!/usr/bin/env python3
"""Profile-scoped forced Govee receiver; no caller-selected source or clock basis."""
import argparse
import json
import math
import os
from pathlib import Path
import signal
import stat
import sys
import time
import urllib.request

MAX_BYTES = 4096
READ_WINDOW_MS = 8000
FORWARD_WINDOW_MS = 15000


def strict_json(contents):
    def unique(entries):
        result = {}
        for name, value in entries:
            if name in result:
                raise ValueError('Duplicate field')
            result[name] = value
        return result
    return json.loads(contents, object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Non-finite value')))


def private_file(path):
    information = path.lstat()
    if not stat.S_ISREG(information.st_mode) or information.st_uid != 0 or information.st_mode & 0o077:
        raise ValueError('Expected a root-owned private file')
    return path.read_text()


def air_quality(pm25):
    """HomeKit category derived from a new PM2.5 read using Govee's published bands; not AQI."""
    return 1 if pm25 <= 12 else 2 if pm25 <= 35 else 3 if pm25 <= 75 else 4 if pm25 <= 115 else 5


def receipt_reading(payload, now, extra_fields=frozenset()):
    """Validate the receipt clock before model-specific fields are interpreted."""
    if (not isinstance(payload, dict)
            or set(payload) != {'version', 'requestIssuedAt', 'observedAt', 'reading'} | extra_fields
            or type(payload['version']) is not int or payload['version'] != 1
            or type(payload['observedAt']) is not int or payload['observedAt'] <= 0
            or payload['observedAt'] - now > 1000
            or now - payload['observedAt'] > FORWARD_WINDOW_MS):
        raise ValueError('Invalid or expired read receipt')
    # Small sender clock skew is clamped backwards, never made newer by forwarding.
    observed_at = min(payload['observedAt'], now)
    reading = payload['reading']
    if reading is None:
        if payload['requestIssuedAt'] is not None:
            raise ValueError('Unavailable receipt must not claim a successful request')
        return observed_at, None
    requested_at = payload['requestIssuedAt']
    if (type(requested_at) is not int or requested_at <= 0
            or not 0 <= payload['observedAt'] - requested_at <= READ_WINDOW_MS
            or not isinstance(reading, dict)):
        raise ValueError('Unqualified device read')
    return observed_at, reading


def qualified_reading(payload, now):
    observed_at, reading = receipt_reading(payload, now)
    if reading is None:
        return observed_at, {metric: None for metric in ('temperature', 'humidity', 'pm25', 'airQuality')}
    if set(reading) != {'temperatureC', 'humidity', 'pm25'}:
        raise ValueError('Invalid monitor reading')
    for metric, maximum in (('temperatureC', 60), ('humidity', 100), ('pm25', 2000)):
        value = reading[metric]
        if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= maximum:
            raise ValueError('Invalid device value')
    return observed_at, {'temperature': reading['temperatureC'], 'humidity': reading['humidity'],
                         'pm25': reading['pm25'], 'airQuality': air_quality(reading['pm25'])}


def qualified_power(payload, now):
    """Appliance power is the only metric permitted by this separate identity."""
    observed_at, reading = receipt_reading(payload, now, {'model'})
    if payload['model'] not in ('H712C', 'H7161'):
        raise ValueError('Unqualified appliance model')
    if reading is None:
        return observed_at, {'power': None}
    if set(reading) != {'power'} or type(reading['power']) is not int or reading['power'] not in (0, 1):
        raise ValueError('Invalid appliance power')
    return observed_at, {'power': reading['power']}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_arguments, **_keywords):
        raise ValueError('Controller redirect rejected')


def deliver(payload, config, profile='monitor'):
    now = int(time.time() * 1000)
    if profile == 'monitor':
        observed_at, values = qualified_reading(payload, now)
        model = 'H5106'
    elif profile == 'appliance-power':
        observed_at, values = qualified_power(payload, now)
        if set(config['devices']) != {'H712C', 'H7161'}:
            raise ValueError('Invalid appliance allowlist')
        model = payload['model']
        config = {**config['devices'][model], 'environment': config['environment']}
    else:
        raise ValueError('Unsupported receiver profile')
    if (set(config['sources']) != set(values) or set(config['externalIds']) != set(values)
            or not isinstance(config['deviceId'], str) or not config['deviceId']
            or len(set(config['sources'].values())) != len(values)
            or not all(isinstance(value, str) and value for value in config['sources'].values())):
        raise ValueError('Invalid server-owned sensor mapping')
    environment = private_file(Path(config['environment'])).splitlines()
    tokens = [line.split('=', 1)[1] for line in environment if line.startswith('SLEEPYPOD_AUTH_TOKEN=')]
    if len(tokens) != 1 or len(tokens[0]) < 32:
        raise ValueError('Owner authentication unavailable')
    headers = {'Authorization': 'Bearer ' + tokens[0], 'Content-Type': 'application/json'}
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    endpoint = 'http://127.0.0.1:3000/api/v1/home/bedroom'
    with opener.open(urllib.request.Request(endpoint, headers=headers), timeout=5) as response:
        status = strict_json(response.read(131072))
    sources = {source['id']: source for source in status['config']['sources']}
    reports = []
    for metric, value in values.items():
        source_id = config['sources'][metric]
        source = sources.get(source_id)
        if (not source or source['model'] != model or source['metric'] != metric
                or source['provider'] != 'homebridge'
                or source['deviceId'] != config['deviceId'] or source['externalId'] != config['externalIds'][metric]
                or source['unit'] != {'temperature': '°C', 'humidity': '%', 'pm25': 'µg/m³',
                                     'airQuality': 'category', 'power': 'on/off'}[metric]):
            raise ValueError('Configured sensor identity changed')
        reports.append({'schemaVersion': 1, 'revision': status['revision'], 'sourceId': source_id,
                        'available': value is not None, 'value': value, 'observedAt': observed_at,
                        'measuredAt': None, 'timeBasis': 'device_read'})
    request = urllib.request.Request(endpoint + '/reports', data=json.dumps({'reports': reports}).encode(),
                                     headers=headers, method='POST')
    with opener.open(request, timeout=5) as response:
        result = strict_json(response.read(16384))
    return {'accepted': sum(item['accepted'] is True for item in result['results']),
            'submitted': len(reports), 'deviceReadOnly': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--profile', choices=('monitor', 'appliance-power'), default='monitor')
    arguments = parser.parse_args()
    signal.alarm(15)
    try:
        if os.environ.get('SSH_ORIGINAL_COMMAND', ''):
            raise ValueError('Only the forced sensor publisher is permitted')
        contents = sys.stdin.buffer.read(MAX_BYTES + 1)
        if len(contents) > MAX_BYTES:
            raise ValueError('Read receipt too large')
        result = deliver(strict_json(contents), strict_json(private_file(arguments.config)), arguments.profile)
        print(json.dumps(result))
    except Exception:
        print(json.dumps({'accepted': 0, 'error': 'device_read_rejected'}))
        sys.exit(1)


if __name__ == '__main__':
    main()
