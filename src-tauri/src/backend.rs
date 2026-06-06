use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use serde_yaml::Value as YamlValue;

/// Gateway platform configuration
#[derive(Debug, Serialize, Deserialize)]
pub struct GatewayPlatform {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub connected: bool,
    pub config: std::collections::HashMap<String, String>,
}

/// Memory entry
#[derive(Debug, Serialize, Deserialize)]
pub struct MemoryEntry {
    pub id: String,
    pub target: String,
    pub content: String,
    pub created_at: u64,
}

/// Skill definition
#[derive(Debug, Serialize, Deserialize)]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
}

/// Schedule/Cron job
#[derive(Debug, Serialize, Deserialize)]
pub struct Schedule {
    pub id: String,
    pub name: String,
    pub cron: String,
    pub prompt: String,
    pub enabled: bool,
}

fn get_hermes_home() -> PathBuf {
    dirs::home_dir()
        .map(|h| h.join(".taskbolt"))
        .unwrap_or_else(|| PathBuf::from(".taskbolt"))
}

fn read_config_yaml() -> Result<YamlValue, String> {
    let config_path = get_hermes_home().join("config.yaml");
    if !config_path.exists() {
        return Ok(YamlValue::Mapping(serde_yaml::Mapping::new()));
    }
    let content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config.yaml: {}", e))?;
    serde_yaml::from_str(&content)
        .map_err(|e| format!("Failed to parse config.yaml: {}", e))
}

fn write_config_yaml(config: &YamlValue) -> Result<(), String> {
    let config_path = get_hermes_home().join("config.yaml");
    let content = serde_yaml::to_string(config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(&config_path, content)
        .map_err(|e| format!("Failed to write config.yaml: {}", e))
}

// ═══════════════════════════════════════════════════════════════
// GATEWAY COMMANDS
// ═══════════════════════════════════════════════════════════════

#[tauri::command]
pub async fn get_gateway_config() -> Result<Vec<GatewayPlatform>, String> {
    let config = read_config_yaml()?;
    let platforms_map = config
        .get("platforms")
        .and_then(|v| v.as_mapping())
        .cloned()
        .unwrap_or_default();

    let mut platforms = vec![
        GatewayPlatform {
            id: "telegram".to_string(),
            name: "Telegram".to_string(),
            icon: "✈️".to_string(),
            connected: false,
            config: std::collections::HashMap::new(),
        },
        GatewayPlatform {
            id: "whatsapp".to_string(),
            name: "WhatsApp".to_string(),
            icon: "📱".to_string(),
            connected: false,
            config: std::collections::HashMap::new(),
        },
        GatewayPlatform {
            id: "imessage".to_string(),
            name: "iMessage".to_string(),
            icon: "💬".to_string(),
            connected: false,
            config: std::collections::HashMap::new(),
        },
    ];

    for platform in &mut platforms {
        if let Some(platform_config) = platforms_map.get(&YamlValue::String(platform.id.clone())) {
            if let Some(mapping) = platform_config.as_mapping() {
                platform.connected = mapping
                    .get(&YamlValue::String("enabled".to_string()))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                for (key, value) in mapping {
                    if let (YamlValue::String(k), YamlValue::String(v)) = (key, value) {
                        platform.config.insert(k.clone(), v.clone());
                    }
                }
            }
        }
    }

    Ok(platforms)
}

#[tauri::command]
pub async fn set_gateway_platform(
    platform_id: String,
    config: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let mut yaml = read_config_yaml()?;
    
    if yaml.get("platforms").is_none() {
        yaml.as_mapping_mut()
            .ok_or("Config is not a mapping")?
            .insert(
                YamlValue::String("platforms".to_string()),
                YamlValue::Mapping(serde_yaml::Mapping::new()),
            );
    }

    let platforms = yaml
        .get_mut("platforms")
        .and_then(|v| v.as_mapping_mut())
        .ok_or("platforms is not a mapping")?;

    let mut platform_yaml = serde_yaml::Mapping::new();
    platform_yaml.insert(
        YamlValue::String("enabled".to_string()),
        YamlValue::Bool(true),
    );
    for (key, value) in config {
        platform_yaml.insert(YamlValue::String(key), YamlValue::String(value));
    }

    platforms.insert(YamlValue::String(platform_id), YamlValue::Mapping(platform_yaml));
    write_config_yaml(&yaml)
}

#[tauri::command]
pub async fn disconnect_gateway_platform(platform_id: String) -> Result<(), String> {
    let mut yaml = read_config_yaml()?;
    
    if let Some(platforms) = yaml.get_mut("platforms").and_then(|v| v.as_mapping_mut()) {
        if let Some(platform) = platforms.get_mut(&YamlValue::String(platform_id)) {
            if let Some(mapping) = platform.as_mapping_mut() {
                mapping.insert(
                    YamlValue::String("enabled".to_string()),
                    YamlValue::Bool(false),
                );
            }
        }
    }
    
    write_config_yaml(&yaml)
}

// ═══════════════════════════════════════════════════════════════
// MEMORY COMMANDS — Category-based (profile, facts, preferences, history)
// ═══════════════════════════════════════════════════════════════

const MEMORY_CATEGORIES: &[&str] = &["profile", "facts", "preferences", "history"];

#[tauri::command]
pub async fn get_memory_entries() -> Result<Vec<MemoryEntry>, String> {
    let memory_dir = get_hermes_home().join("memory");
    if !memory_dir.exists() {
        fs::create_dir_all(&memory_dir)
            .map_err(|e| format!("Failed to create memory dir: {}", e))?;
        return Ok(vec![]);
    }

    let mut entries = vec![];

    for category in MEMORY_CATEGORIES {
        let path = memory_dir.join(format!("{}.md", category));
        if !path.exists() {
            continue;
        }

        let content = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read {}: {}", category, e))?;

        let metadata = fs::metadata(&path)
            .map_err(|e| format!("Failed to get metadata: {}", e))?;
        let file_modified = metadata
            .created()
            .or_else(|_| metadata.modified())
            .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
            .unwrap_or(0);

        // Parse lines starting with § as individual entries
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with('§') {
                let entry_content = trimmed.trim_start_matches('§').trim().to_string();
                if entry_content.is_empty() {
                    continue;
                }
                
                // Generate a stable ID from category + content hash
                let hash = entry_content.bytes().fold(0u64, |acc, b| acc.wrapping_mul(31).wrapping_add(b as u64));
                let id = format!("{}_{}", category, hash % 100000);

                entries.push(MemoryEntry {
                    id,
                    target: category.to_string(),
                    content: entry_content,
                    created_at: file_modified,
                });
            }
        }
    }

    // Also read legacy single-file entries (non-category .md files)
    let read_dir = fs::read_dir(&memory_dir)
        .map_err(|e| format!("Failed to read memory dir: {}", e))?;

    for entry in read_dir {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("md") {
            let filename = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown")
                .to_string();

            // Skip category files (already parsed above)
            if MEMORY_CATEGORIES.contains(&filename.as_str()) {
                continue;
            }

            let content = fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read {}: {}", filename, e))?;

            let metadata = fs::metadata(&path)
                .map_err(|e| format!("Failed to get metadata: {}", e))?;
            let created_at = metadata
                .created()
                .or_else(|_| metadata.modified())
                .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
                .unwrap_or(0);

            entries.push(MemoryEntry {
                id: filename,
                target: "legacy".to_string(),
                content,
                created_at,
            });
        }
    }

    Ok(entries)
}

