"""
TaskBolt Local Database — Lightweight SQLite for desktop engine.
Replaces Odysseus SQLAlchemy ORM with simple, direct SQLite.

Stores locally:
- Chat sessions & messages (history)
- Memory entries (4-category system)
- User preferences & settings
- MCP server configs

Synced to SaaS (Neon) via Vercel API:
- User account & auth
- Credits & billing
- Tasks & Skills (future sync)
"""

import json
import os
import sqlite3
import time
import logging
from pathlib import Path
from typing import Optional, List, Dict, Any
from contextlib import contextmanager

logger = logging.getLogger("taskbolt.db")

# Database location
DB_DIR = Path(os.environ.get("TASKBOLT_DATA_DIR", str(Path.home() / ".taskbolt" / "data")))
DB_PATH = DB_DIR / "taskbolt.db"


def init_db():
    """Create database tables if they don't exist."""
    DB_DIR.mkdir(parents=True, exist_ok=True)

    with get_connection() as conn:
        conn.executescript("""
            -- Chat sessions
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                name TEXT DEFAULT 'New Chat',
                model TEXT DEFAULT 'qwen-plus',
                mode TEXT DEFAULT 'chat',
                created_at REAL DEFAULT (strftime('%s', 'now')),
                updated_at REAL DEFAULT (strftime('%s', 'now')),
                message_count INTEGER DEFAULT 0,
                metadata TEXT DEFAULT '{}'
            );

            -- Chat messages
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                metadata TEXT DEFAULT '{}',
                created_at REAL DEFAULT (strftime('%s', 'now')),
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            -- Memory entries (4-category system)
            CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                category TEXT NOT NULL DEFAULT 'facts',
                content TEXT NOT NULL,
                importance INTEGER DEFAULT 5,
                created_at REAL DEFAULT (strftime('%s', 'now')),
                updated_at REAL DEFAULT (strftime('%s', 'now'))
            );

            -- User preferences
            CREATE TABLE IF NOT EXISTS preferences (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at REAL DEFAULT (strftime('%s', 'now'))
            );

            -- MCP server configs
            CREATE TABLE IF NOT EXISTS mcp_servers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                url TEXT,
                transport TEXT DEFAULT 'stdio',
                command TEXT,
                args TEXT DEFAULT '[]',
                enabled INTEGER DEFAULT 1,
                auth_status TEXT DEFAULT 'NONE',
                created_at REAL DEFAULT (strftime('%s', 'now'))
            );

            -- Indexes
            CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category, created_at DESC);
        """)

        # Migration: add auth_status column if missing (for existing databases)
        try:
            conn.execute("ALTER TABLE mcp_servers ADD COLUMN auth_status TEXT DEFAULT 'NONE'")
            logger.info("Migrated: added auth_status column to mcp_servers")
        except sqlite3.OperationalError:
            pass  # Column already exists

    logger.info("Database initialized at %s", DB_PATH)


@contextmanager
def get_connection():
    """Get a database connection with auto-commit/rollback."""
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# === Sessions ===

def create_session(session_id: str, name: str = "New Chat", model: str = "qwen-plus") -> Dict[str, Any]:
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO sessions (id, name, model) VALUES (?, ?, ?)",
            (session_id, name, model),
        )
    return {"id": session_id, "name": name, "model": model}


def get_session(session_id: str) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if row:
            return dict(row)
    return None


def list_sessions(limit: int = 50) -> List[Dict[str, Any]]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]


def update_session(session_id: str, **kwargs):
    fields = ", ".join(f"{k} = ?" for k in kwargs)
    values = list(kwargs.values()) + [session_id]
    with get_connection() as conn:
        conn.execute(f"UPDATE sessions SET {fields} WHERE id = ?", values)


def delete_session(session_id: str):
    with get_connection() as conn:
        conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))


# === Messages ===

def add_message(session_id: str, role: str, content: str, metadata: Optional[Dict] = None) -> int:
    meta_json = json.dumps(metadata or {})
    with get_connection() as conn:
        cursor = conn.execute(
            "INSERT INTO messages (session_id, role, content, metadata) VALUES (?, ?, ?, ?)",
            (session_id, role, content, meta_json),
        )
        msg_id = cursor.lastrowid
        # Update session timestamp and count
        conn.execute(
            "UPDATE sessions SET updated_at = strftime('%s', 'now'), message_count = message_count + 1 WHERE id = ?",
            (session_id,),
        )
        return msg_id


