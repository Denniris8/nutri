import unittest
from unittest.mock import patch

from ssh_control import get_ssh_status, set_ssh


class SSHControlTest(unittest.TestCase):
    @patch("ssh_control.subprocess.run")
    def test_status_reports_active_state(self, run):
        run.return_value.returncode = 0
        self.assertEqual(get_ssh_status(), "on")
        run.assert_called_once_with(["systemctl", "is-active", "--quiet", "ssh.service"], timeout=5)

    @patch("ssh_control.subprocess.run")
    def test_status_reports_inactive_state(self, run):
        run.return_value.returncode = 3
        self.assertEqual(get_ssh_status(), "off")

    @patch("ssh_control.subprocess.run")
    def test_set_ssh_only_controls_ssh_service(self, run):
        run.return_value.returncode = 0
        set_ssh("off")
        run.assert_called_once_with(["systemctl", "stop", "ssh.service"], check=True, timeout=15)

    def test_rejects_anything_except_on_or_off(self):
        with self.assertRaises(ValueError):
            set_ssh("restart")


if __name__ == "__main__":
    unittest.main()
