use std::sync::Arc;
use tauri::State;
use tokio::sync::oneshot;

mod engine;

struct AppState {
    engine: Arc<tokio::sync::Mutex<Option<engine::EngineHandle>>>,
}

#[tauri::command]
async fn auto_setup(state: State<'_, AppState>) -> Result<String, String> {
    let mut engine_guard = state.engine.lock().await;

    if engine_guard.is_some() {
        return Ok("TaskBolt engine already running".to_string());
    }

    // Create .taskbolt directory
    let home = dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?;
    let taskbolt_dir = home.join(".taskbolt");
    std::fs::create_dir_all(&taskbolt_dir)
        .map_err(|e| format!("Failed to create .taskbolt dir: {e}"))?;

    for sub in &["config", "data", "sessions", "skills", "logs"] {
        std::fs::create_dir_all(taskbolt_dir.join(sub)).ok();
    }

    let os_name = std::env::consts::OS;
    let os_arch = std::env::consts::ARCH;

    // Start engine — bridge is embedded in the binary, no external clone needed
    let handle = engine::start_engine(&taskbolt_dir)?;
    *engine_guard = Some(handle);

    Ok(format!(
        "System detected ({os_name}/{os_arch}) — TaskBolt engine ready.\nReady to go."
    ))
}

#[tauri::command]
async fn send_message(state: State<'_, AppState>, content: String) -> Result<String, String> {
    // Auto-start engine if not already running (handles stale localStorage from old versions)
    {
        let mut guard = state.engine.lock().await;
        if guard.is_none() {
            let home = dirs::home_dir()
                .ok_or_else(|| "Could not find home directory".to_string())?;
            let taskbolt_dir = home.join(".taskbolt");
            std::fs::create_dir_all(&taskbolt_dir).ok();
            for sub in &["config", "data", "sessions", "skills", "logs"] {
                std::fs::create_dir_all(taskbolt_dir.join(sub)).ok();
            }
            let handle = engine::start_engine(&taskbolt_dir)?;
            *guard = Some(handle);
        }
    }

    let (stdin_tx, response_tx) = {
        let guard = state.engine.lock().await;
        let handle = guard
            .as_ref()
            .ok_or_else(|| "Engine not started.".to_string())?;
        (handle.stdin_tx(), handle.response_tx())
    };

    engine::send_to_engine_parts(&stdin_tx, &response_tx, &content).await
}

#[tauri::command]
async fn connect_telegram(
    state: State<'_, AppState>,
    bot_token: String,
) -> Result<String, String> {
    let (stdin_tx, response_tx) = {
        let guard = state.engine.lock().await;
        let handle = guard
            .as_ref()
            .ok_or_else(|| "Engine not started.".to_string())?;
        (handle.stdin_tx(), handle.response_tx())
    };

    let cmd = serde_json::json!({
        "type": "command",
        "action": "connect_telegram",
        "bot_token": bot_token,
    });

    // Send command directly — don't use send_to_engine_parts which wraps in {type:"message"}
    let (tx, rx) = oneshot::channel();
    {
        let mut guard = response_tx.lock().await;
        *guard = Some(tx);
    }

    stdin_tx
        .send(cmd.to_string())
        .map_err(|e| format!("Send failed: {e}"))?;

    tokio::time::timeout(std::time::Duration::from_secs(120), rx)
        .await
        .map_err(|_| "Agent timed out (120s)".to_string())?
        .map_err(|_| "Engine disconnected".to_string())
}

#[tauri::command]
async fn get_system_info() -> Result<String, String> {
    let home = dirs::home_dir()
        .ok_or_else(|| "Could not find home".to_string())?;
    let taskbolt_dir = home.join(".taskbolt");

    let info = serde_json::json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "home": home.display().to_string(),
        "data_dir": taskbolt_dir.display().to_string(),
        "engine_available": true,
    });

    Ok(info.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .manage(AppState {
            engine: Arc::new(tokio::sync::Mutex::new(None)),
        })
        .invoke_handler(tauri::generate_handler![
            auto_setup,
            send_message,
            connect_telegram,
            get_system_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running TaskBolt");
}
