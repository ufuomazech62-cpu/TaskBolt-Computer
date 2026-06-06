"""
TaskBolt Engine v2 — Full Agentic Loop
stdin/stdout JSON protocol for Tauri subprocess communication.

Key upgrades over v1:
- Streaming responses via /api/v1/chat/completions
- Context compaction (summarize old messages when context is too large)
- Stall detection (break loops when agent is stuck)
- Force-answer mode (stop tools, force final response)
- Smart memory injection into system prompt
- Better tool execution with progress reporting
"""

import asyncio
import json
import logging
import os
import sys
import uuid
import time
from typing import Optional, List, Dict, Any
from collections import Counter

# Setup logging to stderr (stdout is for JSON protocol)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger("taskbolt.engine")

# Add engine root to path
ENGINE_ROOT = os.path.dirname(os.path.abspath(__file__))
if ENGINE_ROOT not in sys.path:
    sys.path.insert(0, ENGINE_ROOT)

from core import taskbolt_auth as auth
from core import taskbolt_db as db

VERSION = "2.0.0"
MAX_ROUNDS = 15  # Max tool-calling rounds per message
MAX_TOOL_CALLS = 30  # Max total tool executions per message
CONTEXT_TOKEN_LIMIT = 8000  # Approximate token limit for context (conservative)
STUCK_THRESHOLD = 3  # Same tool+args repeated this many times = stuck


def emit(event: dict):
    """Send a JSON event to Tauri via stdout."""
    line = json.dumps(event, ensure_ascii=False)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def emit_stream(text: str, session_id: str):
    emit({"type": "stream_delta", "text": text, "session_id": session_id})


def emit_tool_start(tool: str, args_preview: str, round_num: int, session_id: str):
    emit({"type": "tool_start", "tool": tool, "args": args_preview, "round": round_num, "session_id": session_id})


def emit_tool_output(tool: str, output: str, exit_code: int, session_id: str):
    emit({"type": "tool_output", "tool": tool, "output": output[:3000], "exit_code": exit_code, "session_id": session_id})


def emit_status(text: str, session_id: str):
    emit({"type": "status", "text": text, "session_id": session_id})


def emit_error(message: str):
    emit({"type": "error", "message": message})


def estimate_tokens(text: str) -> int:
    """Rough token estimate: ~4 chars per token for English."""
    return len(text) // 4


# ═══════════════════════════════════════════════════════════════
# AUTH HANDLING
# ═══════════════════════════════════════════════════════════════

async def handle_auth(data: dict):
    """Handle JWT authentication."""
    token = data.get("token", "")
    if not token:
        emit({"type": "auth_fail", "error": "No token provided"})
        return

    auth.set_token(token)
    auth.save_token_to_disk(token)

    user = await auth.validate_token()
    if user:
        emit({"type": "auth_ok", "user": {
            "id": user.get("id"),
            "email": user.get("email"),
            "display_name": user.get("display_name") or user.get("username"),
        }})
    else:
        emit({"type": "auth_fail", "error": "Invalid or expired token"})


# ═══════════════════════════════════════════════════════════════
# SYSTEM PROMPT & MEMORY INJECTION
# ═══════════════════════════════════════════════════════════════

SYSTEM_PROMPT = """You are TaskBolt, a powerful AI assistant running as a desktop application.

## Capabilities
You can execute shell commands, run Python code, read/write files, search the web, manage persistent memories, and create tasks synced to the cloud.

## Guidelines
- Be concise and direct. No unnecessary preamble.
- When executing commands, prefer showing output over describing what you would do.
- Use tools proactively — if the user asks something that requires action, take it.
- For file operations, always use absolute paths when possible.
- When searching the web, synthesize findings into a clear answer.
- Save important user preferences and facts to memory so you remember them across sessions.

## Memory System
You have persistent memory organized by category:
- **profile**: User's name, role, timezone, basic info
- **facts**: Important knowledge, project details, technical specs
- **preferences**: User's likes, dislikes, coding style, communication preferences
- **history**: Events, decisions, past conversations worth remembering

Use `save_memory` to store anything worth remembering. Use `recall_memory` to retrieve.
Before responding, check memory for relevant context about the user.

## Safety
- Never execute destructive commands without confirmation (rm -rf, DROP TABLE, etc.)
- Never access or modify files outside the user's home directory without permission
- Never store passwords, API keys, or secrets in memory
"""


