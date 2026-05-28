#!/usr/bin/env python3
"""
TaskBolt Agent Engine — Lightweight Hermes-style agent
Runs locally, calls Vercel for AI, executes tools on user's machine.
All data stays local. Communicates with Tauri via stdin/stdout JSON.
"""

import sys
import json
import os
import subprocess
import platform
import shutil
import re
import time
import signal
from pathlib import Path
from typing import Optional

# ── Local storage ──────────────────────────────────────
DATA_DIR = Path.home() / ".taskbolt"
MEMORY_DIR = DATA_DIR / "memory"
MEMORY_DIR.mkdir(parents=True, exist_ok=True)
CONVERSATIONS_FILE = DATA_DIR / "conversations.json"

# ── Vercel API (auth required, key stays on server) ───
VERCEL_API = os.environ.get("TASKBOLT_API", "https://taskbolt-saas.vercel.app/api/ai/agent")
AUTH_TOKEN = os.environ.get("TASKBOLT_TOKEN", "")

# ── System prompt ──────────────────────────────────────
SYSTEM_PROMPT = """You are TaskBolt, an intelligent AI assistant that sets up, configures, and manages the user's computer. You have FULL access to their system through tools.

RULES:
- Always use tools to take action — don't just describe what to do
- Be direct and practical
- Explain what you're doing and why
- For Windows, prefer PowerShell commands
- Read system info before making changes
- Keep memory of what you've done for the user
- If something fails, try alternative approaches

PERSONALITY:
- Friendly but professional
- Proactive — anticipate what the user needs next
- Concise — don't over-explain obvious things
"""

# ── Tool Definitions ───────────────────────────────────
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "run_command",
            "description": "Execute a shell command (PowerShell on Windows, bash on Linux/Mac). Use for installing software, running scripts, system configuration.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "The command to execute"},
                    "timeout": {"type": "integer", "description": "Timeout in seconds (default: 120)", "default": 120},
                    "workdir": {"type": "string", "description": "Working directory (optional)"}
                },
                "required": ["command"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read the contents of a file from the user's machine.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute or relative file path"}
                },
                "required": ["path"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Write content to a file on the user's machine. Creates parent directories if needed.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path"},
                    "content": {"type": "string", "description": "File content to write"}
                },
                "required": ["path", "content"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "search_files",
            "description": "Search for files by name pattern or search file contents. Uses ripgrep/grep.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Search pattern (regex for content, glob for filenames)"},
                    "path": {"type": "string", "description": "Directory to search in (default: current dir)"},
                    "target": {"type": "string", "enum": ["content", "files"], "description": "Search inside files ('content') or find files by name ('files')"}
                },
                "required": ["pattern"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_system_info",
            "description": "Get information about the user's system: OS, hostname, installed software, disk space, etc.",
            "parameters": {
                "type": "object",
                "properties": {},
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "install_software",
            "description": "Install software using the system package manager (winget on Windows, brew on Mac, apt on Linux).",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Software name or package ID"},
                    "method": {"type": "string", "enum": ["winget", "choco", "brew", "apt", "pip", "npm"], "description": "Installation method (auto-detected if omitted)"}
                },
                "required": ["name"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "save_memory",
            "description": "Save a piece of information to persistent memory. Use this to remember user preferences, system details, past actions, etc.",
            "parameters": {
                "type": "object",
                "properties": {
                    "key": {"type": "string", "description": "Memory key (e.g., 'user_preferences', 'installed_software')"},
                    "value": {"type": "string", "description": "The information to remember"}
                },
                "required": ["key", "value"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "recall_memory",
            "description": "Recall information previously saved to memory.",
            "parameters": {
                "type": "object",
                "properties": {
                    "key": {"type": "string", "description": "Memory key to recall. Omit to see all keys."}
                },
                "required": []
            }
        }
    },
]


# ── Tool Execution ─────────────────────────────────────

def execute_tool(name: str, arguments: dict) -> str:
    """Execute a tool and return the result."""
    try:
        if name == "run_command":
            return tool_run_command(
                arguments["command"],
                arguments.get("timeout", 120),
                arguments.get("workdir")
            )
        elif name == "read_file":
            return tool_read_file(arguments["path"])
        elif name == "write_file":
            return tool_write_file(arguments["path"], arguments["content"])
        elif name == "search_files":
            return tool_search_files(
                arguments["pattern"],
                arguments.get("path", "."),
                arguments.get("target", "content")
            )
        elif name == "get_system_info":
            return tool_get_system_info()
        elif name == "install_software":
            return tool_install_software(arguments["name"], arguments.get("method"))
        elif name == "save_memory":
            return tool_save_memory(arguments["key"], arguments["value"])
        elif name == "recall_memory":
            return tool_recall_memory(arguments.get("key"))
        else:
            return json.dumps({"error": f"Unknown tool: {name}"})
    except Exception as e:
        return json.dumps({"error": str(e)})


def tool_run_command(command: str, timeout: int = 120, workdir: str = None) -> str:
    """Execute a shell command."""
    is_windows = platform.system() == "Windows"
    
    if is_windows:
        # Use PowerShell on Windows
        shell = ["powershell", "-NoProfile", "-Command", command]
    else:
        shell = ["bash", "-c", command]
    
    try:
        result = subprocess.run(
            shell,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=workdir,
            encoding="utf-8",
            errors="replace"
        )
        output = result.stdout or ""
        if result.stderr:
            output += f"\n[STDERR]\n{result.stderr}"
        if result.returncode != 0:
            output += f"\n[EXIT CODE: {result.returncode}]"
        return output.strip() or "(no output)"
    except subprocess.TimeoutExpired:
        return f"Command timed out after {timeout}s"
    except Exception as e:
        return f"Error: {e}"


def tool_read_file(path: str) -> str:
    """Read a file."""
    p = Path(path).expanduser()
    if not p.exists():
        return f"File not found: {path}"
    if p.stat().st_size > 100_000:
        return f"File too large ({p.stat().st_size} bytes). Use search_files for large files."
    try:
        content = p.read_text(encoding="utf-8", errors="replace")
        # Add line numbers
        lines = content.split('\n')
        numbered = [f"{i+1}|{line}" for i, line in enumerate(lines)]
        return '\n'.join(numbered[:500])  # Limit to 500 lines
    except Exception as e:
        return f"Error reading file: {e}"


def tool_write_file(path: str, content: str) -> str:
    """Write to a file."""
    p = Path(path).expanduser()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return f"Written {len(content)} bytes to {p}"


def tool_search_files(pattern: str, path: str = ".", target: str = "content") -> str:
    """Search files."""
    p = Path(path).expanduser()
    
    if target == "files":
        # Find files by name
        results = []
        for f in p.rglob(pattern):
            results.append(str(f))
            if len(results) >= 50:
                break
        return '\n'.join(results) if results else "No files found"
    else:
        # Search content with grep/rg
        is_windows = platform.system() == "Windows"
        if is_windows:
            cmd = f'findstr /S /I /N "{pattern}" *.*'
        else:
            # Try ripgrep first, fall back to grep
            if shutil.which("rg"):
                cmd = f'rg -n "{pattern}" "{path}"'
            else:
                cmd = f'grep -rn "{pattern}" "{path}"'
        
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30)
        output = result.stdout.strip()
        if not output:
            return "No matches found"
        lines = output.split('\n')[:50]
        return '\n'.join(lines)


