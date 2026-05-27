import { useState, useRef, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'

// ── Types ──────────────────────────────────────────────
interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  thinking?: string
  timestamp: number
}

interface TaskThread {
  id: string
  title: string
  messages: Message[]
  createdAt: number
  updatedAt: number
}

interface Skill {
  id: string
  name: string
  description: string
  icon: string
  enabled: boolean
  isCore: boolean
}

type AppState = 'onboarding' | 'tasks' | 'settings'
type SettingsTab = 'general' | 'account' | 'telegram' | 'skills' | 'advanced'

// ── Core bundled skills ───────────────────────────────
const CORE_SKILLS: Skill[] = [
  { id: 'setup', name: 'Setup My Computer', description: 'Auto-detect and configure your PC', icon: '⚡', enabled: true, isCore: true },
  { id: 'install', name: 'Install Software', description: 'Find and install any application', icon: '📦', enabled: true, isCore: true },
  { id: 'fix', name: 'Fix Issues', description: 'Diagnose and repair system problems', icon: '🔧', enabled: true, isCore: true },
  { id: 'update', name: 'Update Everything', description: 'Keep your system and apps up to date', icon: '🔄', enabled: true, isCore: true },
  { id: 'cleanup', name: 'Clean & Optimize', description: 'Free disk space and improve performance', icon: '🧹', enabled: true, isCore: true },
  { id: 'network', name: 'Network Setup', description: 'Configure WiFi, firewall, and networking', icon: '🌐', enabled: true, isCore: true },
  { id: 'security', name: 'Security Check', description: 'Scan and harden your system security', icon: '🛡️', enabled: true, isCore: true },
  { id: 'backup', name: 'Backup & Restore', description: 'Create backups and restore points', icon: '💾', enabled: true, isCore: true },
]

