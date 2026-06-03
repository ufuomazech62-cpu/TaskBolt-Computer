import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-shell'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import sql from 'highlight.js/lib/languages/sql'
import yaml from 'highlight.js/lib/languages/yaml'
import rust from 'highlight.js/lib/languages/rust'
import go from 'highlight.js/lib/languages/go'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import markdown from 'highlight.js/lib/languages/markdown'
import LogoSvg from './LogoSvg'

// Register highlight.js languages
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('css', css)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('yml', yaml)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('rs', rust)
hljs.registerLanguage('go', go)
hljs.registerLanguage('dockerfile', dockerfile)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('md', markdown)

// ── Slash Commands ────────────────────────────────────
interface SlashCommand {
  cmd: string
  label: string
  description: string
  icon: string
}

const SLASH_COMMANDS: SlashCommand[] = [
  { cmd: '/new', label: 'New Task', description: 'Start a fresh conversation', icon: '✨' },
  { cmd: '/clear', label: 'Clear Chat', description: 'Clear all messages in current thread', icon: '🧹' },
  { cmd: '/help', label: 'Help', description: 'Show available commands and capabilities', icon: '❓' },
  { cmd: '/web', label: 'Web Search', description: 'Search the web for information', icon: '🌐' },
  { cmd: '/image', label: 'Generate Image', description: 'Create an AI-generated image', icon: '🖼️' },
  { cmd: '/shell', label: 'Run Command', description: 'Execute a shell command directly', icon: '💻' },
  { cmd: '/code', label: 'Write Code', description: 'Generate or debug code', icon: '⌨️' },
  { cmd: '/status', label: 'Status', description: 'Show system and agent status', icon: '📊' },
  { cmd: '/skills', label: 'Skills', description: 'List all enabled skills', icon: '🧩' },
  { cmd: '/compact', label: 'Compact', description: 'Summarize conversation to free context', icon: '📦' },
]

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

type AppState = 'onboarding' | 'tasks' | 'settings' | 'signin' | 'sessions' | 'memory' | 'tools' | 'schedules' | 'gateway' | 'kanban'
type SidebarView = 'chat' | 'sessions' | 'memory' | 'tools' | 'schedules' | 'gateway' | 'kanban'

// ── Hermes-style Screen Interfaces ──────────────────
interface MemoryEntry {
  id: string
  target: 'memory' | 'user'
  content: string
  createdAt: number
}

interface KanbanCard {
  id: string
  title: string
  description: string
  column: 'todo' | 'progress' | 'done' | 'blocked'
  priority: 'low' | 'medium' | 'high'
  createdAt: number
}

interface ScheduledTask {
  id: string
  name: string
  schedule: string
  prompt: string
  enabled: boolean
  lastRun?: number
  nextRun?: number
}

interface GatewayPlatform {
  id: string
  name: string
  icon: string
  connected: boolean
  config?: Record<string, string>
}

interface ToolsetConfig {
  id: string
  name: string
  description: string
  icon: string
  enabled: boolean
}
type SettingsTab = 'general' | 'account' | 'billing' | 'usage' | 'skills' | 'mcp' | 'advanced'

// ── SaaS Backend ────────────────────────────────────
const SAAS_URL = 'https://taskbolt.space'