def get_messages(session_id: str, limit: int = 100) -> List[Dict[str, Any]]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?",
            (session_id, limit),
        ).fetchall()
        results = []
        for r in rows:
            d = dict(r)
            d["metadata"] = json.loads(d.get("metadata", "{}"))
            results.append(d)
        return results


def get_conversation_context(session_id: str, max_messages: int = 90) -> List[Dict[str, str]]:
    """Get messages formatted for LLM context (role + content only)."""
    messages = get_messages(session_id, limit=max_messages)
    return [{"role": m["role"], "content": m["content"]} for m in messages]


# === Memories ===

def add_memory(category: str, content: str, importance: int = 5, memory_id: Optional[str] = None) -> str:
    import uuid
    mid = memory_id or str(uuid.uuid4())
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO memories (id, category, content, importance) VALUES (?, ?, ?, ?)",
            (mid, category, content, importance),
        )
    return mid


def get_memories(category: Optional[str] = None, limit: int = 100) -> List[Dict[str, Any]]:
    with get_connection() as conn:
        if category:
            rows = conn.execute(
                "SELECT * FROM memories WHERE category = ? ORDER BY created_at DESC LIMIT ?",
                (category, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM memories ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]


def search_memories(query: str, limit: int = 10) -> List[Dict[str, Any]]:
    """Simple text search in memories."""
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM memories WHERE content LIKE ? ORDER BY importance DESC, created_at DESC LIMIT ?",
            (f"%{query}%", limit),
        ).fetchall()
        return [dict(r) for r in rows]


def delete_memory(memory_id: str):
    with get_connection() as conn:
        conn.execute("DELETE FROM memories WHERE id = ?", (memory_id,))


# === Preferences ===

def get_preference(key: str, default: Any = None) -> Any:
    with get_connection() as conn:
        row = conn.execute("SELECT value FROM preferences WHERE key = ?", (key,)).fetchone()
        if row:
            try:
                return json.loads(row["value"])
            except (json.JSONDecodeError, TypeError):
                return row["value"]
    return default


def set_preference(key: str, value: Any):
    json_val = json.dumps(value)
    with get_connection() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES (?, ?, strftime('%s', 'now'))",
            (key, json_val),
        )


# === MCP Servers ===

def get_mcp_servers() -> List[Dict[str, Any]]:
    with get_connection() as conn:
        rows = conn.execute("SELECT * FROM mcp_servers ORDER BY name").fetchall()
        results = []
        for r in rows:
            d = dict(r)
            d["args"] = json.loads(d.get("args", "[]"))
            d["enabled"] = bool(d.get("enabled", 1))
            if "auth_status" not in d:
                d["auth_status"] = "NONE"
            results.append(d)
        return results


def save_mcp_server(server_id: str, name: str, transport: str = "stdio",
                    url: str = None, command: str = None, args: list = None, enabled: bool = True,
                    auth_status: str = "NONE"):
    args_json = json.dumps(args or [])
    with get_connection() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO mcp_servers 
               (id, name, url, transport, command, args, enabled, auth_status) 
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (server_id, name, url, transport, command, args_json, 1 if enabled else 0, auth_status),
        )


def update_mcp_auth_status(server_id: str, auth_status: str):
    """Update the auth_status of an MCP server (NONE, PENDING, ACTIVE, FAILED)."""
    with get_connection() as conn:
        conn.execute("UPDATE mcp_servers SET auth_status = ? WHERE id = ?", (auth_status, server_id))


def delete_mcp_server(server_id: str):
    with get_connection() as conn:
        conn.execute("DELETE FROM mcp_servers WHERE id = ?", (server_id,))


# === Disabled Tools (per-server tool exclusion) ===

def get_disabled_tools() -> set:
    """Return the set of disabled tool names (stored as JSON array in preferences)."""
    try:
        val = get_preference("disabled_tools")
        if val:
            return set(val)
    except Exception:
        pass
    return set()


def set_disabled_tools(tools: set):
    """Save the set of disabled tool names."""
    set_preference("disabled_tools", list(tools))
