use std::sync::Mutex;
use tauri::State;

mod engine;

struct AppState {
    engine: Mutex<Option<engine::EngineHandle>>,
    config_dir: std::path::PathBuf,
}

#[tauri::command]
async fn auto_setup(state: State<'_, AppState>) -> Result<String, String> {
    let mut engine_guard = state.engine.lock().map_err(|e| e.to_string())?;

    if engine_guard.is_some() {
        return Ok("TaskBolt engine already running".to_string());
    }

    // Detect OS and home directory
    let home = dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?;
    let taskbolt_dir = home.join(".taskbolt");
    std::fs::create_dir_all(&taskbolt_dir)
        .map_err(|e| format!("Failed to create .taskbolt dir: {e}"))?;

    // Create subdirectories
    for sub in &["config", "data", "sessions", "skills", "logs"] {
        std::fs::create_dir_all(taskbolt_dir.join(sub)).ok();
    }

    // Detect OS info
    let os_name = std::env::consts::OS;
    let os_arch = std::env::consts::ARCH;
    let info = format!(
        "System detected ({os_name}/{os_arch}) — TaskBolt ready at {}",
        taskbolt_dir.display()
    );

    // Start the Python engine
    let handle = engine::start_engine(&taskbolt_dir)?;
    *engine_guard = Some(handle);

    Ok(info)
}

#[tauri::command]
async fn send_message(state: State<'_, AppState>, content: String) -> Result<String, String> {
    let engine_guard = state.engine.lock().map_err(|e| e.to_string())?;

    let handle = engine_guard
        .as_ref()
        .ok_or_else(|| "Engine not started. Run auto_setup first.".to_string())?;

    engine::send_to_engine(handle, &content).await
}

#[tauri::command]
async fn connect_telegram(
    state: State<'_, AppState>,
    bot_token: String,
) -> Result<String, String> {
    // Write token to config and start gateway
    let engine_guard = state.engine.lock().map_err(|e| e.to_string())?;
    let handle = engine_guard
        .as_ref()
        .ok_or_else(|| "Engine not started.".to_string())?;

    // Send gateway start command to engine
    let cmd = serde_json::json!({
        "type": "command",
        "action": "connect_telegram",
        "bot_token": bot_token,
    });

    engine::send_to_engine(handle, &cmd.to_string()).await
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
        "engine_ready": taskbolt_dir.join("config").exists(),
    });

    Ok(info.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let home = dirs::home_dir().unwrap_or_else(|| ".".into());
    let config_dir = home.join(".taskbolt").join("config");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .manage(AppState {
            engine: Mutex::new(None),
            config_dir,
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
