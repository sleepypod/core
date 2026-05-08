'use client'

import { useState } from 'react'
import { Wifi, Globe, User, KeyRound, Tag, Home, Lock, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { Toggle } from './Toggle'

type Source = 'db' | 'env' | 'default'

interface MqttSettings {
  enabled: boolean
  url: string
  username: string
  passwordIsSet: boolean
  topicPrefix: string
  haDiscovery: boolean
  tlsEnabled: boolean
  sources: Record<'enabled' | 'url' | 'username' | 'password' | 'topicPrefix' | 'haDiscovery' | 'tlsEnabled', Source>
}

type TextField = 'url' | 'username' | 'topicPrefix'

function sourceLabel(s: Source): string | null {
  if (s === 'env') return '.env'
  if (s === 'default') return 'default'
  return null
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 1000) return 'just now'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ago`
}

/**
 * MQTT bridge settings: connection, auth, topic prefix, HA discovery, TLS.
 *
 * Contract shape: see sleepypod-core-26 epic. The mqtt.* tRPC router lands
 * with sleepypod-core-27; until then tsc fails on `trpc.mqtt`.
 */
export function MqttSettingsForm() {
  const utils = trpc.useUtils()
  const settingsQuery = trpc.mqtt.getSettings.useQuery()
  const statusQuery = trpc.mqtt.getStatus.useQuery(undefined, {
    refetchInterval: 5000,
  })

  const data = settingsQuery.data

  return (
    <div className="space-y-4">
      <ConnectionStatusCard
        connected={statusQuery.data?.connected ?? false}
        lastError={statusQuery.data?.lastError ?? null}
        messagesPublished={statusQuery.data?.messagesPublished ?? 0}
        lastPublishAt={statusQuery.data?.lastPublishAt ?? null}
        loading={statusQuery.isLoading}
      />

      {settingsQuery.isLoading && (
        <div className="h-40 animate-pulse rounded-2xl bg-zinc-900" />
      )}

      {settingsQuery.error && (
        <div className="rounded-2xl bg-zinc-900 p-4">
          <p className="text-sm text-red-400">
            Failed to load MQTT settings:
            {' '}
            {settingsQuery.error.message}
          </p>
        </div>
      )}

      {data && (
        <SettingsCard
          data={data}
          onSaved={() => {
            utils.mqtt.getSettings.invalidate()
            utils.mqtt.getStatus.invalidate()
          }}
        />
      )}
    </div>
  )
}

interface ConnectionStatusCardProps {
  connected: boolean
  lastError: string | null
  messagesPublished: number
  lastPublishAt: string | null
  loading: boolean
}

function ConnectionStatusCard({
  connected,
  lastError,
  messagesPublished,
  lastPublishAt,
  loading,
}: ConnectionStatusCardProps) {
  const Icon = connected ? CheckCircle2 : XCircle
  const color = connected ? 'text-emerald-400' : 'text-zinc-500'

  return (
    <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
      <div className="mb-3 flex items-center gap-2">
        <Wifi size={16} className="text-zinc-400" />
        <span className="text-sm font-medium text-zinc-300">Bridge Status</span>
      </div>

      <div className="flex items-center gap-2">
        {loading
          ? <Loader2 size={16} className="animate-spin text-zinc-400" />
          : <Icon size={16} className={color} />}
        <span className={`text-sm font-medium ${color}`}>
          {loading ? 'Checking…' : connected ? 'Connected' : 'Disconnected'}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div>
          <dt className="text-zinc-500">Messages published</dt>
          <dd className="text-zinc-300">{messagesPublished.toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">Last publish</dt>
          <dd className="text-zinc-300">{relativeTime(lastPublishAt)}</dd>
        </div>
      </dl>

      {lastError && (
        <p className="mt-2 break-words text-xs text-red-400">{lastError}</p>
      )}
    </div>
  )
}

interface SettingsCardProps {
  data: MqttSettings
  onSaved: () => void
}

function SettingsCard({ data, onSaved }: SettingsCardProps) {
  const [enabled, setEnabled] = useState(data.enabled)
  const [haDiscovery, setHaDiscovery] = useState(data.haDiscovery)
  const [tlsEnabled, setTlsEnabled] = useState(data.tlsEnabled)

  // Text fields: input is empty when sourced from env/default; placeholder
  // shows the resolved value so the user knows the current effective setting.
  const [url, setUrl] = useState(data.sources.url === 'db' ? data.url : '')
  const [username, setUsername] = useState(data.sources.username === 'db' ? data.username : '')
  const [topicPrefix, setTopicPrefix] = useState(data.sources.topicPrefix === 'db' ? data.topicPrefix : '')
  const [password, setPassword] = useState('')

  // Resync local state when the server snapshot changes (e.g. after save
  // invalidation). Uses the "store prev props in state" pattern so we do not
  // remount via `key=` (which drops input focus mid-edit).
  const [prevData, setPrevData] = useState(data)
  if (data !== prevData) {
    setPrevData(data)
    setEnabled(data.enabled)
    setHaDiscovery(data.haDiscovery)
    setTlsEnabled(data.tlsEnabled)
    setUrl(data.sources.url === 'db' ? data.url : '')
    setUsername(data.sources.username === 'db' ? data.username : '')
    setTopicPrefix(data.sources.topicPrefix === 'db' ? data.topicPrefix : '')
  }

  const updateMutation = trpc.mqtt.updateSettings.useMutation({
    onSuccess: () => {
      setPassword('')
      onSaved()
    },
  })

  const testMutation = trpc.mqtt.testConnection.useMutation()

  const isPending = updateMutation.isPending

  function handleSave() {
    const payload: Partial<{
      enabled: boolean
      url: string
      username: string
      password: string
      topicPrefix: string
      haDiscovery: boolean
      tlsEnabled: boolean
    }> = {
      enabled,
      haDiscovery,
      tlsEnabled,
    }
    if (url.trim()) payload.url = url.trim()
    if (username.trim()) payload.username = username.trim()
    if (topicPrefix.trim()) payload.topicPrefix = topicPrefix.trim()
    if (password) payload.password = password
    updateMutation.mutate(payload)
  }

  function handleTest() {
    const effectiveUrl = url.trim() || data.url
    const effectiveUsername = username.trim() || data.username
    testMutation.mutate({
      url: effectiveUrl,
      username: effectiveUsername,
      tlsEnabled,
      ...(password ? { password } : {}),
    })
  }

  const canTest = Boolean(url.trim() || data.url)

  return (
    <div className="space-y-4">
      {/* Enabled toggle */}
      <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Wifi size={16} className={enabled ? 'text-sky-400' : 'text-zinc-400'} />
            <div>
              <span className="text-sm font-medium text-zinc-300">Enable MQTT Bridge</span>
              <p className="text-xs text-zinc-500">Publishes status + biometrics, accepts commands</p>
            </div>
          </div>
          <Toggle
            enabled={enabled}
            onToggle={() => setEnabled(v => !v)}
            disabled={isPending}
            label="Toggle MQTT bridge"
          />
        </div>
      </div>

      {/* Broker URL */}
      <TextFieldCard
        icon={<Globe size={16} className="text-zinc-400" />}
        label="Broker URL"
        field="url"
        value={url}
        placeholder={data.url || 'mqtt://broker.local:1883'}
        source={data.sources.url}
        onChange={setUrl}
        disabled={isPending}
        autoComplete="off"
      />

      {/* Username */}
      <TextFieldCard
        icon={<User size={16} className="text-zinc-400" />}
        label="Username"
        field="username"
        value={username}
        placeholder={data.username || ''}
        source={data.sources.username}
        onChange={setUsername}
        disabled={isPending}
        autoComplete="off"
      />

      {/* Password */}
      <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <KeyRound size={16} className="text-zinc-400" />
            <span className="text-sm font-medium text-zinc-300">Password</span>
          </div>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
              data.passwordIsSet
                ? 'bg-emerald-500/15 text-emerald-400'
                : 'bg-zinc-800 text-zinc-500'
            }`}
          >
            {data.passwordIsSet ? 'set' : 'unset'}
          </span>
        </div>
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder={data.passwordIsSet ? '••••••••' : ''}
          autoComplete="new-password"
          disabled={isPending}
          className="h-11 w-full rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 text-sm font-medium text-white outline-none transition-colors focus:border-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
        />
        {data.sources.password === 'env' && (
          <p className="mt-1.5 text-xs text-zinc-500">Currently sourced from .env</p>
        )}
      </div>

      {/* Topic Prefix */}
      <TextFieldCard
        icon={<Tag size={16} className="text-zinc-400" />}
        label="Topic Prefix"
        field="topicPrefix"
        value={topicPrefix}
        placeholder={data.topicPrefix || 'sleepypod'}
        source={data.sources.topicPrefix}
        onChange={setTopicPrefix}
        disabled={isPending}
        autoComplete="off"
      />

      {/* HA Discovery */}
      <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Home size={16} className={haDiscovery ? 'text-sky-400' : 'text-zinc-400'} />
            <div>
              <span className="text-sm font-medium text-zinc-300">Home Assistant Discovery</span>
              <p className="text-xs text-zinc-500">Publishes climate/switch/sensor entities</p>
            </div>
          </div>
          <Toggle
            enabled={haDiscovery}
            onToggle={() => setHaDiscovery(v => !v)}
            disabled={isPending}
            label="Toggle Home Assistant discovery"
          />
        </div>
      </div>

      {/* TLS */}
      <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Lock size={16} className={tlsEnabled ? 'text-sky-400' : 'text-zinc-400'} />
            <div>
              <span className="text-sm font-medium text-zinc-300">TLS</span>
              <p className="text-xs text-zinc-500">Use mqtts:// transport</p>
            </div>
          </div>
          <Toggle
            enabled={tlsEnabled}
            onToggle={() => setTlsEnabled(v => !v)}
            disabled={isPending}
            label="Toggle TLS"
          />
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={handleTest}
          disabled={!canTest || testMutation.isPending}
          className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-zinc-900 px-3 py-3 text-sm font-medium text-zinc-300 transition-colors active:bg-zinc-800 disabled:opacity-50"
        >
          {testMutation.isPending && <Loader2 size={14} className="animate-spin" />}
          Test Connection
        </button>
        <button
          onClick={handleSave}
          disabled={isPending}
          className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-sky-500/20 px-3 py-3 text-sm font-medium text-sky-400 transition-colors active:bg-sky-500/30 disabled:opacity-50"
        >
          {isPending && <Loader2 size={14} className="animate-spin" />}
          {isPending ? 'Saving…' : 'Save'}
        </button>
      </div>

      {testMutation.data && (
        <p
          className={`text-xs ${testMutation.data.ok ? 'text-emerald-400' : 'text-red-400'}`}
        >
          {testMutation.data.ok
            ? 'Connection succeeded.'
            : `Connection failed: ${testMutation.data.error ?? 'unknown error'}`}
        </p>
      )}
      {testMutation.error && (
        <p className="text-xs text-red-400">{testMutation.error.message}</p>
      )}

      {updateMutation.error && (
        <p className="text-xs text-red-400">{updateMutation.error.message}</p>
      )}
      {updateMutation.isSuccess && (
        <p className="text-xs text-emerald-400">Settings saved.</p>
      )}
    </div>
  )
}

interface TextFieldCardProps {
  icon: React.ReactNode
  label: string
  field: TextField
  value: string
  placeholder: string
  source: Source
  onChange: (v: string) => void
  disabled?: boolean
  autoComplete?: string
}

function TextFieldCard({
  icon,
  label,
  value,
  placeholder,
  source,
  onChange,
  disabled,
  autoComplete,
}: TextFieldCardProps) {
  const sourceTag = sourceLabel(source)
  return (
    <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-sm font-medium text-zinc-300">{label}</span>
        </div>
        {sourceTag && (
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] font-medium text-zinc-400">
            {sourceTag}
          </span>
        )}
      </div>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        disabled={disabled}
        className="h-11 w-full rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 text-sm font-medium text-white outline-none transition-colors focus:border-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
      />
    </div>
  )
}
