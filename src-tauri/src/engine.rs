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
/// Prod: bundled resources → hermes-engine/ next to the executable
fn find_engine_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("Cannot find current exe: {e}"))?;
    let exe_dir = exe.parent().ok_or("Cannot determine exe directory")?;

    // 1. Check next to the executable (dev: src-tauri/target/debug or release)
    //    Walk up to find hermes-engine
    for ancestor in exe_dir.ancestors().take(5) {
        let candidate = ancestor.join("hermes-engine");
        if candidate.join("pyproject.toml").exists() {
            return Ok(candidate);
        }
    }

    // 2. Check Tauri bundled resources (production)
    //    Tauri places resources in a `resources/` dir next to the exe
    let bundled = exe_dir.join("resources").join("hermes-engine");
    if bundled.join("pyproject.toml").exists() {
        return Ok(bundled);
    }

    // 3. Check user's .taskbolt dir (fallback — engine cloned on first run)
    let home = dirs::home_dir().ok_or_else(|| "Cannot find home dir".to_string())?;
    let user_engine = home.join(".taskbolt").join("hermes-engine");
    if user_engine.join("pyproject.toml").exists() {
        return Ok(user_engine);
    }

    Err(format!(
        "hermes-engine not found. Searched:\n  - exe ancestors\n  - {}\n  - {}",
        bundled.display(),
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
    // Copy bridge script into engine dir
    let bridge_src = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.join("resources").join("taskbolt_bridge.py")))
        .unwrap_or_else(|| PathBuf::from("taskbolt_bridge.py"));

    let bridge_dst = engine_dir.join("taskbolt_bridge.py");

    if bridge_src.exists() {
        std::fs::copy(&bridge_src, &bridge_dst)
            .map_err(|e| format!("Copy bridge failed: {e}"))?;
    } else if !bridge_dst.exists() {
        // Try from CARGO_MANIFEST_DIR (dev mode)
        let manifest_bridge = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("taskbolt_bridge.py");
        if manifest_bridge.exists() {
            std::fs::copy(&manifest_bridge, &bridge_dst)
                .map_err(|e| format!("Copy bridge from manifest failed: {e}"))?;
        } else {
            return Err("taskbolt_bridge.py not found anywhere".to_string());
        }
    }

    // Python executable
    let python = if cfg!(windows) {
        engine_dir.join(".venv").join("Scripts").join("python.exe")
    } else {
        engine_dir.join(".venv").join("bin").join("python")
    };

    let python_exe = if python.exists() {
        python.to_string_lossy().to_string()
    } else if cfg!(windows) {
        "python".to_string()
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
