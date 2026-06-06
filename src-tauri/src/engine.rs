use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tokio::process::Command;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tauri::Emitter;

// Vercel SaaS base URL
const VERCEL_SAAS_URL: &str = "https://taskbolt.space";

pub struct EngineHandle {
    pub child: Arc<tokio::sync::Mutex<Option<tokio::process::Child>>>,
    pub stdin_tx: Option<tokio::sync::mpsc::Sender<String>>,
    current_token: Arc<tokio::sync::Mutex<String>>,
}

impl EngineHandle {
    pub async fn kill_gateway(&self) {
        let mut child_guard = self.child.lock().await;
        if let Some(ref mut child) = *child_guard {
            child.kill().await.ok();
            *child_guard = None;
        }
    }

    pub async fn get_token(&self) -> String {
        self.current_token.lock().await.clone()
    }

    /// Send a JSON message to the engine's stdin
    pub async fn send_message(&self, json_msg: &str) -> Result<(), String> {
        if let Some(ref tx) = self.stdin_tx {
            tx.send(format!("{}\n", json_msg))
                .await
                .map_err(|e| format!("Failed to send to engine: {e}"))?;
            Ok(())
        } else {
            Err("Engine stdin not available".to_string())
        }
    }
}

/// Find Python executable
fn find_python() -> String {
    if cfg!(windows) {
        let username = std::env::var("USERNAME").unwrap_or_default();
        for version in &["Python313", "Python312", "Python311", "Python310"] {
            let py = PathBuf::from(format!(
                r"C:\Users\{}\AppData\Local\Programs\Python\{}\python.exe",
                username, version
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

/// Find the engine directory (where main.py lives)
fn find_engine_dir() -> Option<PathBuf> {
    // Check relative to the executable
    if let Ok(exe) = std::env::current_exe() {
        // Production: engine bundled next to executable
        let candidate = exe.parent()?.join("engine").join("odysseus-core");
        if candidate.join("main.py").exists() {
            return Some(candidate);
        }
        // Dev mode: engine is in the project root
        let candidate = exe.parent()?.join("../../engine/odysseus-core");
        if candidate.join("main.py").exists() {
            return Some(candidate.canonicalize().unwrap_or(candidate));
        }
        // Dev mode: engine is in the project root (direct)
        let candidate = exe.parent()?.join("../../../../engine/odysseus-core");
        if candidate.join("main.py").exists() {
            return Some(candidate.canonicalize().unwrap_or(candidate));
        }
    }

    // Check common locations
    let home = dirs::home_dir()?;

    // In the project workspace (dev mode)
    let candidates = vec![
        home.join(".openclaw-autoclaw").join("agents").join("zechy-computer")
            .join("workspace").join("TaskBolt-Computer").join("engine").join("odysseus-core"),
        home.join(".taskbolt").join("engine").join("odysseus-core"),
    ];

    for candidate in &candidates {
        if candidate.join("main.py").exists() {
            return Some(candidate.clone());
        }
    }

    None
}

/// Check if engine dependencies are installed
async fn check_dependencies(python: &str, engine_dir: &PathBuf) -> bool {
    let output = Command::new(python)
        .args(["-c", "import httpx; print('ok')"])
        .current_dir(engine_dir)
        .output()
        .await;

    match output {
        Ok(o) => o.status.success(),
        Err(_) => false,
    }
}

/// Install engine dependencies
async fn install_dependencies(
    python: &str,
    engine_dir: &PathBuf,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    app_handle.emit("agent-event", serde_json::json!({
        "type": "status",
        "content": "Installing TaskBolt engine dependencies..."
    }).to_string()).ok();

    let req_file = engine_dir.join("requirements.txt");

    let output = Command::new(python)
        .args(["-m", "pip", "install", "-r", req_file.to_str().unwrap_or("requirements.txt"),
               "--quiet", "--disable-pip-version-check"])
        .current_dir(engine_dir)
        .output()
        .await
        .map_err(|e| format!("Could not run pip: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("pip install failed: {stderr}"));
    }

    Ok(())
}

/// Initialize the TaskBolt engine: install deps, start Python process
pub async fn initialize_engine(
    app_handle: tauri::AppHandle,
    jwt_token: &str,
) -> Result<EngineHandle, String> {
    let python = find_python();

    // Find engine directory
    let engine_dir = find_engine_dir()
        .ok_or_else(|| "TaskBolt engine not found. Engine directory missing.".to_string())?;

    app_handle.emit("agent-event", serde_json::json!({
        "type": "status",
        "content": format!("Engine found at: {}", engine_dir.display())
    }).to_string()).ok();

    // Check/install dependencies
    if !check_dependencies(&python, &engine_dir).await {
        install_dependencies(&python, &engine_dir, app_handle.clone()).await?;
    }

    app_handle.emit("agent-event", serde_json::json!({
        "type": "status",
        "content": "Starting TaskBolt engine..."
    }).to_string()).ok();

    // Create stdin channel
    let (stdin_tx, mut stdin_rx) = tokio::sync::mpsc::channel::<String>(100);

    // Spawn the Python engine process
    let mut child = Command::new(&python)
        .args(["main.py"])
        .current_dir(&engine_dir)
        .env("TASKBOLT_SAAS_URL", VERCEL_SAAS_URL)
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to start engine: {e}"))?;

    // Take stdin handle for sending messages
    let mut child_stdin = child.stdin.take()
        .ok_or_else(|| "Failed to get engine stdin".to_string())?;

    // Spawn task to forward messages from channel to process stdin
    tokio::spawn(async move {
        while let Some(msg) = stdin_rx.recv().await {
            if child_stdin.write_all(msg.as_bytes()).await.is_err() {
                break;
            }
            child_stdin.flush().await.ok();
        }
    });

    // Take stdout to read SSE events
    let stdout = child.stdout.take()
        .ok_or_else(|| "Failed to get engine stdout".to_string())?;

    // Spawn task to read stdout and emit events to Tauri
    let app_clone = app_handle.clone();
    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();

        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() { continue; }

            // Engine outputs JSON lines — forward as agent-event
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(trimmed) {
                let event_type = parsed.get("type").and_then(|t| t.as_str()).unwrap_or("unknown");

                match event_type {
                    "ready" => {
                        app_clone.emit("agent-event", serde_json::json!({
                            "type": "status",
                            "content": format!("TaskBolt engine v{} ready ({} tools)",
                                parsed.get("version").and_then(|v| v.as_str()).unwrap_or("?"),
                                parsed.get("tools").and_then(|t| t.as_u64()).unwrap_or(0))
                        }).to_string()).ok();
                    }
                    "stream_delta" => {
                        // Stream text content chunks
                        app_clone.emit("agent-event", serde_json::json!({
                            "type": "content",
                            "content": parsed.get("text").and_then(|c| c.as_str()).unwrap_or("")
                        }).to_string()).ok();
                    }
                    "tool_start" => {
                        let tool = parsed.get("tool").and_then(|t| t.as_str()).unwrap_or("unknown");
                        let round = parsed.get("round").and_then(|r| r.as_u64()).unwrap_or(0);
                        let _args = parsed.get("args").and_then(|a| a.as_str()).unwrap_or("");
                        app_clone.emit("agent-event", serde_json::json!({
                            "type": "status",
                            "content": format!("Round {}: Running {}...", round, tool)
                        }).to_string()).ok();
                    }
                    "tool_output" => {
                        // Tool output — emit as content for now
                        let output = parsed.get("output").and_then(|o| o.as_str()).unwrap_or("");
                        if !output.is_empty() {
                            app_clone.emit("agent-event", serde_json::json!({
                                "type": "tool_output",
                                "tool": parsed.get("tool").and_then(|t| t.as_str()).unwrap_or(""),
                                "output": output,
                                "exit_code": parsed.get("exit_code").and_then(|e| e.as_i64()).unwrap_or(0)
                            }).to_string()).ok();
                        }
                    }
                    "status" => {
                        app_clone.emit("agent-event", serde_json::json!({
                            "type": "status",
                            "content": parsed.get("text").and_then(|m| m.as_str()).unwrap_or("")
                        }).to_string()).ok();
                    }
                    "error" => {
                        app_clone.emit("agent-event", serde_json::json!({
                            "type": "error",
                            "content": parsed.get("message").and_then(|m| m.as_str()).unwrap_or("Engine error")
                        }).to_string()).ok();
                    }
                    "done" => {
                        app_clone.emit("agent-event", serde_json::json!({
                            "type": "done"
                        }).to_string()).ok();
                    }
                    "auth_ok" => {
                        app_clone.emit("agent-event", serde_json::json!({
                            "type": "auth_ok",
                            "user": parsed.get("user").unwrap_or(&serde_json::Value::Null)
                        }).to_string()).ok();
                    }
                    "auth_fail" => {
                        app_clone.emit("agent-event", serde_json::json!({
                            "type": "auth_fail",
                            "error": parsed.get("error").and_then(|e| e.as_str()).unwrap_or("Auth failed")
                        }).to_string()).ok();
                    }
                    "pong" => {
                        // Ignore ping responses
                    }
                    "ok" => {
                        // Acknowledgement events (memory added, session deleted, etc.)
                    }
                    "session_list" | "memory_list" | "mcp_list" | "preference" => {
                        // Data responses — forward as-is for frontend to handle
                        app_clone.emit("engine-data", trimmed.to_string()).ok();
                    }
                    "setup_progress" => {
                        // Setup progress events
                        app_clone.emit("setup-progress", trimmed.to_string()).ok();
                    }
                    _ => {
                        // Forward unknown events as-is
                        app_clone.emit("engine-data", trimmed.to_string()).ok();
                    }
                }
            }
        }
    });

    // Forward stderr to log (debug only)
    let stderr = child.stderr.take();
    if let Some(stderr) = stderr {
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                // Engine logs go to stderr — we can optionally forward to UI
                eprintln!("[engine] {}", line);
            }
        });
    }

    // Wait for the "ready" signal (up to 30 seconds)
    // The stdout reader task will emit the ready event
    tokio::time::sleep(tokio::time::Duration::from_millis(2000)).await;

    app_handle.emit("agent-event", serde_json::json!({
        "type": "status",
        "content": "TaskBolt engine starting up..."
    }).to_string()).ok();

    // Send auth command to authenticate the engine
    let auth_cmd = serde_json::json!({
        "type": "auth",
        "token": jwt_token
    });
    if let Err(e) = stdin_tx.send(format!("{}\n", auth_cmd)).await {
        eprintln!("[engine] Failed to send auth command: {}", e);
    }

    Ok(EngineHandle {
        child: Arc::new(tokio::sync::Mutex::new(Some(child))),
        stdin_tx: Some(stdin_tx),
        current_token: Arc::new(tokio::sync::Mutex::new(jwt_token.to_string())),
    })
}
