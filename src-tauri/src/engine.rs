use std::path::Path;
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

pub fn start_engine(taskbolt_dir: &Path) -> Result<EngineHandle, String> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let project_root = manifest_dir.parent().unwrap();
    let engine_dir = project_root.join("hermes-engine");

    // The bridge script lives in the project root; copy it into hermes-engine
    let bridge_src = project_root.join("taskbolt_bridge.py");
    let bridge_dst = engine_dir.join("taskbolt_bridge.py");
    if bridge_src.exists() {
        std::fs::copy(&bridge_src, &bridge_dst)
            .map_err(|e| format!("Failed to copy bridge: {e}"))?;
    } else if !bridge_dst.exists() {
        return Err("taskbolt_bridge.py not found in project root or hermes-engine".to_string());
    }

    // Determine Python executable
    let python = if cfg!(windows) {
        engine_dir.join(".venv").join("Scripts").join("python.exe")
    } else {
        engine_dir.join(".venv").join("bin").join("python")
    };

    let python_exe = if python.exists() {
        python.to_string_lossy().to_string()
    } else {
        if cfg!(windows) {
            "python".to_string()
        } else {
            "python3".to_string()
        }
    };

    let script = &bridge_dst;

    // Spawn Python bridge process
    let mut child = Command::new(&python_exe)
        .arg("-u")
        .arg(script)
        .arg("--taskbolt-dir")
        .arg(taskbolt_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .current_dir(&engine_dir)
        .spawn()
        .map_err(|e| {
            format!(
                "Failed to start Python engine: {e}\n  Python: {python_exe}\n  Script: {script:?}"
            )
        })?;

    let stdin = child.stdin.take().ok_or("Failed to open stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to open stdout")?;

    let (stdin_tx, mut stdin_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let response_tx: Arc<tokio::sync::Mutex<Option<oneshot::Sender<String>>>> =
        Arc::new(tokio::sync::Mutex::new(None));

    let child = Arc::new(tokio::sync::Mutex::new(child));

    // Writer task
    tokio::spawn(async move {
        let mut stdin = stdin;
        while let Some(msg) = stdin_rx.recv().await {
            let line = format!("{msg}\n");
            if stdin.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            stdin.flush().await.ok();
        }
    });

    // Reader task
    let response_tx_reader = response_tx.clone();
    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.starts_with("RESPONSE:") {
                let content = line.strip_prefix("RESPONSE:").unwrap_or(&line).trim().to_string();
                let mut guard = response_tx_reader.lock().await;
                if let Some(tx) = guard.take() {
                    tx.send(content).ok();
                }
            } else if line.starts_with("STATUS:") {
                eprintln!("[TaskBolt] {}", line.strip_prefix("STATUS:").unwrap_or(&line).trim());
            } else if line.starts_with("ERROR:") {
                eprintln!(
                    "[TaskBolt ERROR] {}",
                    line.strip_prefix("ERROR:").unwrap_or(&line).trim()
                );
            }
        }
    });

    // Stderr logger
    let stderr = {
        let mut c = child.lock().await;
        c.stderr.take()
    };
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

pub async fn send_to_engine(handle: &EngineHandle, message: &str) -> Result<String, String> {
    let (tx, rx) = oneshot::channel();

    // Store the response channel and drop the lock immediately
    {
        let mut guard = handle.response_tx.lock().await;
        *guard = Some(tx);
    }

    let json_msg = serde_json::json!({
        "type": "message",
        "content": message,
    });

    handle
        .stdin_tx
        .send(json_msg.to_string())
        .map_err(|e| format!("Failed to send to engine: {e}"))?;

    tokio::time::timeout(std::time::Duration::from_secs(120), rx)
        .await
        .map_err(|_| "Agent timed out (120s)".to_string())?
        .map_err(|_| "Engine disconnected".to_string())
}
