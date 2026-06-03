import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
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
type SidebarView = 'chat' | 'sessions' | 'memory' | 'tools' | 'schedules' | 'gateway' | 'kanban' | 'skills'

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
type SettingsTab = 'general' | 'account' | 'billing' | 'usage' | 'skills' | 'mcp' | 'feedback' | 'advanced'

// ── SaaS Backend ────────────────────────────────────
const SAAS_URL = 'https://taskbolt.space'

// ── Tool & Skill SVG Icons ────────────────────────────
function renderToolIcon(icon: string): React.ReactNode {
  const s = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const }
  const icons: Record<string, React.ReactNode> = {
    terminal: <svg {...s}><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>,
    browser: <svg {...s}><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>,
    file: <svg {...s}><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>,
    code: <svg {...s}><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>,
    web: <svg {...s}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
    vision: <svg {...s}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
    image: <svg {...s}><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>,
    voice: <svg {...s}><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>,
    delegation: <svg {...s}><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>,
    scheduler: <svg {...s}><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>,
    memory: <svg {...s}><path d="M12 2a10 10 0 0110 10c0 5.52-4.48 10-10 10S2 17.52 2 12"/><path d="M12 6v6l4 2"/></svg>,
    skills: <svg {...s}><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>,
    zap: <svg {...s}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
    download: <svg {...s}><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
    wrench: <svg {...s}><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>,
    rocket: <svg {...s}><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 00-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 012-3.95A12.88 12.88 0 0122 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 01-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>,
    'file-text': <svg {...s}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>,
    search: <svg {...s}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
    refresh: <svg {...s}><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>,
    shield: <svg {...s}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
    bug: <svg {...s}><rect x="8" y="6" width="8" height="14" rx="4"/><path d="M19 12h2"/><path d="M3 12h2"/><path d="M19 8l1.5-1.5"/><path d="M3.5 6.5L5 8"/><path d="M19 16l1.5 1.5"/><path d="M3.5 17.5L5 16"/><path d="M12 6V2"/></svg>,
    git: <svg {...s}><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 009 9"/></svg>,
    api: <svg {...s}><path d="M4 14h6v6H4z"/><path d="M14 4h6v6h-6z"/><path d="M7 14V8a1 1 0 011-1h4"/><path d="M17 10v6a1 1 0 01-1 1h-4"/></svg>,
    database: <svg {...s}><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>,
    container: <svg {...s}><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>,
    pipeline: <svg {...s}><circle cx="5" cy="6" r="2"/><circle cx="12" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/><line x1="5" y1="8" x2="5" y2="16"/><line x1="19" y1="8" x2="19" y2="16"/><path d="M7 6h3"/><path d="M14 6h3"/><path d="M7 18h10"/></svg>,
    youtube: <svg {...s}><path d="M22.54 6.42a2.78 2.78 0 00-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 00-1.94 2A29 29 0 001 11.75a29 29 0 00.46 5.33A2.78 2.78 0 003.4 19.1c1.72.46 8.6.46 8.6.46s6.88 0 8.6-.46a2.78 2.78 0 001.94-2 29 29 0 00.46-5.25 29 29 0 00-.46-5.43z"/><polygon points="9.75 15.02 15.5 11.75 9.75 8.48 9.75 15.02" fill="currentColor" stroke="none"/></svg>,
    script: <svg {...s}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="12" y2="17"/></svg>,
    thumbnail: <svg {...s}><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><polygon points="10 8 10 12 14 10 10 8" fill="currentColor" stroke="none"/></svg>,
    upload: <svg {...s}><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>,
    presentation: <svg {...s}><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>,
    video: <svg {...s}><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>,
    blog: <svg {...s}><path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/></svg>,
    share: <svg {...s}><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>,
    mail: <svg {...s}><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22 6 12 13 2 6"/></svg>,
    table: <svg {...s}><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>,
    translate: <svg {...s}><path d="M5 8l6 6"/><path d="M4 14l6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="M22 22l-5-10-5 10"/><path d="M14 18h6"/></svg>,
    list: <svg {...s}><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>,
    calendar: <svg {...s}><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>,
    notes: <svg {...s}><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
    pdf: <svg {...s}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 15v-2h1.5a1.5 1.5 0 010 3H9z"/></svg>,
    chart: <svg {...s}><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
    'mobile-money': <svg {...s}><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/><path d="M9 8h6"/><path d="M12 8v4"/><circle cx="12" cy="14" r="1.5" fill="currentColor" stroke="none"/></svg>,
    phone: <svg {...s}><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>,
    'globe-africa': <svg {...s}><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 000 20 14.5 14.5 0 000-20"/><path d="M2 12h20"/><path d="M8 4c1 3 1 5 0 8"/><path d="M16 4c-1 3-1 5 0 8"/></svg>,
    building: <svg {...s}><rect x="4" y="2" width="16" height="20" rx="1"/><line x1="9" y1="6" x2="9.01" y2="6"/><line x1="15" y1="6" x2="15.01" y2="6"/><line x1="9" y1="10" x2="9.01" y2="10"/><line x1="15" y1="10" x2="15.01" y2="10"/><line x1="9" y1="14" x2="9.01" y2="14"/><line x1="15" y1="14" x2="15.01" y2="14"/><path d="M10 22v-4h4v4"/></svg>,
    languages: <svg {...s}><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/><path d="M4.93 4.93l4.24 4.24"/><path d="M14.83 14.83l4.24 4.24"/></svg>,
    fintech: <svg {...s}><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/><path d="M7 15h4"/><path d="M15 15h2"/></svg>,
    leaf: <svg {...s}><path d="M11 20A7 7 0 014 13c0-3.5 2-6.5 5-8 1-1 3-2 6-2 0 4-1 6-2 8-1.5 2-3.5 3.5-5 5"/><path d="M2 22l10-10"/></svg>,
    truck: <svg {...s}><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>,
    currency: <svg {...s}><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>,
    tax: <svg {...s}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/><path d="M12 9l-2 2 2 2"/></svg>,
    education: <svg {...s}><path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/></svg>,
    health: <svg {...s}><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>,
    invoice: <svg {...s}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 12h8"/><path d="M8 16h5"/></svg>,
    briefcase: <svg {...s}><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/></svg>,
    calculator: <svg {...s}><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="10" x2="8.01" y2="10"/><line x1="12" y1="10" x2="12.01" y2="10"/><line x1="16" y1="10" x2="16.01" y2="10"/><line x1="8" y1="14" x2="8.01" y2="14"/><line x1="12" y1="14" x2="12.01" y2="14"/><line x1="16" y1="14" x2="16.01" y2="14"/><line x1="8" y1="18" x2="8.01" y2="18"/><line x1="12" y1="18" x2="16" y2="18"/></svg>,
    legal: <svg {...s}><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>,
    people: <svg {...s}><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>,
    network: <svg {...s}><rect x="9" y="2" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="5" y1="16" x2="5" y2="12"/><line x1="19" y1="16" x2="19" y2="12"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
    backup: <svg {...s}><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/><path d="M2 8l4-4 4 4"/></svg>,
    printer: <svg {...s}><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>,
  }
  return icons[icon] || <svg {...s}><circle cx="12" cy="12" r="10"/></svg>
}

