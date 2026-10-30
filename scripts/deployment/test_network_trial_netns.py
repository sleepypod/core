"""Opt-in Linux packet test. All firewall changes stay inside disposable namespaces."""
import os
import select
import subprocess
import sys
import unittest
from unittest.mock import patch
import uuid

import network_trial as trial


ENABLED = os.environ.get('SLEEPYPOD_NETWORK_NAMESPACE_TEST') == '1'


@unittest.skipUnless(ENABLED and sys.platform == 'linux' and os.geteuid() == 0,
                     'Requires explicit Linux root network-namespace test opt-in')
class NetworkNamespaceTest(unittest.TestCase):
    def command(self, *arguments, check=True):
        return subprocess.run(arguments, check=check, capture_output=True, text=True, timeout=10)

    def namespace(self, name, *arguments):
        return self.command('ip', 'netns', 'exec', name, *arguments)

    def setUp(self):
        suffix = uuid.uuid4().hex[:8]
        self.pod, self.peer = 'spq-pod-' + suffix, 'spq-peer-' + suffix
        self.servers = []
        self.addCleanup(self.cleanup)
        for name in (self.pod, self.peer):
            self.command('ip', 'netns', 'add', name)
            self.namespace(name, 'ip', 'link', 'set', 'lo', 'up')
        self.command('ip', '-n', self.pod, 'link', 'add', 'bed0', 'type', 'veth', 'peer', 'name', 'peer0', 'netns', self.peer)
        for name, interface, addresses in [(self.pod, 'bed0', ['192.168.70.2/24', 'fd35:abcd::2/64']),
                                           (self.peer, 'peer0', ['192.168.70.3/24', '192.168.70.4/24', 'fd35:abcd::3/64'])]:
            for address in addresses:
                extra = ['nodad'] if ':' in address else []
                self.namespace(name, 'ip', 'address', 'add', address, 'dev', interface, *extra)
            self.namespace(name, 'ip', 'link', 'set', interface, 'up')
        self.listen(self.pod, '192.168.70.2', 3000)
        self.listen(self.pod, 'fd35:abcd::2', 3001)
        self.listen(self.peer, '192.168.70.3', 1883)

    def cleanup(self):
        for process in self.servers:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
            process.stdout.close()
        for name in (self.pod, self.peer):
            self.command('ip', 'netns', 'delete', name, check=False)

    def listen(self, namespace, address, port):
        source = '''import socket,sys
address,port=sys.argv[1],int(sys.argv[2])
listener=socket.socket(socket.AF_INET6 if ':' in address else socket.AF_INET)
listener.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
listener.bind((address,port)); listener.listen(); print('ready',flush=True)
while True:
 connection,_=listener.accept(); connection.close()
'''
        process = subprocess.Popen(['ip', 'netns', 'exec', namespace, sys.executable, '-u', '-c', source, address, str(port)],
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.servers.append(process)
        self.assertTrue(select.select([process.stdout], [], [], 5)[0], 'Test listener did not start')
        self.assertEqual(process.stdout.readline().strip(), 'ready')

    def connects(self, namespace, source_address, destination, port):
        source = '''import socket,sys
source,destination,port=sys.argv[1],sys.argv[2],int(sys.argv[3])
connection=socket.socket(socket.AF_INET6 if ':' in source else socket.AF_INET)
connection.settimeout(1); connection.bind((source,0))
try: connection.connect((destination,port)); print('connected')
except OSError: print('blocked')
finally: connection.close()
'''
        return self.namespace(namespace, sys.executable, '-c', source, source_address, destination, str(port)).stdout.strip() == 'connected'

    def test_real_ipv4_ipv6_packets_and_restoration(self):
        probes = [(self.peer, '192.168.70.3', '192.168.70.2', 3000),
                  (self.peer, '192.168.70.4', '192.168.70.2', 3000),
                  (self.peer, 'fd35:abcd::3', 'fd35:abcd::2', 3001),
                  (self.pod, '192.168.70.2', '192.168.70.3', 1883)]
        self.assertEqual([self.connects(*probe) for probe in probes], [True] * 4)
        self.namespace(self.pod, trial.FIREWALLS[0], '-A', 'OUTPUT', '-d', '203.0.113.1/32', '-j', 'DROP')
        original = {binary: self.namespace(self.pod, binary, '-S').stdout for binary in trial.FIREWALLS}
        record = {'id': uuid.uuid4().hex, 'controlAddress': '192.168.70.3'}
        def run_in_pod(arguments, check=True):
            if arguments[0] == trial.SYSTEMCTL:
                return subprocess.CompletedProcess(arguments, 0, stdout='', stderr='')
            return self.namespace(self.pod, *arguments)
        with patch.object(trial, 'run', run_in_pod), patch.object(trial, 'save'):
            for plan in trial.plans(record['controlAddress'], record['id']):
                run_in_pod([plan['binary'], '-N', plan['chain']])
                for rule in plan['rules']:
                    run_in_pod([plan['binary'], '-A', plan['chain'], *rule])
                run_in_pod([plan['binary'], '-I', plan['direction'], '1', *plan['jump']])
            self.assertEqual([self.connects(*probe) for probe in probes], [True, False, False, False])
            trial.restore(record)
        self.assertEqual([self.connects(*probe) for probe in probes], [True] * 4)
        self.assertEqual({binary: self.namespace(self.pod, binary, '-S').stdout for binary in trial.FIREWALLS}, original)


if __name__ == '__main__':
    unittest.main()
