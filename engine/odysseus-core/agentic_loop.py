"""
TaskBolt Agentic Loop — Production-grade multi-round agent execution.

Adapted from Odysseus agent loop patterns for the TaskBolt desktop architecture.
Communicates with the Tauri frontend via stdout JSON events.
All LLM calls go through the Vercel SaaS proxy (taskbolt.space/api/ai/agent).

Flow:
  1. Build context: system prompt + conversation history + user message
  2. Call LLM with tool definitions enabled
  3. If tool_calls → execute each, append results, loop back
  4. If no tool_calls → agent is done, return accumulated response
  5. Stall detection prevents infinite loops (repeated tools / total limit)
  6. Force-answer mode terminates tool use and requests final response
  7. Context compaction keeps messages within token budget
"""

import json
import logging
import time
from collections import Counter
from typing import Any, Dict, List, Optional

import httpx

from core import taskbolt_auth as auth
from core import taskbolt_db as db

# Import emit/tool helpers from main (they are already defined there)
from main import (
    build_system_message,
    emit,
    emit_error,
    emit_status,
    emit_stream,
    emit_tool_output,
    emit_tool_start,
    execute_tool,
    get_tool_definitions,
    select_tools_for_message,
)

logger = logging.getLogger("taskbolt.agentic_loop")

# ─── Configuration constants ───────────────────────────────────────────────────
DEFAULT_MAX_ROUNDS = 15          # Maximum tool-calling rounds per user message
MAX_TOTAL_TOOL_CALLS = 30       # Hard ceiling on total tool executions per loop
REPEATED_TOOL_THRESHOLD = 4     # Same tool+args signature this many times → stall
INDIVIDUAL_TOOL_LIMIT = 15      # Any single tool fired this many times → stall
CONTEXT_TOKEN_BUDGET= 8000    # Approximate token budget for message history
CONTEXT_KEEP_RECENT = 6         # Number of recent messages to always preserve
API_TIMEOUT_SECONDS = 120       # HTTP timeout for each LLM call
FORCE_ANSWER_PROMPT = (
    "Stop using tools. You have used enough tools to gather information. "
    "Write your complete final answer now based on what you have learned. "
    "Do NOT call any more tools."
)


# ═══════════════════════════════════════════════════════════════════════════════
# TOKEN ESTIMATION & CONTEXT MANAGEMENT
# ═══════════════════════════════════════════════════════════════════════════════

def estimate_tokens(text: str) -> int:
    """Rough token estimate: ~4 characters per token for mixed content."""
    return len(text) // 4


def estimate_messages_tokens(messages: List[dict]) -> int:
    """Estimate total tokens across all messages."""
    total_chars = sum(len(json.dumps(m, ensure_ascii=False)) for m in messages)
    return total_chars // 4


def compact_context(
    messages: List[dict],
    max_tokens: int = CONTEXT_TOKEN_BUDGET,
    keep_recent: int = CONTEXT_KEEP_RECENT,
) -> List[dict]:
    """
    Compact conversation history to fit within the token budget.

    Strategy:
      - Always preserve the system message (index 0).
      - Always preserve the last `keep_recent` messages.
      - Replace dropped middle messages with a short summary placeholder.

    Returns a new list; does not mutate the input.
    """
    if not messages:
        return messages

    # Separate the leading system message from the rest
    system_msg: Optional[dict] = None
    history: List[dict] = []
    for m in messages:
        if m.get("role") == "system" and system_msg is None:
            system_msg = m
        else:
            history.append(m)

    # Check if compaction is needed
    total_tokens = estimate_messages_tokens(history)
    if total_tokens <= max_tokens:
        result: List[dict] = []
        if system_msg is not None:
            result.append(system_msg)
        result.extend(history)
        return result

    logger.info(
        "Context compaction triggered: ~%d tokens (budget %d). "
        "Compacting %d history messages.",
        total_tokens,
        max_tokens,
        len(history),
    )

    # Keep the most recent messages
    kept = history[-keep_recent:] if len(history) > keep_recent else history[:]
    dropped = history[:-keep_recent] if len(history) > keep_recent else []

    # Build a compact summary of dropped messages
    if dropped:
        dropped_count = len(dropped)
        first_snippet = (dropped[0].get("content") or "")[:120]
        last_snippet = (dropped[-1].get("content") or "")[:120]
        summary_content = (
            f"[Earlier conversation truncated: {dropped_count} messages removed to save context. "
            f"First message started with: \"{first_snippet}...\" "
            f"Last removed message: \"{last_snippet}...\"]"
        )
        summary_msg = {"role": "system", "content": summary_content}
        kept = [summary_msg] + kept

    result = []
    if system_msg is not None:
        result.append(system_msg)
    result.extend(kept)

    new_tokens = estimate_messages_tokens(result)
    logger.info("Context compacted: %d → %d messages, ~%d tokens", len(messages), len(result), new_tokens)
    return result


