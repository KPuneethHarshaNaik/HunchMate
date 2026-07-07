'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  Award,
  BarChart3,
  Ban,
  CalendarRange,
  CheckCheck,
  CircleAlert,
  LoaderCircle,
  Shield,
  Search,
  Users,
  Users2,
  UserCog,
} from 'lucide-react'
import { Link } from '@/utils/router'
import {
  Chart as ChartJS,
  ArcElement,
  BarElement,
  CategoryScale,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
} from 'chart.js'
import { Bar, Doughnut, Line } from 'react-chartjs-2'
import { useAuth } from '@/context/AuthContext'
import {
  getAdminOverview,
  listAdminAuditLogs,
  listAdminEvents,
  listUsers,
  updateEventStatusFirebase,
  updateUserRoleFirebase,
  updateUserStatusFirebase,
} from '@/lib/supabase-data'
import '@/vite-pages/admin/Dashboard.css'

const USER_ROLE_OPTIONS = ['participant', 'organizer', 'admin']
const USER_STATUS_OPTIONS = ['active', 'suspended']
const EVENT_STATUS_OPTIONS = ['upcoming', 'live', 'completed', 'cancelled', 'archived']
const ALLOW_ADMIN_BYPASS = false
const CHART_PALETTE = {
  primary: '#0ea5e9',
  accent: '#fb923c',
  success: '#10b981',
  warning: '#f59e0b',
  danger: '#e11d48',
  neutral: '#94a3b8',
}

ChartJS.register(
  ArcElement,
  BarElement,
  CategoryScale,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip
)

function normalizeUserRole(role) {
  const value = String(role || '').trim().toLowerCase()
  if (value === 'admin') return 'admin'
  if (value === 'organizer' || value === 'organiser') return 'organizer'
  return 'participant'
}

function formatDate(value) {
  if (!value) return 'N/A'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'N/A'
  return date.toLocaleString()
}

