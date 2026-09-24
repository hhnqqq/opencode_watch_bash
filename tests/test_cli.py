import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def owatch(*args):
    return subprocess.run(
        [sys.executable, "-m", "opencode_watch_bash.cli", *args],
        capture_output=True,
        text=True,
        cwd=ROOT,
        timeout=60,
    )


class WatchBashTests(unittest.TestCase):
    def test_success(self):
        r = owatch("echo hello")
        self.assertEqual(r.returncode, 0)
        self.assertIn("│ hello", r.stdout)
        self.assertIn("done (exit code 0)", r.stdout)

    def test_failure(self):
        r = owatch("exit 3")
        self.assertEqual(r.returncode, 3)
        self.assertIn("failed (exit code 3)", r.stdout)

    def test_timeout(self):
        r = owatch("-t", "1", "sleep 30")
        self.assertEqual(r.returncode, 124)
        self.assertIn("timeout", r.stdout)

    def test_no_stream_tail(self):
        r = owatch(
            "--no-stream",
            "--tail",
            "2",
            "for i in 1 2 3 4 5 6 7 8 9 10; do printf 'out-%02d\\n' $i; done",
        )
        self.assertEqual(r.returncode, 0)
        self.assertIn("out-09", r.stdout)
        self.assertIn("out-10", r.stdout)
        self.assertNotIn("out-01", r.stdout)

    def test_log(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "out.log")
            r = owatch("--log", path, "echo logged-line")
            self.assertEqual(r.returncode, 0)
            with open(path) as f:
                self.assertIn("logged-line", f.read())

    def test_dash_dash(self):
        r = owatch("--", "echo", "dashed")
        self.assertEqual(r.returncode, 0)
        self.assertIn("dashed", r.stdout)

    def test_title(self):
        r = owatch("--title", "my-title", "echo hi")
        self.assertEqual(r.returncode, 0)
        self.assertIn("Watch: my-title", r.stdout)


if __name__ == "__main__":
    unittest.main()
