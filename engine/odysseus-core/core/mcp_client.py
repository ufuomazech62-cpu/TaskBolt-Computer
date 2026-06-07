"""
mcp_client.py — TaskBolt MCP (Model Context Protocol) Client

Manages connections to external MCP tool servers. Users configure servers
via the Connectors page in the UI. Each server runs as a subprocess (stdio)
or connects via HTTP (SSE). Discovered tools are merged into the agent's
tool list and routed through the agentic loop.

Architecture:
  - McpClient singleton manages all server connections
  - Servers stored in SQLite (taskbolt_db mcp_servers table)
  - Tools namespaced as mcp__{server_id}__{tool_name} to avoid collisions
  - Auto-reconnect for crashed servers
  - Graceful degradation if mcp package is unavailable
"""

import asyncio
import json
import logging
import os
from contextlib import AsyncExitStack
from typing import Any, Dict, List, Optional

logger = logging.getLogger("taskbolt.mcp")

# Global singleton
_client: Optional["McpClient"] = None


def get_client() -> "McpClient":
    """Get or create the global MCP client singleton."""
    global _client
    if _client is None:
        _client = McpClient()
    return _client


class McpClient:
    """Manages MCP server connections and tool routing for TaskBolt."""

    def __init__(self):
        self._connections: Dict[str, Dict[str, Any]] = {}   # server_id -> status info
        self._tools: Dict[str, List[Dict]] = {}             # server_id -> tool schemas
        self._sessions: Dict[str, Any] = {}                 # server_id -> MCP ClientSession
        self._stacks: Dict[str, AsyncExitStack] = {}        # server_id -> cleanup stacks
        self._server_configs: Dict[str, Dict] = {}          # server_id -> config for reconnect
        self._available = False
        self._check_availability()

    def _check_availability(self):
        """Check if the mcp Python package is installed."""
        try:
            from mcp import ClientSession, StdioServerParameters  # noqa: F401
            self._available = True
            logger.info("MCP package available — MCP connectors enabled")
        except ImportError:
            self._available = False
            logger.warning("MCP package not installed. MCP connectors disabled. Install: pip install mcp")

    @property
    def is_available(self) -> bool:
        return self._available

    # ═══════════════════════════════════════════════════════════════════
    # SERVER CONNECTION
    # ═══════════════════════════════════════════════════════════════════

    async def connect_server(
        self,
        server_id: str,
        name: str,
        transport: str = "stdio",
        command: Optional[str] = None,
        args: Optional[List[str]] = None,
        env: Optional[Dict[str, str]] = None,
        url: Optional[str] = None,
    ) -> bool:
        """Connect to an MCP server. Returns True on success."""
        if not self._available:
            logger.warning("MCP not available, skipping connect for %s", name)
            return False

        # Disconnect existing connection if any
        if server_id in self._sessions:
            await self.disconnect_server(server_id)

        # Save config for potential reconnect
        self._server_configs[server_id] = {
            "name": name,
            "transport": transport,
            "command": command,
            "args": args or [],
            "env": env or {},
            "url": url,
        }

        try:
            if transport == "stdio":
                return await self._connect_stdio(server_id, name, command or "", args or [], env or {})
            elif transport in ("sse", "http"):
                return await self._connect_sse(server_id, name, url or "")
            else:
                logger.error("Unknown MCP transport: %s", transport)
                self._connections[server_id] = {
                    "status": "error",
                    "error": f"Unknown transport: {transport}",
                    "name": name,
                }
                return False
        except Exception as e:
            logger.error("Failed to connect MCP server %s (%s): %s", name, server_id, e)
            self._connections[server_id] = {
                "status": "error",
                "error": str(e)[:200],
                "name": name,
            }
            return False

    async def _connect_stdio(
        self, server_id: str, name: str, command: str, args: List[str], env: Dict[str, str]
    ) -> bool:
        """Connect to an MCP server via stdio transport."""
        try:
            from mcp import ClientSession, StdioServerParameters
            from mcp.client.stdio import stdio_client

            server_params = StdioServerParameters(
                command=command,
                args=args,
                env={**os.environ, **env} if env else None,
            )

            stack = AsyncExitStack()
            try:
                transport = await stack.enter_async_context(stdio_client(server_params))
                read_stream, write_stream = transport
                session = await stack.enter_async_context(ClientSession(read_stream, write_stream))
                await session.initialize()
                tools_result = await session.list_tools()
            except Exception:
                try:
                    await stack.aclose()
                except (RuntimeError, Exception):
                    pass  # anyio cancel scope may fail on cross-task cleanup
                raise

            # Parse discovered tools
            tools = []
            for tool in tools_result.tools:
                tools.append({
                    "name": tool.name,
                    "description": tool.description or "",
                    "input_schema": tool.inputSchema if hasattr(tool, "inputSchema") else {},
                })

            self._sessions[server_id] = session
            self._stacks[server_id] = stack
            self._tools[server_id] = tools
            self._connections[server_id] = {
                "status": "connected",
                "name": name,
                "transport": "stdio",
                "tool_count": len(tools),
            }

            logger.info("MCP server connected: %s (%s) — %d tools via stdio", name, server_id, len(tools))
            return True

        except ImportError:
            logger.warning("mcp package not installed")
            self._connections[server_id] = {
                "status": "error",
                "error": "mcp package not installed",
                "name": name,
            }
            return False

    async def _connect_sse(self, server_id: str, name: str, url: str) -> bool:
        """Connect to an MCP server via SSE transport."""
        try:
            from mcp import ClientSession
            from mcp.client.sse import sse_client

            stack = AsyncExitStack()
            try:
                transport = await stack.enter_async_context(sse_client(url))
                read_stream, write_stream = transport
                session = await stack.enter_async_context(ClientSession(read_stream, write_stream))
                await session.initialize()
                tools_result = await session.list_tools()
            except Exception:
                await stack.aclose()
                raise

            tools = []
            for tool in tools_result.tools:
                tools.append({
                    "name": tool.name,
                    "description": tool.description or "",
                    "input_schema": tool.inputSchema if hasattr(tool, "inputSchema") else {},
                })

            self._sessions[server_id] = session
            self._stacks[server_id] = stack
            self._tools[server_id] = tools
            self._connections[server_id] = {
                "status": "connected",
                "name": name,
                "transport": "sse",
                "tool_count": len(tools),
            }

            logger.info("MCP server connected: %s (%s) — %d tools via SSE", name, server_id, len(tools))
            return True

        except ImportError:
            logger.warning("mcp package not installed")
            self._connections[server_id] = {
                "status": "error",
                "error": "mcp package not installed",
                "name": name,
            }
            return False

    async def disconnect_server(self, server_id: str):
        """Disconnect from an MCP server and clean up."""
        stack = self._stacks.pop(server_id, None)
        if stack:
            try:
                await stack.aclose()
            except Exception as e:
                logger.warning("Error closing MCP server %s: %s", server_id, e)

        self._sessions.pop(server_id, None)
        self._tools.pop(server_id, None)
        self._connections.pop(server_id, None)
        logger.info("MCP server disconnected: %s", server_id)

    async def disconnect_all(self):
        """Disconnect from all MCP servers."""
        ids = list(self._sessions.keys())
        for sid in ids:
            await self.disconnect_server(sid)

    # ═══════════════════════════════════════════════════════════════════
    # TOOL DISCOVERY & ROUTING
    # ═══════════════════════════════════════════════════════════════════

    def get_openai_tool_schemas(self) -> List[Dict]:
        """Return all MCP tools in OpenAI function-calling format.

        Tool names are namespaced: mcp__{server_id}__{tool_name}
        This prevents collisions between different servers' tools.
        """
        schemas = []
        for server_id, tools in self._tools.items():
            conn = self._connections.get(server_id, {})
            if conn.get("status") != "connected":
                continue

            server_name = conn.get("name", server_id)
            for tool in tools:
                qualified_name = f"mcp__{server_id}__{tool['name']}"
                input_schema = tool.get("input_schema", {"type": "object", "properties": {}})

                # Ensure input_schema has required fields
                if not isinstance(input_schema, dict):
                    input_schema = {"type": "object", "properties": {}}
                if "type" not in input_schema:
                    input_schema["type"] = "object"

                schemas.append({
                    "type": "function",
                    "function": {
                        "name": qualified_name,
                        "description": f"[MCP: {server_name}] {tool['description'][:200]}",
                        "parameters": input_schema,
                    },
                })

        return schemas

    async def call_tool(self, qualified_name: str, arguments: Dict) -> Dict:
        """Call an MCP tool by its qualified name (mcp__{server_id}__{tool_name}).

        Returns: {"output": str, "exit_code": int}
        """
        parts = qualified_name.split("__", 2)
        if len(parts) != 3 or parts[0] != "mcp":
            return {"output": f"Invalid MCP tool name: {qualified_name}", "exit_code": 1}

        server_id = parts[1]
        tool_name = parts[2]

        session = self._sessions.get(server_id)
        if not session:
            # Try reconnect for known configs
            config = self._server_configs.get(server_id)
            if config:
                logger.info("MCP server %s not connected, attempting reconnect...", server_id)
                reconnected = await self.connect_server(server_id=server_id, **config)
                if reconnected:
                    session = self._sessions.get(server_id)
            if not session:
                return {"output": f"MCP server not connected: {server_id}", "exit_code": 1}

        try:
            result = await session.call_tool(tool_name, arguments)
        except Exception as e:
            logger.error("MCP tool call failed: %s: %s", qualified_name, e)
            # Try reconnect once
            config = self._server_configs.get(server_id)
            if config:
                logger.info("Attempting reconnect for %s after tool call failure", server_id)
                await self.disconnect_server(server_id)
                reconnected = await self.connect_server(server_id=server_id, **config)
                if reconnected:
                    session = self._sessions.get(server_id)
                    if session:
                        try:
                            result = await session.call_tool(tool_name, arguments)
                        except Exception as e2:
                            return {"output": f"MCP tool error after reconnect: {e2}", "exit_code": 1}
                    else:
                        return {"output": f"Reconnected but no session for {server_id}", "exit_code": 1}
                else:
                    return {"output": f"MCP server crashed and reconnect failed: {server_id}", "exit_code": 1}
            else:
                return {"output": f"MCP tool error: {e}", "exit_code": 1}

        # Parse result content
        output_parts = []
        for content in result.content:
            if hasattr(content, "text"):
                output_parts.append(content.text)
            elif hasattr(content, "data"):
                output_parts.append(str(content.data))
            else:
                output_parts.append(str(content))

        output = "\n".join(output_parts)
        is_error = getattr(result, "isError", False)

        return {
            "output": output[:15000] if output else "(no output)",
            "exit_code": 1 if is_error else 0,
        }

    def is_mcp_tool(self, tool_name: str) -> bool:
        """Check if a tool name is an MCP tool (starts with mcp__)."""
        return tool_name.startswith("mcp__")

    # ═══════════════════════════════════════════════════════════════════
    # STATUS & MANAGEMENT
    # ═══════════════════════════════════════════════════════════════════

    def get_all_statuses(self) -> Dict[str, Dict]:
        """Get connection statuses for all servers."""
        return dict(self._connections)

    def get_status(self, server_id: str) -> Dict:
        """Get status for a specific server."""
        return self._connections.get(server_id, {"status": "disconnected"})

    def get_connected_count(self) -> int:
        """Count of currently connected servers."""
        return sum(1 for c in self._connections.values() if c.get("status") == "connected")

    def get_total_tools(self) -> int:
        """Total number of MCP tools across all connected servers."""
        return sum(len(tools) for tools in self._tools.values())

    def get_tool_descriptions_for_prompt(self) -> str:
        """Generate a text summary of MCP tools for the system prompt."""
        all_tools = []
        for server_id, tools in self._tools.items():
            conn = self._connections.get(server_id, {})
            if conn.get("status") != "connected":
                continue
            server_name = conn.get("name", server_id)
            for tool in tools:
                all_tools.append({
                    "server_name": server_name,
                    "name": f"mcp__{server_id}__{tool['name']}",
                    "description": tool.get("description", "")[:120],
                })

        if not all_tools:
            return ""

        lines = ["\n\n## Connected MCP Tools (external integrations)"]
        by_server: Dict[str, list] = {}
        for t in all_tools:
            sn = t["server_name"]
            if sn not in by_server:
                by_server[sn] = []
            by_server[sn].append(t)

        for server_name, server_tools in by_server.items():
            lines.append(f"\n**{server_name}:**")
            for t in server_tools:
                lines.append(f"  - `{t['name']}`: {t['description']}")

        return "\n".join(lines)

    # ═══════════════════════════════════════════════════════════════════
    # AUTO-CONNECT FROM DATABASE
    # ═══════════════════════════════════════════════════════════════════

    async def connect_all_enabled(self):
        """Connect to all enabled MCP servers stored in the database."""
        if not self._available:
            return

        try:
            from core import taskbolt_db as db
            servers = db.get_mcp_servers()
        except Exception as e:
            logger.warning("Failed to load MCP servers from DB: %s", e)
            return

        if not servers:
            logger.info("No MCP servers configured in database")
            return

        connected = 0
        for srv in servers:
            if not srv.get("enabled", True):
                continue

            server_id = srv.get("id", "")
            name = srv.get("name", "Unknown")
            transport = srv.get("transport", "stdio")
            command = srv.get("command")
            url = srv.get("url")

            # Skip Composio servers — they connect on-demand via browser OAuth
            if command and str(command).startswith("composio:"):
                logger.info("Skipping Composio server %s during auto-connect (requires browser OAuth)", name)
                continue

            # Parse args and env from JSON strings if needed
            args = srv.get("args", [])
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except json.JSONDecodeError:
                    args = []

            env = srv.get("env", {})
            if isinstance(env, str):
                try:
                    env = json.loads(env)
                except json.JSONDecodeError:
                    env = {}

            try:
                task = asyncio.create_task(
                    self.connect_server(
                        server_id=server_id,
                        name=name,
                        transport=transport,
                        command=command,
                        args=args,
                        env=env,
                        url=url,
                    )
                )
                try:
                    ok = await asyncio.wait_for(task, timeout=10)
                except asyncio.TimeoutError:
                    task.cancel()
                    try:
                        await task
                    except (asyncio.CancelledError, RuntimeError, Exception):
                        pass
                    logger.warning("MCP server %s timed out during connection (10s)", name)
                    self._connections[server_id] = {
                        "status": "error",
                        "error": "Connection timed out (10s)",
                        "name": name,
                    }
                else:
                    if ok:
                        connected += 1
            except RuntimeError as e:
                if "cancel scope" in str(e):
                    logger.warning("MCP server %s cleanup error suppressed, skipping", name)
                else:
                    logger.warning("MCP server %s failed: %s", name, e)
            except Exception as e:
                logger.warning("MCP server %s failed: %s", name, e)

        logger.info(
            "MCP auto-connect complete: %d/%d servers connected, %d total tools",
            connected, len(servers), self.get_total_tools(),
        )
