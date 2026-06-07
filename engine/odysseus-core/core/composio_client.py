"""
composio_client.py — TaskBolt Composio Integration (v3.1 API)

Manages connections to external services via Composio's unified API.
Users authenticate through normal OAuth flows — browser opens, user signs in,
connection becomes active automatically.

Architecture:
  - ComposioClient singleton manages all service connections
  - Uses Composio REST API v3.1 directly (no SDK dependency for core flow)
  - Auth configs pre-created on Composio (Composio-managed OAuth)
  - Link creation → redirect URL → browser OAuth → poll for ACTIVE
  - Tool execution via Composio tool router sessions
"""

import asyncio
import json
import logging
import os
import time
import webbrowser
from typing import Any, Dict, List, Optional

logger = logging.getLogger("taskbolt.composio")

# Global singleton
_client: Optional["ComposioClient"] = None

# Composio API v3.1
COMPOSIO_BASE = "https://backend.composio.dev/api/v3.1"

# Pre-created auth config IDs (Composio-managed OAuth)
# These were created via POST /api/v3.1/auth_configs
AUTH_CONFIG_IDS = {
    "gmail": "ac_rsmymoDVUeZl",
    "github": "ac_bUfg0V9iTQID",
    "google-calendar": "ac_WfaQa2g2fwMO",
    "google-drive": "ac_uV772X-JiDG9",
    "google-sheets": "ac_RXuCl0ke7yD1",
    "notion": "ac_J133MsomCTCx",
    "slack": "ac_ZRADJCE9nlCl",
    "discord": "ac_FdjrLdXiwvHN",
    "linkedin": "ac_a8eDZ1TIP8oF",
    "trello": "ac_LbHhC_8wxqR0",
    "asana": "ac_j-jPbZ4H_I5i",
    "linear": "ac_uDz560RH-Raa",
    "outlook": "ac_lFGlMMyq4PSs",
    "figma": "ac_32npCqZZjDnS",
    "dropbox": "ac_9N2AcY2YJGJ-",
    "zoom": "ac_DPnQe_cmn6jr",
    "youtube": "ac_Bup1XqPlYzfT",
}

# Map our service slugs to Composio toolkit slugs
SLUG_MAP = {
    "gmail": "gmail",
    "github": "github",
    "google-calendar": "googlecalendar",
    "google-drive": "googledrive",
    "google-sheets": "googlesheets",
    "notion": "notion",
    "slack": "slack",
    "discord": "discord",
    "linkedin": "linkedin",
    "twitter": "twitter",
    "x": "twitter",
    "trello": "trello",
    "asana": "asana",
    "linear": "linear",
    "outlook": "outlook",
    "figma": "figma",
    "dropbox": "dropbox",
    "zoom": "zoom",
    "youtube": "youtube",
}


def get_client() -> "ComposioClient":
    global _client
    if _client is None:
        _client = ComposioClient()
    return _client


