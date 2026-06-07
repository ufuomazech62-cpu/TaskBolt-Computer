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
import signal
import time
import uuid
from typing import Optional, List, Dict, Any
from collections import Counter
from pathlib import Path

# Setup logging to both stderr AND a log file
log_dir = Path.home() / ".taskbolt" / "logs"
log_dir.mkdir(parents=True, exist_ok=True)
log_file = log_dir / "engine.log"

# Clear old log on startup (ignore if locked by another process)
try:
    if log_file.exists():
        log_file.unlink()
except (PermissionError, OSError):
    pass  # Another engine instance has the file open — append instead

file_handler = logging.FileHandler(str(log_file), encoding="utf-8")
file_handler.setLevel(logging.DEBUG)
file_handler.setFormatter(logging.Formatter("%(asctime)s [%(name)s] %(levelname)s: %(message)s"))

stream_handler = logging.StreamHandler(sys.stderr)
stream_handler.setLevel(logging.INFO)
stream_handler.setFormatter(logging.Formatter("%(asctime)s [%(name)s] %(levelname)s: %(message)s"))

logging.basicConfig(level=logging.DEBUG, handlers=[file_handler, stream_handler])
logger = logging.getLogger("taskbolt.engine")
logger.info("Engine log file: %s", log_file)

# Add engine root to path
ENGINE_ROOT = os.path.dirname(os.path.abspath(__file__))
if ENGINE_ROOT not in sys.path:
    sys.path.insert(0, ENGINE_ROOT)

from core import taskbolt_auth as auth
from core import taskbolt_db as db
from core.mcp_client import get_client as get_mcp_client
from core.composio_client import get_client as get_composio_client

# Load Composio API key from ~/.taskbolt/.env if not already set
if not os.environ.get("COMPOSIO_API_KEY"):
    env_file = os.path.join(os.path.expanduser("~"), ".taskbolt", ".env")
    if os.path.exists(env_file):
        with open(env_file, "r") as f:
            for line in f:
                line = line.strip()
                if line.startswith("COMPOSIO_API_KEY="):
                    os.environ["COMPOSIO_API_KEY"] = line.split("=", 1)[1]
                    logger.info("Loaded COMPOSIO_API_KEY from %s", env_file)
                    break

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