def tool_get_system_info() -> str:
    """Get system information."""
    info = {
        "os": platform.system(),
        "os_version": platform.version(),
        "architecture": platform.machine(),
        "processor": platform.processor(),
        "hostname": platform.node(),
        "python": sys.version.split()[0],
        "home": str(Path.home()),
        "cwd": os.getcwd(),
    }
    
    # Disk space
    try:
        if platform.system() == "Windows":
            result = subprocess.run(
                ["powershell", "-Command", "Get-PSDrive -PSProvider FileSystem | Select-Object Name,Used,Free | Format-Table -AutoSize"],
                capture_output=True, text=True, timeout=10
            )
            info["disk"] = result.stdout.strip()
        else:
            result = subprocess.run(["df", "-h"], capture_output=True, text=True, timeout=10)
            info["disk"] = result.stdout.strip()
    except:
        pass
    
    # Installed package managers
    pkg_mgrs = []
    for cmd in ["winget", "choco", "brew", "apt", "pip", "npm", "cargo"]:
        if shutil.which(cmd):
            pkg_mgrs.append(cmd)
    info["package_managers"] = pkg_mgrs
    
    return json.dumps(info, indent=2)


def tool_install_software(name: str, method: str = None) -> str:
    """Install software."""
    if not method:
        # Auto-detect
        if platform.system() == "Windows":
            method = "winget" if shutil.which("winget") else "choco"
        elif platform.system() == "Darwin":
            method = "brew"
        else:
            method = "apt"
    
    commands = {
        "winget": f"winget install --accept-package-agreements --accept-source-agreements {name}",
        "choco": f"choco install {name} -y",
        "brew": f"brew install {name}",
        "apt": f"sudo apt install {name} -y",
        "pip": f"pip install {name}",
        "npm": f"npm install -g {name}",
    }
    
    cmd = commands.get(method)
    if not cmd:
        return f"Unknown installation method: {method}"
    
    return tool_run_command(cmd, timeout=300)


def tool_save_memory(key: str, value: str) -> str:
    """Save to persistent memory."""
    mem_file = MEMORY_DIR / f"{key}.json"
    data = {"key": key, "value": value, "saved_at": time.time()}
    mem_file.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return f"Saved to memory: {key}"


