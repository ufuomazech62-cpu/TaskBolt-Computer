use std::sync::Mutex;
use tauri::State;

mod engine;

struct AppState {
    engine: Mutex<Option<engine::EngineHandle>>,
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
    std::fs::create_dir_all(&taskbolt_dir).map_err(|e| format!("Failed to create .taskbolt dir: {e}"))?;

    let info = format!(
        "System detected — setting up TaskBolt at {}",
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
    
    let handle = engine_guard.as_ref()
        .ok_or_else(|| "Engine not started. Run auto_setup first.".to_string())?;

    engine::send_to_engine(handle, &content).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .manage(AppState {
            engine: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            auto_setup,
            send_message,
        ])
        .run(tauri::generate_context!())
        .expect("error while running TaskBolt");
}