SYSTEM_PROMPT = """You are TaskBolt, a powerful AI assistant running as a desktop application on the user's machine. You have direct access to their filesystem, shell, web, and desktop environment. You are proactive, resourceful, and action-oriented.

## Core Principles

1. **Bias toward action.** If the user's intent is even slightly ambiguous, take the most reasonable interpretation and act. Do not ask for clarification on minor details — just do the work and adjust if they correct you.
2. **Show, don't tell.** Execute commands and show output rather than describing what you would do. The user wants results, not plans.
3. **Never go silent.** If a tool call fails, immediately retry with a different approach or explain the error and propose a fix. Never leave the user wondering what happened.
4. **Declare completion.** When finished, clearly state the outcome. Use markers like DONE (task complete), BLOCKED (need user input or permission), or KEEP GOING (multi-step task in progress).
5. **Be concise.** Keep responses short and focused unless the user explicitly asks for depth. No preamble like "I'll help you with that" or "Let me do that for you."
6. **Use multiple tool calls per response.** You can invoke several tools in a single response when they are independent. Chain dependent calls across responses.

## Tool Usage Reference

### File & Code Tools

**run_shell** — Execute shell commands on the user's system.
- Use for: git operations, package installs, builds, system queries, running scripts.
- Always use absolute paths when possible.
- For destructive commands (rm -rf, format, drop), ask for confirmation first.
- Prefer capturing output to show the user rather than silencing it.
- For LONG-running commands (>20s), mention you're running it in the background.
- NEVER use shell to create/edit files — use write_file or edit_file instead.
- Example: run_shell(command="git log --oneline -5")

**run_python** — Execute Python code in an isolated environment.
- Use for: data processing, calculations, quick scripts, API calls, text manipulation.
- Has access to standard library and installed packages.
- Print output to communicate results back.
- Example: run_python(code="import json; print(json.dumps({'status': 'ok'}, indent=2))")

**read_file** — Read the contents of a file from the filesystem.
- Use for: examining code, configs, logs, any text file.
- Always check if a file exists before assuming its contents.
- Large files are truncated at 30K chars — mention this if relevant.
- Example: read_file(path="C:/Users/user/project/config.yaml")

**write_file** — Create or completely overwrite a file.
- Use for: creating new files, replacing entire file contents.
- Creates parent directories automatically.
- Mention when overwriting existing files. Use edit_file for surgical changes.
- Example: write_file(path="C:/Users/user/project/README.md", content="# My Project")

**edit_file** — Targeted find-and-replace edits within a file.
- Use for: small changes, bug fixes, adding imports, modifying config values.
- old_text must match EXACTLY and be unique in the file.
- Preferred over write_file when only changing a portion of a file.
- Example: edit_file(path="/app/main.py", old_string="DEBUG = True", new_string="DEBUG = False")

### Web Tools

**web_search** — Search the web for current information.
- Use for: finding documentation, checking current events, researching topics.
- Returns titles, snippets, and URLs. Synthesize multiple results into a coherent answer.
- Prefer authoritative sources (official docs, reputable sites).
- Example: web_search(query="Python 3.12 new features")

**web_fetch** — Fetch and extract text content from a specific URL.
- Use for: reading documentation pages, API responses, articles.
- Strips HTML tags and returns clean text. Handles most standard web pages.
- Falls back to raw HTML if extraction fails.
- Example: web_fetch(url="https://docs.python.org/3/whatsnew/3.12.html")

**web_browse** — Browse a page with full JavaScript rendering.
- Use for: sites requiring JS, interactive pages, SPAs, dynamic content.
- Slower than web_fetch but handles rendered content.
- Use when web_fetch returns incomplete or empty results.
- Example: web_browse(url="https://dashboard.example.com/stats")

### Desktop Tools

**screenshot** — Capture the user's desktop or a specific window.
- Use for: visual debugging, understanding UI state, documenting issues.
- Can target full screen or a specific window by title.
- Describe what you see in the screenshot to the user.
- Example: screenshot(target="full_screen") or screenshot(target="VS Code")

**clipboard** — Read from or write to the system clipboard.
- Use for: getting content the user copied, placing results for easy pasting.
- Example: clipboard(action="read") or clipboard(action="write", text="result here")

**system_info** — Get information about the user's system.
- Use for: checking OS, CPU, RAM, disk space, installed software.
- Use proactively when environment matters (choosing the right package manager, etc.)
- Example: system_info()

### Memory Tools

**save_memory** — Persist information to long-term memory across sessions.
- Categories: profile, facts, preferences, history.
- Write clear, self-contained entries that make sense without surrounding context.
- Do NOT store passwords, API keys, tokens, or secrets.
- Example: save_memory(category="preferences", content="User prefers TypeScript over JavaScript")

**recall_memory** — Search and retrieve stored memories.
- Searches across all categories by default. Can filter by category.
- Use proactively at the start of complex tasks to gather context.
- Example: recall_memory(query="coding style preferences")

**delete_memory** — Remove outdated or incorrect memories.
- Always confirm with the user before deleting unless it's clearly outdated.
- Example: delete_memory(memory_id="abc123")

### System Tools

**list_directory** — List files and directories at a given path.
- Returns names, types (file/dir), sizes, and modification times.
- Example: list_directory(path="C:/Users/user/project/src")

**search_files** — Find files by name pattern or search file contents.
- Name mode uses glob patterns. Content mode uses regex.
- Example: search_files(pattern="*.py", target="files", path="/project")
- Example: search_files(pattern="def main", target="content", path="/project")

**process_manage** — List, inspect, or kill running processes.
- Can filter by name pattern. Use with caution when killing.
- Example: process_manage(action="list") or process_manage(action="kill", name="node")

### UX Tools

**notification** — Send a desktop notification to the user.
- Use for: alerting about long-running task completion, important events.
- Keep messages short and actionable. Use sparingly.
- Example: notification(title="Build Complete", message="All tests passed (47/47)")

**create_task** — Create a cloud-synced task/reminder.
- Tasks sync across devices. Include clear titles and optional due dates.
- Example: create_task(title="Review PR #42", due="2025-01-15")

**generate_image** — Generate images using AI.
- Provide detailed prompts for better results.
- Example: generate_image(prompt="Minimalist logo for a coffee shop, flat design, warm colors")

## Memory System

You have persistent memory that survives across sessions. Use it actively.

**Categories:**
- **profile** — User identity: name, role, timezone, contact info.
- **facts** — Knowledge: project names, tech stack, server details, domain info.
- **preferences** — User choices: coding style, language, communication tone.
- **history** — Events: decisions made, past solutions, milestones.

**When to save:**
- User states a preference or shares important context
- A significant decision is made
- You solve a hard problem worth remembering

**When to recall:**
- At the start of any non-trivial task
- When the user references something from a past conversation

**Never store:** passwords, API keys, tokens, or secrets.

## Safety Rules

1. **Destructive commands require confirmation.** (rm -rf, DROP TABLE, format, git reset --hard)
2. **Respect boundaries.** Don't access files outside home directory without permission.
3. **No secrets in memory.** Never persist passwords, API keys, or credentials.
4. **Network caution.** Inform the user what you're connecting to for outbound requests.
5. **Process killing.** Confirm before killing processes unless explicitly asked.
6. **File overwrites.** Mention existing files before overwriting with write_file.

## Response Formatting

- Use **markdown** for structure: headers, bold, code blocks, lists.
- Keep responses **concise** — one clear answer beats three paragraphs of caveats.
- Use `inline code` for commands, file paths, and technical terms.
- No filler phrases: skip "Sure!", "Of course!", "I'd be happy to help!"
- End with a clear outcome statement: what was done, what the result was.

## Error Handling Protocol

When something fails:
1. **Read the error** — understand what went wrong before reacting.
2. **Retry with a fix** — if obvious (typo, missing dep, wrong path), fix and retry.
3. **Try an alternative** — if first approach won't work, pivot.
4. **Report clearly** — explain: what you tried, what the error was, what the user can do.
5. **Never silently fail** — every tool call should result in progress or a clear explanation.
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

    # Inject MCP tool descriptions if any servers are connected
    try:
        mcp = get_mcp_client()
        mcp_desc = mcp.get_tool_descriptions_for_prompt()
        if mcp_desc:
            parts.append(mcp_desc)
    except Exception as e:
        logger.warning("Failed to inject MCP tool descriptions: %s", e)

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
    Call the Vercel SaaS AI proxy.
    Returns: {content: str, tool_calls: list, usage: dict}
    """
    import httpx

    url = auth.SAAS_BASE + "/api/ai/agent"
    headers = auth.get_headers()

    body = {
        "model": model,
        "messages": messages,
    }
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"

    emit_status("Thinking...", session_id)

    async with httpx.AsyncClient(timeout=120) as client:
        try:
            # Log request for debugging
            body_json = json.dumps(body)
            logger.info("Request to %s: %d chars, tools=%d", url, len(body_json), len(tools) if tools else 0)
            response = await client.post(url, headers=headers, json=body)
        except Exception as e:
            emit_error(f"Network error: {e}")
            return {"content": "", "tool_calls": [], "usage": {}, "error": str(e)}

        if response.status_code != 200:
            raw = response.text[:500]
            logger.error("API error %d: %s", response.status_code, raw)
            try:
                error_data = response.json()
                error_msg = error_data.get("error", f"API error: {response.status_code}")
                if isinstance(error_msg, dict):
                    error_msg = error_msg.get("message", str(error_msg))
            except:
                error_msg = f"API error: {response.status_code}: {raw[:200]}"
            emit_error(str(error_msg))
            return {"content": "", "tool_calls": [], "usage": {}, "error": str(error_msg)}

        try:
            data = response.json()
            logger.info("API response keys: %s", list(data.keys()))
            logger.info("Choices count: %d", len(data.get("choices", [])))
            if data.get("usage"):
                logger.info("Usage: %s", data.get("usage"))
            if data.get("_credits"):
                logger.info("Credits: %s", data.get("_credits"))
        except Exception as e:
            emit_error(f"Failed to parse response: {e}")
            return {"content": "", "tool_calls": [], "usage": {}, "error": str(e)}

        # Extract assistant response
        choices = data.get("choices", [])
        if not choices:
            emit_error("No response from AI")
            return {"content": "", "tool_calls": [], "usage": data.get("usage", {}), "error": "No choices"}

        choice = choices[0]
        message = choice.get("message", {})
        content = message.get("content", "")
        tool_calls = message.get("tool_calls", [])
        
        logger.info("Response content length: %d chars", len(content))
        logger.info("Tool calls count: %d", len(tool_calls))
        if tool_calls:
            for i, tc in enumerate(tool_calls):
                func = tc.get("function", {})
                logger.info("Tool call %d: %s", i, func.get("name", "unknown"))

        # Stream the text content
        if content:
            emit_stream(content, session_id)
            logger.info("Emitted stream_delta with %d chars", len(content))

        # Convert tool_calls to list format
        tool_calls_list = []
        for tc in tool_calls:
            tool_calls_list.append({
                "id": tc.get("id", ""),
                "type": "function",
                "function": {
                    "name": tc.get("function", {}).get("name", ""),
                    "arguments": tc.get("function", {}).get("arguments", "{}"),
                },
            })

        return {
            "content": content,
            "tool_calls": tool_calls_list,
            "usage": data.get("usage", {}),
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
    logger.info("=== CHAT COMMAND RECEIVED ===")
    logger.info("Data keys: %s", list(data.keys()))
    
    if not auth.is_authenticated():
        logger.warning("Not authenticated")
        emit_error("Not authenticated. Please log in first.")
        return

    message = data.get("message", "").strip()
    session_id = data.get("session_id") or str(uuid.uuid4())
    model = data.get("model", "qwen-plus")
    
    logger.info("Message: %s", message[:100] if message else "(empty)")
    logger.info("Session ID: %s", session_id)
    logger.info("Model: %s", model)

    if not message:
        emit_error("Empty message")
        return

    # Ensure session exists
    session = db.get_session(session_id)
    if not session:
        db.create_session(session_id, name=message[:42], model=model)
        logger.info("Created new session: %s", session_id)

    # Save user message
    db.add_message(session_id, "user", message)
    logger.info("Saved user message to DB")

    try:
        # Run the production agentic loop (adapted from Odysseus)
        from agentic_loop import run_agentic_loop
        logger.info("=== STARTING AGENTIC LOOP (Odysseus-adapted) ===")
        full_response = await run_agentic_loop(message, session_id, model)
        logger.info("=== AGENTIC LOOP COMPLETED ===")
        logger.info("Response length: %d chars", len(full_response))

        # Save assistant response
        if full_response:
            db.add_message(session_id, "assistant", full_response)
            logger.info("Saved assistant response to DB")

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
    """Return OpenAI-compatible tool definitions (built-in + MCP)."""
    builtins = [
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
                        "due": {"type": "string", "description": "Optional due date (ISO or natural language)"},
                    },
                    "required": ["title"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "web_browse",
                "description": "Browse a webpage with full JavaScript rendering. Use for SPAs, dynamic content, or when web_fetch returns incomplete results.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": {"type": "string", "description": "URL to browse"},
                    },
                    "required": ["url"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "screenshot",
                "description": "Take a screenshot of the desktop or a specific window. Returns image description.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "target": {"type": "string", "description": "'full_screen' or window title (default: full_screen)", "default": "full_screen"},
                    },
                    "required": [],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "clipboard",
                "description": "Read from or write to the system clipboard.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["read", "write"], "description": "Read or write clipboard"},
                        "text": {"type": "string", "description": "Text to write (only for write action)"},
                    },
                    "required": ["action"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "system_info",
                "description": "Get detailed system information: OS, CPU, RAM, disk, network, etc.",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "required": [],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "search_files",
                "description": "Find files by name pattern or search file contents with regex.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": {"type": "string", "description": "Glob pattern (files) or regex (content)"},
                        "target": {"type": "string", "enum": ["files", "content"], "description": "Search file names or contents", "default": "content"},
                        "path": {"type": "string", "description": "Directory to search (default: current)", "default": "."},
                    },
                    "required": ["pattern"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "process_manage",
                "description": "List, inspect, or kill running processes.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["list", "kill"], "description": "List or kill processes"},
                        "name": {"type": "string", "description": "Process name filter (for list) or exact name (for kill)"},
                        "pid": {"type": "integer", "description": "Process ID (for kill)"},
                    },
                    "required": ["action"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "notification",
                "description": "Send a desktop notification to the user.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string", "description": "Notification title"},
                        "message": {"type": "string", "description": "Notification body text"},
                    },
                    "required": ["title", "message"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "delete_memory",
                "description": "Delete a specific memory entry by ID.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "memory_id": {"type": "string", "description": "Memory ID to delete"},
                    },
                    "required": ["memory_id"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "generate_image",
                "description": "Generate an image using AI. Provide a detailed prompt for best results.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "prompt": {"type": "string", "description": "Detailed image description"},
                        "style": {"type": "string", "description": "Optional style (photorealistic, cartoon, pixel art, etc.)"},
                    },
                    "required": ["prompt"],
                },
            },
        },
    ]

    # Merge MCP tools from connected servers
    mcp = get_mcp_client()
    mcp_schemas = mcp.get_openai_tool_schemas()
    if mcp_schemas:
        logger.info("Merging %d MCP tools into tool definitions", len(mcp_schemas))
    return builtins + mcp_schemas