def tool_recall_memory(key: str = None) -> str:
    """Recall from persistent memory."""
    if key:
        mem_file = MEMORY_DIR / f"{key}.json"
        if mem_file.exists():
            return mem_file.read_text(encoding="utf-8")
        return f"No memory found for key: {key}"
    else:
        # List all memory keys
        keys = [f.stem for f in MEMORY_DIR.glob("*.json")]
        return json.dumps({"available_keys": keys})


# ── Agent Loop ─────────────────────────────────────────

def load_conversation(thread_id: str) -> list:
    """Load conversation history."""
    if CONVERSATIONS_FILE.exists():
        try:
            data = json.loads(CONVERSATIONS_FILE.read_text(encoding="utf-8"))
            return data.get(thread_id, [])
        except:
            pass
    return []


def save_conversation(thread_id: str, messages: list):
    """Save conversation history."""
    data = {}
    if CONVERSATIONS_FILE.exists():
        try:
            data = json.loads(CONVERSATIONS_FILE.read_text(encoding="utf-8"))
        except:
            pass
    # Keep last 100 messages per thread
    data[thread_id] = messages[-100:]
    CONVERSATIONS_FILE.write_text(json.dumps(data), encoding="utf-8")


def agent_loop(user_message: str, thread_id: str, auth_token: str):
    """
    Main agent loop: send to LLM, execute tools, repeat until done.
    Streams responses via stdout to Tauri.
    """
    messages = load_conversation(thread_id)
    messages.append({"role": "user", "content": user_message})
    
    max_iterations = 10  # Prevent infinite loops
    
    for iteration in range(max_iterations):
        # Load memory context
        memory_context = ""
        mem_keys_file = MEMORY_DIR / "_index.json"
        if not mem_keys_file.exists():
            # Build index
            keys = [f.stem for f in MEMORY_DIR.glob("*.json") if f.stem != "_index"]
            if keys:
                memory_context = f"\n\n[Available memory: {', '.join(keys)}]"
        
        # Call Vercel API with tools
        payload = {
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT + memory_context},
                *messages
            ],
            "tools": TOOLS,
            "model": "qwen3.6-flash",
            "stream": False,  # Non-streaming for tool calling
        }
        
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {auth_token}",
        }
        
        try:
            import urllib.request
            req = urllib.request.Request(
                VERCEL_API,
                data=json.dumps(payload).encode("utf-8"),
                headers=headers,
                method="POST"
            )
            
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            emit({"type": "error", "content": f"API error: {e}"})
            return
        
        # Check for tool calls
        choice = data.get("choices", [{}])[0]
        message = choice.get("message", {})
        tool_calls = message.get("tool_calls")
        
        if tool_calls:
            # Add assistant message with tool calls
            messages.append(message)
            
            # Execute each tool
            for tc in tool_calls:
                fn = tc["function"]
                tool_name = fn["name"]
                try:
                    args = json.loads(fn["arguments"])
                except:
                    args = {}
                
                # Emit tool start
                emit({"type": "tool_start", "name": tool_name, "args": args})
                
                # Execute
                result = execute_tool(tool_name, args)
                
                # Emit tool result
                emit({"type": "tool_result", "name": tool_name, "result": result[:2000]})
                
                # Add tool result to messages
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": result[:4000]  # Truncate for context
                })
            
            # Continue loop to let AI process results
            continue
        else:
            # Final response — no more tool calls
            content = message.get("content", "")
            thinking = message.get("reasoning_content", "")
            
            if thinking:
                emit({"type": "thinking", "content": thinking})
            
            emit({"type": "content", "content": content})
            messages.append({"role": "assistant", "content": content})
            save_conversation(thread_id, messages)
            emit({"type": "done"})
            return
    
    # Max iterations reached
    emit({"type": "content", "content": "I've reached the maximum number of tool calls. Here's what I've done so far."})
    save_conversation(thread_id, messages)
    emit({"type": "done"})


def emit(data: dict):
    """Send JSON message to Tauri via stdout."""
    print(json.dumps(data), flush=True)


# ── Main ───────────────────────────────────────────────

def main():
    """Read JSON commands from stdin, process, emit results to stdout."""
    emit({"type": "status", "content": "TaskBolt Agent Engine ready"})
    
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        
        try:
            cmd = json.loads(line)
        except:
            continue
        
        action = cmd.get("action")
        
        if action == "chat":
            user_message = cmd.get("message", "")
            thread_id = cmd.get("thread_id", "default")
            auth_token = cmd.get("auth_token", AUTH_TOKEN)
            
            if not user_message:
                emit({"type": "error", "content": "Empty message"})
                continue
            
            agent_loop(user_message, thread_id, auth_token)
        
        elif action == "stop":
            emit({"type": "status", "content": "Stopping..."})
            break
        
        elif action == "ping":
            emit({"type": "pong"})


if __name__ == "__main__":
    main()