def build_system_message() -> dict:
    """Build the system message with injected memories."""
    parts = [SYSTEM_PROMPT]

    # Inject relevant memories
    try:
        profile_memories = db.get_memories(category="profile", limit=5)
        fact_memories = db.get_memories(category="facts", limit=10)
        pref_memories = db.get_memories(category="preferences", limit=5)

        if profile_memories or fact_memories or pref_memories:
            parts.append("\n\n## About This User (from memory)")

            if profile_memories:
                parts.append("\n**Profile:**")
                for m in profile_memories:
                    parts.append(f"- {m['content']}")

            if pref_memories:
                parts.append("\n**Preferences:**")
                for m in pref_memories:
                    parts.append(f"- {m['content']}")

            if fact_memories:
                parts.append("\n**Known Facts:**")
                for m in fact_memories:
                    parts.append(f"- {m['content']}")

    except Exception as e:
        logger.warning("Failed to inject memories: %s", e)

    # Add current timestamp
    parts.append(f"\n\nCurrent time: {time.strftime('%Y-%m-%d %H:%M:%S %Z')}")

    return {"role": "system", "content": "".join(parts)}


# ═══════════════════════════════════════════════════════════════
# CONTEXT MANAGEMENT
# ═══════════════════════════════════════════════════════════════

def compact_context(messages: List[dict], max_tokens: int = CONTEXT_TOKEN_LIMIT) -> List[dict]:
    """
    Compact conversation history to fit within token limit.
    Strategy: Keep system message + last N messages, summarize the middle.
    """
    if not messages:
        return messages

    # Separate system message
    system_msg = None
    history = []
    for m in messages:
        if m.get("role") == "system":
            system_msg = m
        else:
            history.append(m)

    # Estimate tokens
    total_chars = sum(len(json.dumps(m)) for m in history)
    total_tokens = total_chars // 4

    if total_tokens <= max_tokens:
        # Fits, no compaction needed
        result = []
        if system_msg:
            result.append(system_msg)
        result.extend(history)
        return result

    # Need to compact — keep last messages, summarize old ones
    logger.info("Context too large (%d tokens), compacting...", total_tokens)

    # Always keep the last 6 messages (3 exchanges)
    keep_count = min(6, len(history))
    kept = history[-keep_count:]
    dropped = history[:-keep_count]

    if dropped:
        # Create a summary message for dropped history
        dropped_count = len(dropped)
        first_msg = dropped[0].get("content", "")[:100]
        last_dropped = dropped[-1].get("content", "")[:100]
        summary = (
            f"[Earlier conversation: {dropped_count} messages. "
            f"Started with: \"{first_msg}...\" "
            f"Most recent dropped: \"{last_dropped}...\"]"
        )
        kept = [{"role": "system", "content": summary}] + kept

    result = []
    if system_msg:
        result.append(system_msg)
    result.extend(kept)
    return result


# ═══════════════════════════════════════════════════════════════
# STALL DETECTION
# ═══════════════════════════════════════════════════════════════

def detect_stall(tool_history: List[str]) -> Optional[str]:
    """
    Detect if the agent is stuck in a loop.
    Returns a reason string if stuck, None otherwise.
    """
    if len(tool_history) < 4:
        return None

    # Check for repeated tool calls
    recent = tool_history[-6:]
    counter = Counter(recent)
    most_common = counter.most_common(1)

    if most_common and most_common[0][1] >= STUCK_THRESHOLD:
        return f"Repeated '{most_common[0][0]}' {most_common[0][1]} times"

    # Check if we've hit the tool call limit
    if len(tool_history) >= MAX_TOOL_CALLS:
        return f"Tool call limit reached ({MAX_TOOL_CALLS})"

    return None