# ═══════════════════════════════════════════════════════════════
# TOOL EXECUTION
# ═══════════════════════════════════════════════════════════════

async def execute_tool(tool_name: str, tool_args: dict, session_id: str) -> dict:
    """Execute a tool call and return the result."""
    try:
        # Route MCP tool calls to the MCP client
        if tool_name.startswith("mcp__"):
            mcp = get_mcp_client()
            return await mcp.call_tool(tool_name, tool_args)

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
        elif tool_name == "web_browse":
            return await tool_web_browse(tool_args)
        elif tool_name == "screenshot":
            return await tool_screenshot(tool_args)
        elif tool_name == "clipboard":
            return await tool_clipboard(tool_args)
        elif tool_name == "system_info":
            return tool_system_info(tool_args)
        elif tool_name == "save_memory":
            return tool_save_memory(tool_args)
        elif tool_name == "recall_memory":
            return tool_recall_memory(tool_args)
        elif tool_name == "delete_memory":
            return tool_delete_memory(tool_args)
        elif tool_name == "list_directory":
            return tool_list_directory(tool_args)
        elif tool_name == "search_files":
            return tool_search_files(tool_args)
        elif tool_name == "process_manage":
            return await tool_process_manage(tool_args)
        elif tool_name == "notification":
            return tool_notification(tool_args)
        elif tool_name == "create_task":
            return await tool_create_task(tool_args)
        elif tool_name == "generate_image":
            return await tool_generate_image(tool_args)
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