# ═══════════════════════════════════════════════════════════════════════════════
# STALL DETECTION
# ═══════════════════════════════════════════════════════════════════════════════

class StallDetector:
    """
    Tracks tool-call signatures across rounds and detects when the agent is
    stuck in a loop or has exhausted its useful tool budget.

    Detection criteria:
      1. Same tool+args signature repeated >= REPEATED_TOOL_THRESHOLD times
         in the most recent window.
      2. Any single tool name fired >= INDIVIDUAL_TOOL_LIMIT times total.
      3. Total tool executions >= MAX_TOTAL_TOOL_CALLS.
      4. Consecutive identical rounds (same set of tool calls) >= 4.
    """

    def __init__(self) -> None:
        self.signatures: List[str] = []           # Full sig history (name:args_preview)
        self.tool_name_counts: Counter = Counter() # Counts per tool name
        self.round_signatures: List[str] = []      # Hash of each round's tool-call set
        self.total_calls: int = 0

    def record_round(self, tool_calls: List[dict]) -> None:
        """Record a round of tool calls for stall tracking."""
        round_sigs: List[str] = []
        for tc in tool_calls:
            func = tc.get("function", {})
            name = func.get("name", "unknown")
            args_str = func.get("arguments", "")
            sig = f"{name}:{args_str[:80]}"
            self.signatures.append(sig)
            self.tool_name_counts[name] += 1
            round_sigs.append(sig)
            self.total_calls += 1

        # Store a canonical hash of this round's tool-call set
        self.round_signatures.append("|".join(sorted(round_sigs)))

    def detect(self) -> Optional[str]:
        """
        Check for stall conditions.
        Returns a human-readable reason string if stuck, None otherwise.
        """
        # 1. Total tool call ceiling
        if self.total_calls >= MAX_TOTAL_TOOL_CALLS:
            return f"Total tool call limit reached ({self.total_calls}/{MAX_TOTAL_TOOL_CALLS})"

        # 2. Individual tool overuse — any single tool fired too many times
        for name, count in self.tool_name_counts.most_common(3):
            if count >= INDIVIDUAL_TOOL_LIMIT:
                return f"Tool '{name}' called {count} times (limit: {INDIVIDUAL_TOOL_LIMIT})"

        # 3. Repeated identical signature in recent window
        if len(self.signatures) >= REPEATED_TOOL_THRESHOLD:
            recent = self.signatures[-(REPEATED_TOOL_THRESHOLD * 2):]
            counter = Counter(recent)
            most_common_sig, most_common_count = counter.most_common(1)[0]
            if most_common_count >= REPEATED_TOOL_THRESHOLD:
                tool_name = most_common_sig.split(":")[0]
                return (
                    f"Repeated '{tool_name}' with similar args "
                    f"{most_common_count} times (threshold: {REPEATED_TOOL_THRESHOLD})"
                )

        # 4. Consecutive identical rounds (same set of tool calls)
        if len(self.round_signatures) >= 4:
            last_four = self.round_signatures[-4:]
            if len(set(last_four)) == 1:
                return "4 consecutive rounds with identical tool calls"

        return None


# ═══════════════════════════════════════════════════════════════════════════════
# LLM API CALL
# ═══════════════════════════════════════════════════════════════════════════════

