use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tauri::Emitter;

pub struct EngineHandle {
    #[allow(dead_code)]
    child: Arc<tokio::sync::Mutex<tokio::process::Child>>,
    stdin_tx: tokio::sync::mpsc::UnboundedSender<String>,
}

impl EngineHandle {
    pub fn stdin_tx(&self) -> tokio::sync::mpsc::UnboundedSender<String> {
        self.stdin_tx.clone()
    }
}

/// Find Python executable on the system.
fn find_python() -> String {
    // 1. Check project-local .venv (dev mode)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            for ancestor in exe_dir.ancestors().take(5) {
                let venv_py = if cfg!(windows) {
                    ancestor.join(".venv").join("Scripts").join("python.exe")
                } else {
                    ancestor.join(".venv").join("bin").join("python")
                };
                if venv_py.exists() {
                    return venv_py.to_string_lossy().to_string();
                }
            }
        }
    }

    // 2. Try common Windows Python installations
    if cfg!(windows) {
        for version in &["Python313", "Python312", "Python311", "Python310"] {
            let py = PathBuf::from(format!(
                r"C:\Users\{}\AppData\Local\Programs\Python\{}\python.exe",
                std::env::var("USERNAME").unwrap_or_default(),
                version
            ));
            if py.exists() {
                return py.to_string_lossy().to_string();
            }
        }
    }

    // 3. Fallback to PATH
    if cfg!(windows) {
        "python".to_string()
    } else {
        "python3".to_string()
    }
}

/// Embed the agent engine script into the binary
const AGENT_SCRIPT: &str = include_str!("../../agent-engine/taskbolt_agent.py");

pub fn start_engine(
    taskbolt_dir: &std::path::Path,
    app_handle: tauri::AppHandle,
) -> Result<EngineHandle, String> {
    // Write embedded agent script to data directory
    let agent_dst = taskbolt_dir.join("taskbolt_agent.py");
    std::fs::write(&agent_dst, AGENT_SCRIPT)
        .map_err(|e| format!("Write embedded agent failed: {e}"))?;

    let python_exe = find_python();

    let mut child = Command::new(&python_exe)
        .arg("-u")
        .arg(&agent_dst)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .current_dir(taskbolt_dir)
        .env("TASKBOLT_API", "https://taskbolt-saas.vercel.app/api/ai/agent")
        .spawn()
        .map_err(|e| {
            format!(
                "Engine spawn failed: {e}\n  Python: {python_exe}\n  Agent: {}",
                agent_dst.display()
            )
        })?;

    let stdin = child.stdin.take().ok_or("No stdin")?;
    let stdout = child.stdout.take().ok_or("No stdout")?;
    let stderr = child.stderr.take();

    let (stdin_tx, mut stdin_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    let child = Arc::new(tokio::sync::Mutex::new(child));

    // Writer — forwards messages from Tauri to agent stdin
    tokio::spawn(async move {
        let mut stdin = stdin;
        while let Some(msg) = stdin_rx.recv().await {
            if stdin
                .write_all(format!("{msg}\n").as_bytes())
                .await
                .is_err()
            {
                break;
            }
            stdin.flush().await.ok();
        }
    });

    // Reader — reads JSON lines from agent and emits Tauri events
    let handle = app_handle.clone();
    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            // Each line is a JSON event from the agent
            // Emit it as a Tauri event so the frontend can listen
            let _ = handle.emit("agent-event", &line);
        }
    });

    // Stderr reader for debugging
    if let Some(stderr) = stderr {
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[TaskBolt agent] {line}");
            }
        });
    }

    Ok(EngineHandle { child, stdin_tx })
}

/// Send a chat message to the agent engine
pub fn send_chat(
    stdin_tx: &tokio::sync::mpsc::UnboundedSender<String>,
    message: &str,
    thread_id: &str,
    auth_token: &str,
) -> Result<(), String> {
    let json_msg = serde_json::json!({
        "action": "chat",
        "message": message,
        "thread_id": thread_id,
        "auth_token": auth_token,
    });

    stdin_tx
        .send(json_msg.to_string())
        .map_err(|e| format!("Send failed: {e}"))
}