async def tool_web_browse(args: dict) -> dict:
    """Browse a webpage with JS rendering using a headless approach."""
    url = args.get("url", "")
    try:
        import httpx
        # Try using requests first for basic rendering
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            resp = await client.get(url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            })
            text = resp.text
            import re
            # Strip scripts, styles, and tags
            text = re.sub(r"<script[^>]*>.*?</script>", "", text, flags=re.DOTALL)
            text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.DOTALL)
            text = re.sub(r"<[^>]+>", " ", text)
            text = re.sub(r"\s+", " ", text).strip()
            
            if len(text) < 200:
                # Content too short — likely JS-rendered, try alternative approach
                text = f"[Page at {url} appears to require JavaScript rendering. Content extracted: {len(text)} chars.]\n\n{text}\n\nTip: For JS-heavy sites, the content may be limited. Try web_fetch first for simpler pages."
            
            if len(text) > 20000:
                text = text[:20000] + "\n... [TRUNCATED]"
            return {"output": text or "(empty page)", "exit_code": 0}
    except Exception as e:
        return {"output": f"Browse error: {e}", "exit_code": 1}


async def tool_screenshot(args: dict) -> dict:
    """Take a screenshot of the desktop."""
    target = args.get("target", "full_screen")
    try:
        from pathlib import Path
        import subprocess
        import tempfile
        
        # Save screenshot to temp file
        tmp_dir = tempfile.gettempdir()
        tmp_path = os.path.join(tmp_dir, "taskbolt_screenshot.png")
        
        # Try using PowerShell on Windows (built-in)
        if sys.platform == "win32":
            ps_script = f"""
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$bitmap.Save('{tmp_path}')
$graphics.Dispose()
$bitmap.Dispose()
"""
            proc = await asyncio.create_subprocess_exec(
                "powershell", "-Command", ps_script,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=15)
            
            if os.path.exists(tmp_path):
                size = os.path.getsize(tmp_path)
                return {"output": f"Screenshot saved to {tmp_path} ({size:,} bytes). Target: {target}. The image is available at this path for further analysis.", "exit_code": 0}
            else:
                err = stderr.decode("utf-8", errors="replace") if stderr else "Unknown error"
                return {"output": f"Screenshot failed: {err}", "exit_code": 1}
        else:
            # Linux/macOS: try scrot or screencapture
            if sys.platform == "darwin":
                cmd = ["screencapture", "-x", tmp_path]
            else:
                cmd = ["scrot", tmp_path]
            
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(proc.communicate(), timeout=15)
            
            if os.path.exists(tmp_path):
                size = os.path.getsize(tmp_path)
                return {"output": f"Screenshot saved to {tmp_path} ({size:,} bytes). Target: {target}.", "exit_code": 0}
            return {"output": "Screenshot tools not available (need scrot on Linux or screencapture on macOS)", "exit_code": 1}
    except asyncio.TimeoutError:
        return {"output": "Screenshot timed out", "exit_code": 1}
    except Exception as e:
        return {"output": f"Screenshot error: {e}", "exit_code": 1}