async def call_llm(
    messages: List[dict],
    tools: Optional[List[dict]],
    model: str,
    session_id: str,
) -> Dict[str, Any]:
    """
    Call the Vercel SaaS AI proxy at /api/ai/agent.

    Args:
        messages:   Full message list (system + history + current).
        tools:      OpenAI-format tool definitions, or None/empty for no tools.
        model:      Model identifier (e.g. "qwen-plus").
        session_id: Session ID for event emission.

    Returns dict with keys:
        content:    str  — assistant text content (may be empty)
        tool_calls: list — parsed tool call objects
        usage:      dict — token usage info
        credits:    dict — credit billing info
        error:      Optional[str] — error message if the call failed
    """
    url = f"{auth.SAAS_BASE}/api/ai/agent"
    headers = auth.get_headers()

    body: Dict[str, Any] = {
        "model": model,
        "messages": messages,
    }
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"

    emit_status("Thinking...", session_id)

    async with httpx.AsyncClient(timeout=API_TIMEOUT_SECONDS) as client:
        try:
            body_size = len(json.dumps(body, ensure_ascii=False))
            logger.info(
                "LLM request → %s | model=%s | msgs=%d | tools=%d | body=%d chars",
                url, model, len(messages), len(tools) if tools else 0, body_size,
            )
            response = await client.post(url, headers=headers, json=body)
        except httpx.TimeoutException:
            error_msg = f"LLM request timed out after {API_TIMEOUT_SECONDS}s"
            logger.error(error_msg)
            emit_error(error_msg)
            return {"content": "", "tool_calls": [], "usage": {}, "credits": {}, "error": error_msg}
        except httpx.ConnectError as e:
            error_msg = f"Cannot connect to API: {e}"
            logger.error(error_msg)
            emit_error(error_msg)
            return {"content": "", "tool_calls": [], "usage": {}, "credits": {}, "error": error_msg}
        except Exception as e:
            error_msg = f"Network error: {e}"
            logger.exception("Unexpected network error during LLM call")
            emit_error(error_msg)
            return {"content": "", "tool_calls": [], "usage": {}, "credits": {}, "error": error_msg}

        # ── Handle non-200 responses ──────────────────────────────────────
        if response.status_code != 200:
            raw_body = response.text[:500]
            logger.error("API returned %d: %s", response.status_code, raw_body)
            try:
                error_data = response.json()
                error_detail = error_data.get("error", f"HTTP {response.status_code}")
                if isinstance(error_detail, dict):
                    error_detail = error_detail.get("message", str(error_detail))
            except (json.JSONDecodeError, ValueError):
                error_detail = f"HTTP {response.status_code}: {raw_body[:200]}"

            emit_error(str(error_detail))
            return {"content": "", "tool_calls": [], "usage": {}, "credits": {}, "error": str(error_detail)}

        # ── Parse successful response ─────────────────────────────────────
        try:
            data = response.json()
        except (json.JSONDecodeError, ValueError) as e:
            error_msg = f"Failed to parse API response: {e}"
            logger.error(error_msg)
            emit_error(error_msg)
            return {"content": "", "tool_calls": [], "usage": {}, "credits": {}, "error": error_msg}

        # Log response metadata
        choices = data.get("choices", [])
        usage = data.get("usage", {})
        credits = data.get("_credits", {})
        logger.info(
            "LLM response ← choices=%d | usage=%s | credits=%s",
            len(choices), usage, credits,
        )

        if not choices:
            error_msg = "No response from AI (empty choices)"
            logger.warning(error_msg)
            emit_error(error_msg)
            return {"content": "", "tool_calls": [], "usage": usage, "credits": credits, "error": error_msg}

        # Extract message from first choice
        choice = choices[0]
        message = choice.get("message", {})
        content = message.get("content") or ""
        raw_tool_calls = message.get("tool_calls") or []

        logger.info("Response: content=%d chars, tool_calls=%d", len(content), len(raw_tool_calls))

        # Normalize tool calls into a consistent internal format
        parsed_tool_calls: List[dict] = []
        for tc in raw_tool_calls:
            func_info = tc.get("function", {})
            parsed_tool_calls.append({
                "id": tc.get("id", ""),
                "type": "function",
                "function": {
                    "name": func_info.get("name", ""),
                    "arguments": func_info.get("arguments", "{}"),
                },
            })

        if parsed_tool_calls:
            for i, tc in enumerate(parsed_tool_calls):
                logger.info(
                    "  tool_call[%d]: %s (id=%s)",
                    i, tc["function"]["name"], tc["id"],
                )

        return {
            "content": content,
            "tool_calls": parsed_tool_calls,
            "usage": usage,
            "credits": credits,
            "error": None,
        }