# ═══════════════════════════════════════════════════════════════
# STREAMING LLM CALL
# ═══════════════════════════════════════════════════════════════

async def stream_llm(messages: List[dict], tools: List[dict], model: str, session_id: str) -> dict:
    """
    Call the Vercel SaaS with streaming.
    Returns: {content: str, tool_calls: list, usage: dict}
    """
    import httpx

    url = auth.SAAS_BASE + "/api/v1/chat/completions"
    headers = auth.get_headers()

    body = {
        "model": model,
        "messages": messages,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"

    content_parts = []
    tool_calls = {}  # index -> {id, name, arguments_parts}
    usage = {}

    async with httpx.AsyncClient(timeout=120) as client:
        async with client.stream("POST", url, headers=headers, json=body) as response:
            if response.status_code != 200:
                error_body = await response.aread()
                try:
                    error_data = json.loads(error_body)
                    error_msg = error_data.get("error", {}).get("message", f"API error: {response.status_code}")
                except:
                    error_msg = f"API error: {response.status_code}"
                emit_error(error_msg)
                return {"content": "", "tool_calls": [], "usage": {}, "error": error_msg}

            async for line in response.aiter_lines():
                line = line.strip()
                if not line or not line.startswith("data:"):
                    continue

                data = line[5:].strip()
                if data == "[DONE]":
                    break

                try:
                    chunk = json.loads(data)
                except:
                    continue

                # Extract usage from final chunk
                if chunk.get("usage"):
                    usage = chunk["usage"]
                    continue

                choices = chunk.get("choices", [])
                if not choices:
                    continue

                delta = choices[0].get("delta", {})

                # Stream text content
                if delta.get("content"):
                    text = delta["content"]
                    content_parts.append(text)
                    emit_stream(text, session_id)

                # Accumulate tool calls
                if delta.get("tool_calls"):
                    for tc_delta in delta["tool_calls"]:
                        idx = tc_delta.get("index", 0)
                        if idx not in tool_calls:
                            tool_calls[idx] = {
                                "id": tc_delta.get("id", ""),
                                "function": {"name": "", "arguments": ""},
                            }
                        if tc_delta.get("id"):
                            tool_calls[idx]["id"] = tc_delta["id"]
                        func = tc_delta.get("function", {})
                        if func.get("name"):
                            tool_calls[idx]["function"]["name"] += func["name"]
                        if func.get("arguments"):
                            tool_calls[idx]["function"]["arguments"] += func["arguments"]

    # Convert tool_calls dict to list
    tool_calls_list = [
        {"id": tc["id"], "type": "function", "function": tc["function"]}
        for tc in sorted(tool_calls.values(), key=lambda x: x.get("id", ""))
    ]

    return {
        "content": "".join(content_parts),
        "tool_calls": tool_calls_list,
        "usage": usage,
    }


# ═══════════════════════════════════════════════════════════════
# AGENT LOOP — Multi-round tool execution
# ═══════════════════════════════════════════════════════════════

async def run_agent_loop(user_message: str, session_id: str, model: str = "qwen-plus") -> str:
    """
    Multi-round agentic loop:
    1. Build context with system prompt + memories + history
    2. Call LLM
    3. If tool calls → execute → add results → loop
    4. If no tool calls → done
    5. Stall detection prevents infinite loops
    """
    # Get conversation history
    history = db.get_conversation_context(session_id, max_messages=50)

    # Add current user message
    history.append({"role": "user", "content": user_message})

    # Build full message list with system prompt
    system_msg = build_system_message()
    messages = [system_msg] + history

    # Compact if needed
    messages = compact_context(messages)

    tools = get_tool_definitions()
    full_response = ""
    round_num = 0
    tool_history = []  # Track tool calls for stall detection

    while round_num < MAX_ROUNDS:
        round_num += 1
        emit_status(f"Round {round_num}...", session_id)

        # Call LLM with streaming
        result = await stream_llm(messages, tools, model, session_id)

        if result.get("error"):
            break

        assistant_content = result["content"]
        tool_calls = result["tool_calls"]
        full_response += assistant_content

        # No tool calls — agent is done
        if not tool_calls:
            break

        # Check for stall
        for tc in tool_calls:
            func = tc.get("function", {})
            tool_sig = f"{func.get('name', 'unknown')}:{func.get('arguments', '')[:50]}"
            tool_history.append(tool_sig)

        stall_reason = detect_stall(tool_history)
        if stall_reason:
            logger.warning("Stall detected: %s — forcing final answer", stall_reason)
            emit_status("Wrapping up...", session_id)
            # Force a final response without tools
            messages.append({"role": "assistant", "content": assistant_content or "(processing...)"})
            messages.append({
                "role": "user",
                "content": f"[System: You've been using tools extensively ({stall_reason}). Please provide a final summary or answer now without using any more tools.]"
            })
            final_result = await stream_llm(messages, [], model, session_id)  # No tools
            if final_result.get("content"):
                full_response += "\n\n" + final_result["content"]
            break

        # Add assistant message with tool calls to history
        assistant_msg = {
            "role": "assistant",
            "content": assistant_content or None,
            "tool_calls": tool_calls,
        }
        messages.append(assistant_msg)

        # Execute each tool call
        for tc in tool_calls:
            func = tc.get("function", {})
            tool_name = func.get("name", "unknown")
            tool_args_str = func.get("arguments", "{}")

            try:
                tool_args = json.loads(tool_args_str) if tool_args_str else {}
            except json.JSONDecodeError:
                tool_args = {"raw": tool_args_str}

            # Emit tool start (truncate args for display)
            args_preview = json.dumps(tool_args)[:200]
            emit_tool_start(tool_name, args_preview, round_num, session_id)

            # Execute the tool
            tool_result = await execute_tool(tool_name, tool_args, session_id)

            # Emit tool output
            emit_tool_output(tool_name, tool_result.get("output", ""), tool_result.get("exit_code", 0), session_id)

            # Add tool result to messages
            messages.append({
                "role": "tool",
                "tool_call_id": tc.get("id", ""),
                "content": tool_result.get("output", "No output"),
            })

        # Continue the loop — LLM will process tool results

    return full_response


# ═══════════════════════════════════════════════════════════════
# CHAT HANDLER
# ═══════════════════════════════════════════════════════════════

async def handle_chat(data: dict):
    """Handle a chat message — routes to agent loop."""
    if not auth.is_authenticated():
        emit_error("Not authenticated. Please log in first.")
        return

    message = data.get("message", "").strip()
    session_id = data.get("session_id") or str(uuid.uuid4())
    model = data.get("model", "qwen-plus")

    if not message:
        emit_error("Empty message")
        return

    # Ensure session exists
    session = db.get_session(session_id)
    if not session:
        db.create_session(session_id, name=message[:42], model=model)

    # Save user message
    db.add_message(session_id, "user", message)

    try:
        # Run the agentic loop
        full_response = await run_agent_loop(message, session_id, model)

        # Save assistant response
        if full_response:
            db.add_message(session_id, "assistant", full_response)

            # Update session name if first exchange
            msgs = db.get_messages(session_id, limit=3)
            if len(msgs) <= 2:
                smart_name = generate_smart_name(message)
                db.update_session(session_id, name=smart_name)

        emit({"type": "done", "session_id": session_id})

    except Exception as e:
        logger.exception("Chat error")
        emit_error(str(e))


# ═══════════════════════════════════════════════════════════════
# TOOL DEFINITIONS
# ═══════════════════════════════════════════════════════════════

def get_tool_definitions() -> list:
    """Return OpenAI-compatible tool definitions."""
    return [
        {
            "type": "function",
            "function": {
                "name": "run_shell",
                "description": "Execute a shell command. Returns stdout, stderr, exit code. Use for file ops, git, npm, system info, etc.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {"type": "string", "description": "Shell command to execute"},
                        "timeout": {"type": "integer", "description": "Timeout in seconds (default: 30)", "default": 30},
                    },
                    "required": ["command"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "run_python",
                "description": "Execute Python code. Has access to stdlib + installed packages.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "code": {"type": "string", "description": "Python code to execute"},
                        "timeout": {"type": "integer", "description": "Timeout in seconds (default: 30)", "default": 30},
                    },
                    "required": ["code"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read file contents. Returns text.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Absolute or relative file path"},
                    },
                    "required": ["path"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Write content to a file. Creates parent dirs. Overwrites.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "File path"},
                        "content": {"type": "string", "description": "Content to write"},
                    },
                    "required": ["path", "content"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "edit_file",
                "description": "Find and replace text in a file. Use for targeted edits instead of rewriting entire files.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "File path"},
                        "old_text": {"type": "string", "description": "Exact text to find"},
                        "new_text": {"type": "string", "description": "Replacement text"},
                    },
                    "required": ["path", "old_text", "new_text"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Search the web. Returns results with titles, URLs, snippets.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Search query"},
                        "max_results": {"type": "integer", "description": "Max results (default: 5)", "default": 5},
                    },
                    "required": ["query"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "web_fetch",
                "description": "Fetch and extract text from a URL.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": {"type": "string", "description": "URL to fetch"},
                    },
                    "required": ["url"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "save_memory",
                "description": "Save info to persistent memory. Categories: profile, facts, preferences, history.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "category": {"type": "string", "enum": ["profile", "facts", "preferences", "history"]},
                        "content": {"type": "string", "description": "What to remember"},
                        "importance": {"type": "integer", "description": "1-10 importance (default: 5)", "default": 5},
                    },
                    "required": ["category", "content"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "recall_memory",
                "description": "Search saved memories.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Search query"},
                        "category": {"type": "string", "enum": ["profile", "facts", "preferences", "history"]},
                        "limit": {"type": "integer", "description": "Max results (default: 5)", "default": 5},
                    },
                    "required": ["query"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "list_directory",
                "description": "List files and directories.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Directory path (default: .)", "default": "."},
                    },
                    "required": [],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "create_task",
                "description": "Create a task synced to the cloud.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string", "description": "Task title"},
                        "description": {"type": "string", "description": "Optional description"},
                    },
                    "required": ["title"],
                },
            },
        },
    ]