// ── Core skills ───────────────────────────────────────
const CORE_SKILLS: Skill[] = [
  // ── Quick Actions (top row) ──
  { id: 'general-task', name: 'General Task', description: 'Ask me to do anything on your computer', icon: '⚡', enabled: true, isCore: true },
  { id: 'troubleshoot', name: 'Troubleshoot', description: 'Diagnose and fix any computer problem', icon: '🔧', enabled: true, isCore: true },

  // ── Everyday Essentials ──
  { id: 'install', name: 'Install Software', description: 'Find and install any application', icon: '📦', enabled: true, isCore: true },
  { id: 'fix', name: 'Fix Issues', description: 'Repair system problems automatically', icon: '🩹', enabled: true, isCore: true },
  { id: 'cleanup', name: 'Clean & Optimize', description: 'Free disk space and boost performance', icon: '🧹', enabled: true, isCore: true },
  { id: 'setup', name: 'Setup My Computer', description: 'Auto-detect and configure your PC', icon: '⚙️', enabled: true, isCore: true },
  { id: 'update', name: 'Update Everything', description: 'Keep your system and apps up to date', icon: '🔄', enabled: true, isCore: true },

  // ── Productivity & Office ──
  { id: 'data-analysis', name: 'Data Analysis', description: 'Analyze spreadsheets, CSVs, and datasets', icon: '📊', enabled: true, isCore: true },
  { id: 'documents', name: 'Create Documents', description: 'Write reports, summaries, and presentations', icon: '📄', enabled: true, isCore: true },
  { id: 'email', name: 'Email Assistant', description: 'Draft, organize, and manage your emails', icon: '✉️', enabled: true, isCore: true },
  { id: 'file-organizer', name: 'Organize Files', description: 'Sort, rename, and organize files automatically', icon: '📁', enabled: true, isCore: true },
  { id: 'research', name: 'Research Assistant', description: 'Web research and comprehensive summaries', icon: '🔍', enabled: true, isCore: true },
  { id: 'writing', name: 'Writing Assistant', description: 'Edit, proofread, and improve your writing', icon: '✍️', enabled: true, isCore: true },
  { id: 'pdf-tools', name: 'PDF Tools', description: 'Merge, split, extract, and convert PDFs', icon: '📑', enabled: true, isCore: true },
  { id: 'translation', name: 'Translation', description: 'Translate documents and text to any language', icon: '🌐', enabled: true, isCore: true },
  { id: 'presentations', name: 'Presentations', description: 'Create slide decks with content and design', icon: '🎯', enabled: true, isCore: true },
  { id: 'meeting-notes', name: 'Meeting Notes', description: 'Summarize meetings and extract action items', icon: '📝', enabled: true, isCore: true },
  { id: 'resume-builder', name: 'Resume & CV', description: 'Build professional resumes and cover letters', icon: '👔', enabled: true, isCore: true },
  { id: 'invoice', name: 'Invoices & Receipts', description: 'Create invoices, track expenses, generate receipts', icon: '🧾', enabled: true, isCore: true },

  // ── Professional & Business ──
  { id: 'legal-docs', name: 'Legal Documents', description: 'Draft contracts, NDAs, terms of service, agreements', icon: '⚖️', enabled: true, isCore: true },
  { id: 'financial-analysis', name: 'Financial Analysis', description: 'Analyze budgets, P&L statements, cash flow, investments', icon: '💰', enabled: true, isCore: true },
  { id: 'business-plan', name: 'Business Plans', description: 'Write business plans, market analysis, pitch decks', icon: '📈', enabled: true, isCore: true },
  { id: 'tax-prep', name: 'Tax Preparation', description: 'Organize tax documents, calculate deductions, prepare filings', icon: '🏛️', enabled: true, isCore: true },
  { id: 'project-mgmt', name: 'Project Management', description: 'Create project plans, Gantt charts, task breakdowns', icon: '📋', enabled: true, isCore: true },
  { id: 'hr-assistant', name: 'HR & Recruiting', description: 'Job descriptions, interview questions, onboarding docs', icon: '👥', enabled: true, isCore: true },
  { id: 'seo-audit', name: 'SEO & Marketing', description: 'SEO audits, keyword research, content strategy, social media', icon: '📣', enabled: true, isCore: true },
  { id: 'competitor-analysis', name: 'Competitor Analysis', description: 'Research competitors, SWOT analysis, market positioning', icon: '🎯', enabled: true, isCore: true },

  // ── Creative & Media ──
  { id: 'image-editing', name: 'Image Editing', description: 'Batch resize, convert, watermark, and edit images', icon: '🖼️', enabled: true, isCore: true },
  { id: 'video-tools', name: 'Video Tools', description: 'Convert, compress, trim, and merge video files', icon: '🎬', enabled: true, isCore: true },
  { id: 'audio-tools', name: 'Audio Tools', description: 'Convert, edit, and process audio files', icon: '🎵', enabled: true, isCore: true },
  { id: 'social-media', name: 'Social Media', description: 'Create posts, schedule content, generate captions', icon: '📱', enabled: true, isCore: true },
  { id: 'branding', name: 'Brand Identity', description: 'Create brand guidelines, color palettes, typography', icon: '🎨', enabled: true, isCore: true },

  // ── System & Security ──
  { id: 'network', name: 'Network Setup', description: 'Configure WiFi, firewall, and networking', icon: '📡', enabled: true, isCore: true },
  { id: 'security', name: 'Security Check', description: 'Scan and harden your system security', icon: '🛡️', enabled: true, isCore: true },
  { id: 'backup', name: 'Backup & Restore', description: 'Create backups and restore points', icon: '💾', enabled: true, isCore: true },
  { id: 'privacy-audit', name: 'Privacy Audit', description: 'Check data exposure, remove traces, harden privacy', icon: '🔒', enabled: true, isCore: true },
  { id: 'malware-scan', name: 'Malware Scan', description: 'Deep scan for malware, spyware, and suspicious processes', icon: '🦠', enabled: true, isCore: true },

  // ── Automation & Power Tools ──
  { id: 'desktop-control', name: 'Desktop Control', description: 'Control mouse, keyboard, and automate clicks', icon: '🖱️', enabled: true, isCore: true },
  { id: 'browser', name: 'Browser Automation', description: 'Browse, scrape, and fill web forms automatically', icon: '🌍', enabled: true, isCore: true },
  { id: 'workflow-auto', name: 'Workflow Automation', description: 'Automate repetitive tasks with scripts and macros', icon: '🔁', enabled: true, isCore: true },
  { id: 'batch-ops', name: 'Batch Operations', description: 'Rename, convert, resize hundreds of files at once', icon: '⚡', enabled: true, isCore: true },
  { id: 'scheduled-tasks', name: 'Scheduled Tasks', description: 'Set up cron jobs, reminders, and automated schedules', icon: '⏰', enabled: true, isCore: true },
  { id: 'web-scraping', name: 'Web Scraping', description: 'Extract data from websites, download content, monitor pages', icon: '🕷️', enabled: true, isCore: true },

  // ── Developer & IT ──
  { id: 'ai-setup', name: 'AI Agent Setup', description: 'Configure Claude, Copilot, Cursor, and more', icon: '🤖', enabled: true, isCore: true },
  { id: 'local-llm', name: 'Local LLM Setup', description: 'Install and run AI models on your computer', icon: '🧠', enabled: true, isCore: true },
  { id: 'dev-env', name: 'Development Setup', description: 'Set up Python, Node, Docker, and dev tools', icon: '💻', enabled: true, isCore: true },
  { id: 'database-mgmt', name: 'Database Management', description: 'Set up, query, backup PostgreSQL, MySQL, SQLite', icon: '🗄️', enabled: true, isCore: true },
  { id: 'api-testing', name: 'API Testing', description: 'Test REST APIs, generate docs, debug endpoints', icon: '🔌', enabled: true, isCore: true },
  { id: 'git-ops', name: 'Git & Version Control', description: 'Clone repos, manage branches, resolve conflicts, deploy', icon: '🌿', enabled: true, isCore: true },
  { id: 'server-setup', name: 'Server Setup', description: 'Configure Nginx, Docker, SSH, SSL certificates', icon: '🖥️', enabled: true, isCore: true },
  { id: 'ci-cd', name: 'CI/CD Pipelines', description: 'Set up GitHub Actions, automated testing, deployments', icon: '🚀', enabled: true, isCore: true },

  // ── Education & Learning ──
  { id: 'study-aid', name: 'Study Assistant', description: 'Create flashcards, summaries, practice questions', icon: '📚', enabled: true, isCore: true },
  { id: 'code-tutor', name: 'Code Tutor', description: 'Learn programming with hands-on exercises and explanations', icon: '🎓', enabled: true, isCore: true },
  { id: 'language-learn', name: 'Language Learning', description: 'Practice conversations, vocabulary, grammar in any language', icon: '🗣️', enabled: true, isCore: true },
]