# ═══════════════════════════════════════════════════════════════════════════════
# TOOL EXECUTION HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

def parse_tool_arguments(args_json_str: str) -> dict:
    """Safely parse a tool's arguments JSON string into a dict."""
    if not args_json_str:
        return {}
    try:
        return json.loads(args_json_str)
    except (json.JSONDecodeError, TypeError):
        logger.warning("Failed to parse tool arguments: %s", args_json_str[:200])
        return {"_raw_arguments": args_json_str}


def build_args_preview(tool_args: dict, max_length: int = 200) -> str:
    """Create a truncated preview of tool arguments for the UI."""
    try:
        preview = json.dumps(tool_args, ensure_ascii=False)
        return preview[:max_length] + ("..." if len(preview) > max_length else "")
    except (TypeError, ValueError):
        return str(tool_args)[:max_length]


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN AGENTIC LOOP
# ═══════════════════════════════════════════════════════════════════════════════

async def run_agentic_loop(
    user_message: str,
    session_id: str,
    model: str = "qwen-plus",
    max_rounds: int = 15,
) -> str:
    """
    Execute a multi-round agentic loop for a single user message.

    This is the main entry point called by the chat handler. It:
      1. Builds the full message context (system prompt + history + user msg)
      2. Iteratively calls the LLM and executes any tool calls
      3. Detects stalls and forces a final answer when needed
      4. Compacts context if it grows beyond the token budget
      5. Returns the accumulated assistant response text

    Args:
        user_message: The user's input message text.
        session_id:   Unique session identifier for DB and events.
        model:        Model name to request (e.g. "qwen-plus", "qwen-max").
        max_rounds:   Maximum number of LLM call rounds before forcing done.

    Returns:
        The full accumulated assistant response text (may include text from
        multiple rounds concatenated together).
    """
    loop_start = time.time()
    logger.info(
        "═══ Starting agentic loop | session=%s | model=%s | max_rounds=%d ═══",
        session_id, model, max_rounds,
    )

    # ── Step 1: Build initial message context ─────────────────────────────
    history = db.get_conversation_context(session_id, max_messages=50)
    history.append({"role": "user", "content": user_message})

    system_msg = build_system_message(user_message=user_message)
    messages: List[dict] = [system_msg] + history

    # Compact to fit within token budget
    messages = compact_context(messages)

    # Load disabled tools from DB
    disabled_tools = db.get_disabled_tools()
    if disabled_tools:
        logger.info("Disabled tools loaded: %s", sorted(disabled_tools))

    # Get tool definitions with keyword-based selection
    tools = get_tool_definitions(user_message=user_message, disabled_tools=disabled_tools)
    logger.info("Tool definitions loaded: %d tools (filtered from all available)", len(tools))

    # ── Loop state ────────────────────────────────────────────────────────
    full_response = ""           # Accumulated text from all rounds
    round_num = 0                # Current round counter
    stall_detector = StallDetector()
    force_answer = False         # When True, next call omits tools

    # ── Step 2: Main execution loop ──────────────────────────────────────
    while round_num < max_rounds:
        round_num += 1
        emit_status(f"Round {round_num}{'/' + str(max_rounds)}...", session_id)
        logger.info("── Round %d/%d ── (messages=%d)", round_num, max_rounds, len(messages))

        # Periodic context compaction (every 4 rounds to prevent bloat)
        if round_num > 1 and round_num % 4 == 0:
            prev_len = len(messages)
            messages = compact_context(messages)
            if len(messages) < prev_len:
                logger.info(
                    "Periodic compaction at round %d: %d → %d messages",
                    round_num, prev_len, len(messages),
                )

        # ── Call the LLM ──────────────────────────────────────────────────
        active_tools = None if force_answer else tools
        result = await call_llm(messages, active_tools, model, session_id)

        # Handle API errors
        if result.get("error"):
            logger.error("LLM call failed in round %d: %s", round_num, result["error"])
            break

        assistant_content = result["content"]
        tool_calls = result["tool_calls"]

        # Accumulate text response
        if assistant_content:
            full_response += assistant_content
            emit_stream(assistant_content, session_id)
            logger.info("Round %d: received %d chars of content", round_num, len(assistant_content))

        # ── Check: no tool calls → agent is done ──────────────────────────
        if not tool_calls:
            logger.info("Round %d: No tool calls — agent finished naturally.", round_num)
            break

        # ── Record tool calls for stall detection ─────────────────────────
        stall_detector.record_round(tool_calls)
        stall_reason = stall_detector.detect()

        if stall_reason and not force_answer:
            logger.warning(
                "Stall detected at round %d: %s — entering force-answer mode.",
                round_num, stall_reason,
            )
            emit_status("Wrapping up...", session_id)

            # Append the current assistant message (with tool calls) and
            # a directive to stop using tools
            messages.append({
                "role": "assistant",
                "content": assistant_content or None,
                "tool_calls": tool_calls,
            })
            messages.append({
                "role": "system",
                "content": FORCE_ANSWER_PROMPT,
            })

            # Execute any pending tool calls first so context is complete,
            # then make one final call without tools
            for tc in tool_calls:
                func = tc.get("function", {})
                tool_name = func.get("name", "unknown")
                tool_args = parse_tool_arguments(func.get("arguments", "{}"))
                args_preview = build_args_preview(tool_args)

                emit_tool_start(tool_name, args_preview, round_num, session_id)
                tool_result = await execute_tool(tool_name, tool_args, session_id)
                emit_tool_output(
                    tool_name,
                    tool_result.get("output", ""),
                    tool_result.get("exit_code", 0),
                    session_id,
                )
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.get("id", ""),
                    "content": tool_result.get("output", "No output"),
                })

            # One final call without tools to get the concluding answer
            force_answer = True
            continue

        # ── No stall: proceed with tool execution ─────────────────────────
        # Append the assistant message with its tool_calls
        messages.append({
            "role": "assistant",
            "content": assistant_content or None,
            "tool_calls": tool_calls,
        })

        # Execute each tool call sequentially
        for tc in tool_calls:
            func = tc.get("function", {})
            tool_name = func.get("name", "unknown")
            tool_args = parse_tool_arguments(func.get("arguments", "{}"))
            args_preview = build_args_preview(tool_args)

            logger.info(
                "Round %d: executing tool '%s' | args=%s",
                round_num, tool_name, args_preview[:120],
            )

            # Notify frontend of tool execution
            emit_tool_start(tool_name, args_preview, round_num, session_id)

            # Execute the tool
            tool_result = await execute_tool(tool_name, tool_args, session_id)

            tool_output = tool_result.get("output", "No output")
            tool_exit_code = tool_result.get("exit_code", 0)

            # Notify frontend of tool result
            emit_tool_output(tool_name, tool_output, tool_exit_code, session_id)

            logger.info(
                "Round %d: tool '%s' completed | exit=%d | output=%d chars",
                round_num, tool_name, tool_exit_code, len(tool_output),
            )

            # Append tool result to messages for the LLM to process
            messages.append({
                "role": "tool",
                "tool_call_id": tc.get("id", ""),
                "content": tool_output,
            })

        # Loop continues — LLM will see tool results and decide next action

    # ── Step 3: Handle max-rounds exhaustion ──────────────────────────────
    if round_num >= max_rounds and not force_answer:
        logger.warning(
            "Max rounds (%d) reached without natural completion. "
            "Forcing final answer.",
            max_rounds,
        )
        emit_status("Generating final answer...", session_id)
        messages.append({
            "role": "system",
            "content": FORCE_ANSWER_PROMPT,
        })
        final_result = await call_llm(messages, None, model, session_id)
        if final_result.get("content"):
            full_response += "\n\n" + final_result["content"]
            emit_stream(final_result["content"], session_id)

    # ── Done ──────────────────────────────────────────────────────────────
    elapsed = time.time() - loop_start
    logger.info(
        "═══ Agentic loop complete | session=%s | rounds=%d | "
        "tools_used=%d | response=%d chars | elapsed=%.1fs ═══",
        session_id, round_num, stall_detector.total_calls,
        len(full_response), elapsed,
    )

    return full_response
