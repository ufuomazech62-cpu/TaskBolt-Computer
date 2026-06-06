"""
TaskBolt Auth — JWT validation via Vercel SaaS proxy.
Replaces Odysseus bcrypt/file-based auth entirely.

Flow:
1. Tauri sends JWT on engine startup
2. Engine validates JWT against taskbolt.space/api/account
3. User context cached for session lifetime
4. Every LLM call carries the JWT (billing/credits enforced server-side)
"""

import json
import os
import time
import logging
from pathlib import Path
from typing import Optional, Dict, Any

import httpx

logger = logging.getLogger("taskbolt.auth")

# TaskBolt SaaS base URL — hardcoded, never read from env var
SAAS_BASE = "https://taskbolt.space"

# Local auth cache
_auth_cache: Optional[Dict[str, Any]] = None
_token: Optional[str] = None
_token_expiry: float = 0


def set_token(jwt_token: str) -> None:
    """Store the JWT token received from Tauri on login."""
    global _token, _auth_cache, _token_expiry
    _token = jwt_token
    _auth_cache = None  # Clear cache on new token
    _token_expiry = 0
    logger.info("JWT token set for TaskBolt engine")


def get_token() -> Optional[str]:
    """Get the current JWT token."""
    return _token


def get_headers() -> Dict[str, str]:
    """Get authorization headers for SaaS API calls."""
    if not _token:
        return {}
    return {
        "Authorization": "Bearer " + _token,
        "Content-Type": "application/json",
    }


async def validate_token() -> Optional[Dict[str, Any]]:
    """
    Validate the current JWT against the SaaS backend.
    Returns user info dict or None if invalid.
    Caches result for 5 minutes.
    """
    global _auth_cache, _token_expiry

    if not _token:
        logger.warning("No JWT token set")
        return None

    # Return cached if fresh (< 5 min old)
    if _auth_cache and time.time() < _token_expiry:
        return _auth_cache

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                SAAS_BASE + "/api/account",
                headers=get_headers(),
            )
            if resp.status_code == 200:
                _auth_cache = resp.json()
                _token_expiry = time.time() + 300  # 5 min cache
                logger.info("Auth validated for user: %s", _auth_cache.get("email", "unknown"))
                return _auth_cache
            else:
                logger.error("Auth validation failed: %d", resp.status_code)
                return None
    except Exception as e:
        logger.error("Auth validation error: %s", e)
        # If network fails, allow cached auth (offline mode)
        if _auth_cache:
            logger.warning("Using cached auth (network unavailable)")
            return _auth_cache
        return None


def get_user_id() -> Optional[str]:
    """Get the current user's ID from cached auth."""
    if _auth_cache:
        return _auth_cache.get("id") or _auth_cache.get("userId")
    return None


def get_user_email() -> Optional[str]:
    """Get the current user's email from cached auth."""
    if _auth_cache:
        return _auth_cache.get("email")
    return None


def is_authenticated() -> bool:
    """Quick check if we have a token (doesn't validate)."""
    return _token is not None


def clear_auth():
    """Clear all auth state (logout)."""
    global _token, _auth_cache, _token_expiry
    _token = None
    _auth_cache = None
    _token_expiry = 0
    logger.info("Auth cleared")


def save_token_to_disk(jwt_token: str) -> None:
    """Persist token to ~/.taskbolt/auth.json for auto-login."""
    auth_dir = Path.home() / ".taskbolt"
    auth_dir.mkdir(exist_ok=True)
    auth_file = auth_dir / "auth.json"
    try:
        data = {"token": jwt_token, "saved_at": time.time()}
        auth_file.write_text(json.dumps(data, indent=2))
        os.chmod(auth_file, 0o600)  # Owner-only read
        logger.info("Token saved to disk")
    except Exception as e:
        logger.error("Failed to save token: %s", e)


def load_token_from_disk() -> Optional[str]:
    """Load persisted token from ~/.taskbolt/auth.json."""
    auth_file = Path.home() / ".taskbolt" / "auth.json"
    if not auth_file.exists():
        return None
    try:
        data = json.loads(auth_file.read_text())
        token = data.get("token")
        if token:
            set_token(token)
            return token
        return None
    except Exception as e:
        logger.error("Failed to load token: %s", e)
        return None
