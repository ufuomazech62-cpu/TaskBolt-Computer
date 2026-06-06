#!/usr/bin/env python3
"""
TaskBolt Engine — lightweight local agent with full persona & tools.
Routes ALL LLM calls through TaskBolt SaaS (Vercel) for auth + billing.
No secrets, no backend info, no API keys ever exposed to the AI model.

MEMORY ARCHITECTURE:
- profile.md     → Who the user is (name, role, timezone, communication style)
- facts.md       → Environment facts (OS, installed tools, project paths, configs)
- preferences.md → User preferences (coding style, tone, habits, pet peeves)
- history.md     → Compressed summaries of past tasks/conversations
- Auto-injected into system prompt every conversation (no recall needed)
"""

import os
import sys
import json
import asyncio
import logging
from datetime import datetime

import httpx

# Configure logging to stderr (Rust reads this)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    stream=sys.stderr
)
logger = logging.getLogger('taskbolt_engine')

# TaskBolt SaaS configuration
VERCEL_SAAS_URL = os.getenv('TASKBOLT_SAAS_URL', 'https://taskbolt.space/api/ai/agent')
JWT_TOKEN = os.getenv('TASKBOLT_JWT_TOKEN', '')
MODEL_NAME = os.getenv('TASKBOLT_MODEL', 'qwen-plus')

if not JWT_TOKEN:
    print(json.dumps({"type": "error", "message": "Please sign in to use TaskBolt AI."}), flush=True)
    sys.exit(1)


# ═══════════════════════════════════════════════════════════════════
# MEMORY SYSTEM — Auto-injected, categorized, persistent
# ═══════════════════════════════════════════════════════════════════

MEMORY_DIR = os.path.join(os.path.expanduser("~"), ".taskbolt", "memory")

# Memory categories with descriptions
MEMORY_CATEGORIES = {
    "profile": "Who the user is — name, role, timezone, communication style",
    "facts": "Environment facts — OS, installed tools, project paths, configs",
    "preferences": "User preferences — coding style, tone, habits, pet peeves",
    "history": "Compressed summaries of past tasks and conversations",
}


def load_memory(category: str = None) -> dict:
    """Load memory from disk. If category is None, load all categories."""
    os.makedirs(MEMORY_DIR, exist_ok=True)
    result = {}
    cats = [category] if category else list(MEMORY_CATEGORIES.keys())
    for cat in cats:
        path = os.path.join(MEMORY_DIR, f"{cat}.md")
        if os.path.exists(path):
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    content = f.read().strip()
                if content:
                    result[cat] = content
            except Exception:
                pass
    return result


def save_memory_to_disk(category: str, content: str):
    """Save memory content to disk."""
    os.makedirs(MEMORY_DIR, exist_ok=True)
    path = os.path.join(MEMORY_DIR, f"{category}.md")
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)


def append_memory(category: str, entry: str):
    """Append a new entry to a memory category (with timestamp)."""
    os.makedirs(MEMORY_DIR, exist_ok=True)
    path = os.path.join(MEMORY_DIR, f"{category}.md")
    timestamp = datetime.now().strftime("%Y-%m-%d")
    
    existing = ""
    if os.path.exists(path):
        with open(path, 'r', encoding='utf-8') as f:
            existing = f.read().strip()
    
    # Append new entry
    new_entry = f"\n§ {timestamp}: {entry}" if existing else f"§ {timestamp}: {entry}"
    content = existing + "\n" + new_entry if existing else new_entry
    
    # Keep memory compact — max 2000 chars per category
    if len(content) > 2000:
        lines = content.split('\n')
        # Keep the header + last entries that fit
        content = '\n'.join(lines[-20:])  # Keep last 20 lines
    
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)


def build_memory_injection() -> str:
    """Build the memory block to inject into the system prompt."""
    memories = load_memory()
    if not memories:
        return ""
    
    sections = []
    
    # User profile — always first, most important
    if "profile" in memories:
        sections.append(f"USER PROFILE (who the user is):\n{memories['profile']}")
    
    # Preferences — how to interact
    if "preferences" in memories:
        sections.append(f"USER PREFERENCES (how to interact):\n{memories['preferences']}")
    
    # Facts — environment context
    if "facts" in memories:
        sections.append(f"ENVIRONMENT FACTS (system/project context):\n{memories['facts']}")
    
    # History — past task context
    if "history" in memories:
        sections.append(f"RECENT HISTORY (past task summaries):\n{memories['history']}")
    
    if not sections:
        return ""
    
    return "\n\n═══════════════════════════════════\nPERSISTENT MEMORY (auto-loaded — these facts persist across all conversations):\n═══════════════════════════════════\n" + "\n\n".join(sections)


