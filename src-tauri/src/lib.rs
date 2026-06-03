use std::sync::Arc;
use tauri::State;
use tauri::Emitter;
use futures_util::StreamExt;

mod engine;

struct AppState {
    engine: Arc<tokio::sync::Mutex<Option<engine::EngineHandle>>>,
}

#[tauri::command]
async fn auto_setup(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let mut engine_guard = state.engine.lock().await;

    if engine_guard.is_some() {
        return Ok("TaskBolt engine already running".to_string());
    }

    let handle = engine::initialize_engine(app.clone()).await?;
    *engine_guard = Some(handle);

    let os_name = std::env::consts::OS;
    let os_arch = std::env::consts::ARCH;

    Ok(format!(
        "System detected ({os_name}/{os_arch}) — TaskBolt AI agent ready.\nI can now execute commands, install software, manage files, and automate tasks on your computer."
    ))
}

/// Send a message to the agent via HTTP/SSE gateway.
/// Events stream back via Tauri "agent-event" listener.
#[tauri::command]
async fn send_message(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    content: String,
    thread_id: String,
    auth_token: String,
) -> Result<(), String> {
    // Auto-start engine if not running
    {
        let mut guard = state.engine.lock().await;
        if guard.is_none() {
            let handle = engine::initialize_engine(app.clone()).await?;
            *guard = Some(handle);
        }
    }

    let (client, gateway_url, api_key) = {
        let guard = state.engine.lock().await;
        let handle = guard
            .as_ref()
            .ok_or_else(|| "Engine not started.".to_string())?;
        (handle.client.clone(), handle.gateway_url.clone(), handle.api_key().to_string())
    };

    // Build the OpenAI-compatible chat request
    let session_id = format!("tb-{}", &thread_id);

    let body = serde_json::json!({
        "model": "openai:deepseek-v4-flash",
        "messages": [
            {"role": "user", "content": content}
        ],
        "stream": true
    });

    let url = format!("{}/v1/chat/completions", gateway_url);

    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("X-Hermes-Session-Id", &session_id)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Gateway request failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        app.emit("agent-event", serde_json::json!({
            "type": "error",
            "content": format!("Engine error ({}): {}", status, text)
        }).to_string()).ok();
        app.emit("agent-event", serde_json::json!({
            "type": "done"
        }).to_string()).ok();
        return Ok(());
    }

    // Parse SSE stream
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream error: {e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // Process complete SSE lines
        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].trim().to_string();
            buffer = buffer[line_end + 1..].to_string();

            if line.is_empty() || line.starts_with(':') {
                continue;
            }

            if let Some(data) = line.strip_prefix("data: ") {
                if data == "[DONE]" {
                    app.emit("agent-event", serde_json::json!({
                        "type": "done"
                    }).to_string()).ok();
                    return Ok(());
                }

                // Parse OpenAI-format SSE
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                    // Check for custom hermes events
                    if let Some(event_type) = parsed.get("event").and_then(|e| e.as_str()) {
                        match event_type {
                            "hermes.tool.progress" => {
                                let tool_name = parsed.get("tool").and_then(|t| t.as_str()).unwrap_or("tool");
                                app.emit("agent-event", serde_json::json!({
                                    "type": "tool_start",
                                    "name": tool_name,
                                    "args": parsed.get("args").unwrap_or(&serde_json::Value::Null)
                                }).to_string()).ok();
                            }
                            _ => {}
                        }
                        continue;
                    }

                    // Standard OpenAI delta
                    if let Some(choices) = parsed.get("choices").and_then(|c| c.as_array()) {
                        if let Some(choice) = choices.first() {
                            let delta = choice.get("delta").unwrap_or(&serde_json::Value::Null);

                            // Reasoning/thinking content
                            if let Some(reasoning) = delta.get("reasoning_content")
                                .or_else(|| delta.get("reasoning"))
                                .and_then(|r| r.as_str())
                            {
                                app.emit("agent-event", serde_json::json!({
                                    "type": "thinking",
                                    "content": reasoning
                                }).to_string()).ok();
                            }

                            // Regular content
                            if let Some(text) = delta.get("content").and_then(|c| c.as_str()) {
                                app.emit("agent-event", serde_json::json!({
                                    "type": "content",
                                    "content": text
                                }).to_string()).ok();
                            }

                            // Tool calls in delta
                            if let Some(tool_calls) = delta.get("tool_calls").and_then(|tc| tc.as_array()) {
                                for tc in tool_calls {
                                    if let Some(func) = tc.get("function") {
                                        let name = func.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                                        let args_str = func.get("arguments").and_then(|a| a.as_str()).unwrap_or("{}");
                                        if let Ok(args) = serde_json::from_str::<serde_json::Value>(args_str) {
                                            app.emit("agent-event", serde_json::json!({
                                                "type": "tool_start",
                                                "name": name,
                                                "args": args
                                            }).to_string()).ok();
                                        }
                                    }
                                }
                            }

                            // Finish reason
                            if let Some(finish) = choice.get("finish_reason").and_then(|f| f.as_str()) {
                                if finish == "tool_calls" {
                                    // Tool calls completed, results coming
                                }
                            }
                        }
                    }

                    // Usage info (final chunk)
                    if parsed.get("usage").is_some() {
                        // Could track token usage here
                    }
                }
            }

            // Handle custom event types
            if let Some(event_data) = line.strip_prefix("event: ") {
                // Store event type for next data line
                let _ = event_data;
            }
        }
    }

    // Stream ended without [DONE]
    app.emit("agent-event", serde_json::json!({
        "type": "done"
    }).to_string()).ok();

    Ok(())
}

/// Cancel the current message generation
#[tauri::command]
async fn cancel_message(
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Kill and restart gateway to cancel
    let mut guard = state.engine.lock().await;
    if let Some(handle) = guard.as_mut() {
        let mut child_guard = handle.child.lock().await;
        if let Some(ref mut child) = *child_guard {
            child.kill().await.ok();
            *child_guard = None;
        }
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