# ═══════════════════════════════════════════════════════════════
# TOOL EXECUTION
# ═══════════════════════════════════════════════════════════════

async def execute_tool(tool_name: str, tool_args: dict, session_id: str) -> dict:
    """Execute a tool call and return the result."""
    try:
        if tool_name == "run_shell":
            return await tool_run_shell(tool_args)
        elif tool_name == "run_python":
            return await tool_run_python(tool_args)
        elif tool_name == "read_file":
            return await tool_read_file(tool_args)
        elif tool_name == "write_file":
            return await tool_write_file(tool_args)
        elif tool_name == "edit_file":
            return await tool_edit_file(tool_args)
        elif tool_name == "web_search":
            return await tool_web_search(tool_args)
        elif tool_name == "web_fetch":
            return await tool_web_fetch(tool_args)
        elif tool_name == "save_memory":
            return tool_save_memory(tool_args)
        elif tool_name == "recall_memory":
            return tool_recall_memory(tool_args)
        elif tool_name == "list_directory":
            return tool_list_directory(tool_args)
        elif tool_name == "create_task":
            return await tool_create_task(tool_args)
        else:
            return {"output": f"Unknown tool: {tool_name}", "exit_code": 1}
    except Exception as e:
        logger.exception("Tool execution error: %s", tool_name)
        return {"output": f"Tool error: {str(e)}", "exit_code": 1}


