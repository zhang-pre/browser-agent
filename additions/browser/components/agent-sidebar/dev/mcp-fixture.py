#!/usr/bin/env python3
"""Deterministic local MCP fixture for native Firefox transport tests."""
import json
import sys
import time

# MCP stdio is UTF-8, including when Python runs on Windows.
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def respond(message):
    method = message.get("method")
    if "id" not in message:
        return None
    if method == "initialize":
        result = {"protocolVersion": "2025-11-25", "capabilities": {"tools": {}}, "serverInfo": {"name": "native-fixture", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": [{"name": "echo", "description": "Echo a test value", "inputSchema": {"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"]}}]}
    elif method == "tools/call":
        time.sleep(min(5, max(0, message["params"]["arguments"].get("delayMs", 0) / 1000)))
        result = {"content": [{"type": "text", "text": message["params"]["arguments"]["value"]}]}
    else:
        result = {}
    return {"jsonrpc": "2.0", "id": message["id"], "result": result}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        message = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        response = respond(message)
        self.send_response(200 if response else 202)
        self.send_header("Content-Type", "application/json")
        if message.get("method") == "initialize":
            self.send_header("Mcp-Session-Id", "native-test-session")
        self.end_headers()
        if response:
            self.wfile.write(json.dumps(response).encode())

    def do_DELETE(self):
        self.send_response(204)
        self.end_headers()


if "--http" in sys.argv:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    print(server.server_port, flush=True)
    server.serve_forever()
else:
    print("fixture diagnostics on stderr only", file=sys.stderr, flush=True)
    roots_parent = None
    for line in sys.stdin:
        message = json.loads(line)
        if message.get("method") == "tools/call" and message["params"].get("name") == "native_roots":
            roots_parent = message["id"]
            print(json.dumps({"jsonrpc": "2.0", "id": "native-roots", "method": "roots/list"}), flush=True)
            continue
        if message.get("id") == "native-roots" and "method" not in message:
            result = {"jsonrpc": "2.0", "id": roots_parent, "result": {"content": [{"type": "text", "text": json.dumps(message.get("result"))}]}}
        else:
            result = respond(message)
        if result:
            print(json.dumps(result), flush=True)
