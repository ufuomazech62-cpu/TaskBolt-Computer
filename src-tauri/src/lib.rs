use std::sync::Arc;
use tauri::State;
use tauri::Emitter;

mod engine;
mod backend;

struct AppState {
    engine: Arc<tokio::sync::Mutex<Option<engine::EngineHandle>>>,
}

#[tauri::command]
async fn auto_setup(
    _state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let os_name = std::env::consts::OS;
    let os_arch = std::env::consts::ARCH;

    app.emit("agent-event", serde_json::json!({
        "type": "status",
        "content": format!("System detected ({os_name}/{os_arch}) — TaskBolt ready.")
    }).to_string()).ok();

    Ok(format!(
        "System detected ({os_name}/{os_arch}) — TaskBolt AI agent ready.\nI can now execute commands, install software, manage files, and automate tasks on your computer."
    ))
}

/// Send a message through the TaskBolt engine (Odysseus agent core).
///
/// Architecture:
///   User message → Tauri → TaskBolt Engine (Python, local)
///     → Engine uses Odysseus tools (bash, python, files, web, memory, skills)
///     → All LLM calls go to https://taskbolt.space/api/v1/chat/completions
///     → Vercel SaaS checks JWT auth + deducts credits + calls DashScope
///     → Response streams back with full tool-calling capability
///
/// The engine runs locally with ALL tools. Only AI model calls go through SaaS for billing.
/// API key never touches the user's machine.
#[tauri::command]
async fn send_message(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    content: String,
    thread_id: String,
    auth_token: String,
) -> Result<(), String> {
    // Auth token is required — SaaS billing won't work without it
    if auth_token.is_empty() {
        app.emit("agent-event", serde_json::json!({
            "type": "error",
            "content": "Please sign in to use TaskBolt AI."
        }).to_string()).ok();
        app.emit("agent-event", serde_json::json!({
            "type": "done"
        }).to_string()).ok();
        return Ok(());
    }

    // Auto-start engine if not running, or restart if token changed
    {
        let mut guard = state.engine.lock().await;
        let needs_restart = match guard.as_ref() {
            None => true,
            Some(handle) => handle.get_token().await != auth_token,
        };

        if needs_restart {
            // Kill old engine if token changed
            if let Some(ref handle) = *guard {
                handle.kill_gateway().await;
            }

            let handle = engine::initialize_engine(app.clone(), &auth_token).await?;
            *guard = Some(handle);
        }
    }

    // Send the message to the engine via stdin
    let msg = serde_json::json!({
        "type": "chat",
        "message": content,
        "session_id": thread_id,
        "model": "qwen-plus"
    });

    {
        let guard = state.engine.lock().await;
        let handle = guard
            .as_ref()
            .ok_or_else(|| "Engine not started.".to_string())?;
        handle.send_message(&msg.to_string()).await?;
    }

    Ok(())
}

/// Save user context to a file the engine reads for personalization
#[tauri::command]
async fn save_user_context(context: String) -> Result<(), String> {
    let home = dirs::home_dir()
        .ok_or_else(|| "Could not determine home directory".to_string())?;
    let dir = home.join(".taskbolt");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create .taskbolt dir: {e}"))?;
    let path = dir.join("user_context.txt");
    std::fs::write(&path, &context).map_err(|e| format!("Could not write user context: {e}"))?;
    Ok(())
}

/// Cancel the current message generation
#[tauri::command]
async fn cancel_message(
    state: State<'_, AppState>,
) -> Result<(), String> {
    let guard = state.engine.lock().await;
    if let Some(ref handle) = *guard {
        handle.kill_gateway().await;
    }
    Ok(())
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
            cancel_message,
            save_user_context,
            backend::get_gateway_config,
            backend::set_gateway_platform,
            backend::disconnect_gateway_platform,
            backend::get_memory_entries,
            backend::add_memory_entry,
            backend::delete_memory_entry,
            backend::get_user_profile,
            backend::set_user_profile,
            backend::get_skills,
            backend::toggle_skill,
            backend::get_toolsets,
            backend::toggle_toolset,
            backend::get_schedules,
            backend::add_schedule,
            backend::toggle_schedule,
            backend::delete_schedule,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
