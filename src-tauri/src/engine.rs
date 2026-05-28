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

/// Find Python executable on the system.
/// Prefers Python 3.12 on Windows (3.13+ has asyncio proactor bugs with piped stdin).
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
            let py = PathBuf::from(format!(r"C:\Users\{}\AppData\Local\Programs\Python\{}\python.exe",
                std::env::var("USERNAME").unwrap_or_default(), version));
            if py.exists() {
                return py.to_string_lossy().to_string();
            }
        }
    }

    // 3. Fallback to PATH
    if cfg!(windows) { "python".to_string() } else { "python3".to_string() }
}

pub fn start_engine(taskbolt_dir: &std::path::Path) -> Result<EngineHandle, String> {
    // Bridge script is embedded in the binary via include_str! — always available.
    // Write it to the taskbolt data directory so it persists across runs.
    let bridge_dst = taskbolt_dir.join("taskbolt_bridge.py");
    std::fs::write(&bridge_dst, include_str!("../../taskbolt_bridge.py"))
        .map_err(|e| format!("Write embedded bridge failed: {e}"))?;

    let python_exe = find_python();

    let mut child = Command::new(&python_exe)
        .arg("-u")
        .arg(&bridge_dst)
        .arg("--taskbolt-dir")
        .arg(taskbolt_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .current_dir(taskbolt_dir)
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
