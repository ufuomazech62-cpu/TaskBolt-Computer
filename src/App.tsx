import { useState, useRef, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'

interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
}

type AppState = 'onboarding' | 'chat'

function App() {
  const [state, setState] = useState<AppState>('onboarding')
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [setupProgress, setSetupProgress] = useState<string>('')
  const [setupDone, setSetupDone] = useState(false)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

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
        setTimeout(() => setState('chat'), 800)
      } catch (e) {
        setSetupProgress(`Setup issue: ${e}. Retrying...`)
        // Retry after delay
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
    } catch (e) {
      const errorMsg: Message = {
        id: crypto.randomUUID(),
        role: 'system',
        content: `Error: ${e}`,
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
        </div>
      </div>
    )
  }

  // ── Chat Screen ──
  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <span className="logo-small">⚡</span>
          <span className="title">TaskBolt</span>
        </div>
        <div className="header-right">
          <button className="btn-icon" title="Settings">⚙</button>
        </div>
      </header>

      <main className="chat-area">
        {messages.length === 0 && (
          <div className="empty-state">
            <h2>What can I set up for you?</h2>
            <div className="suggestions">
              <button onClick={() => setInput('Install and configure Claude Code')}>Install Claude Code</button>
              <button onClick={() => setInput('Free up disk space on my computer')}>Free up disk space</button>
              <button onClick={() => setInput('Set up my development environment')}>Set up dev environment</button>
              <button onClick={() => setInput('Update all outdated software')}>Update all software</button>
              <button onClick={() => setInput('Connect my Telegram to this AI')}>Connect Telegram</button>
              <button onClick={() => setInput('Optimize my computer performance')}>Optimize performance</button>
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
        <p className="input-hint">TaskBolt has full access to your terminal. Press Enter to send.</p>
      </footer>
    </div>
  )
}

export default App
