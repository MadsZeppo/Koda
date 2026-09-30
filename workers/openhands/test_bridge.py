import json
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


BRIDGE = Path(__file__).with_name("bridge.py")


class MockHandler(BaseHTTPRequestHandler):
    calls = []
    source_path = "src/budget.ts"
    test_path = "tests/budget.test.ts"
    query = "attemptBudget"

    def log_message(self, *_args):
        pass

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length))
        MockHandler.calls.append(body)
        names = {tool["function"]["name"] for tool in body.get("tools", [])}
        forbidden = {name for name in names if "write" in name or "edit" in name or "terminal" in name}
        if forbidden:
            self.send_error(500, f"mutation tools exposed: {forbidden}")
            return
        number = len(MockHandler.calls)
        if number == 1:
            name = "koda_search_repository"
            arguments = {"query": MockHandler.query, "glob": "**/*.ts", "limit": 20}
        elif number == 2:
            name = "koda_read_repository_file"
            arguments = {"path": MockHandler.source_path, "start_line": 1, "end_line": 80}
        elif number == 3:
            name = "koda_submit_repository_exploration"
            arguments = {
                "confidence": "high",
                "editable_candidates": [{"path": MockHandler.source_path, "reason": "Defines the attempt budget"}],
                "readonly_files": [],
                "related_tests": [MockHandler.test_path],
                "dependencies": [],
                "evidence": [{"path": MockHandler.source_path, "detail": "Read the budget policy implementation"}],
                "unresolved_questions": [],
            }
        else:
            name = "finish"
            arguments = {"message": "Exploration submitted."}
        payload = {
            "id": f"mock-{number}",
            "object": "chat.completion",
            "created": 1,
            "model": "mock",
            "choices": [{
                "index": 0,
                "finish_reason": "tool_calls",
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{
                        "id": f"call-{number}",
                        "type": "function",
                        "function": {"name": name, "arguments": json.dumps(arguments)},
                    }],
                },
            }],
            "usage": {"prompt_tokens": 50, "completion_tokens": 20, "total_tokens": 70},
        }
        encoded = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


class BridgeTest(unittest.TestCase):
    def test_real_sdk_agent_navigates_with_read_only_tools(self):
        MockHandler.calls = []
        MockHandler.source_path = "src/budget.ts"
        MockHandler.test_path = "tests/budget.test.ts"
        MockHandler.query = "attemptBudget"
        server = ThreadingHTTPServer(("127.0.0.1", 0), MockHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as scratch:
                repo = Path(root)
                (repo / "src").mkdir()
                (repo / "tests").mkdir()
                source = "export const attemptBudget = 8192;\n"
                (repo / "src/budget.ts").write_text(source)
                (repo / "tests/budget.test.ts").write_text("import '../src/budget.js';\n")
                request = Path(scratch) / "request.json"
                report = Path(scratch) / "report.json"
                request.write_text(json.dumps({
                    "repo_path": str(repo),
                    "task": "Find the code that controls coding-attempt token budgets and its tests.",
                    "llm_model": "openai/mock",
                    "base_url": f"http://127.0.0.1:{server.server_port}/v1",
                    "budget_usd": 1,
                    "max_tokens": 4000,
                    "max_input_tokens": 20000,
                    "max_output_tokens": 500,
                    "max_iterations": 6,
                    "max_files_read": 12,
                    "request_timeout_ms": 5000,
                    "input_cost_per_token": 0,
                    "output_cost_per_token": 0,
                }))
                completed = subprocess.run(
                    [str(Path(__import__("sys").executable)), str(BRIDGE), str(request), str(report)],
                    env={**__import__("os").environ, "KODA_EXPLORER_API_KEY": "local", "OPENHANDS_SUPPRESS_BANNER": "1"},
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                data = json.loads(report.read_text())
                self.assertEqual(completed.returncode, 0, completed.stderr + json.dumps(data))
                self.assertEqual(data["status"], "completed")
                self.assertEqual(data["result"]["editable_candidates"][0]["path"], "src/budget.ts")
                self.assertEqual(data["result"]["related_tests"], ["tests/budget.test.ts"])
                self.assertGreaterEqual(data["tool_calls"], 3)
                self.assertEqual((repo / "src/budget.ts").read_text(), source)
                self.assertGreaterEqual(len(MockHandler.calls), 3)
        finally:
            server.shutdown()
            server.server_close()

    def test_real_sdk_explores_koda_itself_without_modifying_it(self):
        MockHandler.calls = []
        MockHandler.source_path = "src/agent/attemptPolicy.ts"
        MockHandler.test_path = "tests/attemptPolicy.test.ts"
        MockHandler.query = "attemptLimitPolicy"
        server = ThreadingHTTPServer(("127.0.0.1", 0), MockHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            repo = BRIDGE.parents[2]
            before = (repo / MockHandler.source_path).read_bytes()
            with tempfile.TemporaryDirectory() as scratch:
                request = Path(scratch) / "request.json"
                report = Path(scratch) / "report.json"
                request.write_text(json.dumps({
                    "repo_path": str(repo),
                    "task": "Find the code responsible for determining the per-attempt token budget for a coding worker and identify the most relevant tests. Do not modify anything.",
                    "llm_model": "openai/mock",
                    "base_url": f"http://127.0.0.1:{server.server_port}/v1",
                    "budget_usd": 1,
                    "max_tokens": 4000,
                    "max_input_tokens": 20000,
                    "max_output_tokens": 500,
                    "max_iterations": 6,
                    "max_files_read": 12,
                    "request_timeout_ms": 5000,
                    "input_cost_per_token": 0,
                    "output_cost_per_token": 0,
                }))
                completed = subprocess.run(
                    [str(Path(__import__("sys").executable)), str(BRIDGE), str(request), str(report)],
                    env={**__import__("os").environ, "KODA_EXPLORER_API_KEY": "local", "OPENHANDS_SUPPRESS_BANNER": "1"},
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                data = json.loads(report.read_text())
                self.assertEqual(completed.returncode, 0, completed.stderr + json.dumps(data))
                self.assertEqual(data["result"]["editable_candidates"][0]["path"], MockHandler.source_path)
                self.assertEqual(data["result"]["related_tests"], [MockHandler.test_path])
                self.assertGreaterEqual(data["tool_calls"], 3)
                self.assertEqual((repo / MockHandler.source_path).read_bytes(), before)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