class ComposioClient:
    """Manages Composio service connections via v3.1 REST API."""

    def __init__(self):
        self._connections: Dict[str, Dict[str, Any]] = {}
        self._tools: Dict[str, List[Dict]] = {}
        self._available = False
        self._api_key: Optional[str] = None
        self._user_id = "taskbolt-user"
        self._sessions: Dict[str, str] = {}  # service_id -> tool_router session_id
        self._check_availability()

    def _check_availability(self):
        self._api_key = os.environ.get("COMPOSIO_API_KEY")
        if not self._api_key:
            # Try loading from .env file
            env_path = os.path.expanduser("~/.taskbolt/.env")
            if os.path.exists(env_path):
                with open(env_path) as f:
                    for line in f:
                        if line.startswith("COMPOSIO_API_KEY="):
                            self._api_key = line.split("=", 1)[1].strip()
                            os.environ["COMPOSIO_API_KEY"] = self._api_key
                            break

        if self._api_key:
            self._available = True
            logger.info("Composio v3.1 ready — %d auth configs available", len(AUTH_CONFIG_IDS))
        else:
            self._available = False
            logger.warning("Composio API key not set")

    @property
    def is_available(self) -> bool:
        return self._available and bool(self._api_key)

    def set_api_key(self, key: str):
        self._api_key = key
        os.environ["COMPOSIO_API_KEY"] = key
        self._available = True
        logger.info("Composio API key configured")

    # ═══════════════════════════════════════════════════════════════════
    # HTTP HELPERS
    # ═══════════════════════════════════════════════════════════════════

    def _api(self, method: str, path: str, body: dict = None, timeout: int = 15) -> dict:
        """Make a request to Composio v3.1 API."""
        import urllib.request
        import urllib.error

        url = f"{COMPOSIO_BASE}{path}"
        headers = {"x-api-key": self._api_key, "Content-Type": "application/json"}
        data = json.dumps(body).encode() if body else None
        req = urllib.request.Request(url, data=data, method=method, headers=headers)

        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return {"ok": True, "status": resp.status, "data": json.loads(resp.read())}
        except urllib.error.HTTPError as e:
            body_text = e.read().decode()[:500]
            try:
                err_data = json.loads(body_text)
            except Exception:
                err_data = {"error": body_text}
            return {"ok": False, "status": e.code, "error": body_text, "data": err_data}
        except Exception as e:
            return {"ok": False, "status": 0, "error": str(e), "data": {}}

    # ═══════════════════════════════════════════════════════════════════
    # CONNECT SERVICE — OAuth via Composio Link
    # ═══════════════════════════════════════════════════════════════════

    async def connect_service(
        self,
        service_id: str,
        name: str,
        service_slug: str,
        auth_token: Optional[str] = None,
    ) -> bool:
        """Connect a service via Composio OAuth link flow."""
        if not self.is_available:
            error_msg = "Composio API key not configured"
            logger.warning("Composio not available: %s", error_msg)
            self._connections[service_id] = {"status": "error", "error": error_msg, "name": name}
            return False

        if service_id in self._connections:
            await self.disconnect_service(service_id)

        try:
            composio_slug = SLUG_MAP.get(service_slug, service_slug)
            auth_config_id = AUTH_CONFIG_IDS.get(service_slug)

            if not auth_config_id:
                # Try to create one on the fly
                logger.info("No cached auth config for %s, creating...", service_slug)
                result = self._api("POST", "/auth_configs", {"toolkit": {"slug": composio_slug}})
                if result["ok"]:
                    auth_config_id = result["data"].get("auth_config", {}).get("id")
                    if auth_config_id:
                        AUTH_CONFIG_IDS[service_slug] = auth_config_id
                else:
                    error_msg = f"No auth config for {service_slug}: {result.get('error', '')[:100]}"
                    self._connections[service_id] = {"status": "error", "error": error_msg, "name": name}
                    return False

            if not auth_config_id:
                error_msg = f"Could not create auth config for {service_slug}"
                self._connections[service_id] = {"status": "error", "error": error_msg, "name": name}
                return False

            logger.info("Creating Composio link for %s (auth_config: %s)", name, auth_config_id)

            # Step 1: Create link → get redirect URL
            result = self._api("POST", "/connected_accounts/link", {
                "auth_config_id": auth_config_id,
                "user_id": self._user_id,
                "callback_url": "https://taskbolt.space/connect/success.html",
            })

            if not result["ok"]:
                error_msg = f"Link creation failed: {result.get('error', '')[:150]}"
                logger.error(error_msg)
                self._connections[service_id] = {"status": "error", "error": error_msg, "name": name}
                return False

            link_data = result["data"]
            redirect_url = link_data.get("redirect_url")
            connected_account_id = link_data.get("connected_account_id")

            if not redirect_url:
                error_msg = "No redirect URL in link response"
                self._connections[service_id] = {"status": "error", "error": error_msg, "name": name}
                return False

            logger.info("Opening browser for %s OAuth: %s", name, redirect_url[:80])

            # Store connection as pending
            self._connections[service_id] = {
                "status": "auth_pending",
                "name": name,
                "service_slug": service_slug,
                "connected_account_id": connected_account_id,
                "redirect_url": redirect_url,
            }

            # Step 2: Open browser
            browser_opened = False
            try:
                browser_opened = webbrowser.open(redirect_url, new=2)
            except Exception:
                pass

            if not browser_opened:
                try:
                    import platform
                    if platform.system() == "Windows":
                        os.startfile(redirect_url)
                        browser_opened = True
                except Exception:
                    pass

            if not browser_opened:
                self._connections[service_id]["error"] = f"Open this URL to sign in: {redirect_url}"

            # Step 3: Poll for ACTIVE status in background
            asyncio.create_task(
                self._poll_connection(service_id, name, service_slug, connected_account_id)
            )

            return True

        except Exception as e:
            logger.error("Failed to connect %s: %s", name, e)
            self._connections[service_id] = {"status": "error", "error": str(e)[:200], "name": name}
            return False

    async def _poll_connection(
        self, service_id: str, name: str, service_slug: str, connected_account_id: str
    ):
        """Poll Composio until the connection becomes ACTIVE. Emits status to frontend."""
        logger.info("Polling connection status for %s (%s)...", name, connected_account_id)

        def _emit_status(event: dict):
            """Emit JSON to stdout for Tauri to pick up."""
            import sys
            line = json.dumps(event, ensure_ascii=False)
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

        for attempt in range(60):  # Poll for up to 5 minutes
            await asyncio.sleep(5)

            result = self._api("GET", f"/connected_accounts/{connected_account_id}")
            if not result["ok"]:
                continue

            status = result["data"].get("status", "UNKNOWN")
            logger.debug("Poll %s: status=%s (attempt %d)", name, status, attempt + 1)

            if status == "ACTIVE":
                logger.info("✅ %s connected successfully!", name)
                self._connections[service_id] = {
                    "status": "connected",
                    "name": name,
                    "service_slug": service_slug,
                    "connected_account_id": connected_account_id,
                }
                # Update DB auth_status
                from . import taskbolt_db as db
                db.update_mcp_auth_status(service_id, "ACTIVE")
                # Fetch available tools
                await self._fetch_tools(service_id, service_slug)
                tool_count = len(self._tools.get(service_id, []))
                # Emit connected status to frontend
                _emit_status({
                    "type": "mcp_connect_result",
                    "server_id": service_id,
                    "name": name,
                    "success": True,
                    "status": "connected",
                    "tool_count": tool_count,
                    "error": "",
                })
                return

            if status in ("FAILED", "EXPIRED", "REVOKED"):
                error_msg = f"Connection {status.lower()}. Please try again."
                logger.warning("%s connection %s", name, status)
                self._connections[service_id] = {
                    "status": "error",
                    "error": error_msg,
                    "name": name,
                }
                # Update DB auth_status
                from . import taskbolt_db as db
                db.update_mcp_auth_status(service_id, "FAILED")
                # Emit error to frontend
                _emit_status({
                    "type": "mcp_connect_result",
                    "server_id": service_id,
                    "name": name,
                    "success": False,
                    "status": "error",
                    "tool_count": 0,
                    "error": error_msg,
                })
                return

        # Timeout
        if self._connections.get(service_id, {}).get("status") == "auth_pending":
            error_msg = "Authentication timed out. Please try again."
            self._connections[service_id] = {
                "status": "error",
                "error": error_msg,
                "name": name,
            }
            _emit_status({
                "type": "mcp_connect_result",
                "server_id": service_id,
                "name": name,
                "success": False,
                "status": "error",
                "tool_count": 0,
                "error": error_msg,
            })

    async def _fetch_tools(self, service_id: str, service_slug: str):
        """Fetch available tools for a connected service."""
        composio_slug = SLUG_MAP.get(service_slug, service_slug)
        result = self._api("GET", f"/toolkits/{composio_slug}")

        tools = []
        if result["ok"]:
            toolkit_data = result["data"]
            # Get actions/tools from toolkit
            actions = toolkit_data.get("actions", toolkit_data.get("tools", []))
            for action in actions[:30]:
                tool_name = action.get("slug", action.get("name", ""))
                tool_desc = action.get("description", "")[:200]
                tool_params = action.get("input_parameters", action.get("parameters", {}))
                if not isinstance(tool_params, dict):
                    tool_params = {}
                tools.append({
                    "name": tool_name,
                    "description": tool_desc,
                    "input_schema": tool_params,
                })

        self._tools[service_id] = tools
        conn = self._connections.get(service_id, {})
        conn["tool_count"] = len(tools)
        logger.info("Fetched %d tools for %s", len(tools), service_id)

    async def disconnect_service(self, service_id: str):
        """Disconnect a service."""
        # Clean up session
        self._sessions.pop(service_id, None)
        self._connections.pop(service_id, None)
        self._tools.pop(service_id, None)
        logger.info("Composio service disconnected: %s", service_id)

    async def disconnect_all(self):
        ids = list(self._connections.keys())
        for sid in ids:
            await self.disconnect_service(sid)

    # ═══════════════════════════════════════════════════════════════════
    # TOOL EXECUTION
    # ═══════════════════════════════════════════════════════════════════

    async def call_tool(self, qualified_name: str, arguments: Dict) -> Dict:
        """Call a Composio tool via tool router session."""
        parts = qualified_name.split("__", 2)
        if len(parts) != 3 or parts[0] != "composio":
            return {"output": f"Invalid Composio tool name: {qualified_name}", "exit_code": 1}

        service_id = parts[1]
        tool_name = parts[2]

        conn = self._connections.get(service_id)
        if not conn or conn.get("status") != "connected":
            return {"output": f"Composio service not connected: {service_id}", "exit_code": 1}

        try:
            connected_account_id = conn.get("connected_account_id")

            # Ensure we have a tool router session
            session_id = self._sessions.get(service_id)
            if not session_id:
                session_id = await self._create_session(service_id, connected_account_id)
                if not session_id:
                    return {"output": "Failed to create tool execution session", "exit_code": 1}

            # Execute tool through session
            result = self._api("POST", f"/tool_router/session/{session_id}/execute", {
                "tool_slug": tool_name,
                "arguments": arguments,
            }, timeout=30)

            if result["ok"]:
                data = result["data"]
                output = json.dumps(data, indent=2, default=str)
                return {"output": output[:15000] if output else "(no output)", "exit_code": 0}
            else:
                error_msg = result.get("error", "Unknown error")[:500]
                # If session expired, recreate it
                if result.get("status") in (404, 410):
                    self._sessions.pop(service_id, None)
                    return {"output": f"Session expired, retrying... Tool: {tool_name}", "exit_code": 1}
                return {"output": f"Composio execution error: {error_msg}", "exit_code": 1}

        except Exception as e:
            logger.error("Composio tool call failed: %s: %s", qualified_name, e)
            return {"output": f"Composio tool error: {e}", "exit_code": 1}

    async def _create_session(self, service_id: str, connected_account_id: str) -> Optional[str]:
        """Create a tool router session for a service."""
        composio_slug = SLUG_MAP.get(
            self._connections.get(service_id, {}).get("service_slug", ""), ""
        )
        if not composio_slug:
            return None

        auth_config_id = AUTH_CONFIG_IDS.get(
            self._connections.get(service_id, {}).get("service_slug", "")
        )

        result = self._api("POST", "/labs/tool_router/session", {
            "user_id": self._user_id,
            "config": {
                "enabled_toolkits": {
                    composio_slug: {
                        "auth_config_ids": [auth_config_id] if auth_config_id else []
                    }
                }
            },
            "connected_accounts": {
                composio_slug: [connected_account_id]
            },
        }, timeout=20)

        if result["ok"]:
            session_id = result["data"].get("session_id", result["data"].get("id"))
            self._sessions[service_id] = session_id
            logger.info("Created tool router session: %s for %s", session_id, service_id)
            return session_id
        else:
            logger.error("Failed to create session: %s", result.get("error", "")[:200])
            return None

    def is_composio_tool(self, tool_name: str) -> bool:
        return tool_name.startswith("composio__")

    # ═══════════════════════════════════════════════════════════════════
    # TOOL SCHEMAS
    # ═══════════════════════════════════════════════════════════════════

    def get_openai_tool_schemas(self) -> List[Dict]:
        schemas = []
        for service_id, tools in self._tools.items():
            conn = self._connections.get(service_id, {})
            if conn.get("status") != "connected":
                continue
            service_name = conn.get("name", service_id)
            for tool in tools:
                qualified_name = f"composio__{service_id}__{tool['name']}"
                input_schema = tool.get("input_schema", {"type": "object", "properties": {}})
                if not isinstance(input_schema, dict):
                    input_schema = {"type": "object", "properties": {}}
                if "type" not in input_schema:
                    input_schema["type"] = "object"
                schemas.append({
                    "type": "function",
                    "function": {
                        "name": qualified_name,
                        "description": f"[{service_name}] {tool['description'][:200]}",
                        "parameters": input_schema,
                    },
                })
        return schemas

    # ═══════════════════════════════════════════════════════════════════
    # STATUS
    # ═══════════════════════════════════════════════════════════════════

    def get_all_statuses(self) -> Dict[str, Dict]:
        return dict(self._connections)

    def get_status(self, service_id: str) -> Dict:
        return self._connections.get(service_id, {"status": "disconnected"})

    def get_connected_count(self) -> int:
        return sum(1 for c in self._connections.values() if c.get("status") == "connected")

    def get_total_tools(self) -> int:
        return sum(len(tools) for tools in self._tools.values())

    def get_tool_descriptions_for_prompt(self) -> str:
        all_tools = []
        for service_id, tools in self._tools.items():
            conn = self._connections.get(service_id, {})
            if conn.get("status") != "connected":
                continue
            service_name = conn.get("name", service_id)
            for tool in tools:
                all_tools.append({
                    "service_name": service_name,
                    "name": f"composio__{service_id}__{tool['name']}",
                    "description": tool.get("description", "")[:120],
                })
        if not all_tools:
            return ""
        lines = ["\n\n## Connected Apps (via Composio)"]
        by_service: Dict[str, list] = {}
        for t in all_tools:
            sn = t["service_name"]
            if sn not in by_service:
                by_service[sn] = []
            by_service[sn].append(t)
        for service_name, service_tools in by_service.items():
            lines.append(f"\n**{service_name}:**")
            for t in service_tools:
                lines.append(f"  - `{t['name']}`: {t['description']}")
        return "\n".join(lines)

    @staticmethod
    def list_available_services() -> List[Dict]:
        return [
            {"id": "gmail", "name": "Gmail", "slug": "gmail", "category": "Communication"},
            {"id": "google-calendar", "name": "Calendar", "slug": "google-calendar", "category": "Productivity"},
            {"id": "google-drive", "name": "Drive", "slug": "google-drive", "category": "Storage"},
            {"id": "google-sheets", "name": "Google Sheets", "slug": "google-sheets", "category": "Spreadsheets"},
            {"id": "youtube", "name": "YouTube", "slug": "youtube", "category": "Media"},
            {"id": "github", "name": "GitHub", "slug": "github", "category": "Development"},
            {"id": "slack", "name": "Slack", "slug": "slack", "category": "Communication"},
            {"id": "notion", "name": "Notion", "slug": "notion", "category": "Productivity"},
            {"id": "discord", "name": "Discord", "slug": "discord", "category": "Communication"},
            {"id": "linkedin", "name": "LinkedIn", "slug": "linkedin", "category": "Social"},
            {"id": "trello", "name": "Trello", "slug": "trello", "category": "Productivity"},
            {"id": "asana", "name": "Asana", "slug": "asana", "category": "Productivity"},
            {"id": "linear", "name": "Linear", "slug": "linear", "category": "Development"},
            {"id": "outlook", "name": "Outlook", "slug": "outlook", "category": "Communication"},
            {"id": "figma", "name": "Figma", "slug": "figma", "category": "Design"},
            {"id": "dropbox", "name": "Dropbox", "slug": "dropbox", "category": "Storage"},
            {"id": "zoom", "name": "Zoom", "slug": "zoom", "category": "Communication"},
        ]