function App() {
  // ── State ────────────────────────────────────────────
  const [appState, setAppState] = useState<AppState>('onboarding')
  const [darkMode, setDarkMode] = useState(true)
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
  const oauthPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

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
  const [allTransactions, setAllTransactions] = useState<any[]>([])
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [deleteThreadConfirm, setDeleteThreadConfirm] = useState<string | null>(null)
  const [agentStatus, setAgentStatus] = useState<'idle' | 'thinking' | 'executing' | 'typing'>('idle')
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [version, setVersion] = useState('')
  const [showSlashPalette, setShowSlashPalette] = useState(false)
  const [slashFilter, setSlashFilter] = useState('')
  const [copiedCodeIdx, setCopiedCodeIdx] = useState<number | null>(null)
  const [isRecording, setIsRecording] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [sidebarView, setSidebarView] = useState<SidebarView>('chat')
  const [memoryEntries, setMemoryEntries] = useState<MemoryEntry[]>([])
  const [memoryProfile, setMemoryProfile] = useState('')
  const [kanbanCards, setKanbanCards] = useState<KanbanCard[]>([])
  const [schedules, setSchedules] = useState<ScheduledTask[]>([])
  const [gatewayPlatforms, setGatewayPlatforms] = useState<GatewayPlatform[]>([
    { id: 'telegram', name: 'Telegram', icon: '✈️', connected: false },
    { id: 'discord', name: 'Discord', icon: '🎮', connected: false },
    { id: 'slack', name: 'Slack', icon: '💬', connected: false },
    { id: 'whatsapp', name: 'WhatsApp', icon: '📱', connected: false },
    { id: 'email', name: 'Email', icon: '📧', connected: false },
    { id: 'sms', name: 'SMS', icon: '💌', connected: false },
  ])
  const [toolsets, setToolsets] = useState<ToolsetConfig[]>([
    { id: 'terminal', name: 'Terminal', description: 'Execute shell commands', icon: '💻', enabled: true },
    { id: 'browser', name: 'Browser', description: 'Browse and interact with websites', icon: '🌐', enabled: true },
    { id: 'file', name: 'File System', description: 'Read, write, and manage files', icon: '📁', enabled: true },
    { id: 'code', name: 'Code Execution', description: 'Run Python, JS, and other code', icon: '⌨️', enabled: true },
    { id: 'web', name: 'Web Search', description: 'Search the internet for information', icon: '🔍', enabled: true },
    { id: 'vision', name: 'Vision', description: 'Analyze images and screenshots', icon: '👁️', enabled: true },
    { id: 'image_gen', name: 'Image Generation', description: 'Create AI-generated images', icon: '🎨', enabled: true },
    { id: 'tts', name: 'Text-to-Speech', description: 'Convert text to spoken audio', icon: '🔊', enabled: true },
    { id: 'delegation', name: 'Delegation', description: 'Spawn sub-agents for complex tasks', icon: '🤝', enabled: true },
    { id: 'cron', name: 'Scheduling', description: 'Set up recurring automated tasks', icon: '⏰', enabled: true },
    { id: 'memory', name: 'Memory', description: 'Persistent memory across sessions', icon: '🧠', enabled: true },
    { id: 'skills', name: 'Skills', description: 'Procedural knowledge and workflows', icon: '🧩', enabled: true },
  ])
  const [newKanbanTitle, setNewKanbanTitle] = useState('')
  const [newKanbanColumn, setNewKanbanColumn] = useState<KanbanCard['column']>('todo')
  const [newScheduleName, setNewScheduleName] = useState('')
  const [newScheduleCron, setNewScheduleCron] = useState('')
  const [newSchedulePrompt, setNewSchedulePrompt] = useState('')
  const [newMemoryContent, setNewMemoryContent] = useState('')
  const [newMemoryTarget, setNewMemoryTarget] = useState<'memory' | 'user'>('memory')
  const [searchResults, setSearchResults] = useState<{ threadId: string; msgContent: string; snippet: string }[]>([])
  const recognitionRef = useRef<any>(null)
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
    loadMemory()
    loadKanban()
    loadSchedules()
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

  // ── Google OAuth (polling-based for Tauri) ──────────
  const signInGoogle = async () => {
    const session = crypto.randomUUID()
    try {
      await open(`${SAAS_URL}/api/auth/google?session=${session}`)
    } catch {
      // fallback for dev
      window.location.href = `${SAAS_URL}/api/auth/google?session=${session}`
    }
    // Poll for auth completion
    let polls = 0
    const interval = setInterval(async () => {
      polls++
      if (polls >= 60) { clearInterval(interval); return }
      try {
        const res = await fetch(`${SAAS_URL}/api/auth/google?action=poll&session=${session}`)
        const data = await res.json()
        if (data.ok && data.token) {
          clearInterval(interval)
          handleAuthSuccess(data.token, data.user)
        }
      } catch {}
    }, 2000)
    oauthPollRef.current = interval
  }

  // ── GitHub OAuth (polling-based for Tauri) ──────────
  const signInGitHub = async () => {
    const session = crypto.randomUUID()
    try {
      await open(`${SAAS_URL}/api/auth/github?session=${session}`)
    } catch {
      window.location.href = `${SAAS_URL}/api/auth/github?session=${session}`
    }
    let polls = 0
    const interval = setInterval(async () => {
      polls++
      if (polls >= 60) { clearInterval(interval); return }
      try {
        const res = await fetch(`${SAAS_URL}/api/auth/github?action=poll&session=${session}`)
        const data = await res.json()
        if (data.ok && data.token) {
          clearInterval(interval)
          handleAuthSuccess(data.token, data.user)
        }
      } catch {}
    }, 2000)
    oauthPollRef.current = interval
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

  // ── Memory persistence ──
  const loadMemory = () => {
    try {
      const entries = localStorage.getItem('tb_memory_entries')
      if (entries) setMemoryEntries(JSON.parse(entries))
      const profile = localStorage.getItem('tb_memory_profile')
      if (profile) setMemoryProfile(profile)
    } catch {}
  }
  const saveMemory = (entries: MemoryEntry[]) => {
    setMemoryEntries(entries)
    localStorage.setItem('tb_memory_entries', JSON.stringify(entries))
  }

  // ── Kanban persistence ──
  const loadKanban = () => {
    try {
      const saved = localStorage.getItem('tb_kanban_cards')
      if (saved) setKanbanCards(JSON.parse(saved))
    } catch {}
  }
  const saveKanban = (cards: KanbanCard[]) => {
    setKanbanCards(cards)
    localStorage.setItem('tb_kanban_cards', JSON.stringify(cards))
  }

  // ── Schedules persistence ──
  const loadSchedules = () => {
    try {
      const saved = localStorage.getItem('tb_schedules')
      if (saved) setSchedules(JSON.parse(saved))
    } catch {}
  }
  const saveSchedules = (s: ScheduledTask[]) => {
    setSchedules(s)
    localStorage.setItem('tb_schedules', JSON.stringify(s))
  }

  // ── Thread helpers ───────────────────────────────────
  const activeThread = threads.find(t => t.id === activeThreadId)
  const filteredThreads = threads.filter(t => {
    const q = searchQuery.toLowerCase()
    if (t.title.toLowerCase().includes(q)) return true
    return t.messages.some(m => m.content.toLowerCase().includes(q))
  }).sort((a, b) => b.updatedAt - a.updatedAt)

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
    let lastEventTime = Date.now()
    let unlistenFn: (() => void) | null = null

    // Safety timeout: if no events for 60s, kill the stream
    const safetyTimer = setInterval(() => {
      const elapsed = Date.now() - lastEventTime
      if (elapsed > 60000) {
        clearInterval(safetyTimer)
        if (!fullContent) {
          fullContent = '⚠️ No response received. The AI service may be temporarily unavailable. Please try again.'
        }
        updateMsg()
        setIsStreaming(false)
        setAgentStatus('idle')
        try { unlistenFn?.() } catch {}
      }
    }, 5000)

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
    const unlistenPromise = listen<string>('agent-event', (event) => {
      lastEventTime = Date.now()
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
            // Check if this is a rate limit / payment error — show popup, not raw text
            const errText = data.content || ''
            if (errText.includes('No credits remaining') || errText.includes('rateLimited') || errText.includes('402') || errText.includes('Payment Required') || errText.includes('insufficient credits')) {
              setShowRateLimitPopup(true)
              setIsStreaming(false)
              setAgentStatus('idle')
              clearInterval(safetyTimer)
              if (unlistenFn) unlistenFn()
              return
            }
            fullContent += `\n\n⚠️ ${errText}`
            updateMsg()
            break
          case 'done':
            setIsStreaming(false)
            setAgentStatus('idle')
            clearInterval(safetyTimer)
            if (unlistenFn) unlistenFn()
            break
          case 'status':
            break
        }
      } catch {
        // skip malformed events
      }
    })
    unlistenPromise.then(fn => { unlistenFn = fn })

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
      clearInterval(safetyTimer)
      ;(unlistenFn as (() => void) | null)?.()
    } finally {
      // Note: invoke('send_message') returns instantly (just writes to stdin).
      // The listener stays active until a 'done' event fires from the agent.
      // We only reset streaming here as a safety net if invoke itself throws.
      // Do NOT call unlistenFn() here — it would kill the listener before events arrive.
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      // Check if slash palette is open - select first match
      if (showSlashPalette) {
        const filtered = SLASH_COMMANDS.filter(c => c.cmd.includes(slashFilter) || c.label.toLowerCase().includes(slashFilter.toLowerCase()))
        if (filtered.length > 0) {
          executeSlashCommand(filtered[0].cmd)
          return
        }
      }
      handleSend()
    }
    if (e.key === 'Escape' && showSlashPalette) {
      setShowSlashPalette(false)
      setSlashFilter('')
    }
  }

  // ── Slash Command Logic ──────────────────────────────
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setInput(val)
    // Show slash palette when input starts with /
    if (val.startsWith('/')) {
      setShowSlashPalette(true)
      setSlashFilter(val)
    } else {
      setShowSlashPalette(false)
      setSlashFilter('')
    }
  }

  const executeSlashCommand = (cmd: string) => {
    setShowSlashPalette(false)
    setSlashFilter('')
    setInput('')

    switch (cmd) {
      case '/new':
        setActiveThreadId(null)
        setInput('')
        break
      case '/clear':
        if (activeThread) {
          setThreads(prev => prev.map(t =>
            t.id === activeThread.id ? { ...t, messages: [] } : t
          ))
          localStorage.setItem('tb_threads', JSON.stringify(
            threads.map(t => t.id === activeThread.id ? { ...t, messages: [] } : t)
          ))
        }
        break
      case '/help': {
        const helpContent = `## Available Commands\n\n${SLASH_COMMANDS.map(c => `**${c.cmd}** — ${c.description}`).join('\n')}\n\n---\n\n**Tip:** Type \`/\` in the input to see all commands with autocomplete.`
        const threadId = activeThread?.id || createThread('Help').id
        const sysMsg: Message = { id: crypto.randomUUID(), role: 'assistant', content: helpContent, timestamp: Date.now() }
        addMessage(threadId, sysMsg)
        break
      }
      case '/status': {
        const statusContent = `## System Status\n\n- **Agent:** ${agentStatus === 'idle' ? '✅ Ready' : '⏳ ' + agentStatus}\n- **Threads:** ${threads.length}\n- **Skills:** ${skills.filter(s => s.enabled).length} enabled\n- **Credits:** ${billingStatus?.credits?.balance?.toLocaleString() || '—'}\n- **Version:** v${version}`
        const threadId2 = activeThread?.id || createThread('Status').id
        const sysMsg2: Message = { id: crypto.randomUUID(), role: 'assistant', content: statusContent, timestamp: Date.now() }
        addMessage(threadId2, sysMsg2)
        break
      }
      case '/skills': {
        const enabledSkills = skills.filter(s => s.enabled)
        const skillsContent = `## Enabled Skills (${enabledSkills.length})\n\n${enabledSkills.map(s => `- ${s.icon} **${s.name}** — ${s.description}`).join('\n')}`
        const threadId3 = activeThread?.id || createThread('Skills').id
        const sysMsg3: Message = { id: crypto.randomUUID(), role: 'assistant', content: skillsContent, timestamp: Date.now() }
        addMessage(threadId3, sysMsg3)
        break
      }
      default:
        // For /web, /image, /shell, /code, /compact — send as message to agent
        setInput(cmd + ' ')
        setTimeout(() => inputRef.current?.focus(), 50)
        break
    }
  }

  // ── Voice Input (Web Speech API) ─────────────────────
  const startRecording = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SpeechRecognition) {
      alert('Voice input not supported in this browser')
      return
    }
    const recognition = new SpeechRecognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-US'

    recognition.onresult = (event: any) => {
      let transcript = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript
      }
      setInput(prev => prev ? prev + ' ' + transcript : transcript)
    }

    recognition.onerror = () => {
      setIsRecording(false)
    }

    recognition.onend = () => {
      setIsRecording(false)
    }

    recognition.start()
    recognitionRef.current = recognition
    setIsRecording(true)
  }

  const stopRecording = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop()
      recognitionRef.current = null
    }
    setIsRecording(false)
  }

  // ── Drag & Drop ──────────────────────────────────────
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) {
      setUploadedFiles(prev => [...prev, ...files])
    }
  }

  // ── Enhanced Search (searches message content) ───────
  const handleSearchChange = (query: string) => {
    setSearchQuery(query)
    if (!query.trim()) {
      setSearchResults([])
      return
    }
    const q = query.toLowerCase()
    const results: { threadId: string; msgContent: string; snippet: string }[] = []
    for (const thread of threads) {
      for (const msg of thread.messages) {
        if (msg.content.toLowerCase().includes(q)) {
          const idx = msg.content.toLowerCase().indexOf(q)
          const start = Math.max(0, idx - 40)
          const end = Math.min(msg.content.length, idx + query.length + 40)
          const snippet = (start > 0 ? '...' : '') + msg.content.slice(start, end) + (end < msg.content.length ? '...' : '')
          results.push({ threadId: thread.id, msgContent: msg.content, snippet })
          if (results.length >= 20) break
        }
      }
      if (results.length >= 20) break
    }
    setSearchResults(results)
  }

  // ── MCP ──

  // ── Billing API calls ────────────────────────────────
  const authHeaders = (): HeadersInit => ({
    'Content-Type': 'application/json',
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
  })

  const fetchBillingStatus = async () => {
    try {
      const res = await fetch(`${SAAS_URL}/api/billing?action=status`, { headers: authHeaders() })
      const data = await res.json()
      if (data.ok) {
        setBillingStatus(data)
        if (data.transactions) setAllTransactions(data.transactions)
      }
    } catch { /* ignore */ }
  }

  const downloadPaymentHistory = () => {
    if (!allTransactions.length) return
    const headers = ['Date', 'Type', 'Credits', 'Amount (USD)', 'Status']
    const rows = allTransactions.map(t => [
      new Date(t.created_at).toLocaleDateString(),
      t.type || 'purchase',
      t.credits || 0,
      t.amount_usd || '',
      t.status || 'pending',
    ])
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `taskbolt-payment-history-${new Date().toISOString().slice(0,10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
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

  // ── Code Block Component with syntax highlighting + copy ──
  const CodeBlock = ({ code, lang, blockIdx }: { code: string; lang: string; blockIdx: number }) => {
    const [copied, setCopied] = useState(false)
    const highlighted = useMemo(() => {
      if (lang && hljs.getLanguage(lang)) {
        try { return hljs.highlight(code, { language: lang }).value } catch {}
      }
      try { return hljs.highlightAuto(code).value } catch {}
      return code
    }, [code, lang])

    const handleCopy = () => {
      navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }

    return (
      <div className="code-block-wrapper">
        <div className="code-block-header">
          <span className="code-block-lang">{lang || 'code'}</span>
          <button className={`code-copy-btn ${copied ? 'copied' : ''}`} onClick={handleCopy}>
            {copied ? (
              <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied</>
            ) : (
              <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy</>
            )}
          </button>
        </div>
        <pre className="md-code-block hljs"><code dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
      </div>
    )
  }

  // ── Markdown renderer with syntax highlighting ──
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

  const renderMarkdown = (text: string, isStreamingMsg = false) => {
    const parts: React.ReactNode[] = []
    const lines = text.split('\n')
    let inCodeBlock = false
    let codeBlockContent = ''
    let codeBlockLang = ''
    let codeBlockIdx = 0
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
          parts.push(<CodeBlock key={`cb-${codeBlockIdx}`} code={codeBlockContent} lang={codeBlockLang} blockIdx={codeBlockIdx} />)
          codeBlockIdx++
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
      // Checkbox (must come before list items)
      else if (line.match(/^[\-\*] \[[ x]\] /)) {
        const checked = line.match(/\[x\]/)
        const text = line.replace(/^[\-\*] \[[ x]\] /, '')
        parts.push(<div key={i} className="md-li md-checkbox"><span className={`checkbox-icon ${checked ? 'checked' : ''}`}>{checked ? '✓' : ''}</span> {renderInline(text)}</div>)
      }
      // List items
      else if (line.match(/^[\-\*] /)) {
        parts.push(<div key={i} className="md-li"><span className="md-bullet">•</span>{renderInline(line.slice(2))}</div>)
      } else if (line.match(/^\d+\. /)) {
        const num = line.match(/^(\d+)\./)?.[1]
        parts.push(<div key={i} className="md-li md-ol"><span className="md-num">{num}.</span>{renderInline(line.replace(/^\d+\. /, ''))}</div>)
      }
      // Empty line
      else if (line.trim() === '') {
        parts.push(<div key={i} className="md-br" />)
      }
      // Regular text
      else {
        parts.push(<p key={i} className="md-p">{renderInline(line)}</p>)
      }
    })

    flushTable()

    // Unclosed code block (still streaming)
    if (inCodeBlock && codeBlockContent) {
      parts.push(<CodeBlock key={`cb-${codeBlockIdx}`} code={codeBlockContent} lang={codeBlockLang} blockIdx={codeBlockIdx} />)
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
            <div className="logo-bolt"><LogoSvg size={96} animated /></div>
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
              <div className="logo-bolt"><LogoSvg size={96} animated /></div>
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

                {/* Payment History */}
                <div className="payment-history-section">
                  <div className="section-header-row">
                    <h3 style={{ marginTop: '1.5rem' }}>Payment History</h3>
                    {allTransactions.length > 0 && (
                      <button className="btn-secondary btn-download" onClick={downloadPaymentHistory}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                        Download CSV
                      </button>
                    )}
                  </div>
                  {allTransactions.length === 0 ? (
                    <p className="setting-desc" style={{ marginTop: '0.5rem' }}>No transactions yet.</p>
                  ) : (
                    <div className="transaction-list">
                      {allTransactions.map((tx, i) => (
                        <div key={i} className={`transaction-row tx-${tx.status}`}>
                          <div className="tx-info">
                            <span className="tx-type">{tx.type === 'purchase' ? '💳 Purchase' : tx.type === 'admin_credit' ? '🎁 Credit' : tx.type || 'Transaction'}</span>
                            <span className="tx-date">{new Date(tx.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                          </div>
                          <div className="tx-details">
                            <span className="tx-credits">+{tx.credits?.toLocaleString() || 0} credits</span>
                            {tx.amount_usd && <span className="tx-amount">${tx.amount_usd}</span>}
                            <span className={`tx-status-badge tx-status-${tx.status}`}>{tx.status}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
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
                <LogoSvg size={28} animated />
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

        {/* ── Navigation Icons (Hermes-style) ── */}
        <div className="sidebar-nav">
          {([
            { view: 'chat' as SidebarView, icon: '💬', label: 'Chat' },
            { view: 'sessions' as SidebarView, icon: '📋', label: 'Sessions' },
            { view: 'memory' as SidebarView, icon: '🧠', label: 'Memory' },
            { view: 'tools' as SidebarView, icon: '🔧', label: 'Tools' },
            { view: 'schedules' as SidebarView, icon: '⏰', label: 'Schedules' },
            { view: 'gateway' as SidebarView, icon: '📡', label: 'Gateway' },
            { view: 'kanban' as SidebarView, icon: '📊', label: 'Task Board' },
          ]).map(item => (
            <button
              key={item.view}
              className={`sidebar-nav-item ${sidebarView === item.view ? 'active' : ''}`}
              onClick={() => setSidebarView(item.view)}
              title={sidebarOpen ? '' : item.label}
            >
              <span className="nav-icon">{item.icon}</span>
              {sidebarOpen && <span className="nav-label">{item.label}</span>}
            </button>
          ))}
        </div>

        {/* ── Chat-specific sidebar content ── */}
        {sidebarView === 'chat' && (
          <>
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
                    placeholder="Search tasks & messages..."
                    value={searchQuery}
                    onChange={e => handleSearchChange(e.target.value)}
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
          </>
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
      <div className={`main-content ${dragOver ? 'drag-over' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drag overlay */}
        {dragOver && (
          <div className="drag-overlay">
            <div className="drag-overlay-content">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              <span>Drop files here</span>
            </div>
          </div>
        )}
        {/* ── Screen Router ── */}
        {sidebarView === 'chat' && (
        <>
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
            <div className="empty-logo"><LogoSvg size={72} animated /></div>
            <h2>What can I help you with?</h2>
            <p className="empty-subtitle">From fixing your computer to writing reports — I handle it all.</p>
            <div className="skill-suggestions">
              {skills.filter(s => s.enabled && s.isCore).slice(0, 16).map(skill => (
                <button key={skill.id} className="skill-chip" onClick={() => { if (isLoggedIn) setInput(skill.name); else setAppState('signin') }}>
                  <span className="chip-icon">{skill.icon}</span>
                  {skill.name}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="messages-container">
            {activeThread.messages.map((msg, idx) => {
              const isLastMsg = idx === activeThread.messages.length - 1
              const isStreamingThis = isStreaming && isLastMsg && msg.role === 'assistant'
              return (
              <div key={msg.id || idx} className={`msg msg-${msg.role}`}>
                {msg.role === 'assistant' && (
                  <div className="msg-avatar">
                    <LogoSvg size={36} animated status={isStreamingThis ? agentStatus : 'idle'} className="ai-avatar" />
                  </div>
                )}
                <div className="msg-body">
                  {/* Status indicator while empty and streaming */}
                  {msg.role === 'assistant' && isStreamingThis && !msg.content && !msg.toolCalls?.length && (
                    <div className="agent-status-indicator">
                      {agentStatus === 'thinking' && (
                        <div className="status-pill thinking-pill">
                          <span className="status-dot thinking" />
                          <span>Thinking</span>
                          <span className="status-dots-anim">...</span>
                        </div>
                      )}
                      {agentStatus === 'executing' && (
                        <div className="status-pill executing-pill">
                          <span className="status-dot executing" />
                          <span>Executing</span>
                          <span className="exec-bar-wrap"><span className="exec-bar-fill" /></span>
                        </div>
                      )}
                      {(agentStatus === 'typing' || agentStatus === 'idle') && (
                        <div className="typing-indicator">
                          <div className="typing-bar"><span /><span /><span /></div>
                        </div>
                      )}
                    </div>
                  )}
                  {/* Thinking / Reasoning block */}
                  {msg.thinking && (
                    <details className="thinking-block">
                      <summary>
                        <IconChevronRight size={12} />
                        <span className="thinking-label">Reasoning</span>
                      </summary>
                      <pre className="thinking-content">{msg.thinking}</pre>
                    </details>
                  )}
                  {/* Tool calls with progress */}
                  {msg.toolCalls && msg.toolCalls.length > 0 && (
                    <div className="tool-calls">
                      {msg.toolCalls.map((tc, i) => (
                        <div key={i} className={`tool-call-card ${tc.result === undefined ? 'tool-running' : 'tool-done'}`}>
                          <div className="tool-call-header" onClick={(e) => {
                            const details = (e.currentTarget.parentElement as HTMLElement)?.querySelector('.tool-call-detail') as HTMLElement
                            if (details) details.style.display = details.style.display === 'none' ? 'block' : 'none'
                          }}>
                            <span className="tool-call-status-icon">
                              {tc.result === undefined ? <span className="tc-spinner" /> : <span className="tc-check">✓</span>}
                            </span>
                            <span className="tool-call-name">{tc.name}</span>
                            <span className={`tool-call-badge ${tc.result === undefined ? 'badge-running' : 'badge-done'}`}>
                              {tc.result === undefined ? 'running' : 'done'}
                            </span>
                          </div>
                          <div className="tool-call-detail" style={{ display: 'none' }}>
                            <div className="tool-call-section">
                              <span className="tool-call-label">Input</span>
                              <pre className="tool-pre">{JSON.stringify(tc.args, null, 2)}</pre>
                            </div>
                            {tc.result !== undefined && (
                              <div className="tool-call-section">
                                <span className="tool-call-label">Output</span>
                                <pre className="tool-pre">{tc.result.slice(0, 3000)}{tc.result.length > 3000 ? '\n...' : ''}</pre>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Message content */}
                  {msg.content && (
                    <div className="msg-text">
                      {renderMarkdown(msg.content)}
                      {isStreamingThis && <span className="streaming-cursor" />}
                    </div>
                  )}
                </div>
              </div>
              )
            })}
            {isStreaming && activeThread.messages[activeThread.messages.length - 1]?.role === 'user' && (
              <div className="msg msg-assistant">
                <div className="msg-avatar">
                  <LogoSvg size={36} animated status={agentStatus} className="ai-avatar" />
                </div>
                <div className="msg-body">
                  <div className="agent-status-indicator">
                    {agentStatus === 'thinking' && (
                      <div className="status-pill thinking-pill">
                        <span className="status-dot thinking" />
                        <span>Thinking</span>
                        <span className="status-dots-anim">...</span>
                      </div>
                    )}
                    {agentStatus === 'executing' && (
                      <div className="status-pill executing-pill">
                        <span className="status-dot executing" />
                        <span>Executing</span>
                        <span className="exec-bar-wrap"><span className="exec-bar-fill" /></span>
                      </div>
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

          {/* Slash Command Palette */}
          {showSlashPalette && (
            <div className="slash-palette">
              {SLASH_COMMANDS
                .filter(c => c.cmd.includes(slashFilter) || c.label.toLowerCase().includes(slashFilter.toLowerCase()))
                .slice(0, 6)
                .map(cmd => (
                  <button key={cmd.cmd} className="slash-palette-item" onClick={() => executeSlashCommand(cmd.cmd)}>
                    <span className="slash-icon">{cmd.icon}</span>
                    <span className="slash-cmd">{cmd.cmd}</span>
                    <span className="slash-desc">{cmd.description}</span>
                  </button>
                ))}
              {SLASH_COMMANDS.filter(c => c.cmd.includes(slashFilter)).length === 0 && (
                <div className="slash-palette-empty">No matching commands. Send as message?</div>
              )}
            </div>
          )}

          <div className="input-wrapper">
            <button className="upload-btn" onClick={() => fileInputRef.current?.click()} title="Attach files">
              <IconPlus size={18} />
            </button>
            <input ref={fileInputRef} type="file" multiple hidden onChange={handleFileUpload} />
            <button
              className={`voice-btn ${isRecording ? 'recording' : ''}`}
              onClick={() => isRecording ? stopRecording() : startRecording()}
              title={isRecording ? 'Stop recording' : 'Voice input'}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>
                <path d="M19 10v2a7 7 0 01-14 0v-2"/>
                <line x1="12" y1="19" x2="12" y2="23"/>
                <line x1="8" y1="23" x2="16" y2="23"/>
              </svg>
              {isRecording && <span className="voice-recording-dot" />}
            </button>
            <textarea
              ref={inputRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder={!isLoggedIn ? 'Sign in to start chatting...' : 'Ask me anything — or type / for commands...'}
              rows={1}
              className="main-input"
            />
            {isStreaming ? (
              <button
                className="stop-btn"
                onClick={() => {
                  setIsStreaming(false)
                  setAgentStatus('idle')
                  invoke('cancel_message').catch(() => {})
                }}
                title="Stop generating"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="1" y="1" width="12" height="12" rx="2" /></svg>
              </button>
            ) : (
              <button
                className={`send-btn ${input.trim() && isLoggedIn ? 'active' : ''}`}
                onClick={handleSend}
                disabled={!input.trim() || !isLoggedIn}
              >
                <IconSend size={16} />
              </button>
            )}
          </div>
          <p className="input-hint">TaskBolt uses AI to set up and configure your computer</p>
        </div>
        </>
        )}

        {/* ── Sessions Screen ── */}
        {sidebarView === 'sessions' && (
          <div className="screen-view">
            <div className="screen-header">
              <h2>📋 Sessions</h2>
              <span className="screen-count">{threads.length} conversations</span>
            </div>
            <div className="screen-body">
              {threads.length === 0 ? (
                <div className="screen-empty">
                  <span>No conversations yet</span>
                  <p>Start chatting to create sessions</p>
                </div>
              ) : (
                <div className="sessions-list">
                  {threads.sort((a, b) => b.updatedAt - a.updatedAt).map(t => (
                    <div key={t.id} className="session-card" onClick={() => { setSidebarView('chat'); setActiveThreadId(t.id) }}>
                      <div className="session-card-header">
                        <span className="session-title">{t.title}</span>
                        <span className="session-date">{new Date(t.updatedAt).toLocaleDateString()}</span>
                      </div>
                      <div className="session-meta">
                        <span className="session-msg-count">{t.messages.length} messages</span>
                        {t.messages.length > 0 && (
                          <span className="session-preview">{t.messages[t.messages.length - 1].content.slice(0, 80)}...</span>
                        )}
                      </div>
                      <button className="session-delete-btn" onClick={e => { e.stopPropagation(); deleteThread(t.id) }}>
                        <IconX size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Memory Screen ── */}
        {sidebarView === 'memory' && (
          <div className="screen-view">
            <div className="screen-header">
              <h2>🧠 Memory</h2>
              <span className="screen-count">{memoryEntries.length} entries</span>
            </div>
            <div className="screen-body">
              <div className="memory-profile-section">
                <h3>User Profile</h3>
                <textarea
                  className="memory-profile-input"
                  placeholder="Who is the user? Name, role, preferences, habits..."
                  value={memoryProfile}
                  onChange={e => { setMemoryProfile(e.target.value); localStorage.setItem('tb_memory_profile', e.target.value) }}
                  rows={4}
                />
                <div className="memory-profile-stats">
                  <span>{memoryProfile.length} / 1,375 chars</span>
                  <div className="memory-bar">
                    <div className="memory-bar-fill" style={{ width: `${Math.min(100, (memoryProfile.length / 1375) * 100)}%` }} />
                  </div>
                </div>
              </div>

              <h3>Memory Entries</h3>
              <div className="memory-add-form">
                <select value={newMemoryTarget} onChange={e => setNewMemoryTarget(e.target.value as 'memory' | 'user')} className="memory-target-select">
                  <option value="memory">Notes</option>
                  <option value="user">User</option>
                </select>
                <textarea
                  className="memory-input"
                  placeholder="Add a memory entry..."
                  value={newMemoryContent}
                  onChange={e => setNewMemoryContent(e.target.value)}
                  rows={2}
                />
                <button className="btn-primary btn-sm" onClick={() => {
                  if (!newMemoryContent.trim()) return
                  const entry: MemoryEntry = { id: crypto.randomUUID(), target: newMemoryTarget, content: newMemoryContent.trim(), createdAt: Date.now() }
                  saveMemory([entry, ...memoryEntries])
                  setNewMemoryContent('')
                }}>Add</button>
              </div>

              <div className="memory-entries">
                {memoryEntries.map(entry => (
                  <div key={entry.id} className={`memory-entry memory-${entry.target}`}>
                    <div className="memory-entry-header">
                      <span className={`memory-tag ${entry.target}`}>{entry.target === 'user' ? 'User' : 'Notes'}</span>
                      <span className="memory-date">{new Date(entry.createdAt).toLocaleDateString()}</span>
                      <button className="memory-remove-btn" onClick={() => saveMemory(memoryEntries.filter(e => e.id !== entry.id))}>
                        <IconX size={10} />
                      </button>
                    </div>
                    <p className="memory-entry-content">{entry.content}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Tools Screen ── */}
        {sidebarView === 'tools' && (
          <div className="screen-view">
            <div className="screen-header">
              <h2>🔧 Tools</h2>
              <span className="screen-count">{toolsets.filter(t => t.enabled).length} / {toolsets.length} enabled</span>
            </div>
            <div className="screen-body">
              <p className="screen-desc">Enable or disable AI capabilities</p>
              <div className="tools-grid">
                {toolsets.map(tool => (
                  <div key={tool.id} className={`tool-card ${tool.enabled ? 'tool-enabled' : 'tool-disabled'}`}>
                    <div className="tool-card-header">
                      <span className="tool-card-icon">{tool.icon}</span>
                      <span className="tool-card-name">{tool.name}</span>
                    </div>
                    <p className="tool-card-desc">{tool.description}</p>
                    <label className="toggle">
                      <input type="checkbox" checked={tool.enabled} onChange={e => setToolsets(prev => prev.map(t => t.id === tool.id ? { ...t, enabled: e.target.checked } : t))} />
                      <span className="toggle-slider" />
                    </label>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Schedules Screen ── */}
        {sidebarView === 'schedules' && (
          <div className="screen-view">
            <div className="screen-header">
              <h2>⏰ Schedules</h2>
              <span className="screen-count">{schedules.length} tasks</span>
            </div>
            <div className="screen-body">
              <div className="schedule-add-form">
                <input className="input-field" placeholder="Task name" value={newScheduleName} onChange={e => setNewScheduleName(e.target.value)} />
                <input className="input-field" placeholder="Schedule (e.g. '30m', 'every 2h', '0 9 * * *')" value={newScheduleCron} onChange={e => setNewScheduleCron(e.target.value)} />
                <textarea className="input-field" placeholder="What should the agent do?" value={newSchedulePrompt} onChange={e => setNewSchedulePrompt(e.target.value)} rows={2} />
                <button className="btn-primary btn-sm" onClick={() => {
                  if (!newScheduleName.trim() || !newSchedulePrompt.trim()) return
                  const task: ScheduledTask = { id: crypto.randomUUID(), name: newScheduleName.trim(), schedule: newScheduleCron || 'every 1h', prompt: newSchedulePrompt.trim(), enabled: true }
                  saveSchedules([task, ...schedules])
                  setNewScheduleName(''); setNewScheduleCron(''); setNewSchedulePrompt('')
                }}>Create Schedule</button>
              </div>

              <div className="schedules-list">
                {schedules.map(s => (
                  <div key={s.id} className={`schedule-card ${s.enabled ? '' : 'schedule-disabled'}`}>
                    <div className="schedule-card-header">
                      <span className="schedule-name">{s.name}</span>
                      <span className="schedule-cron">{s.schedule}</span>
                      <label className="toggle">
                        <input type="checkbox" checked={s.enabled} onChange={e => saveSchedules(schedules.map(t => t.id === s.id ? { ...t, enabled: e.target.checked } : t))} />
                        <span className="toggle-slider" />
                      </label>
                      <button className="schedule-delete-btn" onClick={() => saveSchedules(schedules.filter(t => t.id !== s.id))}>
                        <IconX size={12} />
                      </button>
                    </div>
                    <p className="schedule-prompt">{s.prompt}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Gateway Screen ── */}
        {sidebarView === 'gateway' && (
          <div className="screen-view">
            <div className="screen-header">
              <h2>📡 Gateway</h2>
              <span className="screen-count">{gatewayPlatforms.filter(p => p.connected).length} connected</span>
            </div>
            <div className="screen-body">
              <p className="screen-desc">Connect messaging platforms to receive AI responses</p>
              <div className="gateway-grid">
                {gatewayPlatforms.map(p => (
                  <div key={p.id} className={`gateway-card ${p.connected ? 'gateway-connected' : ''}`}>
                    <span className="gateway-icon">{p.icon}</span>
                    <span className="gateway-name">{p.name}</span>
                    <span className={`gateway-status ${p.connected ? 'connected' : 'disconnected'}`}>
                      {p.connected ? '● Connected' : '○ Not connected'}
                    </span>
                    <button className={`btn-secondary btn-sm ${p.connected ? 'btn-disconnect' : ''}`} onClick={() => {
                      setGatewayPlatforms(prev => prev.map(pl => pl.id === p.id ? { ...pl, connected: !pl.connected } : pl))
                    }}>
                      {p.connected ? 'Disconnect' : 'Connect'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Kanban Screen ── */}
        {sidebarView === 'kanban' && (
          <div className="screen-view">
            <div className="screen-header">
              <h2>📊 Task Board</h2>
              <span className="screen-count">{kanbanCards.length} cards</span>
            </div>
            <div className="screen-body">
              <div className="kanban-add-form">
                <input className="input-field" placeholder="Card title" value={newKanbanTitle} onChange={e => setNewKanbanTitle(e.target.value)} />
                <select value={newKanbanColumn} onChange={e => setNewKanbanColumn(e.target.value as KanbanCard['column'])} className="input-field">
                  <option value="todo">To Do</option>
                  <option value="progress">In Progress</option>
                  <option value="done">Done</option>
                  <option value="blocked">Blocked</option>
                </select>
                <button className="btn-primary btn-sm" onClick={() => {
                  if (!newKanbanTitle.trim()) return
                  const card: KanbanCard = { id: crypto.randomUUID(), title: newKanbanTitle.trim(), description: '', column: newKanbanColumn, priority: 'medium', createdAt: Date.now() }
                  saveKanban([card, ...kanbanCards])
                  setNewKanbanTitle('')
                }}>Add Card</button>
              </div>

              <div className="kanban-board">
                {(['todo', 'progress', 'done', 'blocked'] as const).map(col => {
                  const colCards = kanbanCards.filter(c => c.column === col)
                  const colLabel = { todo: 'To Do', progress: 'In Progress', done: 'Done', blocked: 'Blocked' }[col]
                  const colColor = { todo: '#ffa657', progress: '#79c0ff', done: '#4ade80', blocked: '#f87171' }[col]
                  return (
                    <div key={col} className="kanban-column">
                      <div className="kanban-column-header" style={{ borderColor: colColor }}>
                        <span className="kanban-col-title">{colLabel}</span>
                        <span className="kanban-col-count">{colCards.length}</span>
                      </div>
                      <div className="kanban-cards">
                        {colCards.map(card => (
                          <div key={card.id} className="kanban-card" draggable
                            onDragStart={e => e.dataTransfer.setData('cardId', card.id)}
                          >
                            <span className="kanban-card-title">{card.title}</span>
                            <div className="kanban-card-actions">
                              {col !== 'todo' && <button className="kanban-move-btn" onClick={() => {
                                const cols: KanbanCard['column'][] = ['todo', 'progress', 'done', 'blocked']
                                const idx = cols.indexOf(card.column)
                                if (idx > 0) saveKanban(kanbanCards.map(c => c.id === card.id ? { ...c, column: cols[idx - 1] } : c))
                              }}>←</button>}
                              {col !== 'blocked' && <button className="kanban-move-btn" onClick={() => {
                                const cols: KanbanCard['column'][] = ['todo', 'progress', 'done', 'blocked']
                                const idx = cols.indexOf(card.column)
                                if (idx < cols.length - 1) saveKanban(kanbanCards.map(c => c.id === card.id ? { ...c, column: cols[idx + 1] } : c))
                              }}>→</button>}
                              <button className="kanban-del-btn" onClick={() => saveKanban(kanbanCards.filter(c => c.id !== card.id))}>
                                <IconX size={10} />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}
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
            <div className="rate-limit-icon"><LogoSvg size={56} animated /></div>
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