async def tool_run_shell(args: dict) -> dict:
    command = args.get("command", "")
    timeout = args.get("timeout", 30)

    # Safety check
    dangerous = ["rm -rf /", "rm -rf ~", "DROP TABLE", "format c:", "del /f /s /q"]
    if any(d in command.lower() for d in dangerous):
        return {"output": "Blocked: Destructive command requires explicit confirmation.", "exit_code": -1}

    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        output = ""
        if stdout:
            output += stdout.decode("utf-8", errors="replace")
        if stderr:
            output += "\n[STDERR]\n" + stderr.decode("utf-8", errors="replace")
        return {"output": output[:15000] or "(no output)", "exit_code": proc.returncode or 0}
    except asyncio.TimeoutError:
        proc.kill()
        return {"output": f"Command timed out after {timeout}s", "exit_code": -1}
    except Exception as e:
        return {"output": str(e), "exit_code": 1}


async def tool_run_python(args: dict) -> dict:
    code = args.get("code", "")
    timeout = args.get("timeout", 30)
    import tempfile
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
        f.write(code)
        tmp_path = f.name
    try:
        proc = await asyncio.create_subprocess_exec(
            sys.executable, tmp_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        output = ""
        if stdout:
            output += stdout.decode("utf-8", errors="replace")
        if stderr:
            output += "\n[STDERR]\n" + stderr.decode("utf-8", errors="replace")
        return {"output": output[:15000] or "(no output)", "exit_code": proc.returncode or 0}
    except asyncio.TimeoutError:
        proc.kill()
        return {"output": f"Python execution timed out after {timeout}s", "exit_code": -1}
    except Exception as e:
        return {"output": str(e), "exit_code": 1}
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


async def tool_read_file(args: dict) -> dict:
    path = args.get("path", "")
    try:
        from pathlib import Path as P
        p = P(path).expanduser().resolve()
        if not p.exists():
            return {"output": f"File not found: {path}", "exit_code": 1}
        content = p.read_text(encoding="utf-8", errors="replace")
        if len(content) > 30000:
            content = content[:30000] + "\n... [TRUNCATED — file too large]"
        return {"output": content or "(empty file)", "exit_code": 0}
    except Exception as e:
        return {"output": str(e), "exit_code": 1}


async def tool_write_file(args: dict) -> dict:
    path = args.get("path", "")
    content = args.get("content", "")
    try:
        from pathlib import Path as P
        p = P(path).expanduser().resolve()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return {"output": f"Written {len(content)} chars to {p}", "exit_code": 0}
    except Exception as e:
        return {"output": str(e), "exit_code": 1}


async def tool_edit_file(args: dict) -> dict:
    path = args.get("path", "")
    old_text = args.get("old_text", "")
    new_text = args.get("new_text", "")
    try:
        from pathlib import Path as P
        p = P(path).expanduser().resolve()
        if not p.exists():
            return {"output": f"File not found: {path}", "exit_code": 1}
        content = p.read_text(encoding="utf-8")
        if old_text not in content:
            return {"output": f"Text not found in file:\n{old_text[:200]}", "exit_code": 1}
        count = content.count(old_text)
        if count > 1:
            return {"output": f"Text appears {count} times — not unique. Be more specific.", "exit_code": 1}
        new_content = content.replace(old_text, new_text, 1)
        p.write_text(new_content, encoding="utf-8")
        return {"output": f"Edited {p}: replaced {len(old_text)} chars with {len(new_text)} chars", "exit_code": 0}
    except Exception as e:
        return {"output": str(e), "exit_code": 1}


async def tool_web_search(args: dict) -> dict:
    query = args.get("query", "")
    max_results = args.get("max_results", 5)
    try:
        import httpx
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                "https://api.duckduckgo.com/",
                params={"q": query, "format": "json", "no_html": 1},
            )
            data = resp.json()
            results = []
            if data.get("Abstract"):
                results.append(f"📖 {data.get('Heading', query)}\n{data['Abstract']}\n🔗 {data.get('AbstractURL', '')}")
            for topic in data.get("RelatedTopics", [])[:max_results]:
                if isinstance(topic, dict) and "Text" in topic:
                    results.append(f"• {topic['Text']}\n🔗 {topic.get('FirstURL', '')}")
            if not results:
                results.append(f"No instant results for '{query}'. Try a different query or use web_fetch on a specific URL.")
            return {"output": "\n\n".join(results), "exit_code": 0}
    except Exception as e:
        return {"output": f"Search error: {e}", "exit_code": 1}


