use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::oneshot;

pub struct EngineHandle {
    child: Arc<tokio::sync::Mutex<Child>>,
    stdin_tx: tokio::sync::mpsc::UnboundedSender<String>,
    response_tx: tokio::sync::Mutex<Option<oneshot::Sender<String>>>,
}

pub fn start_engine(taskbolt_dir: &Path) -> Result<EngineHandle, String> {
    let engine_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("hermes-engine");

    // Determine Python executable
    let python = if cfg!(windows) {
        engine_dir.join(".venv").join("Scripts").join("python.exe")
    } else {
        engine_dir.join(".venv").join("bin").join("python")
    };

    let python_exe = if python.exists() {
        python
    } else {
        // Fall back to system Python
        std::env::var("TASKBOLT_PYTHON")
            .ok()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                if cfg!(windows) {
                    "python".into()
                } else {
                    "python3".into()
                }
            })
    };

    let script = engine_dir.join("taskbolt_bridge.py");

    // Spawn Python bridge process
    let mut child = Command::new(&python_exe)
        .arg("-u") // unbuffered
        .arg(&script)
        .arg("--taskbolt-dir")
        .arg(taskbolt_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to start Python engine: {e}\n  Python: {python_exe:?}\n  Script: {script:?}"))?;

    let stdin = child.stdin.take().ok_or("Failed to open stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to open stdout")?;

    let (stdin_tx, mut stdin_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let (response_tx, response_rx) = tokio::sync::Mutex::new(None);

    let child = Arc::new(tokio::sync::Mutex::new(child));
    let child_clone = child.clone();

    // Writer task: send messages to Python stdin
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

    // Reader task: parse responses from Python stdout
    let response_rx_arc = Arc::new(tokio::sync::Mutex::new(response_rx));
    let response_rx_clone = response_rx_arc.clone();
    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            // Protocol: lines starting with "RESPONSE:" are agent replies
            // Lines starting with "STATUS:" are setup/status updates
            // Lines starting with "ERROR:" are errors
            if line.starts_with("RESPONSE:") {
                let content = line.strip_prefix("RESPONSE:").unwrap_or(&line).trim().to_string();
                let mut rx_guard = response_rx_clone.lock().await;
                if let Some(tx) = rx_guard.take() {
                    tx.send(content).ok();
                }
            } else if line.starts_with("STATUS:") {
                eprintln!("[TaskBolt] {}", line.strip_prefix("STATUS:").unwrap_or(&line).trim());
            } else if line.starts_with("ERROR:") {
                eprintln!("[TaskBolt ERROR] {}", line.strip_prefix("ERROR:").unwrap_or(&line).trim());
            }
        }
    });

    // Stderr logger
    let stderr = child_clone.lock().await.stderr.take();
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
        response_tx: tokio::sync::Mutex::new(None),
    })
}

pub async fn send_to_engine(handle: &EngineHandle, message: &str) -> Result<String, String> {
    let (tx, rx) = oneshot::channel();
    
    // Store the response channel
    {
        let mut guard = handle.response_tx.lock().await;
        *guard = Some(tx);
    }

    // Send the message as JSON to the Python bridge
    let json_msg = serde_json::json!({
        "type": "message",
        "content": message,
    });
    
    handle.stdin_tx
        .send(json_msg.to_string())
        .map_err(|e| format!("Failed to send to engine: {e}"))?;

    // Wait for response with timeout
    tokio::time::timeout(
        std::time::Duration::from_secs(120),
        rx,
    )
    .await
    .map_err(|_| "Agent timed out (120s)".to_string())?
    .map_err(|_| "Engine disconnected".to_string())
}
