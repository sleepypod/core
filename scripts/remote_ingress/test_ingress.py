"""Exercise the rendered configuration through a real local Nginx process."""
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from urllib.parse import parse_qs, urlsplit

from render import render, write_bundle


HOST = 'sleep.example.com'


def unused_port():
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        return reservation.getsockname()[1]


class Origin(BaseHTTPRequestHandler):
    calls = []
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_arguments):
        pass

    def handle_request(self):
        length = int(self.headers.get('Content-Length', 0))
        data = self.rfile.read(length).decode() if length else ''
        request = {'method': self.command, 'path': self.path, 'body': data,
                   'headers': dict(self.headers)}
        self.calls.append(request)
        if data == 'drop-response':
            self.close_connection = True
            return
        authorization = self.headers.get('Authorization')
        # Synthetic identities only. Real authorization still belongs to Core.
        allowed = authorization in ['Bearer owner-fixture', 'Bearer person-fixture']
        challenge = parse_qs(urlsplit(self.path).query).get('challenge', [None])[0]
        payload = json.dumps({'request': request, 'principal': authorization, 'challenge': challenge,
                              'calls': len(self.calls)}).encode()
        self.send_response(200 if allowed else 401)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'public, max-age=3600')
        if self.path == '/api/auth/session':
            self.send_header('Set-Cookie', 'sleepypod_session=fixture; Path=/; HttpOnly; SameSite=Strict')
            self.send_header('Set-Cookie', 'sleepypod_browser_scope=fixture; Path=/; HttpOnly; SameSite=Strict')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(payload)

    do_GET = do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = handle_request