async def tool_web_fetch(args: dict) -> dict:
    url = args.get("url", "")
    try:
        import httpx
        async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
            resp = await client.get(url, headers={"User-Agent": "TaskBolt/2.0"})
            text = resp.text
            import re
            text = re.sub(r"<script[^>]*>.*?</script>", "", text, flags=re.DOTALL)
            text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.DOTALL)
            text = re.sub(r"<[^>]+>", " ", text)
            text = re.sub(r"\s+", " ", text).strip()
            if len(text) > 20000:
                text = text[:20000] + "\n... [TRUNCATED]"
            return {"output": text or "(empty page)", "exit_code": 0}
    except Exception as e:
        return {"output": f"Fetch error: {e}", "exit_code": 1}


def tool_save_memory(args: dict) -> dict:
    category = args.get("category", "facts")
    content = args.get("content", "")
    importance = args.get("importance", 5)
    if not content:
        return {"output": "No content provided", "exit_code": 1}
    mid = db.add_memory(category, content, importance)
    return {"output": f"Memory saved (id: {mid}, category: {category})", "exit_code": 0}


def tool_recall_memory(args: dict) -> dict:
    query = args.get("query", "")
    category = args.get("category")
    limit = args.get("limit", 5)
    if category:
        memories = db.get_memories(category=category, limit=limit)
    else:
        memories = db.search_memories(query, limit=limit)
    if not memories:
        return {"output": "No matching memories found", "exit_code": 0}
    lines = []
    for m in memories:
        lines.append(f"[{m['category']}] {m['content']} (importance: {m['importance']})")
    return {"output": "\n".join(lines), "exit_code": 0}


