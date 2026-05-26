#!/usr/bin/env python3
"""
TaskBolt Bridge — connects the Tauri GUI to the hermes-agent Python engine.

Protocol:
  stdin:  JSON lines from the Rust frontend
  stdout: "RESPONSE: <content>" for agent replies
          "STATUS: <content>" for status updates  
          "ERROR: <content>" for errors

This runs as a subprocess managed by the Tauri Rust backend.
"""

import sys
import os
import json
import argparse
import asyncio
from pathlib import Path

# Add hermes-engine to path so we can import the agent
ENGINE_DIR = Path(__file__).parent
sys.path.insert(0, str(ENGINE_DIR))


class TaskBoltBridge:
    """Bidirectional bridge between Tauri GUI and hermes-agent engine."""

    def __init__(self, taskbolt_dir: Path):
        self.taskbolt_dir = taskbolt_dir
        self.config_dir = taskbolt_dir / "config"
        self.data_dir = taskbolt_dir / "data"
        self.sessions_dir = taskbolt_dir / "sessions"
        self.config_dir.mkdir(parents=True, exist_ok=True)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        self.agent = None

    def log_status(self, msg: str):
        print(f"STATUS: {msg}", flush=True)

    def log_error(self, msg: str):
        print(f"ERROR: {msg}", flush=True)

    def send_response(self, content: str):
        # Escape newlines to keep protocol simple (one line per message)
        safe = content.replace("\n", "\\n")
        print(f"RESPONSE: {safe}", flush=True)

    def auto_configure(self):
        """Zero-config: detect environment and set up defaults."""
        self.log_status("Auto-configuring TaskBolt...")

        # Check for existing .env in hermes-engine
        env_file = ENGINE_DIR / ".env"
        config_file = self.config_dir / "config.yaml"

        if config_file.exists():
            self.log_status("Existing config found — loading")
            return

        # Create default config
        default_config = {
            "provider": "alibaba",
            "model": "qwen3.6-max-preview",
            "api_base": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
            "terminal_backend": "local",
            "auto_approve_safe": True,
            "taskbolt": {
                "auto_setup": True,
                "gui_mode": True,
                "approval_ui": "gui",
            },
        }

        # Write as YAML if pyyaml available, else JSON fallback
        try:
            import yaml
            config_file.write_text(yaml.dump(default_config, default_flow_style=False))
        except ImportError:
            config_file.with_suffix(".json").write_text(json.dumps(default_config, indent=2))

        self.log_status("Default config created — ready to chat")

    def init_agent(self):
        """Initialize the hermes-agent engine for GUI-mode usage."""
        self.log_status("Initializing TaskBolt engine...")

        try:
            # Set environment for GUI mode
            os.environ["HERMES_HOME"] = str(self.taskbolt_dir)
            os.environ["TASKBOLT_GUI_MODE"] = "1"

            # Try to import and initialize the agent
            # The hermes-agent engine exposes a programmatic API
            # We create a lightweight wrapper that handles the agent loop
            from agent.agent_init import init_agent_runtime
            
            self.agent = init_agent_runtime(
                config_dir=str(self.config_dir),
                data_dir=str(self.data_dir),
                gui_mode=True,
            )
            self.log_status("Engine initialized — TaskBolt is ready")

        except ImportError:
            # Fallback: use subprocess-based agent invocation
            self.log_status("Using subprocess mode for engine")
            self.agent = "subprocess"
        except Exception as e:
            self.log_error(f"Engine init error: {e}")
            self.agent = "subprocess"

    async def handle_message(self, content: str):
        """Route a user message through the agent engine."""
        if self.agent is None:
            self.init_agent()

        try:
            if self.agent == "subprocess":
                # Fallback: invoke hermes CLI as subprocess
                result = await self._subprocess_agent(content)
                self.send_response(result)
            else:
                # Direct API call to the agent
                response = await self._direct_agent_call(content)
                self.send_response(response)
        except Exception as e:
            self.log_error(f"Message handling failed: {e}")
            self.send_response(f"Error: {e}")

    async def _subprocess_agent(self, content: str) -> str:
        """Invoke hermes-agent via subprocess (fallback mode)."""
        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m", "hermes_cli",
            "--quiet",
            "--goal", content,
            cwd=str(ENGINE_DIR),
            env={**os.environ, "HERMES_HOME": str(self.taskbolt_dir)},
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode != 0:
            return f"Agent error: {stderr.decode('utf-8', errors='replace')}"
        return stdout.decode("utf-8", errors="replace").strip()

    async def _direct_agent_call(self, content: str) -> str:
        """Call the agent directly via its programmatic API."""
        # This delegates to the hermes-agent's internal run loop
        # The agent handles: tool calls, terminal execution, web search, etc.
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None,
            lambda: self.agent.run_goal(content),
        )

    async def run(self):
        """Main loop: read JSON lines from stdin, process, write to stdout."""
        self.auto_configure()

        self.log_status("Bridge listening...")
        reader = asyncio.StreamReader()
        protocol = asyncio.StreamReaderProtocol(reader)
        await asyncio.get_event_loop().connect_read_pipe(
            lambda: protocol, sys.stdin.buffer
        )

        while True:
            try:
                line = await reader.readline()
                if not line:
                    break
                line = line.decode("utf-8", errors="replace").strip()
                if not line:
                    continue

                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    self.log_error(f"Invalid JSON: {line[:100]}")
                    continue

                msg_type = msg.get("type", "")
                if msg_type == "message":
                    content = msg.get("content", "")
                    await self.handle_message(content)
                elif msg_type == "ping":
                    self.send_response("pong")
                else:
                    self.log_error(f"Unknown message type: {msg_type}")

            except Exception as e:
                self.log_error(f"Bridge error: {e}")


def main():
    parser = argparse.ArgumentParser(description="TaskBolt Python Bridge")
    parser.add_argument(
        "--taskbolt-dir",
        type=Path,
        default=Path.home() / ".taskbolt",
        help="TaskBolt data directory",
    )
    args = parser.parse_args()

    bridge = TaskBoltBridge(args.taskbolt_dir)
    asyncio.run(bridge.run())


if __name__ == "__main__":
    main()