function toTitleCase(value) {
  return String(value || '')
    .replace(/[-_]/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function getAuditDescription(entry = {}) {
  const action = String(entry?.action || '').trim().toLowerCase()
  const targetType = toTitleCase(entry?.targetType || 'record')
  const targetId = String(entry?.targetId || 'unknown')
  const metadata = entry?.metadata || {}

  if (action === 'user-role-updated') {
    const role = toTitleCase(metadata?.role || 'participant')
    return `${targetType} ${targetId} role changed to ${role}.`
  }

  if (action === 'user-status-updated') {
    const status = toTitleCase(metadata?.status || 'active')
    return `${targetType} ${targetId} status changed to ${status}.`
  }

  if (action === 'event-status-updated') {
    const status = toTitleCase(metadata?.status || 'upcoming')
    return `${targetType} ${targetId} status updated to ${status}.`
  }

  if (action === 'complaint-status-updated') {
    const status = toTitleCase(metadata?.status || 'raised')
    return `${targetType} ${targetId} moved to ${status}.`
  }

  if (action === 'complaint-created') {
    return `${targetType} ${targetId} was raised by a user.`
  }

  if (action === 'local-notification') {
    return `Notification ${targetId} was recorded in local mode.`
  }

  const readableAction = toTitleCase(action || 'activity recorded')
  return `${readableAction} on ${targetType} ${targetId}.`
}

function getRoleClassName(role) {
  if (role === 'admin') return 'admin-pill admin-pill--danger'
  if (role === 'organizer') return 'admin-pill admin-pill--primary'
  return 'admin-pill admin-pill--neutral'
}

function getStatusClassName(status) {
  if (status === 'suspended') return 'admin-pill admin-pill--danger'
  if (status === 'live') return 'admin-pill admin-pill--success'
  if (status === 'completed') return 'admin-pill admin-pill--neutral'
  if (status === 'cancelled' || status === 'archived') return 'admin-pill admin-pill--muted'
  return 'admin-pill admin-pill--primary'
}

function safeReadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function safeWriteJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

function appendLocalAdminLog(action, targetType, targetId, metadata = {}) {
  const logs = safeReadJson('hm_admin_logs', [])
  const nextEntry = {
    _id: `local-log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    action,
    actorId: 'local-admin',
    targetType,
    targetId: String(targetId || ''),
    metadata,
    createdAt: new Date().toISOString(),
  }
  safeWriteJson('hm_admin_logs', [nextEntry, ...logs].slice(0, 200))
}

function buildLocalUsers(events, registrations, credentials) {
  const storedUsers = safeReadJson('hm_admin_users', [])
  const userMap = new Map()

  const detectedParticipantIds = new Set([
    ...registrations.map((entry) => String(entry?.userId || '').trim()).filter(Boolean),
    ...credentials.map((entry) => String(entry?.userId || '').trim()).filter(Boolean),
  ])

  detectedParticipantIds.forEach((userId, index) => {
    userMap.set(userId, {
      id: userId,
      name: `Participant ${index + 1}`,
      email: `${userId}@hunchmate.local`,
      role: 'participant',
      status: 'active',
      provider: 'local',
      createdAt: new Date().toISOString(),
      avatarBackdrop: '',
    })
  })

  const organizerMap = new Map()
  events.forEach((event, index) => {
    const organizer = event?.organiser || event?.organizer || {}
    const organizerId = String(organizer?.id || organizer?.email || '').trim()
    if (!organizerId) return
    organizerMap.set(organizerId, {
      id: organizerId,
      name: organizer?.name || `Organizer ${index + 1}`,
      email: organizer?.email || `${organizerId}@hunchmate.local`,
      role: 'organizer',
      status: 'active',
      provider: 'local',
      createdAt: new Date().toISOString(),
      avatarBackdrop: '',
    })
  })

  organizerMap.forEach((value, key) => userMap.set(key, value))

  storedUsers.forEach((entry) => {
    const id = String(entry?.id || '').trim()
    if (!id) return
    const baseline = userMap.get(id) || {}
    userMap.set(id, {
      ...baseline,
      ...entry,
      id,
      role: normalizeUserRole(entry?.role || baseline?.role),
      status: USER_STATUS_OPTIONS.includes(entry?.status) ? entry.status : (baseline.status || 'active'),
    })
  })

  if (!userMap.has('local-admin')) {
    userMap.set('local-admin', {
      id: 'local-admin',
      name: 'Local Admin',
      email: 'admin@hunchmate.local',
      role: 'admin',
      status: 'active',
      provider: 'local',
      createdAt: new Date().toISOString(),
      avatarBackdrop: '',
    })
  }

  return Array.from(userMap.values())
}

function applyLocalUserFilters(users, { search, role, status, limit = 40 }) {
  const searchValue = String(search || '').trim().toLowerCase()
  return users
    .filter((entry) => {
      if (role && entry.role !== role) return false
      if (status && (entry.status || 'active') !== status) return false
      if (!searchValue) return true
      const haystack = `${entry.name || ''} ${entry.email || ''}`.toLowerCase()
      return haystack.includes(searchValue)
    })
    .slice(0, limit)
}

function applyLocalEventFilters(events, { search, status, limit = 40 }) {
  const searchValue = String(search || '').trim().toLowerCase()
  return events
    .filter((entry) => {
      if (status && (entry.status || 'upcoming') !== status) return false
      if (!searchValue) return true
      const organizerName = entry?.organiser?.name || entry?.organizer?.name || ''
      const haystack = `${entry.title || ''} ${organizerName}`.toLowerCase()
      return haystack.includes(searchValue)
    })
    .slice(0, limit)
}

function buildLocalDashboardData() {
  const events = safeReadJson('hm_events', [])
  const registrations = safeReadJson('hm_registrations', [])
  const credentials = safeReadJson('hm_credentials', [])
  const users = buildLocalUsers(events, registrations, credentials)

  const roleCounts = users.reduce((acc, entry) => {
    const role = normalizeUserRole(entry?.role)
    acc[role] += 1
    return acc
  }, { participant: 0, organizer: 0, admin: 0 })

  const uniqueCredentialRecipients = new Set(credentials.map((c) => String(c?.userId || '').trim()).filter(Boolean))

  const metrics = {
    totalUsers: users.length,
    totalEvents: events.length,
    totalRegistrations: registrations.length,
    totalCheckIns: registrations.filter((entry) => Boolean(entry?.checkedIn)).length,
    activeSessions: 0,
    suspendedUsers: users.filter((entry) => entry?.status === 'suspended').length,
    totalCredentials: credentials.length,
    uniqueCredentialRecipients: uniqueCredentialRecipients.size,
    roleCounts,
  }

  const normalizedEvents = events.map((event) => ({
    ...event,
    status: event?.status || 'upcoming',
    organizer: event?.organizer || event?.organiser || {},
    organiser: event?.organiser || event?.organizer || {},
  }))

  const recentEvents = [...normalizedEvents].slice(0, 5)
  const recentUsers = users.slice(0, 5)

  const adminLogs = safeReadJson('hm_admin_logs', [])
  const notificationLogs = (safeReadJson('hm_organizer_notifications', []) || []).map((entry, index) => ({
    _id: String(entry?.id || `local-log-${index}`),
    action: entry?.title || 'local-notification',
    actorId: 'local-system',
    targetType: 'notification',
    targetId: String(entry?.id || index),
    createdAt: entry?.createdAt || new Date().toISOString(),
  }))

  const logs = [...adminLogs, ...notificationLogs]
    .sort((a, b) => new Date(b?.createdAt || 0).getTime() - new Date(a?.createdAt || 0).getTime())
    .slice(0, 50)

  return {
    metrics,
    users,
    events: normalizedEvents,
    logs,
    recentUsers,
    recentEvents,
  }
}

export default function AdminDashboard() {
  const { token, user } = useAuth()
  const bypassActive = ALLOW_ADMIN_BYPASS && user?.role !== 'admin'
  const useLocalMode = !token || bypassActive

  const [overview, setOverview] = useState(null)
  const [users, setUsers] = useState([])
  const [events, setEvents] = useState([])
  const [logs, setLogs] = useState([])

  const [usersTotal, setUsersTotal] = useState(0)
  const [eventsTotal, setEventsTotal] = useState(0)

  const [loading, setLoading] = useState(true)
  const [actionBusy, setActionBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [userSearch, setUserSearch] = useState('')
  const [userRoleFilter, setUserRoleFilter] = useState('')
  const [userStatusFilter, setUserStatusFilter] = useState('')

  const [eventSearch, setEventSearch] = useState('')
  const [eventStatusFilter, setEventStatusFilter] = useState('')

  const overviewRef = useRef(null)
  const usersRef = useRef(null)
  const eventsRef = useRef(null)
  const auditRef = useRef(null)

  const scrollToSection = (ref) => {
    ref?.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const loadOverview = useCallback(async () => {
    if (useLocalMode) {
      const fallback = buildLocalDashboardData()
      setOverview({ metrics: fallback.metrics, recentUsers: fallback.recentUsers, recentEvents: fallback.recentEvents })
      return
    }

    const data = await getAdminOverview()
    setOverview(data)
  }, [useLocalMode])

  const buildUsersQuery = useCallback(() => {
    const query = new URLSearchParams()
    query.set('limit', '40')
    if (userSearch.trim()) query.set('search', userSearch.trim())
    if (userRoleFilter) query.set('role', userRoleFilter)
    if (userStatusFilter) query.set('status', userStatusFilter)
    return query.toString()
  }, [userRoleFilter, userSearch, userStatusFilter])

  const buildEventsQuery = useCallback(() => {
    const query = new URLSearchParams()
    query.set('limit', '40')
    if (eventSearch.trim()) query.set('search', eventSearch.trim())
    if (eventStatusFilter) query.set('status', eventStatusFilter)
    return query.toString()
  }, [eventSearch, eventStatusFilter])

  const loadUsers = useCallback(async () => {
    if (useLocalMode) {
      const fallback = buildLocalDashboardData()
      const filtered = applyLocalUserFilters(fallback.users, {
        search: userSearch,
        role: userRoleFilter,
        status: userStatusFilter,
      })
      setUsers(filtered)
      setUsersTotal(fallback.users.length)
      return
    }

    const queryParams = new URLSearchParams(buildUsersQuery())
    const data = await listUsers({
      limit: Number(queryParams.get('limit') || 40),
      search: queryParams.get('search') || '',
      role: queryParams.get('role') || '',
      status: queryParams.get('status') || '',
    })
    setUsers(Array.isArray(data.users) ? data.users : [])
    setUsersTotal(Number(data.total || 0))
  }, [buildUsersQuery, useLocalMode, userRoleFilter, userSearch, userStatusFilter])

  const loadEvents = useCallback(async () => {
    if (useLocalMode) {
      const fallback = buildLocalDashboardData()
      const filtered = applyLocalEventFilters(fallback.events, {
        search: eventSearch,
        status: eventStatusFilter,
      })
      setEvents(filtered)
      setEventsTotal(fallback.events.length)
      return
    }

    const queryParams = new URLSearchParams(buildEventsQuery())
    const data = await listAdminEvents({
      limit: Number(queryParams.get('limit') || 40),
      search: queryParams.get('search') || '',
      status: queryParams.get('status') || '',
    })
    setEvents(Array.isArray(data.events) ? data.events : [])
    setEventsTotal(Number(data.total || 0))
  }, [buildEventsQuery, eventSearch, eventStatusFilter, useLocalMode])

  const loadLogs = useCallback(async () => {
    if (useLocalMode) {
      const fallback = buildLocalDashboardData()
      setLogs(Array.isArray(fallback.logs) ? fallback.logs : [])
      return
    }

    const data = await listAdminAuditLogs(50)
    setLogs(Array.isArray(data) ? data : [])
  }, [useLocalMode])

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError('')

    try {
      if (useLocalMode) {
        await Promise.all([loadOverview(), loadUsers(), loadEvents(), loadLogs()])
        setNotice('Local mode active: all admin controls are connected to hm_* storage.')
        return
      }

      await Promise.all([loadOverview(), loadUsers(), loadEvents(), loadLogs()])
    } catch (loadError) {
      if (bypassActive || !token) {
        const fallback = buildLocalDashboardData()
        setOverview({ metrics: fallback.metrics, recentUsers: fallback.recentUsers, recentEvents: fallback.recentEvents })
        setUsers(fallback.users)
        setEvents(fallback.events)
        setLogs(fallback.logs)
        setUsersTotal(fallback.users.length)
        setEventsTotal(fallback.events.length)
        setNotice('Connected in local fallback mode. Showing hm_* storage data.')
        setError('')
      } else {
        setError(loadError.message || 'Failed to load admin dashboard')
      }
    } finally {
      setLoading(false)
    }
  }, [bypassActive, loadEvents, loadLogs, loadOverview, loadUsers, token, useLocalMode])

  useEffect(() => {
    if (!token) {
      const fallback = buildLocalDashboardData()
      setOverview({ metrics: fallback.metrics, recentUsers: fallback.recentUsers, recentEvents: fallback.recentEvents })
      setUsers(fallback.users)
      setEvents(fallback.events)
      setLogs(fallback.logs)
      setUsersTotal(fallback.users.length)
      setEventsTotal(fallback.events.length)
      setLoading(false)
      setError('')
      setNotice('Bypass mode active: dashboard opened without auth token using local storage data.')
      return
    }

    loadAll()
  }, [bypassActive, loadAll, token])

  const handleRefresh = async () => {
    setNotice('')
    await loadAll()
  }

  const changeUserRole = async (targetUserId, nextRole) => {
    if (!targetUserId || !nextRole) return

    setActionBusy(true)
    setNotice('')
    setError('')

    try {
      if (useLocalMode) {
        const localUsers = safeReadJson('hm_admin_users', [])
        const userSet = new Map(localUsers.map((entry) => [String(entry?.id || ''), entry]))
        const current = userSet.get(String(targetUserId)) || { id: String(targetUserId), status: 'active', provider: 'local' }
        userSet.set(String(targetUserId), {
          ...current,
          role: nextRole,
          updatedAt: new Date().toISOString(),
        })
        safeWriteJson('hm_admin_users', Array.from(userSet.values()))
        appendLocalAdminLog('user-role-updated', 'user', targetUserId, { role: nextRole })
        setNotice('User role updated successfully.')
        await Promise.all([loadOverview(), loadUsers(), loadLogs()])
        return
      }

      await updateUserRoleFirebase(targetUserId, nextRole, user?.id || 'admin')
      setNotice('User role updated successfully.')
      await Promise.all([loadUsers(), loadLogs(), loadOverview()])
    } catch (updateError) {
      setError(updateError.message || 'Failed to update role')
    } finally {
      setActionBusy(false)
    }
  }

  const toggleUserStatus = async (entry) => {
    if (!entry?.id) return

    const nextStatus = entry.status === 'suspended' ? 'active' : 'suspended'
    const confirmText = nextStatus === 'suspended'
      ? `Suspend ${entry.name || entry.email}? This will revoke active sessions.`
      : `Re-activate ${entry.name || entry.email}?`

    const confirmed = window.confirm(confirmText)
    if (!confirmed) return

    setActionBusy(true)
    setNotice('')
    setError('')

    try {
      if (useLocalMode) {
        const localUsers = safeReadJson('hm_admin_users', [])
        const userSet = new Map(localUsers.map((row) => [String(row?.id || ''), row]))
        const current = userSet.get(String(entry.id)) || {
          id: String(entry.id),
          name: entry.name,
          email: entry.email,
          role: entry.role || 'participant',
          provider: entry.provider || 'local',
        }
        userSet.set(String(entry.id), {
          ...current,
          status: nextStatus,
          updatedAt: new Date().toISOString(),
        })
        safeWriteJson('hm_admin_users', Array.from(userSet.values()))
        appendLocalAdminLog('user-status-updated', 'user', entry.id, { status: nextStatus })
        setNotice(`User status changed to ${nextStatus}.`)
        await Promise.all([loadOverview(), loadUsers(), loadLogs()])
        return
      }

      await updateUserStatusFirebase(entry.id, nextStatus, user?.id || 'admin')
      setNotice(`User status changed to ${nextStatus}.`)
      await Promise.all([loadUsers(), loadLogs(), loadOverview()])
    } catch (updateError) {
      setError(updateError.message || 'Failed to update status')
    } finally {
      setActionBusy(false)
    }
  }

  const updateEventStatus = async (eventId, status) => {
    if (!eventId || !status) return

    setActionBusy(true)
    setNotice('')
    setError('')

    try {
      if (useLocalMode) {
        const localEvents = safeReadJson('hm_events', [])
        const updatedEvents = localEvents.map((event) => {
          const currentId = String(event?.id || event?._id || '').trim()
          if (currentId !== String(eventId)) return event
          return {
            ...event,
            status,
            updatedAt: new Date().toISOString(),
          }
        })
        safeWriteJson('hm_events', updatedEvents)
        appendLocalAdminLog('event-status-updated', 'event', eventId, { status })
        setNotice(`Event status updated to ${status}.`)
        await Promise.all([loadOverview(), loadEvents(), loadLogs()])
        return
      }

      await updateEventStatusFirebase(eventId, status, user?.id || 'admin')
      setNotice(`Event status updated to ${status}.`)
      await Promise.all([loadEvents(), loadLogs(), loadOverview()])
    } catch (updateError) {
      setError(updateError.message || 'Failed to update event status')
    } finally {
      setActionBusy(false)
    }
  }

  const metricCards = useMemo(() => {
    const metrics = overview?.metrics || {}
    const roleCounts = metrics.roleCounts || {}
    return [
      {
        label: 'Total Users',
        value: metrics.totalUsers ?? 0,
        icon: Users,
      },
      {
        label: 'Total Participants',
        value: roleCounts.participant ?? 0,
        icon: Users2,
      },
      {
        label: 'Total Organisers',
        value: roleCounts.organizer ?? 0,
        icon: UserCog,
      },
      {
        label: 'Active Events',
        value: metrics.totalEvents ?? 0,
        icon: CalendarRange,
      },
      {
        label: 'Registrations',
        value: metrics.totalRegistrations ?? 0,
        icon: UserCog,
      },
      {
        label: 'Check-ins',
        value: metrics.totalCheckIns ?? 0,
        icon: CheckCheck,
      },
      {
        label: 'Credentials Issued',
        value: metrics.totalCredentials ?? 0,
        icon: Award,
      },
      {
        label: 'Unique Recipients',
        value: metrics.uniqueCredentialRecipients ?? 0,
        icon: Award,
      },
      {
        label: 'Live Sessions',
        value: metrics.activeSessions ?? 0,
        icon: Activity,
      },
      {
        label: 'Suspended Users',
        value: metrics.suspendedUsers ?? 0,
        icon: Ban,
      },
      {
        label: 'Open Complaints',
        value: metrics.openComplaints ?? 0,
        icon: CircleAlert,
      },
    ]
  }, [overview])

  const heroHighlights = useMemo(() => {
    const metrics = overview?.metrics || {}
    const roleCounts = metrics.roleCounts || {}
    const draftCount = events.filter((e) => (e?.status || '').toLowerCase() === 'draft').length
    const publishedCount = events.filter((e) => (e?.status || '').toLowerCase() !== 'draft').length

    return [
      { label: 'Total Organizers', value: roleCounts.organizer ?? 0 },
      { label: 'Total Events', value: metrics.totalEvents ?? 0 },
      { label: 'Published Events', value: publishedCount },
      { label: 'Draft Events', value: draftCount },
      { label: 'Total Participant Accounts', value: roleCounts.participant ?? 0 },
    ]
  }, [overview, events])

  const chartCommonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: {
          color: '#334155',
          boxWidth: 12,
        },
      },
    },
    scales: {
      x: {
        ticks: { color: '#64748b' },
        grid: { color: 'rgba(148, 163, 184, 0.18)' },
      },
      y: {
        ticks: { color: '#64748b' },
        grid: { color: 'rgba(148, 163, 184, 0.18)' },
      },
    },
  }

  const registrationTrendData = useMemo(() => {
    const labels = events.slice(0, 6).map((event) => event.title || 'Untitled')
    const values = events.slice(0, 6).map((event) => Number(event.registeredCount || 0))

    return {
      labels,
      datasets: [
        {
          label: 'Registrations',
          data: values,
          borderColor: CHART_PALETTE.primary,
          backgroundColor: 'rgba(14, 165, 233, 0.18)',
          tension: 0.35,
          fill: true,
          pointRadius: 3,
        },
      ],
    }
  }, [events])

  const eventStatusData = useMemo(() => {
    const counts = {}
    events.forEach((event) => {
      const status = String(event?.status || 'upcoming').toLowerCase()
      counts[status] = (counts[status] || 0) + 1
    })

    const labels = Object.keys(counts)
    const values = labels.map((label) => counts[label])
    const colors = [CHART_PALETTE.primary, CHART_PALETTE.success, CHART_PALETTE.warning, CHART_PALETTE.danger, CHART_PALETTE.neutral]

    return {
      labels,
      datasets: [
        {
          label: 'Events',
          data: values,
          backgroundColor: labels.map((_, index) => colors[index % colors.length]),
          borderColor: '#0f172a',
          borderWidth: 2,
        },
      ],
    }
  }, [events])

  const roleMixData = useMemo(() => {
    const counts = overview?.metrics?.roleCounts || { participant: 0, organizer: 0, admin: 0 }
    return {
      labels: ['Participant', 'Organizer', 'Admin'],
      datasets: [
        {
          label: 'Users',
          data: [counts.participant || 0, counts.organizer || 0, counts.admin || 0],
          backgroundColor: [
            'rgba(79, 70, 229, 0.75)',
            'rgba(234, 122, 50, 0.75)',
            'rgba(16, 185, 129, 0.75)',
          ],
          borderRadius: 8,
        },
      ],
    }
  }, [overview])

  return (
    <section className="admin-dashboard">
      <div className="admin-dashboard__bg admin-dashboard__bg--one" />
      <div className="admin-dashboard__bg admin-dashboard__bg--two" />

      <header className="admin-dashboard__header container">
        <div className="admin-dashboard__hero">
          <div>
            <p className="admin-dashboard__eyebrow">Platform Administration</p>
            <h1>Control Center</h1>
            <p className="admin-dashboard__subtitle">
              Monitor platform health, govern user access, and moderate events from one secured panel.
            </p>
          </div>
          <div className="admin-dashboard__hero-stats">
            {heroHighlights.map((item) => (
              <article key={item.label} className="admin-dashboard__hero-chip">
                <p>{item.label}</p>
                <strong>{item.value}</strong>
              </article>
            ))}
          </div>
        </div>
        <div className="admin-dashboard__hero-actions">
          <button
            type="button"
            className="admin-dashboard__refresh-btn"
            onClick={handleRefresh}
            disabled={loading || actionBusy}
          >
            {(loading || actionBusy) ? <LoaderCircle size={16} className="admin-spin" /> : <Activity size={16} />}
            Refresh Data
          </button>
        </div>
      </header>

      <div className="container admin-dashboard__content">
        {error ? (
          <div className="admin-alert admin-alert--error">
            <CircleAlert size={16} /> {error}
          </div>
        ) : null}
        {notice ? <div className="admin-alert admin-alert--notice">{notice}</div> : null}

        <div className="admin-workspace">
          <aside className="admin-rail">
            <div className="admin-rail__title">
              <Shield size={16} />
              <span>Admin Navigation</span>
            </div>
            <button type="button" className="admin-rail__item" onClick={() => scrollToSection(overviewRef)}>
              <BarChart3 size={15} /> Overview
            </button>
            <button type="button" className="admin-rail__item" onClick={() => scrollToSection(usersRef)}>
              <Users2 size={15} /> User Management
            </button>
            <button type="button" className="admin-rail__item" onClick={() => scrollToSection(eventsRef)}>
              <CalendarRange size={15} /> Event Moderation
            </button>
            <button type="button" className="admin-rail__item" onClick={() => scrollToSection(auditRef)}>
              <Activity size={15} /> Audit Trail
            </button>
            <Link to="/admin/complaints" className="admin-rail__item admin-rail__item--link">
              <CircleAlert size={15} /> Complaint Center
            </Link>
          </aside>

          <div className="admin-main">
            <section ref={overviewRef} className="admin-section-anchor">
              <section className="admin-metrics">
                {metricCards.map((card) => {
                  const Icon = card.icon
                  return (
                    <article key={card.label} className="admin-metric-card">
                      <div className="admin-metric-card__icon"><Icon size={18} /></div>
                      <div>
                        <p>{card.label}</p>
                        <h3>{card.value}</h3>
                      </div>
                    </article>
                  )
                })}
              </section>

              <section className="admin-analytics-grid">
                <article className="admin-chart-card">
                  <div className="admin-chart-card__head">
                    <h2>Registration Trend</h2>
                    <p>Latest event registration volume</p>
                  </div>
                  <div className="admin-chart-wrap">
                    <Line data={registrationTrendData} options={chartCommonOptions} />
                  </div>
                </article>

                <article className="admin-chart-card">
                  <div className="admin-chart-card__head">
                    <h2>Event Status Mix</h2>
                    <p>Distribution by event status</p>
                  </div>
                  <div className="admin-chart-wrap">
                    <Doughnut
                      data={eventStatusData}
                      options={{
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                          legend: {
                            labels: { color: '#334155' },
                          },
                        },
                      }}
                    />
                  </div>
                </article>

                <article className="admin-chart-card">
                  <div className="admin-chart-card__head">
                    <h2>Role Distribution</h2>
                    <p>User role segmentation</p>
                  </div>
                  <div className="admin-chart-wrap">
                    <Bar data={roleMixData} options={chartCommonOptions} />
                  </div>
                </article>
              </section>
            </section>

            <section ref={usersRef} className="admin-panel admin-section-anchor">
          <div className="admin-panel__head">
            <h2>Users ({usersTotal})</h2>
            <div className="admin-panel__filters">
              <label className="admin-search">
                <Search size={14} />
                <input
                  value={userSearch}
                  onChange={(event) => setUserSearch(event.target.value)}
                  placeholder="Search by name or email"
                />
              </label>
              <select value={userRoleFilter} onChange={(event) => setUserRoleFilter(event.target.value)}>
                <option value="">All roles</option>
                {USER_ROLE_OPTIONS.map((role) => (
                  <option key={role} value={role}>{role}</option>
                ))}
              </select>
              <select value={userStatusFilter} onChange={(event) => setUserStatusFilter(event.target.value)}>
                <option value="">All status</option>
                {USER_STATUS_OPTIONS.map((status) => (
                  <option key={status} value={status}>{status}</option>
                ))}
              </select>
              <button type="button" onClick={loadUsers} disabled={loading || actionBusy}>Apply</button>
            </div>
          </div>

          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Provider</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <div className="admin-user-cell">
                        <span className="admin-avatar" style={{ background: entry.avatarBackdrop || undefined }}>
                          {entry.name?.charAt(0) || 'U'}
                        </span>
                        <div>
                          <strong>{entry.name || 'Unnamed'}</strong>
                          <p>{entry.email}</p>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={getRoleClassName(entry.role)}>{entry.role}</span>
                    </td>
                    <td>
                      <span className={getStatusClassName(entry.status)}>{entry.status || 'active'}</span>
                    </td>
                    <td>{entry.provider || 'local'}</td>
                    <td>{formatDate(entry.createdAt)}</td>
                    <td>
                      <div className="admin-actions">
                        <select
                          value={entry.role}
                          onChange={(event) => changeUserRole(entry.id, event.target.value)}
                          disabled={actionBusy}
                        >
                          {USER_ROLE_OPTIONS.map((role) => (
                            <option key={role} value={role}>{role}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => toggleUserStatus(entry)}
                          disabled={actionBusy}
                          className={entry.status === 'suspended' ? 'admin-btn admin-btn--success' : 'admin-btn admin-btn--danger'}
                        >
                          {entry.status === 'suspended' ? 'Restore' : 'Suspend'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {users.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="admin-empty">No users found for current filters.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
            </section>

            <section ref={eventsRef} className="admin-panel admin-section-anchor">
          <div className="admin-panel__head">
            <h2>Events ({eventsTotal})</h2>
            <div className="admin-panel__filters">
              <label className="admin-search">
                <Search size={14} />
                <input
                  value={eventSearch}
                  onChange={(event) => setEventSearch(event.target.value)}
                  placeholder="Search event title or organizer"
                />
              </label>
              <select value={eventStatusFilter} onChange={(event) => setEventStatusFilter(event.target.value)}>
                <option value="">All status</option>
                {EVENT_STATUS_OPTIONS.map((status) => (
                  <option key={status} value={status}>{status}</option>
                ))}
              </select>
              <button type="button" onClick={loadEvents} disabled={loading || actionBusy}>Apply</button>
            </div>
          </div>

          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Status</th>
                  <th>Organizer</th>
                  <th>Registrations</th>
                  <th>Updated</th>
                  <th>Moderation</th>
                </tr>
              </thead>
              <tbody>
                {events.map((entry) => (
                  <tr key={entry.id || entry._id}>
                    <td>
                      <strong>{entry.title || 'Untitled Event'}</strong>
                    </td>
                    <td>
                      <span className={getStatusClassName(entry.status || 'upcoming')}>{entry.status || 'upcoming'}</span>
                    </td>
                    <td>{entry.organiser?.name || entry.organizer?.name || 'Unknown'}</td>
                    <td>{Number(entry.registeredCount || 0)}</td>
                    <td>{formatDate(entry.updatedAt || entry.createdAt)}</td>
                    <td>
                      <select
                        value={entry.status || 'upcoming'}
                        onChange={(event) => updateEventStatus(entry.id || entry._id, event.target.value)}
                        disabled={actionBusy}
                      >
                        {EVENT_STATUS_OPTIONS.map((status) => (
                          <option key={status} value={status}>{status}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
                {events.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="admin-empty">No events found for current filters.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
            </section>

            <section ref={auditRef} className="admin-panel admin-panel--audit admin-section-anchor">
          <div className="admin-panel__head">
            <h2>Audit Trail</h2>
          </div>
          <div className="admin-log-list">
            {logs.length === 0 ? <p className="admin-empty">No admin actions recorded yet.</p> : null}
            {logs.map((entry) => (
              <article key={entry._id} className="admin-log-item">
                <div>
                  <strong>{toTitleCase(entry.action || 'audit event')}</strong>
                  <p>{getAuditDescription(entry)}</p>
                  <p>{formatDate(entry.createdAt)}</p>
                </div>
                <div>
                  <p>
                    Actor: <span>{entry.actorId}</span>
                  </p>
                  <p>
                    Target: <span>{entry.targetType}:{entry.targetId}</span>
                  </p>
                </div>
              </article>
            ))}
          </div>
            </section>
          </div>
        </div>
      </div>
    </section>
  )
}