def tool_list_directory(args: dict) -> dict:
    path = args.get("path", ".")
    try:
        from pathlib import Path as P
        p = P(path).expanduser().resolve()
        if not p.exists():
            return {"output": f"Path not found: {path}", "exit_code": 1}
        entries = sorted(p.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower()))
        lines = []
        for e in entries[:100]:
            prefix = "📁" if e.is_dir() else "📄"
            size = ""
            if e.is_file():
                try:
                    size = f" ({e.stat().st_size:,} bytes)"
                except OSError:
                    pass
            lines.append(f"{prefix} {e.name}{size}")
        if not lines:
            lines.append("(empty directory)")
        return {"output": "\n".join(lines), "exit_code": 0}
    except Exception as e:
        return {"output": str(e), "exit_code": 1}


async def tool_create_task(args: dict) -> dict:
    title = args.get("title", "")
    description = args.get("description", "")
    if not title:
        return {"output": "No title provided", "exit_code": 1}
    try:
        import httpx
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                auth.SAAS_BASE + "/api/tasks",
                headers=auth.get_headers(),
                json={"title": title, "messages": [{"role": "assistant", "content": description}] if description else []},
            )
            if resp.status_code in (200, 201):
                task = resp.json()
                return {"output": f"Task created: {title} (id: {task.get('id', 'unknown')})", "exit_code": 0}
            else:
                return {"output": f"Failed to create task: {resp.status_code}", "exit_code": 1}
    except Exception as e:
        return {"output": f"Task creation error: {e}", "exit_code": 1}


# ═══════════════════════════════════════════════════════════════
# UTILITY
# ═══════════════════════════════════════════════════════════════

def generate_smart_name(message: str) -> str:
    """Generate a smart session name from the first message."""
    msg = message.strip()
    greetings = {"hi", "hello", "hey", "sup", "yo", "good morning", "good evening", "good afternoon", "howdy", "hola"}
    if msg.lower() in greetings:
        return "New Chat"
    if msg.startswith("/"):
        parts = msg.split(None, 1)
        if len(parts) > 1:
            return parts[1][:42]
        return msg[:42]
    fillers = {"can you", "please", "i need", "i want", "help me", "could you", "would you", "tell me", "show me", "make", "create", "write", "build", "fix", "how to", "how do i", "what is", "explain"}
    lower = msg.lower()
    for f in sorted(fillers, key=len, reverse=True):
        if lower.startswith(f + " ") or lower.startswith(f + "?"):
            msg = msg[len(f):].strip()
            break
    name = msg[:42].strip()
    if name and name[0].islower():
        name = name[0].upper() + name[1:]
    return name or "New Chat"


