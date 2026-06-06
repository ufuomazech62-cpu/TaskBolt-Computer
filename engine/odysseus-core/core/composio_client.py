"""
composio_client.py — TaskBolt Composio Integration

Manages connections to external services via Composio's unified API.
Users authenticate through normal OAuth flows (Sign in with Google, GitHub, etc.)
and Composio handles the token management behind the scenes.

Architecture:
  - ComposioClient singleton manages all service connections
  - Services identified by slug (gmail, github, slack, etc.)
  - Auth handled via Composio's OAuth redirect URLs
  - Browser opens for user to complete login
  - Tools exposed in OpenAI function-calling format
  - Graceful degradation if composio SDK is unavailable
"""

import asyncio
import json
import logging
import os
import subprocess
import sys
import webbrowser
from typing import Any, Dict, List, Optional

logger = logging.getLogger("taskbolt.composio")

# Global singleton
_client: Optional["ComposioClient"] = None


def get_client() -> "ComposioClient":
    """Get or create the global Composio client singleton."""
    global _client
    if _client is None:
        _client = ComposioClient()
    return _client


# Map our service IDs to Composio app names
COMPOSIO_APP_MAP = {
    "gmail": "GMAIL",
    "google-calendar": "GOOGLECALENDAR",
    "google-drive": "GOOGLEDRIVE",
    "google-docs": "GOOGLEDOCS",
    "google-sheets": "GOOGLESHEETS",
    "google-workspace": "GOOGLE_WORKSPACE",
    "github": "GITHUB",
    "slack": "SLACK",
    "notion": "NOTION",
    "vercel": "VERCEL",
    "youtube": "YOUTUBE",
    "twitter": "TWITTER",
    "x": "TWITTER",
    "linkedin": "LINKEDIN",
    "discord": "DISCORD",
    "trello": "TRELLO",
    "asana": "ASANA",
    "linear": "LINEAR",
    "outlook": "OUTLOOK",
    "microsoft-excel": "MICROSOFTEXCEL",
    "microsoft-word": "MICROSOFTWORD",
    "microsoft-powerpoint": "MICROSOFTPOWERPOINT",
    "wordpress": "WORDPRESS",
    "shopify": "SHOPIFY",
    "canva": "CANVA",
    "elevenlabs": "ELEVENLABS",
    "figma": "FIGMA",
    "dropbox": "DROPBOX",
    "zoom": "ZOOM",
}