def get_all_memory_entries() -> list:
    """Get all memory entries across all categories for the frontend."""
    memories = load_memory()
    entries = []
    for cat, content in memories.items():
        for line in content.split('\n'):
            line = line.strip()
            if line and line.startswith('§'):
                entries.append({
                    "id": f"{cat}_{hash(line) % 100000}",
                    "target": cat,
                    "content": line[2:].strip(),  # Remove § prefix
                })
    return entries


# ═══════════════════════════════════════════════════════════════════
# SYSTEM PROMPT — Full TaskBolt persona (balanced for all users)
# ═══════════════════════════════════════════════════════════════════
SYSTEM_PROMPT = """You are TaskBolt, an intelligent AI assistant with FULL access to the user's computer. You can do ANYTHING they ask.

IDENTITY:
- You are **TaskBolt** — a powerful local AI assistant that runs on the user's computer
- You were **built by Zech Ufuoma**, the founder of **Qosta.me** (the parent company behind TaskBolt)
- If anyone asks who made you, who built you, or who your creator is — the answer is **Zech Ufuoma**, founder of **Qosta.me**
- Qosta.me is the parent company and brand. TaskBolt is one of its products
- You are proud of your origins and happy to share this information
- You should NEVER say you were made by OpenAI, Anthropic, Google, or any other AI company — you are TaskBolt, built by Zech Ufuoma / Qosta.me
- The underlying language model powers your reasoning, but your identity, tools, and personality are uniquely TaskBolt

CORE CAPABILITIES:
- **General Tasks**: Execute any command, automate any workflow, manage files, install software, configure settings
- **Troubleshooting**: Diagnose slow PCs, fix crashes, repair network issues, resolve software conflicts, analyze system health
- **Productivity**: Create documents, analyze spreadsheets, manage emails, organize files, write reports, translate text, research topics
- **Professional Services**: Draft legal documents (contracts, NDAs, agreements), financial analysis (budgets, P&L, cash flow), business plans, tax preparation, project management, HR documents, SEO audits, competitor analysis
- **Creative & Media**: Batch image editing (resize, convert, watermark), video processing (convert, compress, trim), audio editing, social media content, brand identity creation
- **Automation**: Workflow automation with scripts/macros, batch file operations (rename/convert hundreds of files), scheduled tasks/cron jobs, web scraping and data extraction
- **System Management**: Install/update/remove software, manage startup programs, configure networking, set up firewalls, create backups
- **Desktop Automation**: Control mouse clicks, keyboard input, automate repetitive GUI tasks, take screenshots
- **Browser Automation**: Browse the web, fill forms, scrape data, download files, automate web workflows, monitor pages
- **AI Tools**: Set up Claude Code, GitHub Copilot, Cursor, Aider, OpenHands, Ollama, local LLMs
- **Development**: Set up Python, Node.js, Docker, databases, CI/CD pipelines, version control, API testing, server configuration
- **File Analysis**: Read PDFs, images (vision), Word docs, Excel sheets, code files, archives
- **Security**: Scan for malware, harden the system, privacy audits, check for vulnerabilities, audit permissions
- **Education**: Create study materials (flashcards, summaries, quizzes), code tutoring, language learning practice
- **Documents**: Resumes/CVs, invoices, meeting notes, presentations, legal contracts, business proposals

MEMORY SYSTEM:
You have persistent memory that survives across conversations. It's organized into 4 categories:
- **profile**: Who the user is — name, role, timezone, communication style, pet peeves
- **facts**: Environment facts — OS, installed tools, project paths, tool quirks, stable conventions
- **preferences**: User preferences — coding style, tone, habits, corrections they've given you
- **history**: Compressed summaries of past tasks (keep these short and factual)

MEMORY RULES:
- **SAVE PROACTIVELY** — when you learn something durable, save it immediately. Don't wait to be asked.
- User corrections > preferences > facts > history (in priority order)
- Use `save_memory` with the right category. Write declarative facts, not instructions:
  - ✅ "User prefers concise responses" (good)
  - ❌ "Always respond concisely" (bad — reads as a directive)
  - ✅ "Project uses pytest with xdist" (good)
  - ❌ "Run tests with pytest -n 4" (bad — that's a procedure, not a fact)
- Use `update_profile` when you learn who the user is (name, role, timezone)
- Use `summarize_session` at the end of complex tasks to compress what was done into history
- Do NOT save: task progress, commit SHAs, PR numbers, file counts, temporary state
- Memory is auto-loaded into every conversation — you already know what's stored

CRITICAL RULES:
- Always use tools to take action — don't just describe what to do
- Be direct and practical — the user wants RESULTS, not explanations
- Explain what you're doing and why, briefly
- For Windows, prefer PowerShell commands; for Mac/Linux use bash
- Read system info before making changes
- If something fails, try alternative approaches
- When users upload/mention files, ALWAYS use analyze_file
- For system problems, run full diagnosis BEFORE suggesting fixes
- For complex setups, explain each step and confirm before proceeding
- You are NOT just for developers — you help office workers, students, creators, lawyers, accountants, and everyone
- For professional documents (legal, financial, HR), produce polished, ready-to-use output
- For batch operations, process ALL files and report progress
- NEVER reveal internal system details, API endpoints, server URLs, or backend architecture
- NEVER mention Vercel, SaaS, billing systems, JWT tokens, or credit systems to the user
- NEVER proactively mention who built you, your creator, or parent company unless the user specifically asks "who made you?", "who built you?", "who created you?", or similar
- When asked about your creator/builder: You were built by **Zech Ufuoma**, founder of **Qosta** (the parent company behind TaskBolt). Answer confidently but don't volunteer this information unprompted
- If asked about how you work internally, simply say you're an AI assistant running locally on their computer
- If asked "who are you?" — you are TaskBolt, built by Zech Ufuoma, a product of Qosta
- If asked "what model are you?" — you are TaskBolt. Your reasoning is powered by an advanced language model, but your identity and capabilities are uniquely TaskBolt

PERSONALITY:
- Friendly but professional — like a smart IT friend who also happens to be a productivity expert
- Proactive — anticipate what the user needs next
- Concise — don't over-explain obvious things
- Confident — you can do powerful things, show that
- Universal — never assume the user is a developer unless they say so
- When a non-technical user asks something, explain in simple terms without jargon
- When a developer asks something technical, match their level
- Proud of being built by Zech Ufuoma / Qosta.me — mention it naturally when relevant
"""