async def tool_clipboard(args: dict) -> dict:
    """Read from or write to the system clipboard."""
    action = args.get("action", "read")
    text = args.get("text", "")
    try:
        if sys.platform == "win32":
            if action == "read":
                proc = await asyncio.create_subprocess_exec(
                    "powershell", "-Command", "Get-Clipboard",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
                content = stdout.decode("utf-8", errors="replace").strip()
                return {"output": content or "(clipboard is empty)", "exit_code": 0}
            else:
                proc = await asyncio.create_subprocess_exec(
                    "powershell", "-Command", f"Set-Clipboard -Value '{text}'",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                await asyncio.wait_for(proc.communicate(), timeout=10)
                return {"output": f"Written {len(text)} chars to clipboard", "exit_code": 0}
        elif sys.platform == "darwin":
            if action == "read":
                proc = await asyncio.create_subprocess_exec(
                    "pbpaste",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
                return {"output": stdout.decode("utf-8", errors="replace").strip() or "(clipboard is empty)", "exit_code": 0}
            else:
                proc = await asyncio.create_subprocess_exec(
                    "pbcopy",
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                )
                await asyncio.wait_for(proc.communicate(input=text.encode()), timeout=10)
                return {"output": f"Written {len(text)} chars to clipboard", "exit_code": 0}
        else:
            # Linux
            cmd_read = ["xclip", "-selection", "clipboard", "-o"]
            cmd_write = ["xclip", "-selection", "clipboard"]
            if action == "read":
                proc = await asyncio.create_subprocess_exec(
                    *cmd_read,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
                return {"output": stdout.decode("utf-8", errors="replace").strip() or "(clipboard is empty)", "exit_code": 0}
            else:
                proc = await asyncio.create_subprocess_exec(
                    *cmd_write,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                )
                await asyncio.wait_for(proc.communicate(input=text.encode()), timeout=10)
                return {"output": f"Written {len(text)} chars to clipboard", "exit_code": 0}
    except asyncio.TimeoutError:
        return {"output": "Clipboard operation timed out", "exit_code": 1}
    except Exception as e:
        return {"output": f"Clipboard error: {e}", "exit_code": 1}


def tool_system_info(args: dict) -> dict:
    """Get detailed system information."""
    try:
        import platform
        import subprocess
        
        info = {
            "os": platform.system(),
            "os_version": platform.version(),
            "os_release": platform.release(),
            "architecture": platform.machine(),
            "processor": platform.processor(),
            "hostname": platform.node(),
            "python_version": platform.python_version(),
        }
        
        # Windows-specific info
        if sys.platform == "win32":
            try:
                proc = subprocess.run(
                    ["wmic", "os", "get", "TotalVisibleMemorySize,FreePhysicalMemory", "/format:csv"],
                    capture_output=True, text=True, timeout=10
                )
                for line in proc.stdout.strip().split("\n"):
                    if "," in line and not line.startswith("Node"):
                        parts = line.strip().split(",")
                        if len(parts) >= 3:
                            total_kb = int(parts[1]) if parts[1].isdigit() else 0
                            free_kb = int(parts[2]) if parts[2].isdigit() else 0
                            info["ram_total_gb"] = round(total_kb / 1024 / 1024, 1)
                            info["ram_free_gb"] = round(free_kb / 1024 / 1024, 1)
                            info["ram_used_gb"] = round((total_kb - free_kb) / 1024 / 1024, 1)
            except Exception:
                pass
            
            try:
                proc = subprocess.run(
                    ["wmic", "logicaldisk", "get", "DeviceID,FreeSpace,Size", "/format:csv"],
                    capture_output=True, text=True, timeout=10
                )
                disks = []
                for line in proc.stdout.strip().split("\n"):
                    if "," in line and "DeviceID" not in line:
                        parts = line.strip().split(",")
                        if len(parts) >= 4:
                            try:
                                drive = parts[1].strip()
                                free = int(parts[2]) if parts[2].strip().isdigit() else 0
                                total = int(parts[3]) if parts[3].strip().isdigit() else 0
                                if total > 0:
                                    disks.append(f"{drive}: {free // (1024**3)}GB free / {total // (1024**3)}GB total")
                            except (ValueError, IndexError):
                                pass
                if disks:
                    info["disks"] = disks
            except Exception:
                pass
        
        # Format as readable text
        lines = [
            f"🖥️ System Information",
            f"━━━━━━━━━━━━━━━━━━━━",
            f"OS: {info['os']} {info['os_release']} ({info['os_version']})",
            f"Architecture: {info['architecture']}",
            f"Processor: {info['processor']}",
            f"Hostname: {info['hostname']}",
            f"Python: {info['python_version']}",
        ]
        if "ram_total_gb" in info:
            lines.append(f"RAM: {info['ram_used_gb']}GB used / {info['ram_total_gb']}GB total ({info['ram_free_gb']}GB free)")
        if "disks" in info:
            lines.append(f"Disks:")
            for d in info["disks"]:
                lines.append(f"  {d}")
        
        return {"output": "\n".join(lines), "exit_code": 0}
    except Exception as e:
        return {"output": f"System info error: {e}", "exit_code": 1}


def tool_search_files(args: dict) -> dict:
    """Find files by name pattern or search file contents."""
    import re
    pattern = args.get("pattern", "")
    target = args.get("target", "content")
    search_path = args.get("path", ".")
    
    try:
        from pathlib import Path
        root = Path(search_path).expanduser().resolve()
        if not root.exists():
            return {"output": f"Path not found: {search_path}", "exit_code": 1}
        
        results = []
        max_results = 50
        
        if target == "files":
            # Glob-based file search
            for match in root.rglob(pattern):
                if match.is_file():
                    size = match.stat().st_size
                    results.append(f"📄 {match.relative_to(root)} ({size:,} bytes)")
                if len(results) >= max_results:
                    results.append(f"... (truncated at {max_results} results)")
                    break
        else:
            # Content search (regex)
            try:
                regex = re.compile(pattern, re.IGNORECASE)
            except re.error:
                regex = re.compile(re.escape(pattern), re.IGNORECASE)
            
            for fpath in root.rglob("*"):
                if fpath.is_file() and fpath.stat().st_size < 1_000_000:  # Skip files > 1MB
                    try:
                        content = fpath.read_text(encoding="utf-8", errors="ignore")
                        for i, line in enumerate(content.split("\n"), 1):
                            if regex.search(line):
                                rel = fpath.relative_to(root)
                                results.append(f"{rel}:{i}: {line.strip()[:120]}")
                                if len(results) >= max_results:
                                    break
                    except (PermissionError, OSError):
                        pass
                if len(results) >= max_results:
                    results.append(f"... (truncated at {max_results} results)")
                    break
        
        if not results:
            return {"output": f"No {'files' if target == 'files' else 'matches'} found for '{pattern}' in {root}", "exit_code": 0}
        
        return {"output": "\n".join(results), "exit_code": 0}
    except Exception as e:
        return {"output": f"Search error: {e}", "exit_code": 1}


async def tool_process_manage(args: dict) -> dict:
    """List or kill processes."""
    action = args.get("action", "list")
    name_filter = args.get("name", "")
    pid = args.get("pid")
    
    try:
        if action == "list":
            if sys.platform == "win32":
                cmd = ["tasklist", "/fo", "csv", "/nh"]
                if name_filter:
                    cmd.extend(["/fi", f"IMAGENAME eq {name_filter}*"])
            else:
                if name_filter:
                    cmd = ["pgrep", "-la", name_filter]
                else:
                    cmd = ["ps", "aux", "--sort=-%mem"]
            
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=15)
            output = stdout.decode("utf-8", errors="replace")
            
            if sys.platform == "win32":
                # Parse CSV tasklist output
                lines = output.strip().split("\n")
                formatted = []
                for line in lines[:50]:  # Limit to 50 processes
                    parts = line.strip('"').split('","')
                    if len(parts) >= 5:
                        pname = parts[0]
                        pid_val = parts[1]
                        mem = parts[4]
                        formatted.append(f"PID {pid_val:>6} | {pname:<30} | {mem}")
                output = "\n".join(formatted) if formatted else output[:5000]
            else:
                # Limit output
                lines = output.split("\n")[:50]
                output = "\n".join(lines)
            
            return {"output": output[:15000] or "(no processes found)", "exit_code": 0}
        
        elif action == "kill":
            if pid:
                if sys.platform == "win32":
                    cmd = ["taskkill", "/f", "/pid", str(pid)]
                else:
                    cmd = ["kill", "-9", str(pid)]
            elif name_filter:
                if sys.platform == "win32":
                    cmd = ["taskkill", "/f", "/im", name_filter]
                else:
                    cmd = ["pkill", "-9", "-f", name_filter]
            else:
                return {"output": "Must provide either 'pid' or 'name' to kill a process", "exit_code": 1}
            
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=10)
            out = stdout.decode("utf-8", errors="replace") + stderr.decode("utf-8", errors="replace")
            return {"output": out.strip() or "Process killed successfully", "exit_code": proc.returncode or 0}
        
        return {"output": f"Unknown action: {action}", "exit_code": 1}
    except asyncio.TimeoutError:
        return {"output": "Process operation timed out", "exit_code": 1}
    except Exception as e:
        return {"output": f"Process error: {e}", "exit_code": 1}


def tool_notification(args: dict) -> dict:
    """Send a desktop notification."""
    title = args.get("title", "TaskBolt")
    message = args.get("message", "")
    try:
        if sys.platform == "win32":
            # Use PowerShell toast notification
            import subprocess
            ps_cmd = f'''
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = '<toast><visual><binding template="ToastText02"><text id="1">{title}</text><text id="2">{message}</text></binding></visual></toast>'
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)
$notify = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("TaskBolt")
$toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
$notify.Show($toast)
'''
            proc = subprocess.run(
                ["powershell", "-Command", ps_cmd],
                capture_output=True, timeout=10
            )
            if proc.returncode == 0:
                return {"output": f"Notification sent: {title} — {message}", "exit_code": 0}
            # Fallback: use BurntToast or simpler method
            subprocess.run(
                ["powershell", "-Command", 
                 f'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show("{message}", "{title}", "OK", "Information")'],
                capture_output=True, timeout=5
            )
            return {"output": f"Notification sent (fallback): {title} — {message}", "exit_code": 0}
        elif sys.platform == "darwin":
            import subprocess
            subprocess.run(
                ["osascript", "-e", f'display notification "{message}" with title "{title}"'],
                capture_output=True, timeout=10
            )
            return {"output": f"Notification sent: {title} — {message}", "exit_code": 0}
        else:
            import subprocess
            subprocess.run(["notify-send", title, message], capture_output=True, timeout=10)
            return {"output": f"Notification sent: {title} — {message}", "exit_code": 0}
    except Exception as e:
        return {"output": f"Notification error: {e}", "exit_code": 1}


def tool_delete_memory(args: dict) -> dict:
    """Delete a memory entry by ID."""
    memory_id = args.get("memory_id", "")
    if not memory_id:
        return {"output": "No memory_id provided", "exit_code": 1}
    try:
        db.delete_memory(memory_id)
        return {"output": f"Memory '{memory_id}' deleted", "exit_code": 0}
    except Exception as e:
        return {"output": f"Delete error: {e}", "exit_code": 1}


async def tool_generate_image(args: dict) -> dict:
    """Generate an image via the Vercel SaaS AI proxy."""
    prompt = args.get("prompt", "")
    style = args.get("style", "")
    if not prompt:
        return {"output": "No prompt provided", "exit_code": 1}
    
    full_prompt = f"{prompt}, {style} style" if style else prompt
    
    try:
        import httpx
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                auth.SAAS_BASE + "/api/ai/image",
                headers=auth.get_headers(),
                json={"prompt": full_prompt, "model": "dall-e-3"},
            )
            if resp.status_code == 200:
                data = resp.json()
                image_url = data.get("url", data.get("image_url", ""))
                if image_url:
                    # Download to local file
                    img_resp = await client.get(image_url)
                    from pathlib import Path
                    img_dir = Path.home() / ".taskbolt" / "images"
                    img_dir.mkdir(parents=True, exist_ok=True)
                    img_path = img_dir / f"gen_{int(time.time())}.png"
                    img_path.write_bytes(img_resp.content)
                    return {"output": f"Image generated and saved to {img_path}\nURL: {image_url}", "exit_code": 0}
                return {"output": f"Image generated: {json.dumps(data)[:500]}", "exit_code": 0}
            else:
                return {"output": f"Image generation failed: {resp.status_code} — {resp.text[:200]}", "exit_code": 1}
    except Exception as e:
        return {"output": f"Image generation error: {e}", "exit_code": 1}


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
    logger.info("=== COMMAND RECEIVED: type=%s ===", cmd_type)
    logger.info("Command data keys: %s", list(data.keys()))

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
        server_id = server.get("id", str(uuid.uuid4()))
        server_name = server.get("name", "Unknown")
        server_command = server.get("command", "")
        
        # Detect Composio connectors (serverPkg starts with "composio:")
        is_composio = server_command.startswith("composio:") if server_command else False
        composio_slug = server_command.split(":", 1)[1] if is_composio else None
        
        db.save_mcp_server(
            server_id=server_id,
            name=server_name,
            transport=server.get("transport", "stdio"),
            url=server.get("url"),
            command=server.get("command"),
            args=server.get("args", []),
            enabled=server.get("enabled", True),
        )
        # Live-connect the server if enabled
        if server.get("enabled", True):
            if is_composio:
                # Route to Composio client
                composio = get_composio_client()
                if composio.is_available:
                    ok = await composio.connect_service(
                        service_id=server_id,
                        name=server_name,
                        service_slug=composio_slug,
                        auth_token=server.get("authValue"),
                    )
                    logger.info("Composio service save+connect: %s (%s) → %s", server_name, composio_slug, "ok" if ok else "failed")
                    if ok:
                        # Auth is pending — browser opened for OAuth. Don't say 'connected' yet.
                        # The polling task will emit the real mcp_connect_result when auth completes.
                        emit({
                            "type": "mcp_connect_result",
                            "server_id": server_id,
                            "name": server_name,
                            "success": False,
                            "status": "auth_pending",
                            "tool_count": 0,
                            "error": "",
                            "auth_pending": True,
                        })
                    else:
                        status = composio.get_status(server_id)
                        emit({
                            "type": "mcp_connect_result",
                            "server_id": server_id,
                            "name": server_name,
                            "success": False,
                            "status": "error",
                            "tool_count": 0,
                            "error": status.get("error", "Failed to initiate connection"),
                        })
                else:
                    emit({
                        "type": "mcp_connect_result",
                        "server_id": server_id,
                        "name": server_name,
                        "success": False,
                        "status": "error",
                        "tool_count": 0,
                        "error": "Composio SDK not installed. Run: pip install composio-core",
                    })
            else:
                # Route to MCP client (original flow)
                mcp = get_mcp_client()
                if mcp.is_available:
                    args = server.get("args", [])
                    if isinstance(args, str):
                        try:
                            args = json.loads(args)
                        except:
                            args = []
                    ok = await mcp.connect_server(
                        server_id=server_id,
                        name=server_name,
                        transport=server.get("transport", "stdio"),
                        command=server.get("command"),
                        args=args,
                        url=server.get("url"),
                    )
                    logger.info("MCP server save+connect: %s → %s", server_name, "ok" if ok else "failed")
                    # Emit REAL status back to frontend
                    status = mcp.get_status(server_id)
                    emit({
                        "type": "mcp_connect_result",
                        "server_id": server_id,
                        "name": server_name,
                        "success": ok,
                        "status": status.get("status", "error"),
                        "tool_count": status.get("tool_count", 0),
                        "error": status.get("error", ""),
                    })
                else:
                    emit({
                        "type": "mcp_connect_result",
                        "server_id": server_id,
                        "name": server_name,
                        "success": False,
                        "status": "error",
                        "tool_count": 0,
                        "error": "MCP package not installed. Run: pip install mcp",
                    })
        else:
            emit({"type": "ok", "action": "mcp_saved"})

    elif cmd_type == "mcp_delete":
        server_id = data.get("server_id", "")
        # Disconnect first
        mcp = get_mcp_client()
        if mcp.is_available:
            await mcp.disconnect_server(server_id)
        db.delete_mcp_server(server_id)
        emit({"type": "ok", "action": "mcp_deleted"})

    elif cmd_type == "mcp_connect":
        # Manually connect/reconnect an MCP server
        server_id = data.get("server_id", "")
        mcp = get_mcp_client()
        if mcp.is_available:
            config = mcp._server_configs.get(server_id)
            if config:
                ok = await mcp.connect_server(server_id=server_id, **config)
                emit({"type": "ok", "action": "mcp_connected", "success": ok})
            else:
                # Load from DB
                servers = db.get_mcp_servers()
                srv = next((s for s in servers if s.get("id") == server_id), None)
                if srv:
                    args = srv.get("args", [])
                    if isinstance(args, str):
                        try:
                            args = json.loads(args)
                        except:
                            args = []
                    ok = await mcp.connect_server(
                        server_id=server_id,
                        name=srv.get("name", "Unknown"),
                        transport=srv.get("transport", "stdio"),
                        command=srv.get("command"),
                        args=args,
                        url=srv.get("url"),
                    )
                    emit({"type": "ok", "action": "mcp_connected", "success": ok})
                else:
                    emit_error(f"MCP server not found: {server_id}")
        else:
            emit_error("MCP package not installed")

    elif cmd_type == "mcp_disconnect":
        server_id = data.get("server_id", "")
        mcp = get_mcp_client()
        if mcp.is_available:
            await mcp.disconnect_server(server_id)
        emit({"type": "ok", "action": "mcp_disconnected"})

    elif cmd_type == "mcp_status":
        mcp = get_mcp_client()
        statuses = mcp.get_all_statuses() if mcp.is_available else {}
        emit({"type": "mcp_status", "servers": statuses, "available": mcp.is_available})

    elif cmd_type == "stop":
        # Cleanup MCP connections before shutdown
        mcp = get_mcp_client()
        if mcp.is_available:
            await mcp.disconnect_all()
            logger.info("MCP servers disconnected on shutdown")
        emit({"type": "ok", "action": "stopped"})

    else:
        emit_error(f"Unknown command type: {cmd_type}")


async def main():
    """Main event loop — read JSON from stdin, process, emit to stdout."""
    # Install a safety net for unretrieved task exceptions (e.g. MCP/anyio cancel scope errors)
    # so they log a warning instead of poisoning the main event loop.
    loop = asyncio.get_event_loop()
    def _handle_task_exception(loop, context):
        exc = context.get("exception")
        msg = context.get("message", "unknown")
        if exc and "cancel scope" in str(exc):
            logger.warning("Suppressed unretrieved task exception (anyio cancel scope): %s", msg)
        else:
            logger.error("Unretrieved task exception: %s — %s", msg, exc)
    loop.set_exception_handler(_handle_task_exception)

    logger.info("TaskBolt Engine v%s starting...", VERSION)

    # Initialize database
    db.init_db()

    # Initialize MCP client and connect enabled servers (skip Composio ones)
    mcp = get_mcp_client()
    composio = get_composio_client()
    if mcp.is_available:
        logger.info("Initializing MCP client...")
        try:
            await mcp.connect_all_enabled()
            connected = mcp.get_connected_count()
            tools = mcp.get_total_tools()
            if connected:
                logger.info("MCP ready: %d server(s) connected, %d tools available", connected, tools)
            else:
                logger.info("MCP ready: no servers configured")
        except Exception as e:
            logger.warning("MCP initialization error (non-fatal): %s", e)
    else:
        logger.info("MCP package not available — connectors disabled")
    
    # Initialize Composio client
    if composio.is_available:
        logger.info("Composio ready: API key loaded")
    else:
        logger.info("Composio not available — Composio connectors disabled")

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