#[tauri::command]
pub async fn add_memory_entry(target: String, content: String) -> Result<String, String> {
    let memory_dir = get_hermes_home().join("memory");
    fs::create_dir_all(&memory_dir)
        .map_err(|e| format!("Failed to create memory dir: {}", e))?;

    // Map target to category
    let category = match target.as_str() {
        "profile" | "user" => "profile",
        "facts" => "facts",
        "preferences" => "preferences",
        "history" => "history",
        _ => "facts", // Default to facts for unknown targets
    };

    let path = memory_dir.join(format!("{}.md", category));
    let timestamp = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let new_line = format!("\n§ {}: {}", timestamp, content.trim());

    // Append to existing content
    let mut existing = if path.exists() {
        fs::read_to_string(&path).unwrap_or_default()
    } else {
        String::new()
    };

    if existing.is_empty() {
        existing = format!("§ {}: {}", timestamp, content.trim());
    } else {
        existing.push_str(&new_line);
    }

    // Keep compact — max 2000 chars
    if existing.len() > 2000 {
        let lines: Vec<&str> = existing.lines().collect();
        let start = if lines.len() > 20 { lines.len() - 20 } else { 0 };
        existing = lines[start..].join("\n");
    }

    fs::write(&path, &existing)
        .map_err(|e| format!("Failed to write memory: {}", e))?;

    let hash = content.bytes().fold(0u64, |acc, b| acc.wrapping_mul(31).wrapping_add(b as u64));
    Ok(format!("{}_{}", category, hash % 100000))
}