function App() {
  // ── State ────────────────────────────────────────────
  const [appState, setAppState] = useState<AppState>('onboarding')
  const [darkMode, setDarkMode] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general')

  // Tasks / threads
  const [threads, setThreads] = useState<TaskThread[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)

  // Onboarding
  const [setupProgress, setSetupProgress] = useState('')
  const [setupDone, setSetupDone] = useState(false)
  const [setupError, setSetupError] = useState('')
  const [setupRetries, setSetupRetries] = useState(0)

  // Skills
  const [skills, setSkills] = useState<Skill[]>(CORE_SKILLS)

  // Auth
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [userName, setUserName] = useState('')

  const [version, setVersion] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // ── Init ─────────────────────────────────────────────
  useEffect(() => {
    getVersion().then(v => setVersion(v)).catch(() => setVersion('0.1.0'))
    loadThreads()
    loadSkills()
    // Check if already set up
    const done = localStorage.getItem('taskbolt_setup_done')
    if (done === 'true') {
      setSetupDone(true)
      setAppState('tasks')
    }
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light')
  }, [darkMode])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [threads, activeThreadId])

  // ── Persistence ──────────────────────────────────────
  const loadThreads = () => {
    try {
      const saved = localStorage.getItem('taskbolt_threads')
      if (saved) setThreads(JSON.parse(saved))
    } catch { /* ignore */ }
  }

  const saveThreads = (t: TaskThread[]) => {
    localStorage.setItem('taskbolt_threads', JSON.stringify(t))
    setThreads(t)
  }

  const loadSkills = () => {
    try {
      const saved = localStorage.getItem('taskbolt_skills')
      if (saved) {
        const userSkills: Skill[] = JSON.parse(saved)
        setSkills([...CORE_SKILLS, ...userSkills])
      }
    } catch { /* ignore */ }
  }

  // ── Helpers ──────────────────────────────────────────
  const activeThread = threads.find(t => t.id === activeThreadId)
  const filteredThreads = threads.filter(t =>
    t.title.toLowerCase().includes(searchQuery.toLowerCase())
  ).sort((a, b) => b.updatedAt - a.updatedAt)

  const createThread = (title: string): TaskThread => {
    const thread: TaskThread = {
      id: crypto.randomUUID(),
      title,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const updated = [thread, ...threads]
    saveThreads(updated)
    setActiveThreadId(thread.id)
    return thread
  }

  const deleteThread = (id: string) => {
    const updated = threads.filter(t => t.id !== id)
    saveThreads(updated)
    if (activeThreadId === id) {
      setActiveThreadId(updated[0]?.id ?? null)
    }
  }

  const addMessage = (threadId: string, msg: Message) => {
    const updated = threads.map(t => {
      if (t.id !== threadId) return t
      return { ...t, messages: [...t.messages, msg], updatedAt: Date.now(),
        title: t.messages.length === 0 ? msg.content.slice(0, 50) : t.title
      }
    })
    saveThreads(updated)
  }

  // ── Onboarding ───────────────────────────────────────
  const handleAutoSetup = async () => {
    setSetupError('')
    setSetupProgress('Initializing TaskBolt engine...')
    setSetupRetries(r => r + 1)

    try {
      const result = await invoke<string>('auto_setup')
      setSetupProgress(result as string)
      setSetupDone(true)
      localStorage.setItem('taskbolt_setup_done', 'true')
      setTimeout(() => setAppState('tasks'), 1500)
    } catch (err: unknown) {
      const msg = typeof err === 'string' ? err : 'Unknown error'
      setSetupError(msg)
      if (setupRetries < 5) {
        setTimeout(handleAutoSetup, 3000)
      }
    }
  }

  // ── Send Message ─────────────────────────────────────
  const handleSend = async () => {
    if (!input.trim() || isStreaming) return

    let thread = activeThread
    if (!thread) {
      thread = createThread(input.slice(0, 50))
    }

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: input.trim(),
      timestamp: Date.now(),
    }
    addMessage(thread.id, userMsg)
    setInput('')
    setIsStreaming(true)

    try {
      // Ensure engine is running
      if (!setupDone) {
        await invoke<string>('auto_setup')
        setSetupDone(true)
        localStorage.setItem('taskbolt_setup_done', 'true')
      }

      const response = await invoke<string>('send_message', { content: userMsg.content })
      // Parse thinking + response if available
      const parsed = response.includes('===RESPONSE===')
        ? response.split('===RESPONSE===')
        : ['', response]
      
      const assistantMsg: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: parsed[1]?.trim() || response,
        thinking: parsed[0]?.trim() || undefined,
        timestamp: Date.now(),
      }
      addMessage(thread.id, assistantMsg)
    } catch (err: unknown) {
      const msg = typeof err === 'string' ? err : 'Request failed'
      addMessage(thread.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content: `Error: ${msg}`,
        timestamp: Date.now(),
      })
    } finally {
      setIsStreaming(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // ── Onboarding Screen ───────────────────────────────
  if (appState === 'onboarding') {
    return (
      <div className={`app-container ${darkMode ? 'dark' : ''}`}>
        <div className="onboarding-screen">
          <div className="onboarding-logo">
            <div className="logo-bolt">⚡</div>
            <h1>TaskBolt</h1>
            <p className="onboarding-subtitle">AI that sets up your computer for you</p>
          </div>

          {!setupDone && !setupError && (
            <div className="setup-progress">
              <div className="spinner" />
              <p>{setupProgress || 'Getting ready...'}</p>
            </div>
          )}

          {setupError && !setupDone && (
            <div className="setup-error">
              <p>⚠️ Setup failed</p>
              <p className="error-detail">{setupError}</p>
              <p className="error-retry">Retrying automatically...</p>
              <button className="btn-primary" onClick={handleAutoSetup}>
                Retry Now
              </button>
            </div>
          )}

          {setupDone && (
            <div className="setup-success">
              <div className="check-icon">✓</div>
              <p>Ready to go!</p>
            </div>
          )}

          {!setupDone && !setupError && (
            <button className="btn-primary btn-start" onClick={handleAutoSetup}>
              Get Started
            </button>
          )}

          <div className="onboarding-footer">
            v{version} · Built with care
          </div>
        </div>
      </div>
    )
  }

  // ── Settings Panel ──────────────────────────────────
  if (appState === 'settings') {
    return (
      <div className={`app-container ${darkMode ? 'dark' : ''}`}>
        <div className="settings-header">
          <button className="btn-icon" onClick={() => setAppState('tasks')}>←</button>
          <h2>Settings</h2>
        </div>
        <div className="settings-body">
          <div className="settings-tabs">
            {(['general', 'account', 'telegram', 'skills', 'advanced'] as SettingsTab[]).map(tab => (
              <button
                key={tab}
                className={`tab-btn ${settingsTab === tab ? 'active' : ''}`}
                onClick={() => setSettingsTab(tab)}
              >
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>

          {settingsTab === 'general' && (
            <div className="settings-section">
              <h3>Appearance</h3>
              <div className="setting-row">
                <span>Dark Mode</span>
                <label className="toggle">
                  <input type="checkbox" checked={darkMode} onChange={e => setDarkMode(e.target.checked)} />
                  <span className="toggle-slider" />
                </label>
              </div>
              <div className="setting-row">
                <span>Sidebar</span>
                <label className="toggle">
                  <input type="checkbox" checked={sidebarOpen} onChange={e => setSidebarOpen(e.target.checked)} />
                  <span className="toggle-slider" />
                </label>
              </div>
            </div>
          )}

          {settingsTab === 'account' && (
            <div className="settings-section">
              <h3>Account</h3>
              {isLoggedIn ? (
                <div>
                  <p>Signed in as <strong>{userName}</strong></p>
                  <button className="btn-secondary" onClick={() => { setIsLoggedIn(false); setUserName('') }}>
                    Sign Out
                  </button>
                </div>
              ) : (
                <div className="auth-options">
                  <p>Sign in to sync your tasks across devices</p>
                  <button className="btn-primary" onClick={() => {
                    setIsLoggedIn(true)
                    setUserName('User')
                  }}>
                    Sign In with Telegram
                  </button>
                </div>
              )}
            </div>
          )}

          {settingsTab === 'telegram' && (
            <div className="settings-section">
              <h3>Telegram Bot</h3>
              <p className="setting-desc">Connect a Telegram bot to control TaskBolt remotely</p>
              <input
                type="text"
                placeholder="Bot Token (e.g. 123456:ABC-def)"
                className="input-field"
              />
              <button className="btn-primary" style={{ marginTop: '1rem' }}>
                Connect Bot
              </button>
            </div>
          )}

          {settingsTab === 'skills' && (
            <div className="settings-section">
              <h3>Skills</h3>
              <p className="setting-desc">Enable or disable capabilities</p>
              {skills.map(skill => (
                <div key={skill.id} className="skill-row">
                  <span className="skill-icon">{skill.icon}</span>
                  <div className="skill-info">
                    <span className="skill-name">{skill.name}</span>
                    <span className="skill-desc">{skill.description}</span>
                  </div>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={skill.enabled}
                      onChange={e => {
                        setSkills(prev => prev.map(s =>
                          s.id === skill.id ? { ...s, enabled: e.target.checked } : s
                        ))
                      }}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>
              ))}
              <button className="btn-secondary" style={{ marginTop: '1rem' }}>
                + Add Custom Skill
              </button>
            </div>
          )}

          {settingsTab === 'advanced' && (
            <div className="settings-section">
              <h3>Advanced</h3>
              <div className="setting-row">
                <span>Version</span>
                <span className="text-muted">v{version}</span>
              </div>
              <button className="btn-danger" style={{ marginTop: '1rem' }} onClick={() => {
                localStorage.clear()
                setSetupDone(false)
                setAppState('onboarding')
              }}>
                Reset Everything
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── Main Tasks View ─────────────────────────────────
  return (
    <div className={`app-container ${darkMode ? 'dark' : ''}`}>
      {/* ── Sidebar ── */}
      <div className={`sidebar ${sidebarOpen ? 'open' : 'closed'}`}>
        <div className="sidebar-header">
          <div className="sidebar-logo">
            <span className="logo-bolt-small">⚡</span>
            <span className="logo-text">TaskBolt</span>
          </div>
          <button className="btn-icon" onClick={() => setSidebarOpen(!sidebarOpen)}>
            {sidebarOpen ? '✕' : '☰'}
          </button>
        </div>

        <button className="btn-new-task" onClick={() => { setActiveThreadId(null); setInput('') }}>
          <span>+</span> New Task
        </button>

        <div className="sidebar-search">
          <input
            type="text"
            placeholder="Search tasks..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="search-input"
          />
        </div>

        <div className="sidebar-threads">
          {filteredThreads.length === 0 && (
            <p className="no-threads">No tasks yet</p>
          )}
          {filteredThreads.map(thread => (
            <div
              key={thread.id}
              className={`thread-item ${thread.id === activeThreadId ? 'active' : ''}`}
              onClick={() => setActiveThreadId(thread.id)}
            >
              <span className="thread-title">{thread.title}</span>
              <button
                className="thread-delete"
                onClick={e => { e.stopPropagation(); deleteThread(thread.id) }}
                title="Delete"
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <div className="sidebar-footer">
          <button className="sidebar-btn" onClick={() => setSkillsOpen(!skillsOpen)}>
            🧩 Skills
          </button>
          <button className="sidebar-btn" onClick={() => setAppState('settings')}>
            ⚙️ Settings
          </button>
          {isLoggedIn && (
            <div className="user-avatar">{userName.charAt(0)}</div>
          )}
        </div>
      </div>

      {/* ── Main Content ── */}
      <div className="main-content">
        {!activeThread ? (
          /* ── Empty state / New task ── */
          <div className="empty-state">
            <div className="empty-logo">⚡</div>
            <h2>What should I set up for you?</h2>
            <p className="empty-subtitle">Describe what you need — I'll handle the rest.</p>
            <div className="skill-suggestions">
              {skills.filter(s => s.enabled && s.isCore).slice(0, 4).map(skill => (
                <button
                  key={skill.id}
                  className="skill-chip"
                  onClick={() => setInput(skill.name)}
                >
                  {skill.icon} {skill.name}
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* ── Messages ── */
          <div className="messages-container">
            {activeThread.messages.map(msg => (
              <div key={msg.id} className={`message ${msg.role}`}>
                {msg.role === 'assistant' && <div className="message-avatar">⚡</div>}
                <div className="message-body">
                  {msg.thinking && (
                    <details className="thinking-block">
                      <summary>Thinking process</summary>
                      <pre>{msg.thinking}</pre>
                    </details>
                  )}
                  <div className="message-text">{msg.content}</div>
                </div>
                {msg.role === 'user' && <div className="message-avatar user">👤</div>}
              </div>
            ))}
            {isStreaming && (
              <div className="message assistant">
                <div className="message-avatar">⚡</div>
                <div className="message-body">
                  <div className="typing-indicator">
                    <span /><span /><span />
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}

        {/* ── Input ── */}
        <div className="input-area">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe what you need..."
            rows={1}
            className="main-input"
          />
          <button
            className={`send-btn ${input.trim() && !isStreaming ? 'active' : ''}`}
            onClick={handleSend}
            disabled={!input.trim() || isStreaming}
          >
            {isStreaming ? '⏳' : '↑'}
          </button>
        </div>
        <p className="input-hint">TaskBolt uses AI to set up and configure your computer</p>
      </div>

      {/* ── Skills Panel (overlay) ── */}
      {skillsOpen && (
        <div className="skills-overlay" onClick={() => setSkillsOpen(false)}>
          <div className="skills-panel" onClick={e => e.stopPropagation()}>
            <div className="skills-header">
              <h3>Skills</h3>
              <button className="btn-icon" onClick={() => setSkillsOpen(false)}>✕</button>
            </div>
            <div className="skills-list">
              {skills.map(skill => (
                <div key={skill.id} className={`skill-card ${skill.enabled ? 'enabled' : ''}`}>
                  <span className="skill-card-icon">{skill.icon}</span>
                  <div className="skill-card-info">
                    <h4>{skill.name}</h4>
                    <p>{skill.description}</p>
                  </div>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={skill.enabled}
                      onChange={e => {
                        setSkills(prev => prev.map(s =>
                          s.id === skill.id ? { ...s, enabled: e.target.checked } : s
                        ))
                      }}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>
              ))}
            </div>
            <button className="btn-secondary">+ Add Custom Skill</button>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