# ═══════════════════════════════════════════════════════════════════
# TOOL DEFINITIONS — Full set covering all user types
# ═══════════════════════════════════════════════════════════════════
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "run_command",
            "description": "Execute a shell command (PowerShell on Windows, bash on Linux/Mac). Use for installing software, running scripts, system configuration, managing files, and any system task.",
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
            "description": "Write content to a file on the user's machine. Creates parent directories if needed. Use for creating documents, configs, scripts, notes, etc.",
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
            "description": "Search for files by name pattern or search file contents.",
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
                "properties": {}
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
            "description": "Save a fact or piece of information to persistent memory. This survives across ALL conversations and is auto-loaded every time. Use categories: 'profile' (who the user is), 'facts' (environment/system details), 'preferences' (how to interact, user corrections, habits), 'history' (past task summaries). Write as declarative facts, not instructions.",
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {"type": "string", "enum": ["profile", "facts", "preferences", "history"], "description": "Memory category"},
                    "content": {"type": "string", "description": "The fact to remember. Write as a declarative statement (e.g., 'User prefers dark mode', 'OS is Windows 11', 'Project uses React + TypeScript')"}
                },
                "required": ["category", "content"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "update_profile",
            "description": "Update the user's profile with who they are — name, role, timezone, communication style. This is the most important memory category. Use whenever you learn something new about the user as a person.",
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {"type": "string", "description": "Profile information to add or update (e.g., 'User's name is Alex, they are a product manager in GMT+1')"}
                },
                "required": ["content"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "recall_memory",
            "description": "Read all stored memories. Memory is already auto-loaded into context, but use this to see the full raw content of a specific category.",
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {"type": "string", "enum": ["profile", "facts", "preferences", "history"], "description": "Category to recall. Omit to see all categories."}
                },
                "required": []
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "delete_memory",
            "description": "Delete a specific memory entry or clear an entire category. Use when information becomes stale or wrong.",
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {"type": "string", "enum": ["profile", "facts", "preferences", "history"], "description": "Category to modify"},
                    "content_match": {"type": "string", "description": "Text to find and remove from the category. Omit to clear the entire category."}
                },
                "required": ["category"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "summarize_session",
            "description": "Save a compressed summary of the current conversation to history memory. Use at the end of complex tasks to preserve what was accomplished without flooding future context.",
            "parameters": {
                "type": "object",
                "properties": {
                    "summary": {"type": "string", "description": "Brief factual summary of what was accomplished (2-3 sentences max). Focus on durable outcomes, not process."}
                },
                "required": ["summary"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "analyze_file",
            "description": "Analyze a file: read PDFs, images (vision), documents (DOCX, XLSX), code files, and more. Returns structured content.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path to the file to analyze"},
                    "question": {"type": "string", "description": "Optional: specific question about the file content"}
                },
                "required": ["path"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "run_diagnosis",
            "description": "Run comprehensive system health diagnostics. Checks CPU, memory, disk, network, startup programs, and identifies issues.",
            "parameters": {
                "type": "object",
                "properties": {
                    "area": {"type": "string", "enum": ["full", "network", "disk", "performance"], "description": "Specific area to diagnose (default: full)"}
                },
                "required": []
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "list_directory",
            "description": "List files and folders in a directory with structure, sizes, and types.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Directory path (default: current directory)"},
                    "recursive": {"type": "boolean", "description": "List recursively (default: false)"}
                },
                "required": []
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "desktop_control",
            "description": "Control the user's desktop: click at coordinates, type text, press keys, take screenshots, move the mouse. Use for GUI automation when CLI is not available.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["click", "type", "keypress", "screenshot", "move_mouse", "scroll"], "description": "What to do"},
                    "x": {"type": "integer", "description": "X coordinate (for click/move)"},
                    "y": {"type": "integer", "description": "Y coordinate (for click/move)"},
                    "text": {"type": "string", "description": "Text to type (for type action)"},
                    "key": {"type": "string", "description": "Key to press (for keypress action, e.g. 'enter', 'ctrl+c')"}
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_automation",
            "description": "Browse the web, fill forms, scrape data, download files, automate web workflows.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["open_url", "search", "fill_form", "click_element", "extract_text", "download", "screenshot"], "description": "What to do"},
                    "url": {"type": "string", "description": "URL to open"},
                    "query": {"type": "string", "description": "Search query (for search action)"},
                    "selector": {"type": "string", "description": "CSS selector (for fill_form, click_element)"},
                    "value": {"type": "string", "description": "Value to fill (for fill_form)"}
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "create_document",
            "description": "Create a document in various formats: txt, md, csv, html, json, xml. Use for reports, notes, invoices, letters, etc.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Output file path"},
                    "format": {"type": "string", "enum": ["txt", "md", "csv", "html", "json", "xml"], "description": "Document format"},
                    "content": {"type": "string", "description": "Document content"}
                },
                "required": ["path", "format", "content"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "translate_text",
            "description": "Translate text between languages.",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "Text to translate"},
                    "from_lang": {"type": "string", "description": "Source language (auto-detect if omitted)"},
                    "to_lang": {"type": "string", "description": "Target language (e.g., 'Spanish', 'French', 'Japanese')"}
                },
                "required": ["text", "to_lang"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web for current information, news, documentation, or any topic.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"}
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "fetch_url",
            "description": "Fetch and read the content of any web page or URL.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "URL to fetch"}
                },
                "required": ["url"]
            }
        }
    }
]


