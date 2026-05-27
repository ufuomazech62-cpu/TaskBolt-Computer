use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;

pub struct EngineHandle {
    #[allow(dead_code)]
    child: Arc<tokio::sync::Mutex<tokio::process::Child>>,
    stdin_tx: tokio::sync::mpsc::UnboundedSender<String>,
    response_tx: Arc<tokio::sync::Mutex<Option<oneshot::Sender<String>>>>,
}

impl EngineHandle {
    pub fn stdin_tx(&self) -> tokio::sync::mpsc::UnboundedSender<String> {
        self.stdin_tx.clone()
    }

    pub fn response_tx(&self) -> Arc<tokio::sync::Mutex<Option<oneshot::Sender<String>>>> {
        self.response_tx.clone()
    }
}

/// Find the hermes-engine directory at runtime.
/// Dev:  <project_root>/hermes-engine (sibling of src-tauri)
/// Prod: ~/.taskbolt/hermes-engine (cloned on first run)
pub fn find_engine_dir() -> Result<PathBuf, String> {
    // 1. Walk up from exe to find hermes-engine (dev mode)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            for ancestor in exe_dir.ancestors().take(5) {
                let candidate = ancestor.join("hermes-engine");
                if candidate.join("pyproject.toml").exists() {
                    return Ok(candidate);
                }
            }
        }
    }

    // 2. Check ~/.taskbolt/hermes-engine (production — cloned on first run)
    let home = dirs::home_dir().ok_or_else(|| "Cannot find home dir".to_string())?;
    let user_engine = home.join(".taskbolt").join("hermes-engine");
    if user_engine.join("pyproject.toml").exists() {
        return Ok(user_engine);
    }

    Err(format!(
        "hermes-engine not found. Run auto_setup to clone it to {}",
        user_engine.display()
    ))
}

/// Clone hermes-engine on first run if not found.
pub async fn ensure_engine() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "No home dir".to_string())?;
    let engine_dir = home.join(".taskbolt").join("hermes-engine");

    if engine_dir.join("pyproject.toml").exists() {
        return Ok(engine_dir);
    }

    eprintln!("[TaskBolt] Cloning hermes-engine (first run)...");
    let status = Command::new("git")
        .args(["clone", "--depth", "1", "https://github.com/NousResearch/hermes-agent.git"])
        .arg(&engine_dir)
        .status()
        .await
        .map_err(|e| format!("git clone failed: {e}"))?;

    if !status.success() {
        return Err("git clone of hermes-engine failed".to_string());
    }

    eprintln!("[TaskBolt] hermes-engine cloned to {}", engine_dir.display());
    Ok(engine_dir)
}

pub fn start_engine(engine_dir: &PathBuf, taskbolt_dir: &std::path::Path) -> Result<EngineHandle, String> {
    // Bridge script is embedded in the binary via include_str! — always available
    let bridge_dst = engine_dir.join("taskbolt_bridge.py");
    if !bridge_dst.exists() {
        std::fs::write(&bridge_dst, include_str!("../../taskbolt_bridge.py"))
            .map_err(|e| format!("Write embedded bridge failed: {e}"))?;
    }

    // Python executable — prefer Python 3.12 on Windows (3.13+ has proactor bugs)
    let python = if cfg!(windows) {
        engine_dir.join(".venv").join("Scripts").join("python.exe")
    } else {
        engine_dir.join(".venv").join("bin").join("python")
    };

    let python_exe = if python.exists() {
        python.to_string_lossy().to_string()
    } else if cfg!(windows) {
        // Try Python 3.12 first (avoids 3.13+ proactor bug)
        let py312 = PathBuf::from(r"C:\Users\H-P\AppData\Local\Programs\Python\Python312\python.exe");
        if py312.exists() {
            py312.to_string_lossy().to_string()
        } else {
            "python".to_string()
        }
    } else {
        "python3".to_string()
    };

    let mut child = Command::new(&python_exe)
        .arg("-u")
        .arg(&bridge_dst)
        .arg("--taskbolt-dir")
        .arg(taskbolt_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .current_dir(engine_dir)
        .spawn()
        .map_err(|e| format!("Engine spawn failed: {e}\n  Python: {python_exe}\n  Bridge: {}", bridge_dst.display()))?;

    let stdin = child.stdin.take().ok_or("No stdin")?;
    let stdout = child.stdout.take().ok_or("No stdout")?;
    let stderr = child.stderr.take();

    let (stdin_tx, mut stdin_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let response_tx: Arc<tokio::sync::Mutex<Option<oneshot::Sender<String>>>> =
        Arc::new(tokio::sync::Mutex::new(None));

    let child = Arc::new(tokio::sync::Mutex::new(child));

    // Writer
    tokio::spawn(async move {
        let mut stdin = stdin;
        while let Some(msg) = stdin_rx.recv().await {
            if stdin.write_all(format!("{msg}\n").as_bytes()).await.is_err() {
                break;
            }
            stdin.flush().await.ok();
        }
    });

    // Reader
    let rt = response_tx.clone();
    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.starts_with("RESPONSE:") {
                let content = line.strip_prefix("RESPONSE:").unwrap_or(&line).trim().to_string();
                let mut g = rt.lock().await;
                if let Some(tx) = g.take() {
                    tx.send(content).ok();
                }
            } else if line.starts_with("STATUS:") {
                eprintln!("[TaskBolt] {}", &line[7..].trim());
            } else if line.starts_with("ERROR:") {
                eprintln!("[TaskBolt ERR] {}", &line[6..].trim());
            }
        }
    });

    if let Some(stderr) = stderr {
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[TaskBolt stderr] {line}");
            }
        });
    }

    Ok(EngineHandle {
        child,
        stdin_tx,
        response_tx,
    })
}

pub async fn send_to_engine_parts(
    stdin_tx: &tokio::sync::mpsc::UnboundedSender<String>,
    response_tx: &Arc<tokio::sync::Mutex<Option<oneshot::Sender<String>>>>,
    message: &str,
) -> Result<String, String> {
    let (tx, rx) = oneshot::channel();
    {
        let mut guard = response_tx.lock().await;
        *guard = Some(tx);
    }

    let json_msg = serde_json::json!({
        "type": "message",
        "content": message,
    });

    stdin_tx
        .send(json_msg.to_string())
        .map_err(|e| format!("Send failed: {e}"))?;

    tokio::time::timeout(std::time::Duration::from_secs(120), rx)
        .await
        .map_err(|_| "Agent timed out (120s)".to_string())?
        .map_err(|_| "Engine disconnected".to_string())
}
