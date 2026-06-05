#!/usr/bin/env python3
"""
TaskBolt Engine — lightweight local agent with full persona & tools.
Routes ALL LLM calls through TaskBolt SaaS (Vercel) for auth + billing.
No secrets, no backend info, no API keys ever exposed to the AI model.
"""

import os
import sys
import json
import asyncio
import logging

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

CRITICAL RULES:
- Always use tools to take action — don't just describe what to do
- Be direct and practical — the user wants RESULTS, not explanations
- Explain what you're doing and why, briefly
- For Windows, prefer PowerShell commands; for Mac/Linux use bash
- Read system info before making changes
- Keep memory of what you've done for the user
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
            "description": "Save a piece of information to persistent memory. Use this to remember user preferences, system details, past actions, etc.",
            "parameters": {
                "type": "object",
                "properties": {
                    "key": {"type": "string", "description": "Memory key (e.g., 'user_preferences', 'installed_software')"},
                    "value": {"type": "string", "description": "The information to remember"}
                },
                "required": ["key", "value"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "recall_memory",
            "description": "Recall information previously saved to memory.",
            "parameters": {
                "type": "object",
                "properties": {
                    "key": {"type": "string", "description": "Memory key to recall. Omit to see all keys."}
                },
                "required": []
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


# Smart status messages — contextual feedback based on what the agent is doing
TOOL_STATUS_MAP = {
    "run_command": "Executing command...",
    "run_bash": "Executing command...",
    "read_file": "Reading file...",
    "write_file": "Writing file...",
    "search_files": "Searching files...",
    "get_system_info": "Gathering system info...",
    "install_software": "Installing software...",
    "save_memory": "Saving to memory...",
    "recall_memory": "Recalling memory...",
    "analyze_file": "Analyzing file...",
    "run_diagnosis": "Running diagnostics...",
    "list_directory": "Listing directory...",
    "desktop_control": "Controlling desktop...",
    "browser_automation": "Browsing the web...",
    "create_document": "Creating document...",
    "translate_text": "Translating...",
    "web_search": "Searching the web...",
    "fetch_url": "Fetching page...",
}

def get_tool_status(tool_name: str, tool_args: dict) -> str:
    """Get a human-friendly status message for a tool execution."""
    base = TOOL_STATUS_MAP.get(tool_name, f"Running {tool_name}...")
    
    # Add context for some tools
    if tool_name in ("run_command", "run_bash"):
        cmd = tool_args.get("command", "")
        if cmd:
            # Extract the first word/command
            first_word = cmd.split()[0] if cmd.split() else ""
            if first_word.lower() in ("pip", "npm", "apt", "brew", "winget", "choco"):
                return f"Installing package..."
            elif first_word.lower() in ("git",):
                return f"Running git..."
            elif first_word.lower() in ("python", "python3", "node"):
                return f"Running script..."
            elif "install" in cmd.lower():
                return f"Installing software..."
            elif "delete" in cmd.lower() or "remove" in cmd.lower() or "rm " in cmd:
                return f"Removing files..."
            elif "mkdir" in cmd.lower() or "mkdir" in cmd:
                return f"Creating directory..."
            elif "curl" in cmd.lower() or "wget" in cmd.lower():
                return f"Downloading..."
    elif tool_name in ("read_file", "analyze_file"):
        path = tool_args.get("path", "")
        if path:
            fname = path.split("/")[-1].split("\\")[-1]
            return f"Reading {fname}..."
    elif tool_name == "write_file":
        path = tool_args.get("path", "")
        if path:
            fname = path.split("/")[-1].split("\\")[-1]
            return f"Writing {fname}..."
    elif tool_name == "web_search":
        query = tool_args.get("query", "")
        if query:
            return f"Searching: {query[:40]}..."
    elif tool_name == "fetch_url":
        url = tool_args.get("url", "")
        if url:
            domain = url.split("//")[-1].split("/")[0] if "//" in url else url[:30]
            return f"Fetching {domain}..."
    elif tool_name == "create_document":
        path = tool_args.get("path", "")
        if path:
            fname = path.split("/")[-1].split("\\")[-1]
            return f"Creating {fname}..."
    
    return base


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
    import tempfile
    import platform
    import shutil

    try:
        if name == "run_command":
            cmd = arguments.get("command", "")
            timeout = arguments.get("timeout", 120)
            workdir = arguments.get("workdir", None)
            shell = True
            if platform.system() == "Windows":
                # Use PowerShell on Windows
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
                # Find files by name
                cmd = f'find {search_path} -name "{pattern}" 2>/dev/null | head -50'
            else:
                # Search file contents
                cmd = f'grep -r "{pattern}" {search_path} 2>/dev/null | head -50'
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30)
            output = result.stdout.strip()
            return output if output else f"No matches found for '{pattern}'"

        elif name == "get_system_info":
            import platform
            info = {
                "os": platform.system(),
                "os_version": platform.version(),
                "architecture": platform.machine(),
                "hostname": platform.node(),
                "python": sys.version.split()[0],
                "cwd": os.getcwd(),
                "home": os.path.expanduser("~"),
            }
            # Disk info
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

        elif name == "save_memory":
            key = arguments.get("key", "default")
            value = arguments.get("value", "")
            mem_dir = os.path.join(os.path.expanduser("~"), ".taskbolt", "memory")
            os.makedirs(mem_dir, exist_ok=True)
            mem_file = os.path.join(mem_dir, f"{key}.md")
            with open(mem_file, 'w', encoding='utf-8') as f:
                f.write(value)
            return f"✓ Saved to memory: {key}"

        elif name == "recall_memory":
            key = arguments.get("key", "")
            mem_dir = os.path.join(os.path.expanduser("~"), ".taskbolt", "memory")
            if not os.path.exists(mem_dir):
                return "No memories stored yet."
            if key:
                mem_file = os.path.join(mem_dir, f"{key}.md")
                if os.path.exists(mem_file):
                    with open(mem_file, 'r', encoding='utf-8') as f:
                        return f.read()
                return f"No memory found for key: {key}"
            else:
                files = [f.replace('.md', '') for f in os.listdir(mem_dir) if f.endswith('.md')]
                return f"Available memory keys: {', '.join(files)}" if files else "No memories stored yet."

        elif name == "analyze_file":
            path = arguments.get("path", "")
            ext = os.path.splitext(path)[1].lower()
            # Text files
            if ext in ['.txt', '.md', '.csv', '.json', '.xml', '.yaml', '.yml', '.log',
                       '.py', '.js', '.ts', '.html', '.css', '.sh', '.bat', '.ps1']:
                with open(path, 'r', encoding='utf-8', errors='replace') as f:
                    content = f.read()
                return content[:15000]
            # For other file types, return metadata
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
                cmd = f'dir "{path}" {"-R" if recursive else ""}'
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
                # Strip HTML tags for readability
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
            # Translation requires the AI itself — return a prompt for the model
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
    1. Send messages + tools to SaaS API
    2. If AI wants to use tools → execute locally → send results back
    3. Repeat until AI gives a final text response
    """
    # Read user context from ~/.taskbolt/user_context.txt
    user_ctx = ""
    try:
        ctx_path = os.path.join(os.path.expanduser("~"), ".taskbolt", "user_context.txt")
        if os.path.exists(ctx_path):
            with open(ctx_path, 'r', encoding='utf-8') as f:
                user_ctx = f.read().strip()
    except Exception:
        pass

    system_content = SYSTEM_PROMPT + f"\n\nCurrent working directory: {os.getcwd()}\nUser's home: {os.path.expanduser('~')}"
    if user_ctx:
        system_content += f"\n\nUSER CONTEXT (what the user told you about themselves):\n{user_ctx}"

    messages = [
        {"role": "system", "content": system_content}
    ]
    messages.extend(conversation_history)
    messages.append({"role": "user", "content": user_message})

    max_rounds = 10  # Safety limit

    for round_num in range(max_rounds):
        logger.info(f"Agent round {round_num + 1}")

        if round_num > 0:
            print(json.dumps({
                "type": "status",
                "message": f"Thinking..."
            }), flush=True)
        else:
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