class ComposioClient:
    """Manages Composio service connections and tool routing for TaskBolt."""

    def __init__(self):
        self._connections: Dict[str, Dict[str, Any]] = {}  # service_id -> status info
        self._tools: Dict[str, List[Dict]] = {}  # service_id -> tool schemas
        self._available = False
        self._api_key: Optional[str] = None
        self._toolset = None
        self._check_availability()

    def _check_availability(self):
        """Check if the composio SDK is installed."""
        try:
            from composio import ComposioToolSet  # noqa: F401
            self._available = True
            # Load API key from environment or config
            self._api_key = os.environ.get("COMPOSIO_API_KEY")
            if self._api_key:
                try:
                    self._toolset = ComposioToolSet(api_key=self._api_key)
                    logger.info("Composio SDK available, API key loaded — Composio connectors enabled")
                except Exception as e:
                    logger.warning("Composio SDK available but failed to initialize: %s", e)
                    self._toolset = None
            else:
                logger.warning("Composio SDK available but no API key. Set COMPOSIO_API_KEY environment variable.")
        except ImportError:
            self._available = False
            logger.warning("Composio SDK not installed. Install: pip install composio-core")

    @property
    def is_available(self) -> bool:
        return self._available and bool(self._api_key) and self._toolset is not None

    def set_api_key(self, key: str):
        """Set the Composio API key."""
        self._api_key = key
        os.environ["COMPOSIO_API_KEY"] = key
        try:
            from composio import ComposioToolSet
            self._toolset = ComposioToolSet(api_key=key)
        except Exception as e:
            logger.warning("Failed to reinitialize Composio with new key: %s", e)
        logger.info("Composio API key configured")

    # ═══════════════════════════════════════════════════════════════════
    # SERVICE CONNECTION — opens browser for OAuth
    # ═══════════════════════════════════════════════════════════════════

    async def connect_service(
        self,
        service_id: str,
        name: str,
        service_slug: str,
        auth_token: Optional[str] = None,
    ) -> bool:
        """Connect to a Composio service. Opens browser for OAuth. Returns True on success."""
        if not self.is_available:
            error_msg = "Composio SDK not available"
            if not self._available:
                error_msg = "Composio SDK not installed. Run: pip install composio-core"
            elif not self._api_key:
                error_msg = "Composio API key not configured"
            logger.warning("Composio not available, skipping connect for %s: %s", name, error_msg)
            self._connections[service_id] = {
                "status": "error",
                "error": error_msg,
                "name": name,
            }
            return False

        # Disconnect existing connection if any
        if service_id in self._connections:
            await self.disconnect_service(service_id)

        try:
            # Get the Composio app name
            app_name = COMPOSIO_APP_MAP.get(service_slug, service_slug.upper())
            
            logger.info("Initiating Composio connection for %s (app: %s)", name, app_name)
            
            # Initiate the OAuth connection — this opens the browser
            redirect_url = None
            try:
                # Try the initiate_connection method
                result = self._toolset.initiate_connection(app_name=app_name)
                
                # result could be a dict with redirect_url or a connection object
                if isinstance(result, dict):
                    redirect_url = result.get("redirectUrl") or result.get("redirect_url") or result.get("url")
                elif hasattr(result, "redirectUrl"):
                    redirect_url = result.redirectUrl
                elif hasattr(result, "redirect_url"):
                    redirect_url = result.redirect_url
                elif isinstance(result, str):
                    redirect_url = result
                    
            except Exception as e:
                logger.warning("initiate_connection failed: %s, trying get_connected_accounts...", e)
                # Check if already connected
                try:
                    accounts = self._toolset.get_connected_accounts()
                    if accounts:
                        logger.info("Found existing Composio accounts, checking for %s", app_name)
                        # Already connected — get tools directly
                        return await self._finalize_connection(service_id, name, service_slug, app_name)
                except Exception:
                    pass
                # Try alternate method
                try:
                    from composio import App
                    app = getattr(App, app_name, None)
                    if app:
                        result = self._toolset.initiate_connection(app=app)
                        if isinstance(result, dict):
                            redirect_url = result.get("redirectUrl") or result.get("redirect_url")
                        elif hasattr(result, "redirectUrl"):
                            redirect_url = result.redirectUrl
                except Exception as e2:
                    logger.error("All Composio connection methods failed: %s", e2)

            if redirect_url:
                # Open the browser for the user to complete OAuth
                logger.info("Opening browser for %s OAuth: %s", name, redirect_url[:200])
                
                # Try multiple methods to open the browser
                browser_opened = False
                try:
                    # Method 1: webbrowser module
                    result = webbrowser.open(redirect_url, new=2)
                    if result:
                        browser_opened = True
                        logger.info("Browser opened via webbrowser module")
                except Exception as e:
                    logger.warning("webbrowser.open failed: %s", e)
                
                if not browser_opened:
                    try:
                        # Method 2: os.startfile on Windows
                        import platform
                        if platform.system() == 'Windows':
                            os.startfile(redirect_url)
                            browser_opened = True
                            logger.info("Browser opened via os.startfile")
                    except Exception as e:
                        logger.warning("os.startfile failed: %s", e)
                
                if not browser_opened:
                    # Method 3: subprocess with common browsers
                    try:
                        import subprocess
                        if platform.system() == 'Windows':
                            # Try Edge, Chrome, Firefox
                            for browser_cmd in ['start msedge', 'start chrome', 'start firefox']:
                                try:
                                    subprocess.Popen(f'{browser_cmd} "{redirect_url}"', shell=True)
                                    browser_opened = True
                                    logger.info("Browser opened via subprocess: %s", browser_cmd)
                                    break
                                except:
                                    continue
                    except Exception as e:
                        logger.error("All browser opening methods failed: %s", e)
                
                if not browser_opened:
                    logger.error("CRITICAL: Could not open browser for %s OAuth", name)
                    self._connections[service_id] = {
                        "status": "error",
                        "name": name,
                        "error": f"Could not open browser. Please manually visit: {redirect_url}",
                    }
                    return False
                
                self._connections[service_id] = {
                    "status": "auth_pending",
                    "name": name,
                    "service_slug": service_slug,
                    "redirect_url": redirect_url,
                }
                
                # Start polling for completion in background
                asyncio.create_task(self._poll_connection_status(service_id, name, service_slug, app_name))
                return True
            
            # No redirect URL — might already be connected
            return await self._finalize_connection(service_id, name, service_slug, app_name)

        except Exception as e:
            logger.error("Failed to connect Composio service %s (%s): %s", name, service_slug, e)
            self._connections[service_id] = {
                "status": "error",
                "error": str(e)[:200],
                "name": name,
            }
            return False

    async def _poll_connection_status(self, service_id: str, name: str, service_slug: str, app_name: str):
        """Poll Composio to check if the user completed the OAuth flow."""
        for attempt in range(30):  # Poll for up to 5 minutes
            await asyncio.sleep(10)
            try:
                # Check if the connection is now active
                result = await self._finalize_connection(service_id, name, service_slug, app_name)
                if result:
                    return
            except Exception:
                pass
        
        # Timed out
        if self._connections.get(service_id, {}).get("status") == "auth_pending":
            self._connections[service_id] = {
                "status": "error",
                "error": "Authentication timed out. Please try again.",
                "name": name,
            }

    async def _finalize_connection(self, service_id: str, name: str, service_slug: str, app_name: str) -> bool:
        """Check if service is connected and get tools."""
        try:
            # Get tools for this service
            tools = []
            try:
                from composio import App
                app = getattr(App, app_name, None)
                if app:
                    actions = self._toolset.get_tools(apps=[app])
                    for action in actions:
                        tool_name = action.name if hasattr(action, 'name') else str(action)
                        tool_desc = action.description if hasattr(action, 'description') else ""
                        tool_params = {}
                        if hasattr(action, 'parameters'):
                            tool_params = action.parameters
                        elif hasattr(action, 'input_schema'):
                            tool_params = action.input_schema
                        tools.append({
                            "name": tool_name,
                            "description": tool_desc or "",
                            "input_schema": tool_params if isinstance(tool_params, dict) else {},
                        })
            except Exception as e:
                logger.warning("Failed to get tools for %s: %s", service_slug, e)

            self._tools[service_id] = tools
            self._connections[service_id] = {
                "status": "connected",
                "name": name,
                "service_slug": service_slug,
                "tool_count": len(tools),
            }

            logger.info("Composio service connected: %s (%s) — %d tools", name, service_slug, len(tools))
            return True

        except Exception as e:
            logger.error("Failed to finalize Composio connection %s: %s", service_slug, e)
            return False

    async def disconnect_service(self, service_id: str):
        """Disconnect from a Composio service and clean up."""
        self._connections.pop(service_id, None)
        self._tools.pop(service_id, None)
        logger.info("Composio service disconnected: %s", service_id)

    async def disconnect_all(self):
        """Disconnect from all Composio services."""
        ids = list(self._connections.keys())
        for sid in ids:
            await self.disconnect_service(sid)

    # ═══════════════════════════════════════════════════════════════════
    # TOOL DISCOVERY & ROUTING
    # ═══════════════════════════════════════════════════════════════════

    def get_openai_tool_schemas(self) -> List[Dict]:
        """Return all Composio tools in OpenAI function-calling format."""
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

    async def call_tool(self, qualified_name: str, arguments: Dict) -> Dict:
        """Call a Composio tool by its qualified name."""
        parts = qualified_name.split("__", 2)
        if len(parts) != 3 or parts[0] != "composio":
            return {"output": f"Invalid Composio tool name: {qualified_name}", "exit_code": 1}

        service_id = parts[1]
        tool_name = parts[2]

        conn = self._connections.get(service_id)
        if not conn or conn.get("status") != "connected":
            return {"output": f"Composio service not connected: {service_id}", "exit_code": 1}

        try:
            result = self._toolset.execute_action(
                action=tool_name,
                params=arguments,
            )

            output = json.dumps(result, indent=2, default=str) if isinstance(result, dict) else str(result)
            
            return {
                "output": output[:15000] if output else "(no output)",
                "exit_code": 0,
            }

        except Exception as e:
            logger.error("Composio tool call failed: %s: %s", qualified_name, e)
            return {"output": f"Composio tool error: {e}", "exit_code": 1}

    def is_composio_tool(self, tool_name: str) -> bool:
        """Check if a tool name is a Composio tool."""
        return tool_name.startswith("composio__")

    # ═══════════════════════════════════════════════════════════════════
    # STATUS & MANAGEMENT
    # ═══════════════════════════════════════════════════════════════════

    def get_all_statuses(self) -> Dict[str, Dict]:
        """Get connection statuses for all services."""
        return dict(self._connections)

    def get_status(self, service_id: str) -> Dict:
        """Get status for a specific service."""
        return self._connections.get(service_id, {"status": "disconnected"})

    def get_connected_count(self) -> int:
        """Count of currently connected services."""
        return sum(1 for c in self._connections.values() if c.get("status") == "connected")

    def get_total_tools(self) -> int:
        """Total number of Composio tools across all connected services."""
        return sum(len(tools) for tools in self._tools.values())

    def get_tool_descriptions_for_prompt(self) -> str:
        """Generate a text summary of Composio tools for the system prompt."""
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
        """List all Composio services that TaskBolt supports."""
        return [
            {"id": "gmail", "name": "Gmail", "slug": "gmail", "category": "Communication"},
            {"id": "google-calendar", "name": "Calendar", "slug": "google-calendar", "category": "Productivity"},
            {"id": "google-drive", "name": "Drive", "slug": "google-drive", "category": "Storage"},
            {"id": "google-docs", "name": "Google Docs", "slug": "google-docs", "category": "Documents"},
            {"id": "google-sheets", "name": "Google Sheets", "slug": "google-sheets", "category": "Spreadsheets"},
            {"id": "youtube", "name": "YouTube", "slug": "youtube", "category": "Media"},
            {"id": "github", "name": "GitHub", "slug": "github", "category": "Development"},
            {"id": "slack", "name": "Slack", "slug": "slack", "category": "Communication"},
            {"id": "notion", "name": "Notion", "slug": "notion", "category": "Productivity"},
            {"id": "vercel", "name": "Vercel", "slug": "vercel", "category": "Development"},
            {"id": "twitter", "name": "X (Twitter)", "slug": "twitter", "category": "Social"},
            {"id": "linkedin", "name": "LinkedIn", "slug": "linkedin", "category": "Social"},
            {"id": "discord", "name": "Discord", "slug": "discord", "category": "Communication"},
            {"id": "trello", "name": "Trello", "slug": "trello", "category": "Productivity"},
            {"id": "asana", "name": "Asana", "slug": "asana", "category": "Productivity"},
            {"id": "linear", "name": "Linear", "slug": "linear", "category": "Development"},
            {"id": "outlook", "name": "Outlook", "slug": "outlook", "category": "Communication"},
            {"id": "microsoft-powerpoint", "name": "PowerPoint", "slug": "microsoft-powerpoint", "category": "Documents"},
            {"id": "microsoft-excel", "name": "Excel", "slug": "microsoft-excel", "category": "Spreadsheets"},
            {"id": "microsoft-word", "name": "Word", "slug": "microsoft-word", "category": "Documents"},
            {"id": "wordpress", "name": "WordPress", "slug": "wordpress", "category": "Web"},
            {"id": "shopify", "name": "Shopify", "slug": "shopify", "category": "Commerce"},
            {"id": "canva", "name": "Canva", "slug": "canva", "category": "Design"},
            {"id": "figma", "name": "Figma", "slug": "figma", "category": "Design"},
            {"id": "dropbox", "name": "Dropbox", "slug": "dropbox", "category": "Storage"},
            {"id": "zoom", "name": "Zoom", "slug": "zoom", "category": "Communication"},
        ]
