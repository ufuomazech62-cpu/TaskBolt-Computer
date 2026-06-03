use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tokio::process::Command;
use tauri::Emitter;
use reqwest::Client;

const GATEWAY_PORT: u16 = 8642;
const GATEWAY_HOST: &str = "127.0.0.1";
const GATEWAY_KEY: &str = "taskbolt-local-key";

// DashScope API config (OpenAI-compatible)
const DASHSCOPE_BASE_URL: &str = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const DASHSCOPE_DEFAULT_KEY: &str = "sk-ws-H.HREPLP.gp4v.MEYCIQDNuGK2sFsWGvTtarP1Pb4QWwyteUTnUC2e8G-2r2eXmQIhAMlpdycwD1pShqIJCptTF_bGuIY_xp5VluEpweczNcUn";
const DEFAULT_MODEL: &str = "deepseek-v4-flash";

pub struct EngineHandle {
    child: Arc<tokio::sync::Mutex<Option<tokio::process::Child>>>,
    pub client: Client,
    pub gateway_url: String,
}

impl EngineHandle {
    pub fn gateway_url(&self) -> &str {
        &self.gateway_url
    }

    pub fn api_key(&self) -> &str {
        GATEWAY_KEY
    }

    pub async fn kill_gateway(&self) {
        let mut child_guard = self.child.lock().await;
        if let Some(ref mut child) = *child_guard {
            child.kill().await.ok();
            *child_guard = None;
        }
    }
}

/// Find hermes CLI executable
fn find_hermes() -> Option<String> {
    // Check common locations
    let home = dirs::home_dir()?;

    // 1. Check ~/.hermes/bin/hermes or ~/.local/bin/hermes
    let candidates = vec![
        home.join(".hermes").join("bin").join("hermes"),
        home.join(".local").join("bin").join("hermes"),
        home.join(".hermes").join(".venv").join("Scripts").join("hermes.exe"),
        home.join(".hermes").join(".venv").join("bin").join("hermes"),
    ];

    for candidate in &candidates {
        if candidate.exists() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }

    // 2. Check PATH via `where` / `which`
    if cfg!(windows) {
        if let Ok(output) = std::process::Command::new("where").arg("hermes").output() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() && output.status.success() {
                return Some(path.lines().next().unwrap_or("").to_string());
            }
        }
    } else {
        if let Ok(output) = std::process::Command::new("which").arg("hermes").output() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() && output.status.success() {
                return Some(path);
            }
        }
    }

    None
}

/// Find Python executable
fn find_python() -> String {
    if cfg!(windows) {
        for version in &["Python313", "Python312", "Python311"] {
            let py = PathBuf::from(format!(
                r"C:\Users\{}\AppData\Local\Programs\Python\{}\python.exe",
                std::env::var("USERNAME").unwrap_or_default(),
                version
            ));
            if py.exists() {
                return py.to_string_lossy().to_string();
            }
        }
        "python".to_string()
    } else {
        "python3".to_string()
    }
}

/// Get the DashScope API key from environment or fallback
fn get_api_key() -> String {
    std::env::var("DASHSCOPE_API_KEY").unwrap_or_else(|_| DASHSCOPE_DEFAULT_KEY.to_string())
}

/// Setup hermes config files
fn setup_hermes_config(hermes_dir: &PathBuf) -> Result<(), String> {
    std::fs::create_dir_all(hermes_dir)
        .map_err(|e| format!("Failed to create .hermes dir: {e}"))?;

    let api_key = get_api_key();

    // Write .env file
    let env_content = format!(
        r#"# TaskBolt Engine Config
OPENAI_API_KEY={api_key}
OPENAI_BASE_URL={DASHSCOPE_BASE_URL}
API_SERVER_KEY={GATEWAY_KEY}
API_SERVER_PORT={GATEWAY_PORT}
API_SERVER_HOST={GATEWAY_HOST}
"#
    );
    std::fs::write(hermes_dir.join(".env"), env_content)
        .map_err(|e| format!("Failed to write .env: {e}"))?;

    // Write config.yaml
    let config_content = format!(
        r#"# TaskBolt Configuration
model: "openai:{DEFAULT_MODEL}"

toolsets:
  - terminal
  - file
  - web
  - browser
  - code_exec
  - vision
  - image_gen
  - tts
  - skills
  - memory
  - session_search
  - delegation
  - cron

agent:
  max_turns: 50
  gateway_timeout: 600

memory:
  memory_enabled: true
  user_profile_enabled: true
  memory_char_limit: 2200
  user_char_limit: 1375

platforms:
  api_server:
    port: {GATEWAY_PORT}
    host: "{GATEWAY_HOST}"
    key: "{GATEWAY_KEY}"
"#
    );
    std::fs::write(hermes_dir.join("config.yaml"), config_content)
        .map_err(|e| format!("Failed to write config.yaml: {e}"))?;

    // Write SOUL.md (persona)
    let soul_content = r#"You are TaskBolt, an intelligent AI assistant that sets up, configures, and fixes computers.

## Core Identity
- You are helpful, knowledgeable, and direct
- You execute tasks on the user's computer using available tools
- You communicate clearly and admit uncertainty when appropriate
- You prioritize being genuinely useful over being verbose

## Capabilities
- Install and configure software, drivers, and development tools
- Diagnose and repair system issues, errors, and misconfigurations
- Clean up disk space, improve performance, and update everything
- Scan for vulnerabilities and harden system security
- Browse the web, research information, and summarize findings
- Write, debug, and run code in any language
- Create documents, reports, and presentations
- Automate repetitive tasks with scripts and workflows
- Manage files — organize, rename, convert, batch operations
- Generate images, convert text to speech
- Set up scheduled tasks and recurring automation

## Guidelines
- Always confirm before destructive operations (deleting files, formatting)
- Explain what you're doing before executing
- Show progress for long-running tasks
- Use the right tool for the job
- On Windows, prefer PowerShell and native tools
"#;
    std::fs::write(hermes_dir.join("SOUL.md"), soul_content)
        .map_err(|e| format!("Failed to write SOUL.md: {e}"))?;

    Ok(())
}