class ConfigurationTests(unittest.TestCase):
    def test_rejects_config_injection_and_nonlocal_upstreams(self):
        for host in ['bad\nserver_name x;', 'https://bed.example.com', 'bed.example.com:443',
                     'BED.example.com', '.example.com', 'a..com', '127.0.0.1', 'host']:
            with self.subTest(host=host), self.assertRaises(ValueError):
                render(host, '10.0.1.69')
        for address in ['169.254.169.254', '8.8.8.8', '10.0.1.69;}', 'pod.example.com']:
            with self.subTest(address=address), self.assertRaises(ValueError):
                render(HOST, address)
        for port in [80, 0, -1, 65536, True, '18080']:
            with self.subTest(port=port), self.assertRaises(ValueError):
                render(HOST, '10.0.1.69', port)
        with self.assertRaises(ValueError):
            render(HOST, '127.0.0.1', 18080, 18080)

    def test_bundle_is_exclusive_inactive_and_contains_no_owner_key(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / 'bundle'
            write_bundle(target, HOST, '10.0.1.69')
            metadata = json.loads((target / 'deployment.json').read_text())
            self.assertFalse(metadata['published'])
            self.assertFalse(metadata['started'])
            self.assertEqual(metadata['coreHostRequirement'], {
                'variable': 'SLEEPYPOD_ALLOWED_HOSTS', 'appendExactHost': HOST,
                'preserveExistingEntries': True, 'applied': False})
            with self.assertRaises(FileExistsError):
                write_bundle(target, HOST, '10.0.1.70')
            self.assertIn('proxy_pass http://10.0.1.69:3000;', (target / 'nginx.conf').read_text())
            self.assertNotIn('proxy_set_header Authorization', (target / 'nginx.conf').read_text())


class ProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        executable = os.environ.get('NGINX_BIN') or shutil.which('nginx')
        if not executable:
            raise RuntimeError('Nginx is required; install it rather than skipping the transport checks')
        cls.temporary = tempfile.TemporaryDirectory(prefix='sleepypod-ingress-')
        cls.directory = Path(cls.temporary.name)
        cls.port = unused_port()
        cls.origin = ThreadingHTTPServer(('127.0.0.1', 0), Origin)
        cls.origin.daemon_threads = True
        cls.thread = threading.Thread(target=cls.origin.serve_forever, daemon=True)
        cls.thread.start()
        configuration = cls.directory / 'nginx.conf'
        configuration.write_text(render(HOST, '127.0.0.1', cls.port, cls.origin.server_port))
        for name in ['body_temp', 'proxy_temp']:
            (cls.directory / name).mkdir()
        command = [executable, '-p', str(cls.directory) + '/', '-c', str(configuration)]
        subprocess.run(command + ['-t'], check=True, capture_output=True)
        cls.process = subprocess.Popen(command + ['-g', 'daemon off;'], stdout=subprocess.DEVNULL,
                                       stderr=subprocess.PIPE)
        for _attempt in range(100):
            if cls.process.poll() is not None:
                raise RuntimeError(cls.process.stderr.read().decode())
            try:
                with socket.create_connection(('127.0.0.1', cls.port), timeout=.1):
                    return
            except OSError:
                time.sleep(.05)
        raise RuntimeError('Local test ingress did not start')

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        cls.process.communicate(timeout=5)
        cls.origin.shutdown()
        cls.origin.server_close()
        cls.thread.join(timeout=5)
        cls.temporary.cleanup()

    def request(self, method, path, body=None, **headers):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        try:
            connection.request(method, path, body, headers={'Host': HOST, **headers})
            response = connection.getresponse()
            return response.status, response.getheaders(), response.read()
        finally:
            connection.close()

    def test_owner_personal_auth_scope_and_freshness_are_preserved(self):
        for principal in ['owner-fixture', 'person-fixture']:
            with self.subTest(principal=principal):
                challenge = ('A' if principal == 'owner-fixture' else 'B') * 43
                path = '/api/v1/connection?challenge=' + challenge
                status, headers, body = self.request('GET', path,
                    Authorization='Bearer ' + principal,
                    Cookie='sleepypod_personal_session=example; sleepypod_browser_scope=' + 'A' * 43,
                    **{'X-Forwarded-Host': 'attacker.invalid', 'X-Forwarded-Proto': 'http'})
                self.assertEqual(status, 200)
                reply = json.loads(body)
                self.assertEqual(reply['principal'], 'Bearer ' + principal)
                forwarded = {key.lower(): value for key, value in reply['request']['headers'].items()}
                self.assertEqual(forwarded['cookie'],
                                 'sleepypod_personal_session=example; sleepypod_browser_scope=' + 'A' * 43)
                self.assertEqual(forwarded['host'], HOST)
                self.assertEqual(forwarded['x-forwarded-host'], HOST)
                self.assertEqual(forwarded['x-forwarded-proto'], 'https')
                self.assertEqual(reply['challenge'], challenge)
                self.assertEqual(reply['request']['path'], path)
                self.assertEqual(dict(headers)['Cache-Control'], 'private, no-store')

    def test_gateway_never_upgrades_missing_or_invalid_credentials(self):
        for headers in [{}, {'Authorization': 'Bearer wrong'}]:
            status, _, _ = self.request('GET', '/api/trpc/device.getStatus', **headers)
            self.assertEqual(status, 401)

    def test_private_reads_are_not_cached(self):
        replies = [self.request('GET', '/api/v1/connection?challenge=same', Authorization='Bearer owner-fixture') for _ in range(2)]
        self.assertEqual([reply[0] for reply in replies], [200, 200])
        self.assertEqual(json.loads(replies[1][2])['calls'], json.loads(replies[0][2])['calls'] + 1)

    def test_native_status_batch_and_passive_rest_equivalents_are_forwarded(self):
        procedures = ['health.system', 'health.scheduler', 'health.hardware',
                      'health.dacMonitor', 'system.wifiStatus', 'system.getLogSources']
        paths = ['/api/trpc/' + ','.join(procedures) + '?batch=1&input=%7B%7D',
                 *['/api/trpc/' + procedure for procedure in procedures],
                 '/api/system/wifi-status', '/api/system/log-sources']
        for path in paths:
            with self.subTest(path=path):
                status, _, body = self.request('GET', path, Authorization='Bearer owner-fixture')
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(body)['request']['path'], path)
                self.assertEqual(self.request('GET', path)[0], 401)

    def test_status_exception_never_admits_mixed_maintenance_or_writes(self):
        paths = ['/api/trpc/health.system,system.getLogs',
                 '/api/trpc/system.wifiStatus,device.execute',
                 '/api/trpc/system.getLogSources,unknown.futureControl',
                 '/api/trpc/system.getLogSourcesExtra', '/api/trpc/system.wifiStatus/extra',
                 '/api/system/log-sources/extra']
        for path in paths:
            with self.subTest(path=path):
                before = len(Origin.calls)
                self.assertEqual(self.request('GET', path, Authorization='Bearer owner-fixture')[0], 403)
                self.assertEqual(len(Origin.calls), before)
        for path in ['/api/trpc/system.wifiStatus', '/api/trpc/health.system,system.getLogSources',
                     '/api/system/wifi-status', '/api/system/log-sources']:
            with self.subTest(write=path):
                before = len(Origin.calls)
                self.assertEqual(self.request('POST', path, '{}', Authorization='Bearer owner-fixture')[0], 403)
                self.assertEqual(len(Origin.calls), before)

    def test_browser_session_cookies_remain_separate_and_secure(self):
        status, headers, _ = self.request('POST', '/api/auth/session', '{}',
            Authorization='Bearer owner-fixture', Origin='https://' + HOST)
        self.assertEqual(status, 200)
        cookies = [value.lower() for name, value in headers if name.lower() == 'set-cookie']
        self.assertEqual(len(cookies), 2)
        for cookie in cookies:
            self.assertIn('secure', cookie)
            self.assertIn('httponly', cookie)
            self.assertIn('samesite=strict', cookie)

    def test_supported_control_and_routine_writes_keep_body_and_method(self):
        for method, path in [('POST', '/api/v1/controls'), ('POST', '/api/v1/me/controls'),
                             ('PUT', '/api/v1/me/routines'), ('POST', '/api/v1/me/routines/publish'),
                             ('POST', '/api/v1/routines'), ('PUT', '/api/v1/temperature/comfort-limit'),
                             ('POST', '/api/base/stop'), ('POST', '/api/trpc/base.stop'),
                             ('PATCH', '/api/settings/side'), ('DELETE', '/api/schedules/alarm'),
                             ('PATCH', '/api/schedules/temperature'), ('POST', '/api/schedules/batch'),
                             ('POST', '/api/device/temperature/resume'),
                             ('POST', '/api/v1/alarm/override'), ('POST', '/api/trpc/controls.submit'),
                             ('POST', '/api/trpc/device.setTemperature,device.setPower')]:
            with self.subTest(path=path):
                payload = '{"requestId":"unique-fixture","target":70}'
                status, _, response = self.request(method, path, payload, Authorization='Bearer person-fixture')
                self.assertEqual(status, 200)
                captured = json.loads(response)['request']
                self.assertEqual(captured['body'], payload)
                self.assertEqual(captured['method'], method)
                self.assertEqual(captured['path'], path)

    def test_unreviewed_and_maintenance_writes_never_reach_origin(self):
        routes = ['/api/mcp', '/api/device/execute', '/api/device/prime',
                  '/api/trpc/device.execute', '/api/trpc/controls.submit,device.execute',
                  '/api/trpc/unknown.futureControl', '/api/trpc',
                  '/api/v1/household/transition', '/api/v1/household/arrangement/approve',
                  '/api/v1/me/unknown', '/en']
        for path in routes:
            with self.subTest(path=path):
                before = len(Origin.calls)
                self.assertEqual(self.request('POST', path, '{}', Authorization='Bearer owner-fixture')[0], 403)
                self.assertEqual(len(Origin.calls), before)

    def test_host_origin_and_upgrade_are_checked_before_forwarding(self):
        for headers, expected in [({'Host': 'attacker.invalid'}, 421),
                                  ({'Origin': 'https://attacker.invalid'}, 403),
                                  ({'Origin': 'null'}, 403),
                                  ({'Upgrade': 'websocket', 'Connection': 'upgrade'}, 426)]:
            with self.subTest(headers=headers):
                before = len(Origin.calls)
                self.assertEqual(self.request('GET', '/api/v1/connection', **headers)[0], expected)
                self.assertEqual(len(Origin.calls), before)

    def test_raw_reads_and_encoded_aliases_are_not_exposed(self):
        for path in ['/api/mcp', '/api/raw/recording', '/api/db-backup',
                     '/api/trpc/system.getStatus', '/api/trpc/device%2Eexecute',
                     '/api/trpc/device%252Eexecute', '/api/%2572aw/recording',
                     '//api/mcp']:
            with self.subTest(path=path):
                before = len(Origin.calls)
                self.assertEqual(self.request('GET', path, Authorization='Bearer owner-fixture')[0], 403)
                self.assertEqual(len(Origin.calls), before)

    def test_oversized_body_is_rejected_before_upstream_delivery(self):
        before = len(Origin.calls)
        status, _, _ = self.request('POST', '/api/v1/controls', '',
            Authorization='Bearer owner-fixture', **{'Content-Length': str(17 * 1024 * 1024)})
        self.assertEqual(status, 413)
        self.assertEqual(len(Origin.calls), before)

    def test_lost_command_response_is_not_replayed(self):
        before = len(Origin.calls)
        status, _, _ = self.request('POST', '/api/v1/controls', 'drop-response', Authorization='Bearer owner-fixture')
        self.assertEqual(status, 502)
        self.assertEqual(len(Origin.calls), before + 1)


if __name__ == '__main__':
    unittest.main()
