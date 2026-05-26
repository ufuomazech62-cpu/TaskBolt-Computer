# TaskBolt-Computer

**AI that sets up your computer for you.**

TaskBolt is a lightweight desktop app (~15MB) that gives non-technical users an AI agent with full terminal access to their computer. Tell it what to set up, fix, or optimize — and it does it end-to-end.

## Positioning

- **Not a general-purpose AI** — focused on computer setup, configuration, and automation
- **Zero-config onboarding** — install → open → auto-detects → ready
- **Full terminal power** — runs commands on the user's actual machine (Git Bash on Windows)
- **GUI chat interface** — ChatGPT/Codex-style UI, no terminal knowledge required
- **Cron-powered maintenance** — auto-updates, cleanup, performance optimization on schedule
- **Telegram-connected** — manage your computer from your phone

## Architecture

```
TaskBolt Desktop (Tauri 2.x, ~15MB)
├── React + TypeScript GUI (ChatGPT-style chat)
├── Rust Backend (Tauri)
│   ├── Engine manager (Python subprocess lifecycle)
│   ├── Auto-setup detector (OS, paths, dependencies)
│   └── Message bridge (JSON protocol over stdin/stdout)
├── Python Engine (hermes-agent, hidden subprocess)
│   ├── Full terminal access (Git Bash)
│   ├── Tools: file, web, cron, delegation, skills
│   └── Messaging gateway (Telegram, Discord, etc.)
└── Data: ~/.taskbolt/ (config, sessions, skills)
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Tauri 2.x (Rust) |
| Frontend | React 19 + TypeScript + Vite |
| Agent engine | Python (hermes-agent) |
| Bridge protocol | JSON lines over stdin/stdout |
| Terminal backend | Git Bash (Windows) / native shell (macOS/Linux) |

## Development

### Prerequisites
- Node.js 22+
- Rust 1.93+
- Python 3.11+

### Setup
```bash
# Install frontend deps
npm install

# Install Python engine deps
cd hermes-engine
pip install -e ".[all]"
cd ..

# Run dev mode (hot-reload GUI + Rust)
npm run tauri dev
```

### Build
```bash
npm run tauri build
```
Output: `src-tauri/target/release/bundle/` (MSI, NSIS, DMG, AppImage)

## Project Structure

```
TaskBolt-Computer/
├── src/                          # React frontend
│   ├── App.tsx                   # Main chat UI
│   ├── App.css                   # Dark theme (ChatGPT-style)
│   ├── main.tsx                  # React entry
│   └── vite-env.d.ts
├── src-tauri/                    # Rust backend (Tauri)
│   ├── src/
│   │   ├── lib.rs                # Tauri commands (auto_setup, send_message)
│   │   ├── main.rs               # Entry point
│   │   └── engine.rs             # Python engine lifecycle & bridge
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── build.rs
│   └── capabilities/
├── hermes-engine/                # Python agent engine (cloned from hermes-agent)
│   ├── taskbolt_bridge.py        # Bridge script (stdin/stdout JSON protocol)
│   └── ...                       # Full hermes-agent codebase
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
└── README.md
```

## How It Works

1. **User installs** the `.exe` / `.dmg`
2. **App opens** → onboarding screen with spinner
3. **Rust backend** auto-detects OS, creates `~/.taskbolt/`, starts Python engine
4. **Python bridge** (`taskbolt_bridge.py`) connects to hermes-agent engine
5. **GUI chat** is ready — user types natural language requests
6. **Agent executes** commands via terminal, reports back through GUI
7. **Cron scheduler** handles maintenance tasks in the background

## Safety

- Approval UI for destructive commands (shown in GUI, not terminal)
- Dry-run previews before executing
- Sandboxed subprocess with restricted environment
- Visible command log builds user trust

## License

MIT (inherited from hermes-agent)