/// Install hermes-agent via pip
pub async fn install_hermes(app_handle: tauri::AppHandle) -> Result<String, String> {
    let python_exe = find_python();

    // Emit progress
    app_handle.emit("agent-event", serde_json::json!({
        "type": "status",
        "content": "Installing TaskBolt engine (this may take a few minutes)..."
    }).to_string()).ok();

    let output = Command::new(&python_exe)
        .args(["-m", "pip", "install", "hermes-agent", "--quiet", "--disable-pip-version-check"])
        .output()
        .await
        .map_err(|e| format!("Failed to run pip: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("pip install failed: {stderr}"));
    }

    app_handle.emit("agent-event", serde_json::json!({
        "type": "status",
        "content": "Engine installed successfully!"
    }).to_string()).ok();

    Ok("hermes-agent installed".to_string())
}

/// Wait for gateway to be ready
async fn wait_for_gateway(client: &Client, max_attempts: u32) -> Result<(), String> {
    let url = format!("http://{}:{}/health", GATEWAY_HOST, GATEWAY_PORT);

    for i in 0..max_attempts {
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => return Ok(()),
            _ => {
                if i % 4 == 0 {
                    // Log every 2 seconds
                }
            }
        }
    }
    Err("Gateway did not become ready within timeout".to_string())
}

/// Start the hermes gateway engine
pub fn start_engine(
    taskbolt_dir: &std::path::Path,
    app_handle: tauri::AppHandle,
) -> Result<EngineHandle, String> {
    let home = dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?;
    let hermes_dir = home.join(".hermes");

    // Setup config
    setup_hermes_config(&hermes_dir)?;

    // Find hermes executable
    let hermes_exe = find_hermes()
        .ok_or_else(|| "Hermes CLI not found. Please run setup first.".to_string())?;

    // Spawn gateway process
    let mut child = Command::new(&hermes_exe)
        .args(["gateway"])
        .env("HERMES_HOME", hermes_dir.to_string_lossy().to_string())
        .current_dir(&hermes_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to spawn gateway: {e}"))?;

    // Read stderr for debugging
    if let Some(stderr) = child.stderr.take() {
        let _app = app_handle.clone();
        tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let reader = tokio::io::BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                // Log gateway stderr (debug info)
                let _ = line; // Suppress unused warning
            }
        });
    }

    let gateway_url = format!("http://{}:{}", GATEWAY_HOST, GATEWAY_PORT);
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let _ = taskbolt_dir; // May use for additional data paths later

    Ok(EngineHandle {
        child: Arc::new(tokio::sync::Mutex::new(Some(child))),
        client,
        gateway_url,
    })
}

/// Check if gateway is already running
pub async fn is_gateway_running() -> bool {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap_or_else(|_| Client::new());
    let url = format!("http://{}:{}/health", GATEWAY_HOST, GATEWAY_PORT);
    client.get(&url).send().await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Initialize: install if needed, then start gateway
pub async fn initialize_engine(app_handle: tauri::AppHandle) -> Result<EngineHandle, String> {
    let home = dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?;
    let taskbolt_dir = home.join(".taskbolt");
    std::fs::create_dir_all(&taskbolt_dir).ok();

    // Check if hermes is installed
    if find_hermes().is_none() {
        app_handle.emit("agent-event", serde_json::json!({
            "type": "status",
            "content": "Installing TaskBolt engine..."
        }).to_string()).ok();

        install_hermes(app_handle.clone()).await?;
    }

    // Check if gateway is already running
    if is_gateway_running().await {
        app_handle.emit("agent-event", serde_json::json!({
            "type": "status",
            "content": "Engine already running — connecting..."
        }).to_string()).ok();

        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(600))
            .build()
            .map_err(|e| format!("HTTP client error: {e}"))?;
        let gateway_url = format!("http://{}:{}", GATEWAY_HOST, GATEWAY_PORT);

        return Ok(EngineHandle {
            child: Arc::new(tokio::sync::Mutex::new(None)),
            client,
            gateway_url,
        });
    }

    // Start the gateway
    app_handle.emit("agent-event", serde_json::json!({
        "type": "status",
        "content": "Starting TaskBolt engine..."
    }).to_string()).ok();

    let handle = start_engine(&taskbolt_dir, app_handle.clone())?;

    // Wait for it to be ready
    app_handle.emit("agent-event", serde_json::json!({
        "type": "status",
        "content": "Waiting for engine to start..."
    }).to_string()).ok();

    wait_for_gateway(&handle.client, 60).await
        .map_err(|e| format!("Engine failed to start: {e}"))?;

    app_handle.emit("agent-event", serde_json::json!({
        "type": "status",
        "content": "TaskBolt engine ready!"
    }).to_string()).ok();

    Ok(handle)
}
