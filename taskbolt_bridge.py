#!/usr/bin/env python3
"""
TaskBolt Bridge — connects the Tauri GUI to the AI engine via DashScope API.

Protocol:
  stdin:  JSON lines from the Rust frontend
  stdout: "RESPONSE: <content>" for agent replies
          "STATUS: <content>" for status updates
          "ERROR: <content>" for errors

This runs as a subprocess managed by the Tauri Rust backend.
Uses DashScope Qwen API directly — no external agent dependency.
"""

import sys
import os
import json
import argparse
import asyncio
import subprocess
import platform
from pathlib import Path
try:
    from urllib.request import Request, urlopen
    from urllib.error import URLError
except ImportError:
    pass

# Configuration
API_BASE = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
DEFAULT_MODEL = "qwen3.6-plus"
API_KEY = os.environ.get("DASHSCOPE_API_KEY", "sk-8085275f314e41159a746b04f3fe5b7c")

ENGINE_DIR = Path(__file__).parent


class TaskBoltBridge:
    """Bidirectional bridge between Tauri GUI and AI engine via DashScope API."""

    def __init__(self, taskbolt_dir: Path):
        self.taskbolt_dir = taskbolt_dir
        self.config_dir = taskbolt_dir / "config"
        self.data_dir = taskbolt_dir / "data"
        self.sessions_dir = taskbolt_dir / "sessions"
        self.skills_dir = taskbolt_dir / "skills"
        self.config_dir.mkdir(parents=True, exist_ok=True)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        self.skills_dir.mkdir(parents=True, exist_ok=True)
        self.conversation_history = []
        self.model = DEFAULT_MODEL
        self.api_key = API_KEY
        self.system_prompt = self._build_system_prompt()

    def _build_system_prompt(self):
        """Build the system prompt with TaskBolt capabilities."""
        os_info = f"{platform.system()} {platform.release()} ({platform.machine()})"
        return f"""You are TaskBolt, an intelligent AI assistant that sets up, configures, and fixes computers.

## Your Capabilities:
- **Setup**: Install and configure software, drivers, and development tools
- **Fix**: Diagnose and repair system issues, errors, and misconfigurations
- **Optimize**: Clean up disk space, improve performance, and update everything
- **Security**: Scan for vulnerabilities and harden system security
- **Network**: Configure WiFi, firewall, proxies, and networking settings
- **Browser**: Browse the web via CLI — fetch pages, scrape data, check URLs
- **MCP**: Connect to external tools via Model Context Protocol
- **Answer**: Any general question with thorough, actionable responses

## Browser Skill:
- You can instruct the user to open URLs in their browser
- You can fetch web content via curl or Python urllib
- For scraping, suggest specific URLs and extract the needed data
- The user's browser is available through the Tauri shell plugin

## System Info:
- OS: {os_info}
- Python: {sys.version}
- TaskBolt Data: {self.taskbolt_dir}

## Rules:
- Be direct, practical, and actionable
- Provide exact commands the user can copy-paste
- For Windows, prefer PowerShell and native tools
- Explain what you're doing and why
- If a command needs admin privileges, say so
- Always confirm before destructive operations
- Keep responses concise but complete"""

    def log_status(self, msg: str):
        print(f"STATUS: {msg}", flush=True)

    def log_error(self, msg: str):
        print(f"ERROR: {msg}", flush=True)

    def send_response(self, content: str, thinking: str = ""):
        if thinking:
            safe_thinking = thinking.replace("\n", "\\n")
            safe_content = content.replace("\n", "\\n")
            print(f"RESPONSE: {safe_thinking}===RESPONSE==={safe_content}", flush=True)
        else:
            safe = content.replace("\n", "\\n")
            print(f"RESPONSE: {safe}", flush=True)

    def auto_configure(self):
        """Zero-config: detect environment and set up defaults."""
        self.log_status("Auto-configuring TaskBolt...")

        config_file = self.config_dir / "config.json"
        if config_file.exists():
            try:
                cfg = json.loads(config_file.read_text())
                self.model = cfg.get("model", DEFAULT_MODEL)
                self.api_key = cfg.get("api_key", API_KEY)
                self.log_status(f"Config loaded — model: {self.model}")
                return
            except Exception:
                pass

        # Create default config
        default_config = {
            "model": DEFAULT_MODEL,
            "api_key": self.api_key,
            "provider": "dashscope",
            "api_base": API_BASE,
            "taskbolt": {
                "auto_setup": True,
                "gui_mode": True,
            },
        }
        config_file.write_text(json.dumps(default_config, indent=2))
        self.log_status("Default config created — ready to chat")

    def call_dashscope_api(self, messages: list) -> tuple:
        """Call DashScope Qwen API with deep thinking enabled.
        Returns (thinking, response) tuple."""
        import urllib.request
        import urllib.error

        url = f"{API_BASE}/chat/completions"
        payload = {
            "model": self.model,
            "messages": messages,
            "stream": False,
            "extra_body": {"enable_thinking": True},
        }

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        req = Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )

        try:
            with urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read().decode("utf-8"))

            choice = data["choices"][0]["message"]
            thinking = ""
            content = choice.get("content", "")

            # Extract reasoning/thinking if available
            if hasattr(choice, "reasoning_content") and choice.get("reasoning_content"):
                thinking = choice["reasoning_content"]
            elif "reasoning_content" in choice:
                thinking = choice["reasoning_content"]

            return thinking, content

        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            raise Exception(f"API error {e.code}: {body[:200]}")
        except urllib.error.URLError as e:
            raise Exception(f"Connection error: {e.reason}")
        except Exception as e:
            raise Exception(f"API call failed: {e}")

    def execute_command(self, cmd: str) -> str:
        """Execute a system command and return output."""
        try:
            result = subprocess.run(
                cmd, shell=True, capture_output=True, text=True, timeout=60
            )
            output = result.stdout or result.stderr or "(no output)"
            return f"Exit code: {result.returncode}\n{output[:2000]}"
        except subprocess.TimeoutExpired:
            return "Command timed out (60s)"
        except Exception as e:
            return f"Execution error: {e}"

    async def handle_message(self, content: str):
        """Route a user message through the AI engine."""
        try:
            # Add user message to history
            self.conversation_history.append({"role": "user", "content": content})

            # Build messages with system prompt
            messages = [{"role": "system", "content": self.system_prompt}] + self.conversation_history[-20:]

            self.log_status("Thinking...")

            # Call DashScope API
            thinking, response = self.call_dashscope_api(messages)

            # Add assistant response to history
            self.conversation_history.append({"role": "assistant", "content": response})

            # Save conversation
            self._save_conversation()

            self.send_response(response, thinking)

        except Exception as e:
            self.log_error(f"Message handling failed: {e}")
            self.send_response(f"I ran into an issue: {e}. Please try again.")

    def _save_conversation(self):
        """Persist conversation to disk."""
        try:
            session_file = self.sessions_dir / f"session_{self.taskbolt_dir.stem}.json"
            session_file.write_text(json.dumps(self.conversation_history[-50:], indent=2))
        except Exception:
            pass

    async def handle_telegram_connect(self, bot_token: str):
        """Handle Telegram bot connection request."""
        self.log_status(f"Connecting Telegram bot...")
        try:
            # Validate bot token by calling getMe
            url = f"https://api.telegram.org/bot{bot_token}/getMe"
            req = Request(url, method="GET")
            with urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            if data.get("ok"):
                bot_info = data["result"]
                self.log_status(f"Connected to @{bot_info['username']}")
                # Save bot token
                config_file = self.config_dir / "config.json"
                cfg = {}
                if config_file.exists():
                    cfg = json.loads(config_file.read_text())
                cfg["telegram_bot_token"] = bot_token
                config_file.write_text(json.dumps(cfg, indent=2))
                self.send_response(f"✅ Connected to @{bot_info['username']}. Your Telegram bot is now linked to TaskBolt.")
            else:
                self.send_response("❌ Invalid bot token. Telegram returned an error.")
        except Exception as e:
            self.send_response(f"❌ Failed to connect: {e}")

    async def run(self):
        """Main loop: read JSON lines from stdin, process, write to stdout."""
        self.auto_configure()
        self.log_status("Bridge listening...")

        # Use thread-based stdin reader — works on all platforms including Windows
        queue = asyncio.Queue()

        def stdin_reader():
            """Read lines from stdin in a background thread."""
            try:
                for line in sys.stdin:
                    line = line.strip()
                    if line:
                        asyncio.run_coroutine_threadsafe(queue.put(line), loop)
            except Exception:
                pass
            finally:
                asyncio.run_coroutine_threadsafe(queue.put(None), loop)

        loop = asyncio.get_event_loop()
        import threading
        threading.Thread(target=stdin_reader, daemon=True).start()

        while True:
            try:
                line = await queue.get()
                if line is None:
                    break

                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    self.log_error(f"Invalid JSON: {line[:100]}")
                    continue

                msg_type = msg.get("type", "")
                if msg_type == "message":
                    content = msg.get("content", "")
                    await self.handle_message(content)
                elif msg_type == "command":
                    action = msg.get("action", "")
                    if action == "connect_telegram":
                        await self.handle_telegram_connect(msg.get("bot_token", ""))
                    elif action == "execute":
                        result = self.execute_command(msg.get("cmd", ""))
                        self.send_response(result)
                    else:
                        self.log_error(f"Unknown action: {action}")
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

    # Fix Windows Python 3.8+ asyncio proactor bug with piped stdin
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    bridge = TaskBoltBridge(args.taskbolt_dir)
    asyncio.run(bridge.run())


if __name__ == "__main__":
    main()
