import importlib.util
from pathlib import Path
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

spec = importlib.util.spec_from_file_location("session_check", Path(__file__).parents[1] / "apache-session-check.py")
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class Backend(BaseHTTPRequestHandler):
    active = True
    status = 200
    cookies = []

    def do_GET(self):
        type(self).cookies.append(self.headers.get("Cookie"))
        self.send_response(self.status if self.active else 401)
        self.end_headers()

    def log_message(self, *args):
        pass


class SessionCheckTests(unittest.TestCase):
    def setUp(self):
        Backend.active, Backend.status, Backend.cookies = True, 200, []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Backend)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_port

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_logout_takes_effect_without_cache(self):
        token = "a" * 43
        self.assertEqual(checker.check_session(token, port=self.port), "OK")
        Backend.active = False
        self.assertEqual(checker.check_session(token, port=self.port), "DENY")
        self.assertEqual(Backend.cookies, ["nif_session=" + token] * 2)

    def test_backend_errors_and_redirects_deny(self):
        for status in (301, 401, 403, 404, 500, 503):
            Backend.status = status
            self.assertEqual(checker.check_session("a" * 43, port=self.port), "DENY")

    def test_cookie_injection_and_missing_cookie_never_reach_backend(self):
        for token in ("", "short", "a" * 129, "a" * 43 + "\r\nX-Test: yes", "a" * 42 + ";"):
            self.assertEqual(checker.check_session(token, port=self.port), "DENY")
        self.assertEqual(Backend.cookies, [])

    def test_connection_failure_denies(self):
        self.assertEqual(checker.check_session("a" * 43, port=0), "DENY")

    def test_program_protocol_emits_only_one_result_per_input(self):
        result = subprocess.run([sys.executable, str(Path(checker.__file__))], input="bad\n\n", text=True, capture_output=True, check=True)
        self.assertEqual(result.stdout.splitlines(), ["DENY", "DENY"])
        self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main()