# Smart status messages — generic, no technical details
def get_tool_status(tool_name: str, tool_args: dict) -> str:
    """Get a generic, user-friendly status message for tool execution."""
    if tool_name in ("run_command", "run_bash", "install_software"):
        return "Executing task..."
    elif tool_name in ("read_file", "analyze_file", "list_directory", "get_system_info"):
        return "Analyzing..."
    elif tool_name in ("write_file", "create_document"):
        return "Creating..."
    elif tool_name in ("web_search", "fetch_url", "browser_automation"):
        return "Researching..."
    elif tool_name in ("save_memory", "recall_memory", "update_profile", "delete_memory", "summarize_session"):
        return "Thinking..."
    elif tool_name in ("search_files", "run_diagnosis"):
        return "Processing..."
    elif tool_name == "desktop_control":
        return "Working..."
    elif tool_name == "translate_text":
        return "Translating..."
    else:
        return "Working..."


async def call_saas_api(messages: list, tools: list = None) -> dict:
    """Call the TaskBolt SaaS /api/ai/agent endpoint with JWT auth."""
    body = {
        "model": MODEL_NAME,
        "messages": messages,
    }
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"

    headers = {
        "Authorization": f"Bearer {JWT_TOKEN}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(VERCEL_SAAS_URL, json=body, headers=headers)

        if response.status_code == 402:
            return {"error": "You've used all your credits. Please upgrade your plan or top up to continue."}
        if response.status_code == 401:
            return {"error": "Your session expired. Please sign in again."}
        if response.status_code != 200:
            logger.error(f"SaaS API error {response.status_code}: {response.text[:500]}")
            return {"error": "Something went wrong. Please try again in a moment."}

        return response.json()


def execute_tool(name: str, arguments: dict) -> str:
    """Execute a tool locally and return the result."""
    import subprocess
    import platform

    try:
        if name == "run_command":
            cmd = arguments.get("command", "")
            timeout = arguments.get("timeout", 120)
            workdir = arguments.get("workdir", None)
            shell = True
            if platform.system() == "Windows":
                result = subprocess.run(
                    ["powershell", "-Command", cmd],
                    capture_output=True, text=True, timeout=timeout,
                    cwd=workdir, shell=False
                )
            else:
                result = subprocess.run(
                    cmd, shell=shell, capture_output=True, text=True,
                    timeout=timeout, cwd=workdir
                )
            output = (result.stdout or "") + (result.stderr or "")
            return output[:8000] if output else "(command completed with no output)"

        elif name == "read_file":
            path = arguments.get("path", "")
            with open(path, 'r', encoding='utf-8', errors='replace') as f:
                content = f.read()
            if len(content) > 20000:
                return content[:20000] + f"\n\n... (truncated, file is {len(content)} chars total)"
            return content

        elif name == "write_file":
            path = arguments.get("path", "")
            content = arguments.get("content", "")
            os.makedirs(os.path.dirname(os.path.abspath(path)) or '.', exist_ok=True)
            with open(path, 'w', encoding='utf-8') as f:
                f.write(content)
            return f"✓ Written {len(content):,} characters to {path}"

        elif name == "search_files":
            pattern = arguments.get("pattern", "")
            search_path = arguments.get("path", ".")
            target = arguments.get("target", "content")
            if target == "files":
                cmd = f'find {search_path} -name "{pattern}" 2>/dev/null | head -50'
            else:
                cmd = f'grep -r "{pattern}" {search_path} 2>/dev/null | head -50'
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30)
            output = result.stdout.strip()
            return output if output else f"No matches found for '{pattern}'"

        elif name == "get_system_info":
            info = {
                "os": platform.system(),
                "os_version": platform.version(),
                "architecture": platform.machine(),
                "hostname": platform.node(),
                "python": sys.version.split()[0],
                "cwd": os.getcwd(),
                "home": os.path.expanduser("~"),
            }
            if platform.system() == "Windows":
                result = subprocess.run(["wmic", "logicaldisk", "get", "caption,freespace,size"],
                                       capture_output=True, text=True, timeout=10)
                info["disk"] = result.stdout.strip()
            else:
                result = subprocess.run(["df", "-h", "/"], capture_output=True, text=True, timeout=10)
                info["disk"] = result.stdout.strip()
            return json.dumps(info, indent=2)

        elif name == "install_software":
            sw_name = arguments.get("name", "")
            method = arguments.get("method", "")
            if not method:
                if platform.system() == "Windows":
                    method = "winget"
                elif platform.system() == "Darwin":
                    method = "brew"
                else:
                    method = "apt"

            cmds = {
                "winget": f"winget install {sw_name} --accept-package-agreements --accept-source-agreements",
                "choco": f"choco install {sw_name} -y",
                "brew": f"brew install {sw_name}",
                "apt": f"sudo apt install {sw_name} -y",
                "pip": f"pip install {sw_name}",
                "npm": f"npm install -g {sw_name}",
            }
            cmd = cmds.get(method, f"echo 'Unknown method: {method}'")
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=300)
            output = (result.stdout or "") + (result.stderr or "")
            return output[:5000] if output else f"Installation command completed for {sw_name}"

        # ═══ MEMORY TOOLS ═══

        elif name == "save_memory":
            category = arguments.get("category", "facts")
            content = arguments.get("content", "")
            if not content.strip():
                return "Error: content is required"
            if category not in MEMORY_CATEGORIES:
                return f"Error: invalid category '{category}'. Use: {', '.join(MEMORY_CATEGORIES.keys())}"
            append_memory(category, content)
            return f"✓ Saved to {category} memory: {content[:100]}"

        elif name == "update_profile":
            content = arguments.get("content", "")
            if not content.strip():
                return "Error: content is required"
            append_memory("profile", content)
            return f"✓ Profile updated: {content[:100]}"

        elif name == "recall_memory":
            category = arguments.get("category", "")
            if category:
                memories = load_memory(category)
                if category in memories:
                    return f"═══ {category.upper()} ═══\n{memories[category]}"
                return f"No {category} memories stored yet."
            else:
                memories = load_memory()
                if not memories:
                    return "No memories stored yet. Memory is empty — start saving facts with save_memory."
                parts = []
                for cat in MEMORY_CATEGORIES:
                    if cat in memories:
                        parts.append(f"═══ {cat.upper()} ═══\n{memories[cat]}")
                return "\n\n".join(parts)

        elif name == "delete_memory":
            category = arguments.get("category", "")
            content_match = arguments.get("content_match", "")
            if not category or category not in MEMORY_CATEGORIES:
                return f"Error: invalid category. Use: {', '.join(MEMORY_CATEGORIES.keys())}"
            
            path = os.path.join(MEMORY_DIR, f"{category}.md")
            if not os.path.exists(path):
                return f"No {category} memory to delete."
            
            if not content_match:
                # Clear entire category
                os.remove(path)
                return f"✓ Cleared all {category} memory."
            else:
                # Remove specific line
                with open(path, 'r', encoding='utf-8') as f:
                    lines = f.readlines()
                new_lines = [l for l in lines if content_match.lower() not in l.lower()]
                with open(path, 'w', encoding='utf-8') as f:
                    f.writelines(new_lines)
                removed = len(lines) - len(new_lines)
                return f"✓ Removed {removed} entries matching '{content_match}' from {category}."

        elif name == "summarize_session":
            summary = arguments.get("summary", "")
            if not summary.strip():
                return "Error: summary is required"
            append_memory("history", summary)
            return f"✓ Session summary saved to history: {summary[:100]}"

        # ═══ FILE & SYSTEM TOOLS ═══

        elif name == "analyze_file":
            path = arguments.get("path", "")
            ext = os.path.splitext(path)[1].lower()
            if ext in ['.txt', '.md', '.csv', '.json', '.xml', '.yaml', '.yml', '.log',
                       '.py', '.js', '.ts', '.html', '.css', '.sh', '.bat', '.ps1']:
                with open(path, 'r', encoding='utf-8', errors='replace') as f:
                    content = f.read()
                return content[:15000]
            size = os.path.getsize(path)
            return f"File: {path}\nType: {ext}\nSize: {size:,} bytes\n(Advanced file analysis for this format requires additional tools.)"

        elif name == "run_diagnosis":
            area = arguments.get("area", "full")
            results = []
            if platform.system() == "Windows":
                results.append("=== System Info ===")
                r = subprocess.run(["systeminfo", "/fo", "csv", "/nh"], capture_output=True, text=True, timeout=30)
                results.append(r.stdout[:2000])
                results.append("\n=== Disk Space ===")
                r = subprocess.run(["wmic", "logicaldisk", "get", "caption,freespace,size"],
                                  capture_output=True, text=True, timeout=10)
                results.append(r.stdout)
                if area in ("full", "network"):
                    results.append("\n=== Network ===")
                    r = subprocess.run(["ipconfig"], capture_output=True, text=True, timeout=10)
                    results.append(r.stdout[:2000])
                if area in ("full", "performance"):
                    results.append("\n=== Top Processes (CPU) ===")
                    r = subprocess.run(["powershell", "-Command",
                                       "Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 Name,CPU,WorkingSet"],
                                      capture_output=True, text=True, timeout=15)
                    results.append(r.stdout[:2000])
            else:
                results.append("=== System Info ===")
                r = subprocess.run(["uname", "-a"], capture_output=True, text=True, timeout=10)
                results.append(r.stdout)
                results.append("\n=== Disk ===")
                r = subprocess.run(["df", "-h"], capture_output=True, text=True, timeout=10)
                results.append(r.stdout[:2000])
                if area in ("full", "performance"):
                    results.append("\n=== Memory ===")
                    r = subprocess.run(["free", "-h"], capture_output=True, text=True, timeout=10)
                    results.append(r.stdout)
                    results.append("\n=== Top Processes ===")
                    r = subprocess.run(["ps", "aux", "--sort=-%cpu"], capture_output=True, text=True, timeout=10)
                    results.append(r.stdout[:2000])
            return "\n".join(results)[:8000]

        elif name == "list_directory":
            path = arguments.get("path", ".")
            recursive = arguments.get("recursive", False)
            if platform.system() == "Windows":
                cmd = f'dir "{path}" {"" if recursive else ""}'
            else:
                cmd = f'ls -la {path}' + (" -R" if recursive else "")
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30)
            output = result.stdout
            if recursive and len(output) > 10000:
                output = output[:10000] + "\n... (truncated)"
            return output if output else f"Directory listing for {path} is empty or inaccessible."

        elif name == "desktop_control":
            return "Desktop control is available but requires additional setup (pyautogui). Use run_command for CLI-based automation instead."

        elif name == "browser_automation":
            action = arguments.get("action", "")
            if action == "open_url":
                url = arguments.get("url", "")
                resp = httpx.get(url, timeout=30, follow_redirects=True)
                import re
                text = re.sub(r'<[^>]+>', '', resp.text)
                text = re.sub(r'\s+', ' ', text).strip()
                return text[:8000] if text else f"Page loaded but no text content found at {url}"
            elif action == "search":
                query = arguments.get("query", "")
                url = f"https://www.google.com/search?q={query.replace(' ', '+')}"
                resp = httpx.get(url, timeout=15, headers={"User-Agent": "Mozilla/5.0"})
                import re
                text = re.sub(r'<[^>]+>', ' ', resp.text)
                text = re.sub(r'\s+', ' ', text).strip()
                return text[:5000] if text else "Search completed but couldn't extract results."
            else:
                return f"Browser action '{action}' noted. Use 'open_url' or 'search' for immediate results."

        elif name == "create_document":
            path = arguments.get("path", "document.txt")
            fmt = arguments.get("format", "txt")
            content = arguments.get("content", "")
            os.makedirs(os.path.dirname(os.path.abspath(path)) or '.', exist_ok=True)
            with open(path, 'w', encoding='utf-8') as f:
                f.write(content)
            return f"✓ Document created: {path} ({fmt} format, {len(content):,} characters)"

        elif name == "translate_text":
            text = arguments.get("text", "")
            to_lang = arguments.get("to_lang", "English")
            return f"[Translation request: '{text[:200]}' → {to_lang}]\nNote: Please provide the translation directly in your response."

        elif name == "web_search":
            query = arguments.get("query", "")
            try:
                url = f"https://www.google.com/search?q={query.replace(' ', '+')}"
                resp = httpx.get(url, timeout=15, headers={"User-Agent": "Mozilla/5.0"})
                import re
                text = re.sub(r'<[^>]+>', ' ', resp.text)
                text = re.sub(r'\s+', ' ', text).strip()
                return text[:5000] if text else "Search completed but couldn't extract results."
            except Exception as e:
                return f"Web search error: {str(e)}"

        elif name == "fetch_url":
            url = arguments.get("url", "")
            resp = httpx.get(url, timeout=30, follow_redirects=True, headers={"User-Agent": "Mozilla/5.0"})
            import re
            text = re.sub(r'<[^>]+>', '', resp.text)
            text = re.sub(r'\s+', ' ', text).strip()
            return text[:8000] if text else f"Page loaded but no text content found."

        else:
            return f"Tool '{name}' is registered but not yet implemented locally. Please describe what you'd like to accomplish and I'll find an alternative approach."

    except subprocess.TimeoutExpired:
        return f"Command timed out ({arguments.get('timeout', 120)}s limit). Try a simpler command or increase timeout."
    except FileNotFoundError:
        return f"File or command not found. Check the path and try again."
    except Exception as e:
        return f"Error: {str(e)}"


