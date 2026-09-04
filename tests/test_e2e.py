from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from meeting_wiki.cli import main


class ModelHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        request = json.loads(self.rfile.read(length))
        assert request["response_format"]["type"] == "json_schema"
        analysis = {
            "title": "Local Design Review",
            "meeting_type": "generic",
            "summary": ["Selected the local-first design."],
            "participants": [{"name": "Alex"}, {"name": "Sam"}],
            "blockers": ["Model packaging"],
            "decisions": [
                {
                    "title": "Local-first default",
                    "decision": "Use local providers by default",
                    "rationale": "Privacy and zero required accounts",
                    "owner": "Alex",
                }
            ],
            "action_items": [{"owner": "Sam", "action": "Package the local model", "done": False}],
            "topics": [{"topic": "Local-first", "insight": "Cloud providers remain optional"}],
            "open_questions": ["Which model size is the default?"],
            "risks": ["Large model download"],
            "private": False,
        }
        body = json.dumps({"choices": [{"message": {"content": json.dumps(analysis)}}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        return None


def test_cli_ingest_end_to_end_with_local_http_model(tmp_path):
    server = ThreadingHTTPServer(("127.0.0.1", 0), ModelHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        transcript = tmp_path / "meeting.txt"
        transcript.write_text("Alex: We should be local-first.\nSam: Agreed.")
        data_dir = tmp_path / "data"
        config = tmp_path / "config.toml"
        config.write_text(
            f'''data_dir = "{data_dir}"
user_name = "Test User"

[providers]
transcription = "text"
llm = "openai_compatible"
storage = "local"
calendar = "none"
notification = "none"
task = "none"

[openai_compatible]
base_url = "http://127.0.0.1:{server.server_port}/v1"
model = "fake"
api_key_env = ""
timeout_seconds = 10
'''
        )
        exit_code = main(
            [
                "--config",
                str(config),
                "ingest",
                "--transcript",
                str(transcript),
                "--title",
                "Local Design Review",
                "--attendees",
                "Alex,Sam",
                "--occurred-at",
                "2026-09-04T15:00:00Z",
                "--now",
            ]
        )
        assert exit_code == 0
        meetings = [
            path
            for path in (data_dir / "wiki" / "meetings").glob("*.md")
            if path.name != "index.md"
        ]
        assert len(meetings) == 1
        content = meetings[0].read_text()
        assert 'meeting_type: "design-review"' in content
        assert "Local-first default" in content
        assert "Package the local model" in (data_dir / "wiki/action-items/active.md").read_text()
        assert (data_dir / "jobs.db").exists()
    finally:
        server.shutdown()
        thread.join(timeout=5)


def test_status_does_not_construct_secret_dependent_providers(tmp_path, monkeypatch, capsys):
    config = tmp_path / "config.toml"
    config.write_text(
        f'''data_dir = "{tmp_path / "data"}"
[providers]
transcription = "text"
llm = "openai_compatible"
storage = "local"
calendar = "none"
notification = "none"
task = "none"
[openai_compatible]
base_url = "https://models.example/v1"
model = "model"
api_key_env = "MISSING_TEST_KEY"
'''
    )
    monkeypatch.delenv("MISSING_TEST_KEY", raising=False)
    assert main(["--config", str(config), "status"]) == 0
    assert capsys.readouterr().out.strip() == "[]"
