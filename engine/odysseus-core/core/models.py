# core/models.py
"""
Pure data models — no database logic, no side effects.
TaskBolt uses taskbolt_db.py for persistence.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Any, Optional


@dataclass
class ChatMessage:
    """A single chat message."""
    role: str
    content: str
    metadata: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        result = {"role": self.role, "content": self.content}
        if self.metadata:
            result["metadata"] = self.metadata
        return result

    def get(self, key: str, default=None):
        return getattr(self, key, default)


@dataclass
class Session:
    """A chat session — pure data container."""
    id: str
    name: str = "New Chat"
    model: str = "qwen-plus"
    mode: str = "chat"
    history: List[ChatMessage] = field(default_factory=list)
    owner: Optional[str] = None
    message_count: int = 0

    def add_message(self, message: ChatMessage):
        self.history.append(message)
        self.message_count = len(self.history)

    def get_context_messages(self) -> List[Dict[str, Any]]:
        return [
            msg.to_dict()
            for msg in self.history
            if (msg.metadata or {}).get("source") != "slash"
        ]

    def get(self, key: str, default=None):
        return getattr(self, key, default)