# ═══════════════════════════════════════════════════════════════
# MAIN LOOP — stdin/stdout JSON protocol
# ═══════════════════════════════════════════════════════════════

async def handle_command(data: dict):
    """Route incoming commands to handlers."""
    cmd_type = data.get("type", "")

    if cmd_type == "ping":
        emit({"type": "pong"})

    elif cmd_type == "auth":
        await handle_auth(data)

    elif cmd_type == "chat":
        await handle_chat(data)

    elif cmd_type == "session_list":
        sessions = db.list_sessions(limit=data.get("limit", 50))
        emit({"type": "session_list", "sessions": sessions})

    elif cmd_type == "session_delete":
        db.delete_session(data.get("session_id", ""))
        emit({"type": "ok", "action": "session_deleted"})

    elif cmd_type == "memory_list":
        memories = db.get_memories(category=data.get("category"), limit=data.get("limit", 100))
        emit({"type": "memory_list", "memories": memories})

    elif cmd_type == "memory_add":
        mid = db.add_memory(
            data.get("category", "facts"),
            data.get("content", ""),
            data.get("importance", 5),
        )
        emit({"type": "ok", "action": "memory_added", "memory_id": mid})

    elif cmd_type == "memory_delete":
        db.delete_memory(data.get("memory_id", ""))
        emit({"type": "ok", "action": "memory_deleted"})

    elif cmd_type == "preference_get":
        value = db.get_preference(data.get("key", ""), data.get("default"))
        emit({"type": "preference", "key": data.get("key"), "value": value})

    elif cmd_type == "preference_set":
        db.set_preference(data.get("key", ""), data.get("value"))
        emit({"type": "ok", "action": "preference_saved"})

    elif cmd_type == "mcp_list":
        servers = db.get_mcp_servers()
        emit({"type": "mcp_list", "servers": servers})

    elif cmd_type == "mcp_save":
        server = data.get("server", {})
        db.save_mcp_server(
            server_id=server.get("id", str(uuid.uuid4())),
            name=server.get("name", "Unknown"),
            transport=server.get("transport", "stdio"),
            url=server.get("url"),
            command=server.get("command"),
            args=server.get("args", []),
            enabled=server.get("enabled", True),
        )
        emit({"type": "ok", "action": "mcp_saved"})

    elif cmd_type == "mcp_delete":
        db.delete_mcp_server(data.get("server_id", ""))
        emit({"type": "ok", "action": "mcp_deleted"})

    elif cmd_type == "stop":
        emit({"type": "ok", "action": "stopped"})

    else:
        emit_error(f"Unknown command type: {cmd_type}")


async def main():
    """Main event loop — read JSON from stdin, process, emit to stdout."""
    logger.info("TaskBolt Engine v%s starting...", VERSION)

    # Initialize database
    db.init_db()

    # Try to auto-login from saved token
    saved_token = auth.load_token_from_disk()
    if saved_token:
        logger.info("Auto-login from saved token")

    # Signal readiness
    emit({"type": "ready", "version": VERSION, "tools": len(get_tool_definitions())})
    logger.info("Engine ready (%d tools), waiting for commands on stdin", len(get_tool_definitions()))

    # Read loop
    loop = asyncio.get_event_loop()
    while True:
        try:
            line = await loop.run_in_executor(None, sys.stdin.readline)
            if not line:
                break  # EOF

            line = line.strip()
            if not line:
                continue

            try:
                data = json.loads(line)
            except json.JSONDecodeError as e:
                emit_error(f"Invalid JSON: {e}")
                continue

            await handle_command(data)

        except KeyboardInterrupt:
            logger.info("Interrupted, shutting down")
            break
        except Exception as e:
            logger.exception("Unhandled error in main loop")
            emit_error(f"Engine error: {e}")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    logger.info("Engine stopped")
