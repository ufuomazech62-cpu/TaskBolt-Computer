import { useState, useRef, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-shell'

// ── Types ──────────────────────────────────────────────
interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  thinking?: string
  toolCalls?: { name: string; args: Record<string, unknown>; result?: string }[]
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
type SettingsTab = 'general' | 'account' | 'billing' | 'usage' | 'skills' | 'mcp' | 'advanced'

// ── SaaS Backend ────────────────────────────────────
const SAAS_URL = 'https://taskbolt-saas.vercel.app'

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

  // Billing & Usage
  const [billingStatus, setBillingStatus] = useState<any>(null)
  const [creditPacks, setCreditPacks] = useState<any[]>([])
  const [billingLoading, setBillingLoading] = useState(false)
  const [loadingPackId, setLoadingPackId] = useState<string | null>(null)
  const [showRateLimitPopup, setShowRateLimitPopup] = useState(false)
  const [usageData, setUsageData] = useState<any>(null)
  const [usagePeriod, setUsagePeriod] = useState('7d')
  const [refreshing, setRefreshing] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [deleteThreadConfirm, setDeleteThreadConfirm] = useState<string | null>(null)
  const [agentStatus, setAgentStatus] = useState<'idle' | 'thinking' | 'executing' | 'typing'>('idle')
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

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
      const res = await fetch(`${SAAS_URL}/api/auth/email?action=send`, {
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
        // Code returned in dev mode - don't show to user
        if (data.code) {
          // Email sent successfully, code is on server
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
      const res = await fetch(`${SAAS_URL}/api/auth/email?action=verify`, {
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
      const res = await fetch(`${SAAS_URL}/api/auth/telegram?action=qr`)
      const data = await res.json()
      if (data.ok) {
        setTgQR({ token: data.token, deeplink: data.deeplink })
        setTgPolling(true)
        // Poll for completion
        tgPollRef.current = setInterval(async () => {
          try {
            const check = await fetch(`${SAAS_URL}/api/auth/telegram?action=check&token=${data.token}`)
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

  // ── Send Message (via local agent engine) ────────────
  // Agent runs locally, calls Vercel only for AI API (key stays on server)
  // Agent can execute commands, install software, manage files — full Hermes-style automation

  const handleSend = async () => {
    if (!input.trim() || isStreaming) return

    // Must be signed in
    if (!isLoggedIn) {
      setAppState('signin')
      return
    }

    const userContent = input.trim()
    setInput('')
    setIsStreaming(true)

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: userContent,
      timestamp: Date.now(),
    }

    let threadId: string

    if (activeThread) {
      threadId = activeThread.id
      addMessage(threadId, userMsg)
    } else {
      const newThread: TaskThread = {
        id: crypto.randomUUID(),
        title: userContent.slice(0, 50),
        messages: [userMsg],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      threadId = newThread.id
      setActiveThreadId(threadId)
      setThreads(prev => {
        const updated = [newThread, ...prev]
        localStorage.setItem('tb_threads', JSON.stringify(updated))
        return updated
      })
    }

    // Create assistant message placeholder
    const assistantMsg: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      thinking: '',
      toolCalls: [],
      timestamp: Date.now(),
    }
    addMessage(threadId, assistantMsg)

    // Track streaming state
    let fullContent = ''
    let fullThinking = ''
    const toolCalls: { name: string; args: Record<string, unknown>; result?: string }[] = []

    const updateMsg = () => {
      setThreads(prev => {
        const updated = prev.map(t => {
          if (t.id !== threadId) return t
          return {
            ...t,
            messages: t.messages.map(m =>
              m.id === assistantMsg.id
                ? { ...m, content: fullContent, thinking: fullThinking, toolCalls: [...toolCalls] }
                : m
            ),
          }
        })
        localStorage.setItem('tb_threads', JSON.stringify(updated))
        return updated
      })
    }

    // Listen for agent events from Tauri
    const unlisten = await listen<string>('agent-event', (event) => {
      try {
        const data = JSON.parse(event.payload)
        switch (data.type) {
          case 'thinking':
            fullThinking += data.content || ''
            setAgentStatus('thinking')
            updateMsg()
            break
          case 'content':
            fullContent += data.content || ''
            setAgentStatus('typing')
            updateMsg()
            break
          case 'tool_start':
            toolCalls.push({ name: data.name, args: data.args || {} })
            setAgentStatus('executing')
            updateMsg()
            break
          case 'tool_result':
            if (toolCalls.length > 0) {
              toolCalls[toolCalls.length - 1].result = data.result || ''
            }
            setAgentStatus('typing')
            updateMsg()
            break
          case 'error':
            // Check if this is a rate limit error
            if (data.content?.includes('No credits remaining') || data.content?.includes('rateLimited')) {
              setShowRateLimitPopup(true)
              setIsStreaming(false)
              setAgentStatus('idle')
              unlisten()
              return
            }
            fullContent += `\n\n⚠️ Error: ${data.content}`
            updateMsg()
            break
          case 'done':
            setIsStreaming(false)
            setAgentStatus('idle')
            unlisten()
            break
          case 'status':
            break
        }
      } catch {
        // skip malformed events
      }
    })

    try {
      // Send message to local agent engine via Tauri
      await invoke('send_message', {
        content: userContent,
        threadId,
        authToken: authToken || '',
      })
    } catch (err: unknown) {
      const msg = typeof err === 'string' ? err : (err instanceof Error ? err.message : 'Agent failed')
      fullContent = `Error: ${msg}`
      updateMsg()
      setIsStreaming(false)
      setAgentStatus('idle')
      unlisten()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // ── MCP ──────────────────────────────────────────────

  // ── Billing API calls ────────────────────────────────
  const authHeaders = (): HeadersInit => ({
    'Content-Type': 'application/json',
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
  })

  const fetchBillingStatus = async () => {
    try {
      const res = await fetch(`${SAAS_URL}/api/billing?action=status`, { headers: authHeaders() })
      const data = await res.json()
      if (data.ok) setBillingStatus(data)
    } catch { /* ignore */ }
  }

  const fetchCreditPacks = async () => {
    try {
      const res = await fetch(`${SAAS_URL}/api/billing?action=packs`, { headers: authHeaders() })
      const data = await res.json()
      if (data.ok) setCreditPacks(data.packs || [])
    } catch { /* ignore */ }
  }

  const fetchUsage = async (period: string = usagePeriod) => {
    try {
      const res = await fetch(`${SAAS_URL}/api/billing?action=usage&period=${period}`, { headers: authHeaders() })
      const data = await res.json()
      if (data.ok) setUsageData(data)
    } catch { /* ignore */ }
  }

  const refreshAll = async () => {
    setRefreshing(true)
    try {
      await Promise.all([
        fetchBillingStatus(),
        fetchCreditPacks(),
        fetchUsage(usagePeriod),
        loadThreads(),
      ])
    } catch { /* ignore */ }
    setTimeout(() => setRefreshing(false), 500)
  }

  const purchasePack = async (packId: string) => {
    setLoadingPackId(packId)
    try {
      // Open our branded checkout page (which then redirects to payment)
      const token = localStorage.getItem('tb_auth_token') || authToken
      const checkoutUrl = `${SAAS_URL}/api/checkout?pack=${packId}&token=${token}`
      await open(checkoutUrl)
      // Aggressive polling: every 3 seconds for 2 minutes waiting for webhook
      let polls = 0
      const pollInterval = setInterval(async () => {
        polls++
        await fetchBillingStatus()
        if (polls >= 40) clearInterval(pollInterval)
      }, 3000)
    } catch (err) {
      console.error('[purchasePack] error:', err)
      alert('Could not open checkout. Please try again.')
    } finally {
      setLoadingPackId(null)
    }
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    setUploadedFiles(prev => [...prev, ...files])
    e.target.value = ''
  }

  const removeUploadedFile = (index: number) => {
    setUploadedFiles(prev => prev.filter((_, i) => i !== index))
  }

  const deleteAccount = async () => {
    if (deleteConfirm !== 'DELETE') return
    setDeleteLoading(true)
    try {
      const res = await fetch(`${SAAS_URL}/api/account?action=delete`, {
        method: 'DELETE',
        headers: authHeaders(),
        body: JSON.stringify({ confirm: 'DELETE' }),
      })
      const data = await res.json()
      if (data.ok) {
        handleSignOut()
        localStorage.clear()
        setAppState('onboarding')
      }
    } catch { /* ignore */ } finally {
      setDeleteLoading(false)
    }
  }

  // Fetch billing data when settings opens or tasks view
  useEffect(() => {
    if (isLoggedIn) {
      fetchBillingStatus()
      if (appState === 'settings') fetchCreditPacks()
    }
  }, [appState, settingsTab, isLoggedIn])

  useEffect(() => {
    if (settingsTab === 'usage' && isLoggedIn) {
      fetchUsage(usagePeriod)
    }
  }, [settingsTab, usagePeriod])

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

  // ── SVG Icon Components (Lucide-style) ──
  const IconBolt = ({ size = 20 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
  )
  const IconPlus = ({ size = 16 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
  )
  const IconSearch = ({ size = 16 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
  )
  const IconSend = ({ size = 18 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
  )
  const IconSettings = ({ size = 18 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
  )
  const IconArrowLeft = ({ size = 18 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
  )
  const IconX = ({ size = 16 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
  )
  const IconChevronLeft = ({ size = 18 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
  )
  const IconPanelLeftClose = ({ size = 18 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><polyline points="15 9 12 12 15 15"/></svg>
  )
  const IconPanelLeftOpen = ({ size = 18 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><polyline points="12 9 15 12 12 15"/></svg>
  )
  const IconMessageSquare = ({ size = 16 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
  )
  const IconZap = ({ size = 16 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
  )
  const IconSun = ({ size = 16 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
  )
  const IconMoon = ({ size = 16 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
  )
  const IconTrash = ({ size = 14 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
  )
  const IconUser = ({ size = 14 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
  )
  const IconPuzzle = ({ size = 16 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 01-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 10-3.214 3.214c.446.166.855.497.925.968a.979.979 0 01-.276.837l-1.61 1.61a2.404 2.404 0 01-1.705.707 2.402 2.402 0 01-1.704-.706l-1.568-1.568a1.026 1.026 0 00-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 11-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 00-.289-.877l-1.568-1.568A2.402 2.402 0 011.998 12c0-.617.236-1.234.706-1.704L4.315 8.685a.98.98 0 01.837-.276c.47.07.802.48.968.925a2.501 2.501 0 103.214-3.214c-.446-.166-.855-.497-.925-.968a.979.979 0 01.276-.837l1.61-1.61a2.404 2.404 0 011.705-.707c.618 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 113.237 3.237c-.464.18-.894.527-.967 1.02z"/></svg>
  )
  const IconCheck = ({ size = 20 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
  )
  const IconLoader = ({ size = 18 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="icon-spin"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg>
  )
  const IconChevronDown = ({ size = 14 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
  )
  const IconChevronRight = ({ size = 14 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
  )
  const IconRefresh = ({ size = 16, spinning = false }: { size?: number; spinning?: boolean }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={spinning ? 'icon-spin' : ''}><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
  )

  // ── Date grouping helper ──
  const groupThreadsByDate = (threads: TaskThread[]) => {
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const yesterday = today - 86400000
    const sevenDaysAgo = today - 7 * 86400000

    const groups: { label: string; items: TaskThread[] }[] = [
      { label: 'Today', items: [] },
      { label: 'Yesterday', items: [] },
      { label: 'Previous 7 Days', items: [] },
      { label: 'Older', items: [] },
    ]

    for (const t of threads) {
      if (t.updatedAt >= today) groups[0].items.push(t)
      else if (t.updatedAt >= yesterday) groups[1].items.push(t)
      else if (t.updatedAt >= sevenDaysAgo) groups[2].items.push(t)
      else groups[3].items.push(t)
    }

    return groups.filter(g => g.items.length > 0)
  }

  // ── Markdown renderer with table/column support ──
  const parseMarkdownTable = (lines: string[]): React.ReactNode | null => {
    if (lines.length < 2) return null
    const parseRow = (line: string) => line.split('|').slice(1, -1).map(c => c.trim())
    const headers = parseRow(lines[0])
    const separator = lines[1]
    if (!separator.match(/^[\s|:-]+$/)) return null

    const rows = lines.slice(2).map(parseRow)
    return (
      <div className="md-table-wrap">
        <table className="md-table">
          <thead>
            <tr>{headers.map((h, i) => <th key={i}>{renderInline(h)}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{renderInline(cell)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  const renderMarkdown = (text: string) => {
    const parts: React.ReactNode[] = []
    const lines = text.split('\n')
    let inCodeBlock = false
    let codeBlockContent = ''
    let codeBlockLang = ''
    let tableBuffer: string[] = []

    const flushTable = () => {
      if (tableBuffer.length > 0) {
        const table = parseMarkdownTable(tableBuffer)
        if (table) {
          parts.push(<div key={`tbl-${parts.length}`}>{table}</div>)
        } else {
          tableBuffer.forEach((l, i) => parts.push(<span key={`tblraw-${parts.length}-${i}`}>{renderInline(l)}{'\n'}</span>))
        }
        tableBuffer = []
      }
    }

    lines.forEach((line, i) => {
      if (line.startsWith('```')) {
        flushTable()
        if (!inCodeBlock) {
          inCodeBlock = true
          codeBlockLang = line.slice(3).trim()
          codeBlockContent = ''
        } else {
          parts.push(<pre key={`cb-${i}`} className="md-code-block"><code>{codeBlockContent}</code></pre>)
          inCodeBlock = false
        }
        return
      }
      if (inCodeBlock) {
        codeBlockContent += (codeBlockContent ? '\n' : '') + line
        return
      }

      // Table detection: line starts with |
      if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
        tableBuffer.push(line.trim())
        return
      } else {
        flushTable()
      }

      // Headers
      if (line.startsWith('### ')) {
        parts.push(<h4 key={i} className="md-h4">{renderInline(line.slice(4))}</h4>)
      } else if (line.startsWith('## ')) {
        parts.push(<h3 key={i} className="md-h3">{renderInline(line.slice(3))}</h3>)
      } else if (line.startsWith('# ')) {
        parts.push(<h2 key={i} className="md-h2">{renderInline(line.slice(2))}</h2>)
      }
      // Blockquote
      else if (line.startsWith('> ')) {
        parts.push(<blockquote key={i} className="md-blockquote">{renderInline(line.slice(2))}</blockquote>)
      }
      // Horizontal rule
      else if (line.match(/^[-*_]{3,}\s*$/)) {
        parts.push(<hr key={i} className="md-hr" />)
      }
      // List items
      else if (line.match(/^[\-\*] /)) {
        parts.push(<div key={i} className="md-li">{renderInline(line.slice(2))}</div>)
      } else if (line.match(/^\d+\. /)) {
        parts.push(<div key={i} className="md-li md-ol">{renderInline(line.replace(/^\d+\. /, ''))}</div>)
      }
      // Checkbox
      else if (line.match(/^[\-\*] \[[ x]\] /)) {
        const checked = line.match(/\[x\]/)
        const text = line.replace(/^[\-\*] \[[ x]\] /, '')
        parts.push(<div key={i} className="md-li md-checkbox">{checked ? '☑' : '☐'} {renderInline(text)}</div>)
      }
      // Empty line
      else if (line.trim() === '') {
        parts.push(<div key={i} className="md-br" />)
      }
      // Regular text
      else {
        parts.push(<span key={i}>{renderInline(line)}{i < lines.length - 1 ? '\n' : ''}</span>)
      }
    })

    flushTable()

    if (inCodeBlock && codeBlockContent) {
      parts.push(<pre key="cb-final" className="md-code-block"><code>{codeBlockContent}</code></pre>)
    }

    return <>{parts}</>
  }

  const renderInline = (text: string): React.ReactNode => {
    const parts: React.ReactNode[] = []
    // Match **bold**, *italic*, ~~strikethrough~~, `code`, [links](url), and regular text
    const regex = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(~~(.+?)~~)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/g
    let lastIndex = 0
    let match

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(text.slice(lastIndex, match.index))
      }
      if (match[2]) {
        parts.push(<strong key={match.index}>{match[2]}</strong>)
      } else if (match[4]) {
        parts.push(<em key={match.index}>{match[4]}</em>)
      } else if (match[6]) {
        parts.push(<del key={match.index}>{match[6]}</del>)
      } else if (match[8]) {
        parts.push(<code key={match.index} className="md-inline-code">{match[8]}</code>)
      } else if (match[10]) {
        parts.push(<a key={match.index} href={match[11]} target="_blank" rel="noopener noreferrer" className="md-link">{match[10]}</a>)
      }
      lastIndex = match.index + match[0].length
    }
    if (lastIndex < text.length) {
      parts.push(text.slice(lastIndex))
    }
    return parts.length === 1 ? parts[0] : <>{parts}</>
  }

  // ── Onboarding ──
  if (appState === 'onboarding') {
    return (
      <div className="app-container">
        <div className="onboarding-screen">
          <div className="onboarding-logo">
            <div className="logo-bolt"><IconBolt size={48} /></div>
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
              <p>Setup failed</p>
              <p className="error-detail">{setupError}</p>
              <button className="btn-primary" onClick={handleAutoSetup}>Retry</button>
            </div>
          )}
          {setupDone && (
            <div className="setup-success">
              <div className="check-icon"><IconCheck size={28} /></div>
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
              <div className="logo-bolt"><IconBolt size={36} /></div>
              <h1>TaskBolt</h1>
              <p className="signin-subtitle">Sign in to get started</p>
            </div>

            {/* Google */}
            <button className="btn-oauth btn-google" onClick={signInGoogle}>
              <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
              Continue with Google
            </button>

            {/* Email Passwordless */}
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

            <div className="divider"><span>or continue with</span></div>

            {/* Telegram */}
            <button className="btn-oauth btn-telegram" onClick={startTelegramQR}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12s5.37 12 12 12 12-5.37 12-12S18.63 0 12 0zm5.94 8.13l-1.97 9.28c-.15.67-.54.83-1.09.52l-3.02-2.22-1.46 1.4c-.16.16-.3.3-.61.3l.22-3.06 5.55-5.02c.24-.22-.05-.33-.38-.13l-6.86 4.32-2.96-.92c-.64-.2-.66-.64.14-.95l11.6-4.47c.54-.2 1.01.13.84.95z"/></svg>
              Telegram
            </button>

            {/* GitHub */}
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
              <IconChevronLeft size={18} />
              <span>Back</span>
            </button>
            <h2>Settings</h2>
            <button className="btn-icon btn-refresh" onClick={refreshAll} title="Refresh" disabled={refreshing}>
              <IconRefresh size={16} spinning={refreshing} />
            </button>
          </div>
          <div className="settings-body">
            <div className="settings-tabs">
              {(['general', 'account', 'billing', 'usage', 'skills', 'mcp', 'advanced'] as SettingsTab[]).map(tab => (
                <button key={tab} className={`tab-btn ${settingsTab === tab ? 'active' : ''}`} onClick={() => setSettingsTab(tab)}>
                  {tab === 'mcp' ? 'MCP' : tab === 'billing' ? 'Credits' : tab.charAt(0).toUpperCase() + tab.slice(1)}
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
                  <>
                    <div className="account-info">
                      <div className="account-avatar">{authUser?.display_name?.charAt(0) || authUser?.email?.charAt(0) || 'U'}</div>
                      <div className="account-details">
                        <strong>{authUser?.display_name || 'User'}</strong>
                        <span className="text-muted">{authUser?.email || `Telegram: ${authUser?.telegram_id}`}</span>
                      </div>
                      <button className="btn-secondary" onClick={handleSignOut}>Sign Out</button>
                    </div>

                    <div className="danger-zone" style={{ marginTop: '2rem' }}>
                      <h3 style={{ color: 'var(--danger)' }}>Danger Zone</h3>
                      <p className="setting-desc">Permanently delete your account and all data. This cannot be undone.</p>
                      <input
                        type="text"
                        placeholder='Type DELETE to confirm'
                        value={deleteConfirm}
                        onChange={e => setDeleteConfirm(e.target.value)}
                        className="input-field"
                        style={{ marginBottom: '0.5rem' }}
                      />
                      <button
                        className="btn-danger"
                        disabled={deleteConfirm !== 'DELETE' || deleteLoading}
                        onClick={deleteAccount}
                      >
                        {deleteLoading ? 'Deleting...' : 'Delete My Account'}
                      </button>
                    </div>
                  </>
                ) : (
                  <button className="btn-primary" onClick={() => setAppState('signin')}>Sign In</button>
                )}
              </div>
            )}

            {settingsTab === 'billing' && (
              <div className="settings-section">
                <div className="section-header-row">
                  <h3>Credits</h3>
                  <button className="btn-icon btn-refresh-sm" onClick={() => { fetchBillingStatus(); fetchCreditPacks() }} title="Refresh credits">
                    <IconRefresh size={14} spinning={refreshing} />
                  </button>
                </div>
                <div className="credits-overview">
                  <div className="credits-balance-card">
                    <span className="credits-label">Current Balance</span>
                    <span className="credits-amount">{billingStatus?.credits?.balance?.toLocaleString() || '0'}</span>
                    <span className="credits-sub">≈ {((billingStatus?.credits?.balance || 0) * 200 / 1000000).toFixed(1)}M tokens</span>
                  </div>
                  <div className="credits-used-card">
                    <span className="credits-label">Total Used</span>
                    <span className="credits-amount">{billingStatus?.credits?.total_used?.toLocaleString() || '0'}</span>
                  </div>
                </div>

                <h3 style={{ marginTop: '1.5rem' }}>Credit Packs</h3>
                <p className="setting-desc">One-time purchase. Credits never expire. 1 credit = 200 tokens.</p>
                <div className="plans-grid">
                  {creditPacks.map(pack => (
                    <div key={pack.id} className="plan-card">
                      <div className="plan-card-header">
                        <span className="plan-name">{pack.name}</span>
                        <span className="plan-price">${pack.price_usd}</span>
                      </div>
                      <p className="plan-desc">{pack.description}</p>
                      <div className="plan-credits">{pack.credits?.toLocaleString()} credits</div>
                      <button
                        className="btn-primary btn-sm"
                        onClick={() => purchasePack(pack.id)}
                        disabled={loadingPackId !== null || pack.available === false}
                      >
                        {loadingPackId === pack.id ? 'Opening checkout...' : loadingPackId !== null ? 'Wait...' : pack.available === false ? 'Unavailable' : `Buy — $${pack.price_usd}`}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {settingsTab === 'usage' && (
              <div className="settings-section">
                <div className="section-header-row">
                  <h3>Usage</h3>
                  <button className="btn-icon btn-refresh-sm" onClick={() => fetchUsage(usagePeriod)} title="Refresh usage">
                    <IconRefresh size={14} spinning={refreshing} />
                  </button>
                </div>

                {/* Period Selector */}
                <div className="usage-period-tabs">
                  {['today', 'week', 'month'].map(p => (
                    <button
                      key={p}
                      className={`period-btn ${usagePeriod === p ? 'active' : ''}`}
                      onClick={() => setUsagePeriod(p)}
                    >
                      {p.charAt(0).toUpperCase() + p.slice(1)}
                    </button>
                  ))}
                </div>

                {usageData ? (
                  <>
                    {/* Stats Grid */}
                    <div className="usage-stats-grid">
                      <div className="usage-stat-card">
                        <span className="usage-stat-label">Total Tokens</span>
                        <span className="usage-stat-value">{usageData.stats.total_tokens.toLocaleString()}</span>
                      </div>
                      <div className="usage-stat-card">
                        <span className="usage-stat-label">Prompt Tokens</span>
                        <span className="usage-stat-value">{usageData.stats.prompt_tokens.toLocaleString()}</span>
                      </div>
                      <div className="usage-stat-card">
                        <span className="usage-stat-label">Completion Tokens</span>
                        <span className="usage-stat-value">{usageData.stats.completion_tokens.toLocaleString()}</span>
                      </div>
                      <div className="usage-stat-card">
                        <span className="usage-stat-label">Credits Used</span>
                        <span className="usage-stat-value">{usageData.stats.credits_used.toLocaleString()}</span>
                      </div>
                      <div className="usage-stat-card">
                        <span className="usage-stat-label">Requests</span>
                        <span className="usage-stat-value">{usageData.stats.requests}</span>
                      </div>
                    </div>

                    {/* Model Breakdown */}
                    {usageData.models && usageData.models.length > 0 && (
                      <div style={{ marginTop: '1.5rem' }}>
                        <h4>By Model</h4>
                        <div className="usage-table">
                          <div className="usage-table-header">
                            <span>Model</span>
                            <span>Tokens</span>
                            <span>Credits</span>
                            <span>Requests</span>
                          </div>
                          {usageData.models.map((m: any, i: number) => (
                            <div key={i} className="usage-table-row">
                              <span className="font-mono">{m.model}</span>
                              <span>{m.tokens.toLocaleString()}</span>
                              <span>{m.credits.toLocaleString()}</span>
                              <span>{m.requests}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Recent Transactions */}
                    {usageData.transactions && usageData.transactions.length > 0 && (
                      <div style={{ marginTop: '1.5rem' }}>
                        <h4>Recent Transactions</h4>
                        <div className="usage-table">
                          <div className="usage-table-header">
                            <span>Type</span>
                            <span>Credits</span>
                            <span>Amount</span>
                            <span>Status</span>
                            <span>Date</span>
                          </div>
                          {usageData.transactions.slice(0, 10).map((t: any, i: number) => (
                            <div key={i} className="usage-table-row">
                              <span>{t.type.replace('_', ' ')}</span>
                              <span>{t.credits.toLocaleString()}</span>
                              <span>{t.amount_usd ? `$${t.amount_usd}` : '—'}</span>
                              <span className={`status-badge status-${t.status}`}>{t.status}</span>
                              <span className="text-muted">{new Date(t.created_at).toLocaleDateString()}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-muted" style={{ textAlign: 'center', padding: '2rem' }}>Loading usage data...</p>
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
                      <IconX size={14} />
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
  const threadGroups = groupThreadsByDate(filteredThreads)

  return (
    <div className={`app-container ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
      {/* Sidebar */}
      <div className={`sidebar ${sidebarOpen ? 'expanded' : 'collapsed'}`}>
        <div className="sidebar-header">
          {sidebarOpen ? (
            <>
              <div className="sidebar-logo">
                <IconBolt size={20} />
                <span className="logo-text">TaskBolt</span>
              </div>
              <button className="btn-icon sidebar-toggle" onClick={() => setSidebarOpen(false)} title="Collapse sidebar">
                <IconPanelLeftClose size={18} />
              </button>
            </>
          ) : (
            <button className="btn-icon sidebar-toggle sidebar-toggle-collapsed" onClick={() => setSidebarOpen(true)} title="Expand sidebar">
              <IconPanelLeftOpen size={18} />
            </button>
          )}
        </div>

        <button className="btn-new-task" onClick={() => { setActiveThreadId(null); setInput('') }} title={sidebarOpen ? '' : 'New Task'}>
          <IconPlus size={16} />
          {sidebarOpen && <span>New Task</span>}
        </button>

        {sidebarOpen && (
          <div className="sidebar-search">
            <div className="search-wrapper">
              <IconSearch size={14} />
              <input
                type="text"
                placeholder="Search tasks..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="search-input"
              />
            </div>
          </div>
        )}

        <div className="sidebar-threads">
          {sidebarOpen ? (
            <>
              {threadGroups.length === 0 && <p className="no-threads">No tasks yet</p>}
              {threadGroups.map(group => (
                <div key={group.label} className="thread-group">
                  <div className="thread-group-label">{group.label}</div>
                  {group.items.map(thread => (
                    <div key={thread.id} className={`thread-item ${thread.id === activeThreadId ? 'active' : ''}`} onClick={() => setActiveThreadId(thread.id)}>
                      <IconMessageSquare size={14} />
                      <span className="thread-title">{thread.title}</span>
                      <button className="thread-delete" onClick={e => { e.stopPropagation(); setDeleteThreadConfirm(thread.id) }} title="Delete">
                        <IconX size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              ))}
            </>
          ) : (
            <div className="sidebar-icons-only">
              <button className="sidebar-icon-btn" onClick={() => { setActiveThreadId(null); setInput('') }} title="New Task">
                <IconPlus size={18} />
              </button>
            </div>
          )}
        </div>

        {/* Skills section in sidebar */}
        {sidebarOpen && (
          <div className="sidebar-skills">
            <button className="sidebar-section-header" onClick={() => setSkillsOpen(!skillsOpen)}>
              <IconPuzzle size={14} />
              <span>Skills</span>
              <span className={`sidebar-chevron ${skillsOpen ? 'open' : ''}`}>
                <IconChevronDown size={12} />
              </span>
            </button>
            {skillsOpen && (
              <div className="sidebar-skills-list">
                {skills.filter(s => s.enabled).slice(0, 6).map(skill => (
                  <button key={skill.id} className="sidebar-skill-item" onClick={() => { setInput(skill.name); inputRef.current?.focus() }}>
                    <span className="sidebar-skill-icon">{skill.icon}</span>
                    <span>{skill.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Footer: User avatar + Settings gear side by side */}
        <div className="sidebar-footer">
          {sidebarOpen ? (
            <div className="sidebar-footer-row">
              {isLoggedIn ? (
                <>
                  <div className="user-avatar" title={authUser?.display_name || authUser?.email || 'User'}>
                    {authUser?.display_name?.charAt(0) || authUser?.email?.charAt(0) || 'U'}
                  </div>
                  <span className="user-name">{authUser?.display_name || authUser?.email || 'User'}</span>
                  <button className="btn-icon" onClick={() => setAppState('settings')} title="Settings">
                    <IconSettings size={16} />
                  </button>
                </>
              ) : (
                <button className="btn-signin-sidebar" onClick={() => setAppState('signin')}>
                  <IconUser size={14} />
                  <span>Sign In</span>
                </button>
              )}
            </div>
          ) : (
            <div className="sidebar-footer-collapsed">
              {isLoggedIn ? (
                <>
                  <div className="user-avatar" title={authUser?.display_name || authUser?.email || 'User'}>
                    {authUser?.display_name?.charAt(0) || authUser?.email?.charAt(0) || 'U'}
                  </div>
                  <button className="btn-icon" onClick={() => setAppState('settings')} title="Settings">
                    <IconSettings size={16} />
                  </button>
                </>
              ) : (
                <button className="btn-icon" onClick={() => setAppState('signin')} title="Sign In">
                  <IconUser size={16} />
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="main-content">
        {/* Top Nav Bar */}
        <div className="top-nav-bar">
          {!isLoggedIn && (
            <button className="btn-signin-banner" onClick={() => setAppState('signin')}>Sign In</button>
          )}
          {isLoggedIn && (
            <div className="nav-right">
              <div className="nav-credits" onClick={() => { setAppState('settings'); setSettingsTab('billing') }} title="Buy credits">
                <span className="nav-credits-icon">⚡</span>
                <span className="nav-credits-amount">{billingStatus?.credits?.balance?.toLocaleString() || '0'}</span>
                <span className="nav-credits-buy">+ Buy</span>
              </div>
              <button className="btn-icon btn-refresh" onClick={refreshAll} title="Refresh" disabled={refreshing}>
                <IconRefresh size={16} spinning={refreshing} />
              </button>
            </div>
          )}
        </div>

        {!activeThread ? (
          <div className="empty-state">
            <div className="empty-logo"><IconBolt size={40} /></div>
            <h2>What can I help you set up?</h2>
            <p className="empty-subtitle">Describe what you need — I'll handle the rest.</p>
            <div className="skill-suggestions">
              {skills.filter(s => s.enabled && s.isCore).slice(0, 6).map(skill => (
                <button key={skill.id} className="skill-chip" onClick={() => { if (isLoggedIn) setInput(skill.name); else setAppState('signin') }}>
                  <span className="chip-icon">{skill.icon}</span>
                  {skill.name}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="messages-container">
            {activeThread.messages.map(msg => (
              <div key={msg.id} className={`msg msg-${msg.role}`}>
                <div className="msg-avatar">
                  {msg.role === 'assistant' ? (
                    <span className="msg-avatar-ai">⚡</span>
                  ) : (
                    <span className="msg-avatar-user">
                      {authUser?.display_name?.charAt(0)?.toUpperCase() || authUser?.email?.charAt(0)?.toUpperCase() || 'U'}
                    </span>
                  )}
                </div>
                <div className="msg-body">
                  <div className="msg-sender">
                    {msg.role === 'assistant' ? 'TaskBolt' : (authUser?.display_name || authUser?.email || 'You')}
                  </div>
                  {msg.thinking && (
                    <details className="thinking-block">
                      <summary>
                        <IconChevronRight size={12} /> Reasoning
                      </summary>
                      <pre>{msg.thinking}</pre>
                    </details>
                  )}
                  {msg.toolCalls && msg.toolCalls.length > 0 && (
                    <div className="tool-calls">
                      {msg.toolCalls.map((tc, i) => (
                        <details key={i} className="tool-call-block" open={tc.result === undefined}>
                          <summary>
                            <span className="tool-call-status">{tc.result === undefined ? <span className="tc-spinner" /> : <span className="tc-check">✓</span>}</span>
                            <span className="tool-call-name">{tc.name}</span>
                            {tc.result !== undefined && <span className="tool-call-badge">done</span>}
                          </summary>
                          <div className="tool-call-detail">
                            <div className="tool-call-section">
                              <span className="tool-call-label">Input</span>
                              <pre>{JSON.stringify(tc.args, null, 2)}</pre>
                            </div>
                            {tc.result !== undefined && (
                              <div className="tool-call-section">
                                <span className="tool-call-label">Output</span>
                                <pre>{tc.result.slice(0, 2000)}{tc.result.length > 2000 ? '\n...' : ''}</pre>
                              </div>
                            )}
                          </div>
                        </details>
                      ))}
                    </div>
                  )}
                  <div className="msg-text">{renderMarkdown(msg.content)}</div>
                </div>
              </div>
            ))}
            {isStreaming && activeThread.messages[activeThread.messages.length - 1]?.content === '' && (
              <div className="msg msg-assistant">
                <div className="msg-avatar">
                  <span className="msg-avatar-ai">⚡</span>
                </div>
                <div className="msg-body">
                  <div className="msg-sender">TaskBolt</div>
                  <div className="agent-status-indicator">
                    {agentStatus === 'thinking' && (
                      <><span className="status-dot thinking" /> Thinking...</>
                    )}
                    {agentStatus === 'executing' && (
                      <><span className="status-dot executing" /> Executing task...</>
                    )}
                    {(agentStatus === 'typing' || agentStatus === 'idle') && (
                      <div className="typing-indicator"><div className="typing-bar"><span /><span /><span /></div></div>
                    )}
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}

        {/* Input Area */}
        <div className="input-area">
          {uploadedFiles.length > 0 && (
            <div className="uploaded-files-bar">
              {uploadedFiles.map((f, i) => (
                <span key={i} className="uploaded-file-chip">
                  📎 {f.name}
                  <button onClick={() => removeUploadedFile(i)}><IconX size={10} /></button>
                </span>
              ))}
            </div>
          )}
          <div className="input-wrapper">
            <button className="upload-btn" onClick={() => fileInputRef.current?.click()} title="Attach files">
              <IconPlus size={18} />
            </button>
            <input ref={fileInputRef} type="file" multiple hidden onChange={handleFileUpload} />
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={!isLoggedIn ? 'Sign in to start chatting...' : 'What would you like to set up?'}
              rows={1}
              className="main-input"
            />
            <button
              className={`send-btn ${input.trim() && !isStreaming && isLoggedIn ? 'active' : ''}`}
              onClick={handleSend}
              disabled={!input.trim() || isStreaming || !isLoggedIn}
            >
              {isStreaming ? <IconLoader size={16} /> : <IconSend size={16} />}
            </button>
          </div>
          <p className="input-hint">TaskBolt uses AI to set up and configure your computer</p>
        </div>
      </div>

      {/* Delete Thread Confirmation Modal */}
      {deleteThreadConfirm && (
        <div className="modal-overlay" onClick={() => setDeleteThreadConfirm(null)}>
          <div className="confirm-modal" onClick={e => e.stopPropagation()}>
            <h3>Delete Task?</h3>
            <p>This will permanently delete this task and all its messages. This cannot be undone.</p>
            <div className="confirm-modal-actions">
              <button className="btn-secondary" onClick={() => setDeleteThreadConfirm(null)}>Cancel</button>
              <button className="btn-danger" onClick={() => { deleteThread(deleteThreadConfirm); setDeleteThreadConfirm(null) }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Rate Limit Popup */}
      {showRateLimitPopup && (
        <div className="modal-overlay" onClick={() => setShowRateLimitPopup(false)}>
          <div className="rate-limit-modal" onClick={e => e.stopPropagation()}>
            <div className="rate-limit-icon">⚡</div>
            <h2>You're out of credits</h2>
            <p>Buy a credit pack or top-up to continue using TaskBolt.</p>
            <div className="rate-limit-options">
              <button className="btn-primary" onClick={() => { setShowRateLimitPopup(false); setAppState('settings'); setSettingsTab('billing') }}>
                Buy Credits
              </button>
              <button className="btn-secondary" onClick={() => setShowRateLimitPopup(false)}>
                Later
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
