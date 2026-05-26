import { useState, useRef, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'

interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
}

type AppState = 'onboarding' | 'chat' | 'settings'
type SettingsTab = 'general' | 'terminal' | 'telegram' | 'maintenance'

interface SettingsState {
  terminalPath: string
  autoMaintenance: boolean
  maintenanceSchedule: string
  telegramConnected: boolean
  telegramBotToken: string
  autoUpdate: boolean
  darkMode: boolean
}

function App() {
  const [state, setState] = useState<AppState>('onboarding')
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general')
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [setupProgress, setSetupProgress] = useState<string>('')
  const [setupDone, setSetupDone] = useState(false)
  const [setupError, setSetupError] = useState<string>('')
  const [version, setVersion] = useState('')
  const chatEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Settings state
  const [settings, setSettings] = useState<SettingsState>({
    terminalPath: '',
    autoMaintenance: true,
    maintenanceSchedule: 'daily',
    telegramConnected: false,
    telegramBotToken: '',
    autoUpdate: true,
    darkMode: true,
  })

  useEffect(() => {
    getVersion().then(v => setVersion(v)).catch(() => setVersion('0.1.0'))
  }, [])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Auto-setup on mount
  useEffect(() => {
    async function runSetup() {
      try {
        setSetupProgress('Detecting your system...')
        const result = await invoke<string>('auto_setup')
        setSetupProgress(result)
        setSetupDone(true)
        setTimeout(() => setState('chat'), 1200)
      } catch (e: any) {
        setSetupError(String(e))
        setSetupProgress(`Retrying... (${String(e).slice(0, 60)})`)
        setTimeout(runSetup, 3000)
      }
    }
    runSetup()
  }, [])

  const sendMessage = async () => {
    const text = input.trim()
    if (!text || isStreaming) return

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setIsStreaming(true)

    try {
      const response = await invoke<string>('send_message', { content: text })
      const assistantMsg: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: response,
        timestamp: Date.now(),
      }
      setMessages(prev => [...prev, assistantMsg])
    } catch (e: any) {
      const errorMsg: Message = {
        id: crypto.randomUUID(),
        role: 'system',
        content: `Error: ${String(e)}`,
        timestamp: Date.now(),
      }
      setMessages(prev => [...prev, errorMsg])
    } finally {
      setIsStreaming(false)
      inputRef.current?.focus()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  // ── Telegram Connect ──
  const connectTelegram = async () => {
    try {
      const result = await invoke<string>('connect_telegram', {
        botToken: settings.telegramBotToken,
      })
      setSettings(prev => ({ ...prev, telegramConnected: true }))
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(),
        role: 'system',
        content: `✅ Telegram connected: ${result}`,
        timestamp: Date.now(),
      }])
    } catch (e: any) {
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(),
        role: 'system',
        content: `❌ Telegram connection failed: ${String(e)}`,
        timestamp: Date.now(),
      }])
    }
  }

  // ── Onboarding Screen ──
  if (state === 'onboarding') {
    return (
      <div className="onboarding">
        <div className="onboarding-card">
          <div className="logo">⚡</div>
          <h1>TaskBolt</h1>
          <p className="tagline">AI that sets up your computer for you</p>
          <div className="setup-status">
            <div className="spinner" />
            <span>{setupProgress || 'Starting...'}</span>
          </div>
          {setupDone && <p className="setup-done">✓ Ready — launching</p>}
          {setupError && !setupDone && (
            <p className="setup-error">Setup failed — retrying automatically</p>
          )}
        </div>
      </div>
    )
  }

  // ── Settings Panel ──
  const renderSettings = () => (
    <div className="settings-panel">
      <div className="settings-header">
        <button className="btn-back" onClick={() => setState('chat')}>← Back</button>
        <h2>Settings</h2>
        <span />
      </div>
      <div className="settings-tabs">
        <button className={settingsTab === 'general' ? 'active' : ''} onClick={() => setSettingsTab('general')}>General</button>
        <button className={settingsTab === 'terminal' ? 'active' : ''} onClick={() => setSettingsTab('terminal')}>Terminal</button>
        <button className={settingsTab === 'telegram' ? 'active' : ''} onClick={() => setSettingsTab('telegram')}>Telegram</button>
        <button className={settingsTab === 'maintenance' ? 'active' : ''} onClick={() => setSettingsTab('maintenance')}>Maintenance</button>
      </div>

      {settingsTab === 'general' && (
        <div className="settings-body">
          <div className="setting-row">
            <label>Auto-update TaskBolt</label>
            <input type="checkbox" checked={settings.autoUpdate}
              onChange={e => setSettings(p => ({ ...p, autoUpdate: e.target.checked }))} />
          </div>
          <div className="setting-row">
            <label>Version</label>
            <span className="setting-value">{version}</span>
          </div>
          <div className="setting-row">
            <label>Engine</label>
            <span className="setting-value">hermes-agent (bundled)</span>
          </div>
        </div>
      )}

      {settingsTab === 'terminal' && (
        <div className="settings-body">
          <div className="setting-row">
            <label>Terminal Backend</label>
            <select value={settings.terminalPath}
              onChange={e => setSettings(p => ({ ...p, terminalPath: e.target.value }))}>
              <option value="">Auto-detect</option>
              <option value="git-bash">Git Bash</option>
              <option value="powershell">PowerShell</option>
              <option value="cmd">CMD</option>
            </select>
          </div>
          <p className="setting-hint">TaskBolt runs commands through your terminal. Auto-detect picks Git Bash on Windows.</p>
        </div>
      )}

      {settingsTab === 'telegram' && (
        <div className="settings-body">
          <div className="setting-row">
            <label>Bot Token</label>
            <input type="password" placeholder="Paste token from @BotFather"
              value={settings.telegramBotToken}
              onChange={e => setSettings(p => ({ ...p, telegramBotToken: e.target.value }))} />
          </div>
          <button className={`btn-primary ${settings.telegramBotToken ? '' : 'disabled'}`}
            onClick={connectTelegram}
            disabled={!settings.telegramBotToken || settings.telegramConnected}>
            {settings.telegramConnected ? '✓ Connected' : 'Connect Telegram'}
          </button>
          <p className="setting-hint">
            1. Open Telegram → search @BotFather → /newbot → follow prompts<br />
            2. Copy the token → paste above → Connect
          </p>
        </div>
      )}

      {settingsTab === 'maintenance' && (
        <div className="settings-body">
          <div className="setting-row">
            <label>Auto-maintenance</label>
            <input type="checkbox" checked={settings.autoMaintenance}
              onChange={e => setSettings(p => ({ ...p, autoMaintenance: e.target.checked }))} />
          </div>
          <div className="setting-row">
            <label>Schedule</label>
            <select value={settings.maintenanceSchedule}
              onChange={e => setSettings(p => ({ ...p, maintenanceSchedule: e.target.value }))}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="never">Never</option>
            </select>
          </div>
          <p className="setting-hint">
            Auto-maintenance cleans disk, updates software, and optimizes performance on schedule.
          </p>
        </div>
      )}
    </div>
  )

  // ── Chat Screen ──
  const renderChat = () => (
    <>
      <header className="header">
        <div className="header-left">
          <span className="logo-small">⚡</span>
          <span className="title">TaskBolt</span>
        </div>
        <div className="header-right">
          <button className="btn-icon" title="Settings" onClick={() => setState('settings')}>⚙</button>
        </div>
      </header>

      <main className="chat-area">
        {messages.length === 0 && (
          <div className="empty-state">
            <div className="empty-logo">⚡</div>
            <h2>What can I set up for you?</h2>
            <div className="suggestions">
              <button onClick={() => { setInput('Install and configure Claude Code on my computer'); inputRef.current?.focus() }}>Install Claude Code</button>
              <button onClick={() => { setInput('Free up disk space on my computer'); inputRef.current?.focus() }}>Free up disk space</button>
              <button onClick={() => { setInput('Set up my development environment with Node, Python, and Git'); inputRef.current?.focus() }}>Set up dev environment</button>
              <button onClick={() => { setInput('Update all outdated software on my system'); inputRef.current?.focus() }}>Update all software</button>
              <button onClick={() => { setInput('Help me connect my Telegram to this AI'); inputRef.current?.focus() }}>Connect Telegram</button>
              <button onClick={() => { setInput('Optimize my computer performance and clean up junk'); inputRef.current?.focus() }}>Optimize performance</button>
            </div>
          </div>
        )}
        {messages.map(msg => (
          <div key={msg.id} className={`message ${msg.role}`}>
            <div className="message-avatar">
              {msg.role === 'user' ? '👤' : msg.role === 'assistant' ? '⚡' : 'ℹ️'}
            </div>
            <div className="message-content">{msg.content}</div>
          </div>
        ))}
        {isStreaming && (
          <div className="message assistant">
            <div className="message-avatar">⚡</div>
            <div className="message-content">
              <span className="typing" />
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </main>

      <footer className="input-area">
        <div className="input-wrapper">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Tell TaskBolt what to set up..."
            rows={1}
          />
          <button
            className={`send-btn ${input.trim() && !isStreaming ? 'active' : ''}`}
            onClick={sendMessage}
            disabled={!input.trim() || isStreaming}
          >
            ↑
          </button>
        </div>
        <p className="input-hint">TaskBolt runs commands on your terminal. Press Enter to send.</p>
      </footer>
    </>
  )

  return (
    <div className="app">
      {state === 'settings' ? renderSettings() : renderChat()}
    </div>
  )
}

export default App
