#!/usr/bin/env python3
"""Forced SSH command: accept only allowlisted cached bedroom readings, never controls."""
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

LIMIT = 32768


def strict_json(contents):
    def pairs(entries):
        result = {}
        for key, value in entries:
            if key in result: raise ValueError('Duplicate field')
            result[key] = value
        return result
    return json.loads(contents, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Non-finite value')))


def private_file(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise ValueError('Expected a root-owned private file')
    return path.read_text()


def readings(payload, source_ids, now):
    """The key cannot choose a timestamp basis, revision, URL, credential or actuator."""
    if (not isinstance(payload, dict) or set(payload) != {'version', 'issuedAt', 'readings'}
            or type(payload['version']) is not int or payload['version'] != 1
            or type(payload['issuedAt']) is not int or abs(now-payload['issuedAt']) > 15000
            or not isinstance(payload['readings'], list) or not 1 <= len(payload['readings']) <= 40):
        raise ValueError('Invalid or expired cache envelope')
    result = []
    seen = set()
    for item in payload['readings']:
        if (not isinstance(item, dict) or set(item) != {'sourceId', 'value'}
                or not isinstance(item['sourceId'], str) or item['sourceId'] not in source_ids
                or item['sourceId'] in seen or (item['value'] is not None and
                (type(item['value']) not in (int, float) or not math.isfinite(item['value'])))):
            raise ValueError('Invalid or unauthorized source')
        seen.add(item['sourceId'])
        result.append(item)
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise ValueError('Unexpected controller redirect')


def deliver(payload, config):
    now = int(time.time()*1000)
    items = readings(payload, config['sourceIds'], now)
    lines = private_file(Path(config['environment'])).splitlines()
    keys = [line.split('=', 1)[1] for line in lines if line.startswith('SLEEPYPOD_AUTH_TOKEN=')]
    if len(keys) != 1 or len(keys[0]) < 32: raise ValueError('Owner authentication unavailable')
    headers = {'Authorization': 'Bearer '+keys[0], 'Content-Type': 'application/json'}
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    # The endpoint is fixed, with no caller-controlled path or HTTP method.
    with opener.open(urllib.request.Request('http://127.0.0.1:3000/api/v1/home/bedroom', headers=headers), timeout=5) as response:
        status = strict_json(response.read(131072))
    reports = [{'schemaVersion': 1, 'revision': status['revision'], 'sourceId': item['sourceId'],
                'available': item['value'] is not None, 'value': item['value'],
                'observedAt': int(time.time()*1000), 'measuredAt': None, 'timeBasis': 'cached'} for item in items]
    request = urllib.request.Request('http://127.0.0.1:3000/api/v1/home/bedroom/reports',
                                     data=json.dumps({'reports': reports}).encode(), headers=headers, method='POST')
    with opener.open(request, timeout=5) as response:
        result = strict_json(response.read(16384))
    # Never return controller settings, health history or the owner token to the publisher.
    return {'accepted': sum(item['accepted'] is True for item in result['results']),
            'submitted': len(reports), 'cachedOnly': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    args = parser.parse_args()
    signal.alarm(15)
    try:
        if os.environ.get('SSH_ORIGINAL_COMMAND', ''):
            raise ValueError('Only the forced cache publisher is permitted')
        config = strict_json(private_file(args.config))
        contents = sys.stdin.buffer.read(LIMIT+1)
        if len(contents) > LIMIT: raise ValueError('Payload too large')
        result = deliver(strict_json(contents), config)
        print(json.dumps(result))
    except Exception:
        print(json.dumps({'accepted': 0, 'error': 'cache_report_rejected'}))
        sys.exit(1)


if __name__ == '__main__': main()
