import { useState, useRef, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'
import { open } from '@tauri-apps/plugin-shell'

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

interface AuthUser {
  id: string
  email?: string | null
  username?: string | null
  display_name?: string | null
  telegram_id?: number | null
  avatar_url?: string | null
}

interface MCPServer {
  id: string
  name: string
  url: string
  transport: string
  enabled: boolean
}

type AppState = 'onboarding' | 'tasks' | 'settings' | 'signin'
type SettingsTab = 'general' | 'account' | 'skills' | 'mcp' | 'advanced'

// ── SaaS Backend ────────────────────────────────────
const SAAS_URL = 'https://taskbolt-saas-ddne1tmox-zazabrorie-4629s-projects.vercel.app'

// ── Core skills ───────────────────────────────────────
const CORE_SKILLS: Skill[] = [
  { id: 'setup', name: 'Setup My Computer', description: 'Auto-detect and configure your PC', icon: '⚡', enabled: true, isCore: true },
  { id: 'install', name: 'Install Software', description: 'Find and install any application', icon: '📦', enabled: true, isCore: true },
  { id: 'fix', name: 'Fix Issues', description: 'Diagnose and repair system problems', icon: '🔧', enabled: true, isCore: true },
  { id: 'update', name: 'Update Everything', description: 'Keep your system and apps up to date', icon: '🔄', enabled: true, isCore: true },
  { id: 'cleanup', name: 'Clean & Optimize', description: 'Free disk space and improve performance', icon: '🧹', enabled: true, isCore: true },
  { id: 'network', name: 'Network Setup', description: 'Configure WiFi, firewall, and networking', icon: '🌐', enabled: true, isCore: true },
  { id: 'security', name: 'Security Check', description: 'Scan and harden your system security', icon: '🛡️', enabled: true, isCore: true },
  { id: 'backup', name: 'Backup & Restore', description: 'Create backups and restore points', icon: '💾', enabled: true, isCore: true },
  { id: 'browser', name: 'TaskBolt Browser', description: 'Browse the web automatically via CLI', icon: '🌍', enabled: true, isCore: true },
]

function App() {
  // ── State ────────────────────────────────────────────
  const [appState, setAppState] = useState<AppState>('onboarding')
  const [darkMode, setDarkMode] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general')

  // Tasks
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

  // Auth
  const [authToken, setAuthToken] = useState<string | null>(null)
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)

  // Email passwordless
  const [emailInput, setEmailInput] = useState('')
  const [emailSent, setEmailSent] = useState(false)
  const [emailCode, setEmailCode] = useState('')
  const [emailLoading, setEmailLoading] = useState(false)
  const [emailError, setEmailError] = useState('')
  const [resendCountdown, setResendCountdown] = useState(0)

  // Telegram QR
  const [tgQR, setTgQR] = useState<{ token: string; deeplink: string } | null>(null)
  const [tgPolling, setTgPolling] = useState(false)
  const tgPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Skills & MCP
  const [skills, setSkills] = useState<Skill[]>(CORE_SKILLS)
  const [mcpServers, setMcpServers] = useState<MCPServer[]>([])
  const [newMcpName, setNewMcpName] = useState('')
  const [newMcpUrl, setNewMcpUrl] = useState('')

  const [version, setVersion] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // ── Init ─────────────────────────────────────────────
  useEffect(() => {
    getVersion().then(v => setVersion(v)).catch(() => setVersion('0.1.0'))
    const token = localStorage.getItem('tb_auth_token')
    const userStr = localStorage.getItem('tb_auth_user')
    if (token && userStr) {
      try {
        setAuthToken(token)
        setAuthUser(JSON.parse(userStr))
      } catch { /* ignore */ }
    }
    loadThreads()
    loadSkills()
    loadMCPServers()
    const done = localStorage.getItem('tb_setup_done')
    if (done === 'true') {
      setSetupDone(true)
      setAppState(token ? 'tasks' : 'signin')
    }

    // Listen for OAuth popup messages
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'auth' && e.data?.token) {
        handleAuthSuccess(e.data.token, e.data.user)
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light')
  }, [darkMode])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [threads, activeThreadId, isStreaming])

  // ── Auth ─────────────────────────────────────────────
  const handleAuthSuccess = (token: string, user: AuthUser) => {
    setAuthToken(token)
    setAuthUser(user)
    localStorage.setItem('tb_auth_token', token)
    localStorage.setItem('tb_auth_user', JSON.stringify(user))
    setAppState('tasks')
    // Reset sign-in state
    setEmailInput('')
    setEmailSent(false)
    setEmailCode('')
    setEmailError('')
    setTgQR(null)
    setTgPolling(false)
    if (tgPollRef.current) clearInterval(tgPollRef.current)
  }

  const handleSignOut = () => {
    setAuthToken(null)
    setAuthUser(null)
    localStorage.removeItem('tb_auth_token')
    localStorage.removeItem('tb_auth_user')
    setAppState('signin')
  }

  const isLoggedIn = !!authToken && !!authUser

  // ── Email Passwordless ───────────────────────────────
  const sendEmailCode = async () => {
    if (!emailInput.includes('@')) { setEmailError('Enter a valid email'); return }
    setEmailLoading(true)
    setEmailError('')
    try {
      const res = await fetch(`${SAAS_URL}/api/auth/email/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailInput }),
      })
      const data = await res.json()
      if (data.ok) {
        setEmailSent(true)
        setEmailCode('')
        setResendCountdown(30)
        // Start resend countdown
        const timer = setInterval(() => {
          setResendCountdown(c => {
            if (c <= 1) { clearInterval(timer); return 0 }
            return c - 1
          })
        }, 1000)
        // If code returned (dev mode), show it
        if (data.code) {
          setEmailError(`Dev mode — your code is: ${data.code}`)
        }
      } else {
        setEmailError(data.error || 'Failed to send code')
      }
    } catch {
      setEmailError('Network error. Try again.')
    } finally {
      setEmailLoading(false)
    }
  }

  const verifyEmailCode = async () => {
    if (emailCode.length < 4) { setEmailError('Enter the full code'); return }
    setEmailLoading(true)
    setEmailError('')
    try {
      const res = await fetch(`${SAAS_URL}/api/auth/email/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailInput, code: emailCode }),
      })
      const data = await res.json()
      if (data.ok) {
        handleAuthSuccess(data.token, data.user)
      } else {
        setEmailError(data.error || 'Invalid code')
      }
    } catch {
      setEmailError('Network error. Try again.')
    } finally {
      setEmailLoading(false)
    }
  }

  // ── Google OAuth ─────────────────────────────────────
  const signInGoogle = () => {
    window.open(`${SAAS_URL}/api/auth/google`, '_blank', 'width=500,height=600')
  }

  // ── GitHub OAuth ─────────────────────────────────────
  const signInGitHub = () => {
    window.open(`${SAAS_URL}/api/auth/github`, '_blank', 'width=500,height=600')
  }

  // ── Telegram QR ──────────────────────────────────────
  const startTelegramQR = async () => {
    try {
      const res = await fetch(`${SAAS_URL}/api/auth/telegram/qr`)
      const data = await res.json()
      if (data.ok) {
        setTgQR({ token: data.token, deeplink: data.deeplink })
        setTgPolling(true)
        // Poll for completion
        tgPollRef.current = setInterval(async () => {
          try {
            const check = await fetch(`${SAAS_URL}/api/auth/telegram/check?token=${data.token}`)
            const d = await check.json()
            if (d.ok && d.token) {
              handleAuthSuccess(d.token, d.user)
            }
          } catch { /* keep polling */ }
        }, 2000)
      }
    } catch { /* ignore */ }
  }

  // ── Persistence ──────────────────────────────────────
  const loadThreads = () => {
    try {
      const saved = localStorage.getItem('tb_threads')
      if (saved) setThreads(JSON.parse(saved))
    } catch { /* ignore */ }
  }

  const saveThreads = (t: TaskThread[] | ((prev: TaskThread[]) => TaskThread[])) => {
    const updater = typeof t === 'function' ? t : () => t
    setThreads(prev => {
      const next = updater(prev)
      localStorage.setItem('tb_threads', JSON.stringify(next))
      return next
    })
  }

  const loadSkills = () => {
    try {
      const saved = localStorage.getItem('tb_skills')
      if (saved) {
        const userSkills: Skill[] = JSON.parse(saved)
        setSkills([...CORE_SKILLS, ...userSkills])
      }
    } catch { /* ignore */ }
  }

  const loadMCPServers = () => {
    try {
      const saved = localStorage.getItem('tb_mcp_servers')
      if (saved) setMcpServers(JSON.parse(saved))
    } catch { /* ignore */ }
  }

  const saveMCPServers = (servers: MCPServer[]) => {
    localStorage.setItem('tb_mcp_servers', JSON.stringify(servers))
    setMcpServers(servers)
  }

  // ── Thread helpers ───────────────────────────────────
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
    if (activeThreadId === id) setActiveThreadId(updated[0]?.id ?? null)
  }

  const addMessage = (threadId: string, msg: Message) => {
    setThreads(prev => {
      const updated = prev.map(t => {
        if (t.id !== threadId) return t
        return {
          ...t,
          messages: [...t.messages, msg],
          updatedAt: Date.now(),
          title: t.messages.length === 0 ? msg.content.slice(0, 50) : t.title,
        }
      })
      localStorage.setItem('tb_threads', JSON.stringify(updated))
      return updated
    })
  }

  // ── Onboarding ───────────────────────────────────────
  const handleAutoSetup = async () => {
    setSetupError('')
    setSetupProgress('Initializing TaskBolt engine...')
    setSetupRetries(r => r + 1)
    try {
      const result = await invoke<string>('auto_setup')
      setSetupProgress(result)
      setSetupDone(true)
      localStorage.setItem('tb_setup_done', 'true')
      setTimeout(() => setAppState(isLoggedIn ? 'tasks' : 'signin'), 1500)
    } catch (err: unknown) {
      const msg = typeof err === 'string' ? err : 'Unknown error'
      setSetupError(msg)
      if (setupRetries < 5) setTimeout(handleAutoSetup, 3000)
    }
  }

  // ── Send Message (routes AI through Vercel SaaS) ─────
  const VERCEL_API = `${SAAS_URL}/api/ai/chat`

  const handleSend = async () => {
    if (!input.trim() || isStreaming) return

    // Must be signed in
    if (!isLoggedIn) {
      setAppState('signin')
      return
    }

    let thread = activeThread
    if (!thread) thread = createThread(input.slice(0, 50))

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
      // Build messages for AI — include conversation history
      const aiMessages = [
        { role: "system", content: "You are TaskBolt, an intelligent AI assistant that sets up, configures, and fixes computers. Be direct, practical, and actionable. Provide exact commands the user can copy-paste. For Windows, prefer PowerShell and native tools. Explain what you're doing and why." },
        ...thread.messages.slice(-20).map(m => ({ role: m.role, content: m.content })),
        { role: "user", content: userMsg.content },
      ]

      // Stream from Vercel SaaS backend — API key lives on server only
      const response = await fetch(VERCEL_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authToken ? `Bearer ${authToken}` : "",
        },
        body: JSON.stringify({
          messages: aiMessages,
          model: "qwen3.6-flash",
          stream: true,
        }),
      })

      if (!response.ok) {
        const err = await response.text()
        throw new Error(err.slice(0, 200))
      }

      // Create assistant message placeholder for streaming
      const assistantMsg: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '',
        thinking: '',
        timestamp: Date.now(),
      }
      addMessage(thread.id, assistantMsg)

      // Helper to update the streaming message in place (not append)
      const updateStreamingMsg = (content: string, thinking: string) => {
        setThreads(prev => {
          const updated = prev.map(t => {
            if (t.id !== thread.id) return t
            return {
              ...t,
              messages: t.messages.map(m =>
                m.id === assistantMsg.id ? { ...m, content, thinking } : m
              ),
            }
          })
          localStorage.setItem('tb_threads', JSON.stringify(updated))
          return updated
        })
      }

      // Read SSE stream
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let fullContent = ''
      let fullThinking = ''

      if (reader) {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || !trimmed.startsWith('data:')) continue
            const data = trimmed.slice(5).trim()
            if (data === '[DONE]') break

            try {
              const parsed = JSON.parse(data)
              if (parsed.error) {
                updateStreamingMsg(`Error: ${parsed.error}`, fullThinking)
                break
              }
              if (parsed.type === 'thinking' && parsed.content) {
                fullThinking += parsed.content
                updateStreamingMsg(fullContent, fullThinking)
              } else if (parsed.type === 'content' && parsed.content) {
                fullContent += parsed.content
                updateStreamingMsg(fullContent, fullThinking)
              }
            } catch { /* skip malformed SSE */ }
          }
        }
      }
    } catch (err: unknown) {
      const msg = typeof err === 'string' ? err : (err instanceof Error ? err.message : 'Request failed')
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

  // ── MCP ──────────────────────────────────────────────
  const addMCPServer = () => {
    if (!newMcpName.trim() || !newMcpUrl.trim()) return
    const server: MCPServer = {
      id: crypto.randomUUID(),
      name: newMcpName.trim(),
      url: newMcpUrl.trim(),
      transport: 'sse',
      enabled: true,
    }
    const updated = [...mcpServers, server]
    saveMCPServers(updated)
    setNewMcpName('')
    setNewMcpUrl('')
  }

  // ─── Render ──────────────────────────────────────────

  // ── Onboarding ──
  if (appState === 'onboarding') {
    return (
      <div className="app-container">
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
              <button className="btn-primary" onClick={handleAutoSetup}>Retry</button>
            </div>
          )}
          {setupDone && (
            <div className="setup-success">
              <div className="check-icon">✓</div>
              <p>Ready!</p>
            </div>
          )}
          {!setupDone && !setupError && (
            <button className="btn-primary btn-start" onClick={handleAutoSetup}>Get Started</button>
          )}
          <div className="onboarding-footer">v{version}</div>
        </div>
      </div>
    )
  }

  // ── Sign In Page ──
  if (appState === 'signin') {
    return (
      <div className="app-container">
        <div className="signin-page">
          <div className="signin-card">
            <div className="signin-logo">
              <div className="logo-bolt">⚡</div>
              <h1>TaskBolt</h1>
              <p className="signin-subtitle">Sign in to get started</p>
            </div>

            {/* Primary: Google */}
            <button className="btn-oauth btn-google" onClick={signInGoogle}>
              <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
              Continue with Google
            </button>

            {/* Primary: Email Passwordless */}
            <div className="email-signin">
              <div className="divider"><span>or sign in with email</span></div>
              <input
                type="email"
                placeholder="Enter your email"
                value={emailInput}
                onChange={e => { setEmailInput(e.target.value); setEmailError('') }}
                className="input-field signin-email"
                disabled={emailSent}
              />
              {!emailSent ? (
                <button className="btn-primary btn-email-send" onClick={sendEmailCode} disabled={emailLoading || !emailInput.includes('@')}>
                  {emailLoading ? 'Sending...' : 'Send Sign-In Code'}
                </button>
              ) : (
                <>
                  <input
                    type="text"
                    placeholder="Enter 6-digit code"
                    value={emailCode}
                    onChange={e => { setEmailCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setEmailError('') }}
                    onKeyDown={e => { if (e.key === 'Enter') verifyEmailCode() }}
                    className="input-field signin-code"
                    maxLength={6}
                    autoFocus
                  />
                  <button className="btn-primary btn-email-verify" onClick={verifyEmailCode} disabled={emailLoading || emailCode.length < 4}>
                    {emailLoading ? 'Verifying...' : 'Verify & Sign In'}
                  </button>
                  {resendCountdown > 0 ? (
                    <p className="resend-timer">Resend in {resendCountdown}s</p>
                  ) : (
                    <button className="btn-link" onClick={sendEmailCode}>Resend code</button>
                  )}
                </>
              )}
              {emailError && <p className="signin-error">{emailError}</p>}
            </div>

            {/* Divider */}
            <div className="divider"><span>or continue with</span></div>

            {/* Secondary: Telegram */}
            <button className="btn-oauth btn-telegram" onClick={startTelegramQR}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12s5.37 12 12 12 12-5.37 12-12S18.63 0 12 0zm5.94 8.13l-1.97 9.28c-.15.67-.54.83-1.09.52l-3.02-2.22-1.46 1.4c-.16.16-.3.3-.61.3l.22-3.06 5.55-5.02c.24-.22-.05-.33-.38-.13l-6.86 4.32-2.96-.92c-.64-.2-.66-.64.14-.95l11.6-4.47c.54-.2 1.01.13.84.95z"/></svg>
              Telegram
            </button>

            {/* Secondary: GitHub */}
            <button className="btn-oauth btn-github" onClick={signInGitHub}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
              GitHub
            </button>

            {tgQR && (
              <div className="modal-overlay" onClick={() => { setTgQR(null); if (tgPollRef.current) clearInterval(tgPollRef.current) }}>
                <div className="tg-qr-modal" onClick={e => e.stopPropagation()}>
                  <h3>Sign in with Telegram</h3>
                  <p className="tg-qr-desc">Scan the QR code or click the link below</p>
                  <div className="tg-qr-code">
                    <img src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(tgQR.deeplink)}`} alt="QR" />
                  </div>
                  <a href={tgQR.deeplink} className="tg-deeplink" target="_blank" rel="noopener">
                    Open Telegram to confirm →
                  </a>
                  <p className="tg-polling">Waiting for confirmation...</p>
                  <button className="btn-link" onClick={() => { setTgQR(null); if (tgPollRef.current) clearInterval(tgPollRef.current) }}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ── Settings ──
  if (appState === 'settings') {
    return (
      <div className="app-container">
        <div className="settings-view">
          <div className="settings-header">
            <button className="btn-back" onClick={() => setAppState('tasks')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
              <span>Back</span>
            </button>
            <h2>Settings</h2>
            <div />
          </div>
          <div className="settings-body">
            <div className="settings-tabs">
              {(['general', 'account', 'skills', 'mcp', 'advanced'] as SettingsTab[]).map(tab => (
                <button key={tab} className={`tab-btn ${settingsTab === tab ? 'active' : ''}`} onClick={() => setSettingsTab(tab)}>
                  {tab === 'mcp' ? 'MCP' : tab.charAt(0).toUpperCase() + tab.slice(1)}
                </button>
              ))}
            </div>

            {settingsTab === 'general' && (
              <div className="settings-section">
                <h3>Appearance</h3>
                <div className="setting-row">
                  <span>Dark Mode</span>
                  <label className="toggle"><input type="checkbox" checked={darkMode} onChange={e => setDarkMode(e.target.checked)} /><span className="toggle-slider" /></label>
                </div>
                <div className="setting-row">
                  <span>Show Sidebar</span>
                  <label className="toggle"><input type="checkbox" checked={sidebarOpen} onChange={e => setSidebarOpen(e.target.checked)} /><span className="toggle-slider" /></label>
                </div>
              </div>
            )}

            {settingsTab === 'account' && (
              <div className="settings-section">
                <h3>Account</h3>
                {isLoggedIn ? (
                  <div className="account-info">
                    <div className="account-avatar">{authUser?.display_name?.charAt(0) || authUser?.email?.charAt(0) || 'U'}</div>
                    <div className="account-details">
                      <strong>{authUser?.display_name || 'User'}</strong>
                      <span className="text-muted">{authUser?.email || `Telegram: ${authUser?.telegram_id}`}</span>
                    </div>
                    <button className="btn-secondary" onClick={handleSignOut}>Sign Out</button>
                  </div>
                ) : (
                  <button className="btn-primary" onClick={() => setAppState('signin')}>Sign In</button>
                )}
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
                      <input type="checkbox" checked={skill.enabled} onChange={e => setSkills(prev => prev.map(s => s.id === skill.id ? { ...s, enabled: e.target.checked } : s))} />
                      <span className="toggle-slider" />
                    </label>
                  </div>
                ))}
              </div>
            )}

            {settingsTab === 'mcp' && (
              <div className="settings-section">
                <h3>MCP Servers</h3>
                <p className="setting-desc">Connect external tools via Model Context Protocol</p>
                {mcpServers.map(server => (
                  <div key={server.id} className="mcp-row">
                    <div className="mcp-info">
                      <strong>{server.name}</strong>
                      <span className="text-muted">{server.url}</span>
                    </div>
                    <label className="toggle">
                      <input type="checkbox" checked={server.enabled} onChange={e => saveMCPServers(mcpServers.map(s => s.id === server.id ? { ...s, enabled: e.target.checked } : s))} />
                      <span className="toggle-slider" />
                    </label>
                    <button className="btn-icon" onClick={() => saveMCPServers(mcpServers.filter(s => s.id !== server.id))}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  </div>
                ))}
                <div className="mcp-add">
                  <input type="text" placeholder="Server name" value={newMcpName} onChange={e => setNewMcpName(e.target.value)} className="input-field mcp-input" />
                  <input type="text" placeholder="URL (e.g. http://localhost:3000)" value={newMcpUrl} onChange={e => setNewMcpUrl(e.target.value)} className="input-field mcp-input" />
                  <button className="btn-primary" onClick={addMCPServer} disabled={!newMcpName.trim() || !newMcpUrl.trim()}>Add Server</button>
                </div>
              </div>
            )}

            {settingsTab === 'advanced' && (
              <div className="settings-section">
                <h3>Advanced</h3>
                <div className="setting-row"><span>Version</span><span className="text-muted">v{version}</span></div>
                <button className="btn-danger" style={{ marginTop: '1rem' }} onClick={() => {
                  localStorage.clear()
                  setSetupDone(false)
                  setAuthToken(null)
                  setAuthUser(null)
                  setAppState('onboarding')
                }}>Reset Everything</button>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ── Main Tasks View ──
  return (
    <div className="app-container">
      {/* Sidebar */}
      <div className={`sidebar ${sidebarOpen ? 'open' : 'closed'}`}>
        <div className="sidebar-header">
          <div className="sidebar-logo">
            <span className="logo-bolt-small">⚡</span>
            <span className="logo-text">TaskBolt</span>
          </div>
          <button className="btn-icon sidebar-toggle" onClick={() => setSidebarOpen(!sidebarOpen)}>
            {sidebarOpen ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
            )}
          </button>
        </div>

        <button className="btn-new-task" onClick={() => { setActiveThreadId(null); setInput('') }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          New Task
        </button>

        <div className="sidebar-search">
          <input type="text" placeholder="Search tasks..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} className="search-input" />
        </div>

        <div className="sidebar-threads">
          {filteredThreads.length === 0 && <p className="no-threads">No tasks yet</p>}
          {filteredThreads.map(thread => (
            <div key={thread.id} className={`thread-item ${thread.id === activeThreadId ? 'active' : ''}`} onClick={() => setActiveThreadId(thread.id)}>
              <span className="thread-title">{thread.title}</span>
              <button className="thread-delete" onClick={e => { e.stopPropagation(); deleteThread(thread.id) }} title="Delete">×</button>
            </div>
          ))}
        </div>

        <div className="sidebar-footer">
          <button className="sidebar-btn" onClick={() => setSkillsOpen(!skillsOpen)}>🧩 Skills</button>
          {isLoggedIn ? (
            <div className="user-row">
              <div className="user-avatar" title={authUser?.display_name || authUser?.email || 'User'}>{authUser?.display_name?.charAt(0) || authUser?.email?.charAt(0) || 'U'}</div>
              <button className="sidebar-btn sidebar-settings" onClick={() => setAppState('settings')} title="Settings">⚙️</button>
            </div>
          ) : (
            <button className="sidebar-btn sidebar-signin" onClick={() => setAppState('signin')}>🔑 Sign In</button>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="main-content">
        {!isLoggedIn && (
          <div className="auth-banner">
            <span>Sign in to use TaskBolt AI</span>
            <button className="btn-signin-banner" onClick={() => setAppState('signin')}>Sign In</button>
          </div>
        )}

        {!activeThread ? (
          <div className="empty-state">
            <div className="empty-logo">⚡</div>
            <h2>What should I set up for you?</h2>
            <p className="empty-subtitle">Describe what you need — I'll handle the rest.</p>
            <div className="skill-suggestions">
              {skills.filter(s => s.enabled && s.isCore).slice(0, 5).map(skill => (
                <button key={skill.id} className="skill-chip" onClick={() => { if (isLoggedIn) setInput(skill.name); else setAppState('signin') }}>
                  {skill.icon} {skill.name}
                </button>
              ))}
            </div>
          </div>
        ) : (
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
                <div className="message-body"><div className="typing-indicator"><span/><span/><span/></div></div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}

        {/* Input Area */}
        <div className="input-area">
          <div className="input-wrapper">
            <button className="attach-btn" title="Upload file">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={!isLoggedIn ? 'Sign in to start chatting...' : 'Describe what you need...'}
              rows={1}
              className="main-input"
            />
            <button
              className={`send-btn ${input.trim() && !isStreaming && isLoggedIn ? 'active' : ''}`}
              onClick={handleSend}
              disabled={!input.trim() || isStreaming || !isLoggedIn}
            >
              {isStreaming ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="3"/></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>
              )}
            </button>
          </div>
        </div>
        <p className="input-hint">TaskBolt uses AI to set up and configure your computer</p>
      </div>

      {/* Skills Panel */}
      {skillsOpen && (
        <div className="skills-overlay" onClick={() => setSkillsOpen(false)}>
          <div className="skills-panel" onClick={e => e.stopPropagation()}>
            <div className="skills-header">
              <h3>Skills</h3>
              <button className="btn-icon" onClick={() => setSkillsOpen(false)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div className="skills-list">
              {skills.map(skill => (
                <div key={skill.id} className={`skill-card ${skill.enabled ? 'enabled' : ''}`}>
                  <span className="skill-card-icon">{skill.icon}</span>
                  <div className="skill-card-info"><h4>{skill.name}</h4><p>{skill.description}</p></div>
                  <label className="toggle">
                    <input type="checkbox" checked={skill.enabled} onChange={e => setSkills(prev => prev.map(s => s.id === skill.id ? { ...s, enabled: e.target.checked } : s))} />
                    <span className="toggle-slider" />
                  </label>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