#[tauri::command]
pub async fn delete_memory_entry(id: String) -> Result<(), String> {
    let memory_dir = get_hermes_home().join("memory");

    // Try category-based delete first (id format: "category_hash")
    if let Some(underscore_pos) = id.find('_') {
        let category = &id[..underscore_pos];
        if MEMORY_CATEGORIES.contains(&category) {
            let path = memory_dir.join(format!("{}.md", category));
            if path.exists() {
                let content = fs::read_to_string(&path)
                    .map_err(|e| format!("Failed to read {}: {}", category, e))?;
                let hash_val: u64 = id[underscore_pos + 1..].parse().unwrap_or(0);
                
                // Remove lines whose content hash matches
                let new_content: String = content
                    .lines()
                    .filter(|line| {
                        let trimmed = line.trim().trim_start_matches('§').trim();
                        let line_hash = trimmed.bytes().fold(0u64, |acc, b| acc.wrapping_mul(31).wrapping_add(b as u64));
                        line_hash % 100000 != hash_val
                    })
                    .collect::<Vec<&str>>()
                    .join("\n");
                
                fs::write(&path, new_content)
                    .map_err(|e| format!("Failed to write {}: {}", category, e))?;
                return Ok(());
            }
        }
    }

    // Fallback: legacy single-file delete
    let path = memory_dir.join(format!("{}.md", id));
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete memory: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_user_profile() -> Result<String, String> {
    let soul_path = get_hermes_home().join("SOUL.md");
    if !soul_path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(&soul_path)
        .map_err(|e| format!("Failed to read SOUL.md: {}", e))
}

#[tauri::command]
pub async fn set_user_profile(content: String) -> Result<(), String> {
    let soul_path = get_hermes_home().join("SOUL.md");
    fs::write(&soul_path, content)
        .map_err(|e| format!("Failed to write SOUL.md: {}", e))
}

// ═══════════════════════════════════════════════════════════════
// TOOLSETS COMMANDS
// ═══════════════════════════════════════════════════════════════

#[tauri::command]
pub async fn get_toolsets() -> Result<Vec<String>, String> {
    let config = read_config_yaml()?;
    let toolsets = config
        .get("toolsets")
        .and_then(|v| v.as_sequence())
        .map(|seq| {
            seq.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    Ok(toolsets)
}

#[tauri::command]
pub async fn toggle_toolset(toolset_id: String, enabled: bool) -> Result<(), String> {
    let mut yaml = read_config_yaml()?;
    
    let mut toolsets: Vec<String> = yaml
        .get("toolsets")
        .and_then(|v| v.as_sequence())
        .map(|seq| {
            seq.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    if enabled {
        if !toolsets.contains(&toolset_id) {
            toolsets.push(toolset_id);
        }
    } else {
        toolsets.retain(|t| t != &toolset_id);
    }

    let seq: Vec<YamlValue> = toolsets.into_iter().map(YamlValue::String).collect();
    yaml.as_mapping_mut()
        .ok_or("Config is not a mapping")?
        .insert(YamlValue::String("toolsets".to_string()), YamlValue::Sequence(seq));

    write_config_yaml(&yaml)
}

// ═══════════════════════════════════════════════════════════════
// SKILLS COMMANDS
// ═══════════════════════════════════════════════════════════════

#[tauri::command]
pub async fn get_skills() -> Result<Vec<Skill>, String> {
    let skills_dir = get_hermes_home().join("skills");
    if !skills_dir.exists() {
        fs::create_dir_all(&skills_dir)
            .map_err(|e| format!("Failed to create skills dir: {}", e))?;
        return Ok(vec![]);
    }

    let mut skills = vec![];
    let read_dir = fs::read_dir(&skills_dir)
        .map_err(|e| format!("Failed to read skills dir: {}", e))?;

    for entry in read_dir {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();
        if path.is_dir() {
            let skill_md = path.join("SKILL.md");
            if skill_md.exists() {
                let id = path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("unknown")
                    .to_string();
                
                let content = fs::read_to_string(&skill_md)
                    .unwrap_or_default();
                
                let name = content
                    .lines()
                    .find(|line| line.starts_with("# "))
                    .map(|line| line.trim_start_matches("# ").to_string())
                    .unwrap_or_else(|| id.clone());

                let description = content
                    .lines()
                    .skip_while(|line| !line.starts_with("description:"))
                    .next()
                    .and_then(|line| line.split(':').nth(1))
                    .map(|s| s.trim().to_string())
                    .unwrap_or_else(|| "No description".to_string());

                skills.push(Skill {
                    id: id.clone(),
                    name,
                    description,
                    enabled: true, // All skills in ~/.hermes/skills/ are enabled
                });
            }
        }
    }

    Ok(skills)
}

#[tauri::command]
pub async fn toggle_skill(id: String, enabled: bool) -> Result<(), String> {
    let skills_dir = get_hermes_home().join("skills");
    let skill_dir = skills_dir.join(&id);
    
    if !enabled && skill_dir.exists() {
        // Move to disabled_skills folder
        let disabled_dir = get_hermes_home().join("disabled_skills");
        fs::create_dir_all(&disabled_dir)
            .map_err(|e| format!("Failed to create disabled_skills dir: {}", e))?;
        let dest = disabled_dir.join(&id);
        fs::rename(&skill_dir, &dest)
            .map_err(|e| format!("Failed to disable skill: {}", e))?;
    } else if enabled {
        // Move from disabled_skills back to skills
        let disabled_dir = get_hermes_home().join("disabled_skills");
        let source = disabled_dir.join(&id);
        if source.exists() {
            fs::rename(&source, &skill_dir)
                .map_err(|e| format!("Failed to enable skill: {}", e))?;
        }
    }
    
    Ok(())
}

// ═══════════════════════════════════════════════════════════════
// SCHEDULES COMMANDS
// ═══════════════════════════════════════════════════════════════

#[tauri::command]
pub async fn get_schedules() -> Result<Vec<Schedule>, String> {
    let cron_dir = get_hermes_home().join("cron");
    if !cron_dir.exists() {
        fs::create_dir_all(&cron_dir)
            .map_err(|e| format!("Failed to create cron dir: {}", e))?;
        return Ok(vec![]);
    }

    let mut schedules = vec![];
    let read_dir = fs::read_dir(&cron_dir)
        .map_err(|e| format!("Failed to read cron dir: {}", e))?;

    for entry in read_dir {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("yaml") {
            let filename = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown")
                .to_string();
            
            let content = fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read {}: {}", filename, e))?;
            
            let yaml: YamlValue = serde_yaml::from_str(&content)
                .map_err(|e| format!("Failed to parse {}: {}", filename, e))?;

            let name = yaml
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(&filename)
                .to_string();
            let cron = yaml
                .get("schedule")
                .and_then(|v| v.as_str())
                .unwrap_or("* * * * *")
                .to_string();
            let prompt = yaml
                .get("prompt")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let enabled = yaml
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);

            schedules.push(Schedule {
                id: filename,
                name,
                cron,
                prompt,
                enabled,
            });
        }
    }

    Ok(schedules)
}

#[tauri::command]
pub async fn add_schedule(name: String, cron: String, prompt: String) -> Result<String, String> {
    let cron_dir = get_hermes_home().join("cron");
    fs::create_dir_all(&cron_dir)
        .map_err(|e| format!("Failed to create cron dir: {}", e))?;

    let id = format!("schedule_{}", chrono::Utc::now().timestamp());
    let path = cron_dir.join(format!("{}.yaml", id));

    let mut yaml = serde_yaml::Mapping::new();
    yaml.insert(YamlValue::String("name".to_string()), YamlValue::String(name));
    yaml.insert(YamlValue::String("schedule".to_string()), YamlValue::String(cron));
    yaml.insert(YamlValue::String("prompt".to_string()), YamlValue::String(prompt));
    yaml.insert(YamlValue::String("enabled".to_string()), YamlValue::Bool(true));

    let content = serde_yaml::to_string(&YamlValue::Mapping(yaml))
        .map_err(|e| format!("Failed to serialize schedule: {}", e))?;
    
    fs::write(&path, content)
        .map_err(|e| format!("Failed to write schedule: {}", e))?;

    Ok(id)
}

#[tauri::command]
pub async fn toggle_schedule(id: String, enabled: bool) -> Result<(), String> {
    let path = get_hermes_home().join("cron").join(format!("{}.yaml", id));
    if !path.exists() {
        return Err(format!("Schedule {} not found", id));
    }

    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read schedule: {}", e))?;
    
    let mut yaml: YamlValue = serde_yaml::from_str(&content)
        .map_err(|e| format!("Failed to parse schedule: {}", e))?;

    if let Some(mapping) = yaml.as_mapping_mut() {
        mapping.insert(
            YamlValue::String("enabled".to_string()),
            YamlValue::Bool(enabled),
        );
    }

    let new_content = serde_yaml::to_string(&yaml)
        .map_err(|e| format!("Failed to serialize schedule: {}", e))?;
    
    fs::write(&path, new_content)
        .map_err(|e| format!("Failed to write schedule: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn delete_schedule(id: String) -> Result<(), String> {
    let path = get_hermes_home().join("cron").join(format!("{}.yaml", id));
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete schedule: {}", e))?;
    }
    Ok(())
}