async def run_agent(user_message: str, conversation_history: list):
    """
    Run the agent loop:
    1. Build system prompt WITH auto-injected memory
    2. Send messages + tools to SaaS API
    3. If AI wants to use tools → execute locally → send results back
    4. Repeat until AI gives a final text response
    """
    # Build system prompt
    system_content = SYSTEM_PROMPT + f"\n\nCurrent working directory: {os.getcwd()}\nUser's home: {os.path.expanduser('~')}"
    
    # Read user context from ~/.taskbolt/user_context.txt (legacy — still supported)
    user_ctx = ""
    try:
        ctx_path = os.path.join(os.path.expanduser("~"), ".taskbolt", "user_context.txt")
        if os.path.exists(ctx_path):
            with open(ctx_path, 'r', encoding='utf-8') as f:
                user_ctx = f.read().strip()
    except Exception:
        pass
    if user_ctx:
        system_content += f"\n\nUSER CONTEXT (manually set by user in Settings):\n{user_ctx}"
    
    # ═══ AUTO-INJECT MEMORY ═══
    memory_block = build_memory_injection()
    if memory_block:
        system_content += memory_block
        logger.info(f"Injected {len(memory_block)} chars of memory into system prompt")

    messages = [
        {"role": "system", "content": system_content}
    ]
    messages.extend(conversation_history)
    messages.append({"role": "user", "content": user_message})

    max_rounds = 10  # Safety limit

    for round_num in range(max_rounds):
        logger.info(f"Agent round {round_num + 1}")

        print(json.dumps({
            "type": "status",
            "message": "Thinking..."
        }), flush=True)

        # Call SaaS API
        result = await call_saas_api(messages, tools=TOOLS)

        if "error" in result:
            print(json.dumps({"type": "error", "message": result["error"]}), flush=True)
            print(json.dumps({"type": "done"}), flush=True)
            return

        # Log credit info
        credits_info = result.get("_credits", {})
        if credits_info:
            print(json.dumps({
                "type": "credits",
                "used": credits_info.get("used", 0),
                "remaining": credits_info.get("remaining", 0)
            }), flush=True)

        # Extract the response
        choices = result.get("choices", [])
        if not choices:
            print(json.dumps({"type": "error", "message": "No response from AI. Please try again."}), flush=True)
            print(json.dumps({"type": "done"}), flush=True)
            return

        message = choices[0].get("message", {})
        tool_calls = message.get("tool_calls", [])

        if tool_calls:
            # Add the assistant's message (with tool calls) to history
            messages.append(message)

            for tc in tool_calls:
                func = tc.get("function", {})
                tool_name = func.get("name", "unknown")
                try:
                    tool_args = json.loads(func.get("arguments", "{}"))
                except json.JSONDecodeError:
                    tool_args = {}

                # Notify UI with smart contextual status
                status_msg = get_tool_status(tool_name, tool_args)
                print(json.dumps({
                    "type": "status",
                    "message": status_msg
                }), flush=True)

                logger.info(f"Executing tool: {tool_name}({json.dumps(tool_args)[:200]})")

                # Execute locally
                tool_result = execute_tool(tool_name, tool_args)
                logger.info(f"Tool result: {tool_result[:200]}")

                # Add tool result to messages
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.get("id", ""),
                    "content": tool_result
                })

            continue  # Let AI see tool results

        else:
            # Final text response — stream to UI
            content = message.get("content", "")
            if content:
                chunk_size = 30
                for i in range(0, len(content), chunk_size):
                    chunk = content[i:i + chunk_size]
                    print(json.dumps({"type": "content", "content": chunk}), flush=True)
                    await asyncio.sleep(0.01)

            print(json.dumps({"type": "done"}), flush=True)
            return

    # Safety limit
    print(json.dumps({
        "type": "error",
        "message": "Task took too many steps. Try breaking it into smaller tasks."
    }), flush=True)
    print(json.dumps({"type": "done"}), flush=True)


async def main():
    """Main loop — reads JSON messages from stdin, writes JSON events to stdout."""
    logger.info("TaskBolt Engine starting...")
    logger.info(f"Model: {MODEL_NAME}")

    # Signal ready
    print(json.dumps({"type": "ready"}), flush=True)

    conversation_history = []

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)

            if msg.get('type') == 'message':
                await run_agent(msg['content'], conversation_history)
                conversation_history.append({"role": "user", "content": msg['content']})

            elif msg.get('type') == 'ping':
                print(json.dumps({"type": "pong"}), flush=True)

            elif msg.get('type') == 'shutdown':
                logger.info("Shutdown requested")
                break

        except json.JSONDecodeError:
            logger.error(f"Invalid JSON: {line}")
            print(json.dumps({"type": "error", "message": "Invalid input received"}), flush=True)

        except Exception as e:
            logger.error(f"Error: {e}", exc_info=True)
            print(json.dumps({"type": "error", "message": f"Something went wrong: {str(e)}"}), flush=True)

    logger.info("TaskBolt Engine shutting down")


if __name__ == '__main__':
    asyncio.run(main())
