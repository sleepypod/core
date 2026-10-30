import json
from pathlib import Path
import tempfile
import unittest

import maintenance_plan as plan

CONTROLLER = '/persistent/sleepypod-unified/service-plan-reviewed'
RELEASE = '/persistent/sleepypod-unified/releases/reviewed'


class MaintenancePlanTests(unittest.TestCase):
    def test_private_socket_and_hardened_root_service(self):
        units = plan.render(CONTROLLER, RELEASE)
        self.assertEqual(set(units), {plan.SERVICE, plan.SOCKET})
        socket = units[plan.SOCKET]
        for setting in ('SocketMode=0660', 'SocketGroup=dac', 'SocketUser=root', 'Accept=no',
                        'ListenStream=/run/sleepypod-maintenance/control.sock'):
            self.assertIn(setting, socket)
        service = units[plan.SERVICE]
        for setting in ('NoNewPrivileges=true', 'CapabilityBoundingSet=\n', 'RestrictAddressFamilies=AF_UNIX',
                        'ProtectSystem=strict', 'PrivateDevices=true', 'RuntimeDirectoryPreserve=yes',
                        'RuntimeDirectoryMode=0700', 'User=root', 'Group=root', ' -I ', '--plan '+CONTROLLER):
            self.assertIn(setting, service)
        self.assertNotIn('EnvironmentFile=', service)
        self.assertNotIn('sudo', service)
        self.assertNotIn('sp-update', service)
        self.assertNotIn('ReadWritePaths=/persistent', service)

    def test_paths_cannot_escape_managed_roots_or_inject_unit_directives(self):
        for value in ('/tmp/plan', CONTROLLER+'/child', '/persistent/sleepypod-unified/../../etc',
                      CONTROLLER+'\nUser=dac', CONTROLLER+'%i', CONTROLLER+' other'):
            with self.subTest(value=value), self.assertRaises(ValueError): plan.render(value, RELEASE)
        with self.assertRaises(ValueError): plan.render(CONTROLLER, '/persistent/free-sleep')

    def test_round_trip_retains_reviewed_content_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            output=Path(directory)/'plan'
            expected=plan.prepare(CONTROLLER, RELEASE, output)
            self.assertEqual(plan.read_plan(output), expected)
            self.assertFalse(expected['servicesStarted'])
            self.assertFalse(expected['coreEnvironmentChanged'])
            self.assertEqual((output/'maintenance-plan.json').stat().st_mode & 0o777, 0o600)
            with self.assertRaises(ValueError): plan.prepare(CONTROLLER, RELEASE, output)
            (output/plan.SERVICE).write_text('ExecStart=/bin/reboot\n')
            with self.assertRaises(ValueError): plan.read_plan(output)

    def test_unknown_membership_and_symlink_units_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            output=Path(directory)/'plan'
            plan.prepare(CONTROLLER, RELEASE, output)
            service=output/plan.SERVICE
            service.unlink()
            service.symlink_to(output/'missing')
            with self.assertRaises(ValueError): plan.read_plan(output)


if __name__ == '__main__': unittest.main()