// ── Core skills ───────────────────────────────────────
const CORE_SKILLS: Skill[] = [
  // ── Core Essentials ──
  { id: 'general-task', name: 'Help me with anything', description: 'Ask me to do anything on your computer', icon: 'zap', enabled: true, isCore: true },
  { id: 'install', name: 'Install software', description: 'Find and install any application', icon: 'download', enabled: true, isCore: true },
  { id: 'fix', name: 'Fix a problem', description: 'Diagnose and repair system issues', icon: 'wrench', enabled: true, isCore: true },
  { id: 'cleanup', name: 'Speed up my PC', description: 'Clean up and optimize performance', icon: 'rocket', enabled: true, isCore: true },
  { id: 'documents', name: 'Write a document', description: 'Reports, emails, resumes, and more', icon: 'file-text', enabled: true, isCore: true },
  { id: 'research', name: 'Research online', description: 'Find information and summarize it', icon: 'search', enabled: true, isCore: true },
  { id: 'automation', name: 'Automate a task', description: 'Set up recurring workflows', icon: 'refresh', enabled: true, isCore: true },
  { id: 'security', name: 'Check my security', description: 'Scan and protect your system', icon: 'shield', enabled: true, isCore: true },

  // ── Code & Development ──
  { id: 'code-write', name: 'Write code', description: 'Generate code in any programming language', icon: 'code', enabled: true, isCore: false },
  { id: 'code-debug', name: 'Debug code', description: 'Find and fix bugs in your code', icon: 'bug', enabled: true, isCore: false },
  { id: 'git-ops', name: 'Git & GitHub', description: 'Commit, push, pull, create PRs, manage repos', icon: 'git', enabled: true, isCore: false },
  { id: 'web-dev', name: 'Build a website', description: 'Create full websites from scratch', icon: 'browser', enabled: true, isCore: false },
  { id: 'api-dev', name: 'Build an API', description: 'Design and implement REST or GraphQL APIs', icon: 'api', enabled: true, isCore: false },
  { id: 'database', name: 'Database work', description: 'Create, query, and manage databases', icon: 'database', enabled: true, isCore: false },
  { id: 'docker', name: 'Docker & containers', description: 'Build and manage containerized apps', icon: 'container', enabled: true, isCore: false },
  { id: 'devops', name: 'CI/CD pipelines', description: 'Set up automated testing and deployment', icon: 'pipeline', enabled: true, isCore: false },

  // ── Content Creation ──
  { id: 'youtube-full', name: 'YouTube video (full)', description: 'Script, voiceover, visuals, edit, thumbnail — end to end', icon: 'youtube', enabled: true, isCore: false },
  { id: 'youtube-script', name: 'YouTube script', description: 'Write engaging video scripts with hooks and CTAs', icon: 'script', enabled: true, isCore: false },
  { id: 'youtube-thumbnail', name: 'YouTube thumbnail', description: 'Generate click-worthy thumbnail designs', icon: 'thumbnail', enabled: true, isCore: false },
  { id: 'youtube-upload', name: 'Upload to YouTube', description: 'Publish videos with optimized titles, descriptions, tags', icon: 'upload', enabled: true, isCore: false },
  { id: 'voiceover', name: 'AI voiceover', description: 'Generate natural voice narration for any script', icon: 'voice', enabled: true, isCore: false },
  { id: 'presentation', name: 'Create presentation', description: 'Build slide decks with visuals and speaker notes', icon: 'presentation', enabled: true, isCore: false },
  { id: 'image-gen', name: 'Generate images', description: 'Create custom images, graphics, and illustrations', icon: 'image', enabled: true, isCore: false },
  { id: 'video-edit', name: 'Edit video', description: 'Cut, merge, add effects, and export video files', icon: 'video', enabled: true, isCore: false },
  { id: 'blog-post', name: 'Write blog post', description: 'SEO-optimized articles with research and citations', icon: 'blog', enabled: true, isCore: false },
  { id: 'social-media', name: 'Social media content', description: 'Create posts, captions, and hashtags for any platform', icon: 'share', enabled: true, isCore: false },

  // ── Productivity ──
  { id: 'email-draft', name: 'Write emails', description: 'Professional emails for any context', icon: 'mail', enabled: true, isCore: false },
  { id: 'spreadsheet', name: 'Work with spreadsheets', description: 'Create, analyze, and format Excel/CSV files', icon: 'table', enabled: true, isCore: false },
  { id: 'translate', name: 'Translate text', description: 'Translate between 100+ languages', icon: 'translate', enabled: true, isCore: false },
  { id: 'summarize', name: 'Summarize content', description: 'Summarize articles, videos, PDFs, and meetings', icon: 'list', enabled: true, isCore: false },
  { id: 'calendar', name: 'Manage schedule', description: 'Plan your day, set reminders, organize meetings', icon: 'calendar', enabled: true, isCore: false },
  { id: 'notes', name: 'Take notes', description: 'Organize ideas, create outlines, build knowledge base', icon: 'notes', enabled: true, isCore: false },
  { id: 'pdf', name: 'Work with PDFs', description: 'Read, merge, convert, and extract from PDFs', icon: 'pdf', enabled: true, isCore: false },
  { id: 'data-analysis', name: 'Analyze data', description: 'Charts, statistics, insights from any dataset', icon: 'chart', enabled: true, isCore: false },

  // ── Africa & Nigeria Focus ──
  { id: 'mobile-money', name: 'Mobile money setup', description: 'Configure M-Pesa, MoMo, Paga, OPay, and mobile payment integrations', icon: 'mobile-money', enabled: true, isCore: false },
  { id: 'ussd-builder', name: 'USSD app builder', description: 'Build USSD menus and services for feature phone users', icon: 'phone', enabled: true, isCore: false },
  { id: 'africa-market', name: 'Africa market research', description: 'Research markets, competitors, and opportunities across Africa', icon: 'globe-africa', enabled: true, isCore: false },
  { id: 'nigerian-business', name: 'Nigerian business setup', description: 'CAC registration, TIN, tax filing, business permits', icon: 'building', enabled: true, isCore: false },
  { id: 'local-languages', name: 'African languages', description: 'Translate and create content in Yoruba, Hausa, Igbo, Swahili, Amharic, and more', icon: 'languages', enabled: true, isCore: false },
  { id: 'africa-fintech', name: 'Fintech integration', description: 'Set up Paystack, Flutterwave, DPO, Chipper Cash, and other African payment APIs', icon: 'fintech', enabled: true, isCore: false },
  { id: 'agriculture', name: 'Agriculture & farming', description: 'Crop planning, market prices, weather data, and farm management for Africa', icon: 'leaf', enabled: true, isCore: false },
  { id: 'africa-logistics', name: 'Logistics & delivery', description: 'Set up delivery tracking, route planning, GIG, Kobo360, Sendy integrations', icon: 'truck', enabled: true, isCore: false },
  { id: 'naira-calc', name: 'Currency & exchange', description: 'NGN/USD/EUR conversions, black market rates, crypto to naira', icon: 'currency', enabled: true, isCore: false },
  { id: 'jtb-nigeria', name: 'JTB tax filing', description: 'File Nigerian taxes — CIT, VAT, PAYE with JTB compliance', icon: 'tax', enabled: true, isCore: false },
  { id: 'education-africa', name: 'Education content', description: 'Create WAEC, NECO, JAMB, and curriculum-aligned learning materials', icon: 'education', enabled: true, isCore: false },
  { id: 'healthcare-africa', name: 'Healthcare tools', description: 'Drug info, symptom checker, clinic management for African contexts', icon: 'health', enabled: true, isCore: false },

  // ── Business & Finance ──
  { id: 'invoice', name: 'Create invoice', description: 'Generate professional invoices and track payments', icon: 'invoice', enabled: true, isCore: false },
  { id: 'business-plan', name: 'Business plan', description: 'Write complete business plans with financial projections', icon: 'briefcase', enabled: true, isCore: false },
  { id: 'accounting', name: 'Bookkeeping', description: 'Track expenses, categorize transactions, generate reports', icon: 'calculator', enabled: true, isCore: false },
  { id: 'contracts', name: 'Legal documents', description: 'Draft contracts, NDAs, agreements, and terms of service', icon: 'legal', enabled: true, isCore: false },
  { id: 'hr-tools', name: 'HR & payroll', description: 'Employee management, payroll calculation, offer letters', icon: 'people', enabled: true, isCore: false },

  // ── System & Network ──
  { id: 'network-setup', name: 'Network config', description: 'Set up WiFi, VPN, DNS, and network troubleshooting', icon: 'network', enabled: true, isCore: false },
  { id: 'backup', name: 'Backup & restore', description: 'Full system backup, cloud sync, and disaster recovery', icon: 'backup', enabled: true, isCore: false },
  { id: 'print-setup', name: 'Printer setup', description: 'Install and configure printers, scanners, and shared devices', icon: 'printer', enabled: true, isCore: false },
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
  const [feedbackRating, setFeedbackRating] = useState(0)
  const [feedbackText, setFeedbackText] = useState('')
  const [feedbackSent, setFeedbackSent] = useState(false)
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
    { id: 'whatsapp', name: 'WhatsApp', icon: '📱', connected: false },
    { id: 'imessage', name: 'iMessage', icon: '💬', connected: false },
  ])
  const [toolsets, setToolsets] = useState<ToolsetConfig[]>([
    { id: 'terminal', name: 'Terminal', description: 'Run commands and scripts on your computer', icon: 'terminal', enabled: true },
    { id: 'browser', name: 'Browser', description: 'Browse and interact with websites', icon: 'browser', enabled: true },
    { id: 'file', name: 'File Manager', description: 'Read, write, and organize your files', icon: 'file', enabled: true },
    { id: 'code', name: 'Code Runner', description: 'Write and run code in any language', icon: 'code', enabled: true },
    { id: 'web', name: 'Web Search', description: 'Search the internet and summarize results', icon: 'web', enabled: true },
    { id: 'vision', name: 'Vision', description: 'Analyze images and screenshots', icon: 'vision', enabled: true },
    { id: 'image_gen', name: 'Image Creator', description: 'Generate images from descriptions', icon: 'image', enabled: true },
    { id: 'tts', name: 'Voice', description: 'Read text aloud in a natural voice', icon: 'voice', enabled: true },
    { id: 'delegation', name: 'Multi-Agent', description: 'Split complex work across multiple AI workers', icon: 'delegation', enabled: true },
    { id: 'cron', name: 'Scheduler', description: 'Run tasks automatically on a schedule', icon: 'scheduler', enabled: true },
    { id: 'memory', name: 'Memory', description: 'Remember context across conversations', icon: 'memory', enabled: true },
    { id: 'skills', name: 'Skills', description: 'Learn and reuse specialized workflows', icon: 'skills', enabled: true },
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
    // Load real backend data
    loadGateway()
    loadMemoryReal()
    loadSkillsReal()
    loadSchedulesReal()
    loadToolsetsReal()
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

  // ── Gateway (real backend) ──
  const loadGateway = async () => {
    try {
      const platforms = await invoke<GatewayPlatform[]>('get_gateway_config')
      setGatewayPlatforms(platforms)
    } catch (e) {
      console.error('Failed to load gateway:', e)
    }
  }

  const connectPlatform = async (id: string) => {
    let config: Record<string, string> = {}
    if (id === 'telegram') {
      const token = prompt('Enter your Telegram Bot Token:')
      if (!token) return
      config['bot_token'] = token
    } else if (id === 'whatsapp') {
      const number = prompt('Enter WhatsApp number (with country code, e.g. +15551234567):')
      if (!number) return
      config['phone_number'] = number
    } else if (id === 'imessage') {
      config['enabled'] = 'true'
    }

    try {
      await invoke('set_gateway_platform', { platformId: id, config })
      setGatewayPlatforms(prev => prev.map(p => p.id === id ? { ...p, connected: true, config } : p))
    } catch (e) {
      console.error('Failed to connect platform:', e)
      alert(`Failed to connect ${id}: ${e}`)
    }
  }

  const disconnectPlatform = async (id: string) => {
    try {
      await invoke('disconnect_gateway_platform', { platformId: id })
      setGatewayPlatforms(prev => prev.map(p => p.id === id ? { ...p, connected: false } : p))
    } catch (e) {
      console.error('Failed to disconnect platform:', e)
    }
  }

  // ── Memory (real backend) ──
  const loadMemoryReal = async () => {
    try {
      const [entries, profile] = await Promise.all([
        invoke<MemoryEntry[]>('get_memory_entries'),
        invoke<string>('get_user_profile'),
      ])
      setMemoryEntries(entries)
      setMemoryProfile(profile || '')
    } catch (e) {
      console.error('Failed to load memory:', e)
      loadMemory() // fallback to localStorage
    }
  }

  const saveMemoryReal = async (entries: MemoryEntry[]) => {
    setMemoryEntries(entries)
  }

  const addMemoryReal = async (target: string, content: string) => {
    try {
      const id = await invoke<string>('add_memory_entry', { target, content })
      const newEntry: MemoryEntry = { id, target: target as 'memory' | 'user', content, createdAt: Date.now() }
      setMemoryEntries(prev => [newEntry, ...prev])
    } catch (e) {
      console.error('Failed to add memory:', e)
      alert(`Failed to save memory: ${e}`)
    }
  }

  const deleteMemoryReal = async (id: string) => {
    try {
      await invoke('delete_memory_entry', { id })
      setMemoryEntries(prev => prev.filter(e => e.id !== id))
    } catch (e) {
      console.error('Failed to delete memory:', e)
    }
  }

  const saveProfileReal = async (content: string) => {
    setMemoryProfile(content)
    try {
      await invoke('set_user_profile', { content })
    } catch (e) {
      console.error('Failed to save profile:', e)
    }
  }

  // ── Skills (real backend) ──
  const loadSkillsReal = async () => {
    try {
      const realSkills = await invoke<Skill[]>('get_skills')
      if (realSkills.length > 0) {
        // Merge real skills with core skills
        setSkills(prev => {
          const coreIds = new Set(CORE_SKILLS.map(s => s.id))
          const realMapped = realSkills.map(s => ({
            id: s.id,
            name: s.name,
            description: s.description,
            icon: '🧩',
            enabled: s.enabled,
            isCore: false,
          }))
          return [...CORE_SKILLS, ...realMapped.filter(s => !coreIds.has(s.id))]
        })
      }
    } catch (e) {
      console.error('Failed to load skills:', e)
    }
  }

  const toggleSkillReal = async (id: string, enabled: boolean) => {
    setSkills(prev => prev.map(s => s.id === id ? { ...s, enabled } : s))
    try {
      await invoke('toggle_skill', { id, enabled })
    } catch (e) {
      console.error('Failed to toggle skill:', e)
    }
  }

  // ── Schedules (real backend) ──
  const loadSchedulesReal = async () => {
    try {
      const real = await invoke<ScheduledTask[]>('get_schedules')
      if (real.length > 0) {
        setSchedules(real)
      }
    } catch (e) {
      console.error('Failed to load schedules:', e)
    }
  }

  const addScheduleReal = async (name: string, schedule: string, prompt: string) => {
    try {
      const id = await invoke<string>('add_schedule', { name, cron: schedule, prompt })
      const newSchedule: ScheduledTask = { id, name, schedule, prompt, enabled: true }
      setSchedules(prev => [newSchedule, ...prev])
    } catch (e) {
      console.error('Failed to add schedule:', e)
      alert(`Failed to create schedule: ${e}`)
    }
  }

  const toggleScheduleReal = async (id: string, enabled: boolean) => {
    setSchedules(prev => prev.map(s => s.id === id ? { ...s, enabled } : s))
    try {
      await invoke('toggle_schedule', { id, enabled })
    } catch (e) {
      console.error('Failed to toggle schedule:', e)
    }
  }

  const deleteScheduleReal = async (id: string) => {
    try {
      await invoke('delete_schedule', { id })
      setSchedules(prev => prev.filter(s => s.id !== id))
    } catch (e) {
      console.error('Failed to delete schedule:', e)
    }
  }

  // ── Toolsets (real backend) ──
  const loadToolsetsReal = async () => {
    try {
      const enabledIds = await invoke<string[]>('get_toolsets')
      if (enabledIds.length > 0) {
        setToolsets(prev => prev.map(t => ({
          ...t,
          enabled: enabledIds.includes(t.id),
        })))
      }
    } catch (e) {
      console.error('Failed to load toolsets:', e)
    }
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
            <p className="onboarding-subtitle">Your personal AI assistant — ready to help with anything on your computer</p>
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
              {(['general', 'account', 'billing', 'usage', 'skills', 'mcp', 'feedback', 'advanced'] as SettingsTab[]).map(tab => (
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
                    <span className="skill-icon">{renderToolIcon(skill.icon)}</span>
                    <div className="skill-info">
                      <span className="skill-name">{skill.name}</span>
                      <span className="skill-desc">{skill.description}</span>
                    </div>
                    <label className="toggle">
                      <input type="checkbox" checked={skill.enabled} onChange={e => {
                        const enabled = e.target.checked
                        setSkills(prev => prev.map(s => s.id === skill.id ? { ...s, enabled } : s))
                        if (!skill.isCore) {
                          toggleSkillReal(skill.id, enabled)
                        }
                      }} />
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

            {settingsTab === 'feedback' && (
              <div className="settings-section">
                <h3>Feedback</h3>
                <p className="setting-desc">Help us improve TaskBolt by sharing your thoughts</p>
                <div className="feedback-form">
                  <label className="feedback-label">How would you rate TaskBolt?</label>
                  <div className="feedback-rating">
                    {['😞', '😐', '🙂', '😊', '🤩'].map((emoji, i) => (
                      <button key={i} className={`rating-btn ${feedbackRating === i + 1 ? 'active' : ''}`} onClick={() => setFeedbackRating(i + 1)}>
                        {emoji}
                      </button>
                    ))}
                  </div>
                  <label className="feedback-label">What can we improve?</label>
                  <textarea
                    className="feedback-textarea"
                    placeholder="Tell us what you like, what's missing, or what could be better..."
                    value={feedbackText}
                    onChange={e => setFeedbackText(e.target.value)}
                    rows={4}
                  />
                  <button
                    className="btn-primary"
                    onClick={async () => {
                      if (!feedbackText.trim()) return
                      try {
                        await fetch(`${SAAS_URL}/api/feedback`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
                          body: JSON.stringify({ rating: feedbackRating, feedback: feedbackText, version }),
                        })
                        setFeedbackSent(true)
                        setFeedbackText('')
                        setFeedbackRating(0)
                      } catch { /* ignore */ }
                    }}
                    disabled={!feedbackText.trim() || feedbackSent}
                  >
                    {feedbackSent ? '✓ Thanks for your feedback!' : 'Send Feedback'}
                  </button>
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

        {/* ── Navigation Icons ── */}
        <div className="sidebar-nav">
          {([
            { view: 'chat' as SidebarView, icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>, label: 'Chat' },
            { view: 'tools' as SidebarView, icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>, label: 'Capabilities' },
            { view: 'schedules' as SidebarView, icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>, label: 'Automations' },
            { view: 'gateway' as SidebarView, icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>, label: 'Messaging' },
            { view: 'kanban' as SidebarView, icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>, label: 'Task Board' },
            { view: 'skills' as SidebarView, icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>, label: 'Skills' },
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
            <h2>Hi, I'm TaskBolt</h2>
            <p className="empty-subtitle">I'm your personal assistant — I can install software, fix problems, speed up your PC, write documents, research topics, and much more. What can I help you with today?</p>
            <div className="skill-suggestions">
              {skills.filter(s => s.enabled && s.isCore).slice(0, 8).map(skill => (
                <button key={skill.id} className="skill-chip" onClick={() => { if (isLoggedIn) setInput(skill.name); else setAppState('signin') }}>
                  <span className="chip-icon">{renderToolIcon(skill.icon)}</span>
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
              placeholder={!isLoggedIn ? 'Sign in to start chatting...' : 'What would you like me to help you with?'}
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
          <p className="input-hint">Your personal AI assistant — just ask and I'll take care of it</p>
        </div>
        </>
        )}

        {/* ── Sessions Screen ── */}
        {sidebarView === 'sessions' && (
          <div className="screen-view">
            <div className="screen-header">
              <h2>Sessions</h2>
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
              <h2>Memory</h2>
              <span className="screen-count">{memoryEntries.length} entries</span>
            </div>
            <div className="screen-body">
              <div className="memory-profile-section">
                <h3>User Profile</h3>
                <textarea
                  className="memory-profile-input"
                  placeholder="Who is the user? Name, role, preferences, habits..."
                  value={memoryProfile}
                  onChange={e => saveProfileReal(e.target.value)}
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
                  addMemoryReal(newMemoryTarget, newMemoryContent.trim())
                  setNewMemoryContent('')
                }}>Add</button>
              </div>

              <div className="memory-entries">
                {memoryEntries.map(entry => (
                  <div key={entry.id} className={`memory-entry memory-${entry.target}`}>
                    <div className="memory-entry-header">
                      <span className={`memory-tag ${entry.target}`}>{entry.target === 'user' ? 'User' : 'Notes'}</span>
                      <span className="memory-date">{new Date(entry.createdAt).toLocaleDateString()}</span>
                      <button className="memory-remove-btn" onClick={() => deleteMemoryReal(entry.id)}>
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
              <h2><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:"middle",marginRight:"8px"}}><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>Capabilities</h2>
              <span className="screen-count">{toolsets.filter(t => t.enabled).length} / {toolsets.length} enabled</span>
            </div>
            <div className="screen-body">
              <p className="screen-desc">Enable or disable AI capabilities</p>
              <div className="tools-grid">
                {toolsets.map(tool => (
                  <div key={tool.id} className={`tool-card ${tool.enabled ? 'tool-enabled' : 'tool-disabled'}`}>
                    <div className="tool-card-header">
                      <span className="tool-card-icon">{renderToolIcon(tool.icon)}</span>
                      <span className="tool-card-name">{tool.name}</span>
                    </div>
                    <p className="tool-card-desc">{tool.description}</p>
                    <label className="toggle">
                      <input type="checkbox" checked={tool.enabled} onChange={e => {
                        const enabled = e.target.checked
                        setToolsets(prev => prev.map(t => t.id === tool.id ? { ...t, enabled } : t))
                        invoke('toggle_toolset', { toolsetId: tool.id, enabled }).catch(e => console.error('Failed to toggle toolset:', e))
                      }} />
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
              <h2><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:"middle",marginRight:"8px"}}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Automations</h2>
              <span className="screen-count">{schedules.length} tasks</span>
            </div>
            <div className="screen-body">
              <p className="screen-desc">Set up tasks that run automatically — daily summaries, weekly reports, regular check-ins, and more</p>
              <div className="schedule-quick-picks">
                <button className="schedule-quick-btn" onClick={() => { setNewScheduleName('Morning Briefing'); setNewScheduleCron('every day at 8am'); setNewSchedulePrompt('Give me a morning briefing — weather, my calendar, and any pending tasks') }}>
                  <span>☀️</span> Morning Briefing
                </button>
                <button className="schedule-quick-btn" onClick={() => { setNewScheduleName('Weekly Report'); setNewScheduleCron('every Friday at 5pm'); setNewSchedulePrompt("Summarize my week — what I accomplished, what's pending, and priorities for next week") }}>
                  <span>📊</span> Weekly Report
                </button>
                <button className="schedule-quick-btn" onClick={() => { setNewScheduleName('System Check'); setNewScheduleCron('every day at noon'); setNewSchedulePrompt('Check my computer health — disk space, updates needed, and any issues') }}>
                  <span>🔍</span> System Check
                </button>
                <button className="schedule-quick-btn" onClick={() => { setNewScheduleName('News Summary'); setNewScheduleCron('every day at 7am'); setNewSchedulePrompt("Search for today's top tech news and give me a brief summary") }}>
                  <span>📰</span> News Summary
                </button>
              </div>
              <div className="schedule-add-form">
                <input className="input-field" placeholder="Task name (e.g. Daily Backup)" value={newScheduleName} onChange={e => setNewScheduleName(e.target.value)} />
                <input className="input-field" placeholder="When? (e.g. every day at 9am, every Monday, every 2 hours)" value={newScheduleCron} onChange={e => setNewScheduleCron(e.target.value)} />
                <textarea className="input-field" placeholder="What should TaskBolt do? (e.g. Check my emails and summarize anything important)" value={newSchedulePrompt} onChange={e => setNewSchedulePrompt(e.target.value)} rows={2} />
                <button className="btn-primary btn-sm" onClick={() => {
                  if (!newScheduleName.trim() || !newSchedulePrompt.trim()) return
                  addScheduleReal(newScheduleName.trim(), newScheduleCron || 'every 1h', newSchedulePrompt.trim())
                  setNewScheduleName(''); setNewScheduleCron(''); setNewSchedulePrompt('')
                }}>Create Automation</button>
              </div>

              <div className="schedules-list">
                {schedules.map(s => (
                  <div key={s.id} className={`schedule-card ${s.enabled ? '' : 'schedule-disabled'}`}>
                    <div className="schedule-card-header">
                      <span className="schedule-name">{s.name}</span>
                      <span className="schedule-cron">{s.schedule}</span>
                      <label className="toggle">
                        <input type="checkbox" checked={s.enabled} onChange={e => toggleScheduleReal(s.id, e.target.checked)} />
                        <span className="toggle-slider" />
                      </label>
                      <button className="schedule-delete-btn" onClick={() => deleteScheduleReal(s.id)}>
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

        {/* ── Messaging Screen ── */}
        {sidebarView === 'gateway' && (
          <div className="screen-view">
            <div className="screen-header">
              <h2><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:"middle",marginRight:"8px"}}><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>Messaging</h2>
              <span className="screen-count">{gatewayPlatforms.filter(p => p.connected).length} connected</span>
            </div>
            <div className="screen-body">
              <p className="screen-desc">Connect your messaging apps so you can chat with TaskBolt from anywhere — send a message on Telegram or WhatsApp and get an instant AI response</p>
              <div className="gateway-grid">
                {gatewayPlatforms.map(p => (
                  <div key={p.id} className={`gateway-card ${p.connected ? 'gateway-connected' : ''}`}>
                    <div className="gateway-brand-logo">
                      {p.id === 'telegram' && (
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="#229ED9"><path d="M12 0C5.37 0 0 5.37 0 12s5.37 12 12 12 12-5.37 12-12S18.63 0 12 0zm5.94 8.13l-1.97 9.28c-.15.67-.54.83-1.09.52l-3.02-2.22-1.46 1.4c-.16.16-.3.3-.61.3l.22-3.06 5.55-5.02c.24-.22-.05-.33-.38-.13l-6.86 4.32-2.96-.92c-.64-.2-.66-.64.14-.95l11.6-4.47c.54-.2 1.01.13.84.95z"/></svg>
                      )}
                      {p.id === 'whatsapp' && (
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="#25D366"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                      )}
                      {p.id === 'imessage' && (
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="#34AADC"><path d="M12 2C6.477 2 2 6.145 2 11.243c0 2.907 1.46 5.497 3.735 7.205l-.935 2.812a.5.5 0 00.707.582l3.158-1.579C9.558 20.42 10.753 20.5 12 20.5c5.523 0 10-4.145 10-9.257S17.523 2 12 2zm-1.5 12.5h-3a.5.5 0 010-1h3a.5.5 0 010 1zm4.5-3h-7.5a.5.5 0 010-1H15a.5.5 0 010 1zm0-3h-7.5a.5.5 0 010-1H15a.5.5 0 010 1z"/></svg>
                      )}
                    </div>
                    <span className="gateway-name">{p.name}</span>
                    <span className={`gateway-status ${p.connected ? 'connected' : 'disconnected'}`}>
                      {p.connected ? '● Connected' : '○ Not connected'}
                    </span>
                    <button className={`btn-secondary btn-sm ${p.connected ? 'btn-disconnect' : ''}`} onClick={() => {
                      p.connected ? disconnectPlatform(p.id) : connectPlatform(p.id)
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
              <h2><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:"middle",marginRight:"8px"}}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>Task Board</h2>
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

        {/* ── Skills Screen ── */}
        {sidebarView === 'skills' && (
          <div className="screen-view">
            <div className="screen-header">
              <h2><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:"middle",marginRight:"8px"}}><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>Skills</h2>
              <span className="screen-count">{skills.filter(s => s.enabled).length} / {skills.length} active</span>
            </div>
            <div className="screen-body">
              <p className="screen-desc">Skills are specialized abilities TaskBolt can use. Toggle them on or off to customize what your assistant can do.</p>
              <div className="tools-grid">
                {skills.map(skill => (
                  <div key={skill.id} className={`tool-card ${skill.enabled ? 'tool-enabled' : 'tool-disabled'}`}>
                    <div className="tool-card-header">
                      <span className="tool-card-icon">{renderToolIcon(skill.icon)}</span>
                      <span className="tool-card-name">{skill.name}</span>
                      {skill.isCore && <span className="skill-core-badge">Core</span>}
                    </div>
                    <p className="tool-card-desc">{skill.description}</p>
                    <label className="toggle">
                      <input type="checkbox" checked={skill.enabled} onChange={e => {
                        const enabled = e.target.checked
                        setSkills(prev => prev.map(s => s.id === skill.id ? { ...s, enabled } : s))
                        if (!skill.isCore) toggleSkillReal(skill.id, enabled)
                      }} />
                      <span className="toggle-slider" />
                    </label>
                  </div>
                ))}
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
