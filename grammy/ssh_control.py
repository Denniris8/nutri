#!/usr/bin/env python3
import hmac
import json
import os
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer


def get_ssh_status():
    result = subprocess.run(["systemctl", "is-active", "--quiet", "ssh.service"], timeout=5)
    return "on" if result.returncode == 0 else "off"


def set_ssh(state):
    if state not in ("on", "off"):
        raise ValueError("invalid state")
    subprocess.run(["systemctl", "start" if state == "on" else "stop", "ssh.service"], check=True, timeout=15)


class Handler(BaseHTTPRequestHandler):
    def _reply(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self):
        expected = f"Bearer {os.environ.get('SSH_CONTROL_TOKEN', '')}"
        return len(expected) > 7 and hmac.compare_digest(self.headers.get("Authorization", ""), expected)

    def do_GET(self):
        if self.path != "/ssh" or not self._authorized():
            return self._reply(404 if self.path != "/ssh" else 401, {"error": "not authorized"})
        try:
            self._reply(200, {"state": get_ssh_status()})
        except Exception as error:
            self._reply(500, {"error": str(error)})

    def do_POST(self):
        state = self.path.removeprefix("/ssh/")
        if state not in ("on", "off"):
            return self._reply(404, {"error": "not found"})
        if not self._authorized():
            return self._reply(401, {"error": "not authorized"})
        try:
            set_ssh(state)
            self._reply(200, {"state": get_ssh_status()})
        except Exception as error:
            self._reply(500, {"error": str(error)})

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 8765), Handler).serve_forever()
