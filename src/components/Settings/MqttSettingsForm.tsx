'use client'

import { useState } from 'react'
import { Plug } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { Badge, Button, Card, CardHeader, InlineError, SectionLabel, SettingRow, Skeleton, StatusDot, Toggle } from '@/src/components/ds'
import { cn } from '@/lib/utils'

type Source = 'db' | 'env' | 'default'

interface MqttSettings {
  enabled: boolean
  url: string | null
  username: string | null
  passwordIsSet: boolean
  topicPrefix: string
  haDiscovery: boolean
  tlsEnabled: boolean
  sources: Record<'enabled' | 'url' | 'username' | 'password' | 'topicPrefix' | 'haDiscovery' | 'tlsEnabled', Source>
}

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
 * MQTT bridge card: status, bridge + HA discovery toggles, connection, auth,
 * topic prefix, test connection and save.
 */
export function MqttSettingsForm() {
  const utils = trpc.useUtils()
  const settingsQuery = trpc.mqtt.getSettings.useQuery({})
  const statusQuery = trpc.mqtt.getStatus.useQuery({}, {
    refetchInterval: 5000,
  })

  const data = settingsQuery.data
  const status = statusQuery.data

  const statusDot = statusQuery.isLoading
    ? <StatusDot tone="muted" label="Checking…" />
    : status?.connected
      ? <StatusDot tone="ok" label="Connected" />
      : <StatusDot tone="muted" label="Disconnected" />

  if (settingsQuery.isLoading) {
    return <Skeleton className="h-[420px]" />
  }

  return (
    <Card>
      <CardHeader title="MQTT" right={statusDot} />
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-2">
        <span>
          {'Published '}
          <span className="font-mono text-fg">{(status?.messagesPublished ?? 0).toLocaleString()}</span>
        </span>
        <span>
          {'Last publish '}
          <span className="font-mono text-fg">{relativeTime(status?.lastPublishAt ?? null)}</span>
        </span>
      </div>
      {status?.lastError && <InlineError className="break-words text-xs">{status.lastError}</InlineError>}

      {settingsQuery.error && (
        <InlineError>
          {'Failed to load MQTT settings: '}
          {settingsQuery.error.message}
        </InlineError>
      )}

      {data && (
        <SettingsFields
          data={data}
          onSaved={() => {
            utils.mqtt.getSettings.invalidate()
            utils.mqtt.getStatus.invalidate()
          }}
        />
      )}
    </Card>
  )
}

function SettingsFields({ data, onSaved }: { data: MqttSettings, onSaved: () => void }) {
  const [enabled, setEnabled] = useState(data.enabled)
  const [haDiscovery, setHaDiscovery] = useState(data.haDiscovery)
  const [tlsEnabled, setTlsEnabled] = useState(data.tlsEnabled)

  // Text fields: input is empty when sourced from env/default; placeholder
  // shows the resolved value so the user knows the current effective setting.
  const [url, setUrl] = useState(data.sources.url === 'db' ? data.url ?? '' : '')
  const [username, setUsername] = useState(data.sources.username === 'db' ? data.username ?? '' : '')
  // Topic prefix always has a sensible resolved default ('sleepypod'); prefill
  // so the user sees what's in effect rather than an empty box with placeholder.
  const [topicPrefix, setTopicPrefix] = useState(data.topicPrefix)
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
    setUrl(data.sources.url === 'db' ? data.url ?? '' : '')
    setUsername(data.sources.username === 'db' ? data.username ?? '' : '')
    setTopicPrefix(data.topicPrefix)
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
    const effectiveUrl = url.trim() || data.url || ''
    const effectiveUsername = username.trim() || data.username || ''
    testMutation.mutate({
      url: effectiveUrl,
      username: effectiveUsername,
      tlsEnabled,
      ...(password ? { password } : {}),
    })
  }

  const canTest = Boolean(url.trim() || data.url)

  return (
    <>
      <SettingRow label="MQTT bridge" sub="Publishes status + biometrics, accepts commands">
        <Toggle on={enabled} onChange={setEnabled} disabled={isPending} label="Toggle MQTT bridge" />
      </SettingRow>
      <SettingRow label="Home Assistant discovery" sub="Publishes climate/switch/sensor entities">
        <Toggle on={haDiscovery} onChange={setHaDiscovery} disabled={isPending} label="Toggle Home Assistant discovery" />
      </SettingRow>

      <SectionLabel className="mt-2">CONNECTION</SectionLabel>
      <Field
        label="Broker URL"
        value={url}
        placeholder={data.url || 'mqtt://broker.local:1883'}
        source={data.sources.url}
        onChange={setUrl}
        disabled={isPending}
      />
      <SettingRow label="TLS" sub="Use mqtts:// transport">
        <Toggle on={tlsEnabled} onChange={setTlsEnabled} disabled={isPending} label="Toggle TLS" />
      </SettingRow>

      <SectionLabel className="mt-2">AUTHENTICATION</SectionLabel>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Username"
          value={username}
          placeholder={data.username || ''}
          source={data.sources.username}
          onChange={setUsername}
          disabled={isPending}
        />
        <Field
          label="Password"
          type="password"
          value={password}
          placeholder={data.passwordIsSet ? '••••••••' : ''}
          source={data.sources.password}
          tag={`${data.sources.password === 'env' ? '.env · ' : ''}${data.passwordIsSet ? 'set' : 'unset'}`}
          onChange={setPassword}
          disabled={isPending}
          autoComplete="new-password"
        />
      </div>
      <p className="text-xs text-fg-2">Leave both blank for anonymous brokers (e.g. local Mosquitto with allow_anonymous true).</p>

      <SectionLabel className="mt-2">TOPICS</SectionLabel>
      <Field
        label="Topic prefix"
        value={topicPrefix}
        placeholder="sleepypod"
        source={data.sources.topicPrefix}
        onChange={setTopicPrefix}
        disabled={isPending}
      />

      {testMutation.data && (
        <p className={cn('text-xs', testMutation.data.ok ? 'text-ok' : 'text-danger')}>
          {testMutation.data.ok
            ? 'Connection succeeded.'
            : `Connection failed: ${testMutation.data.error ?? 'unknown error'}`}
        </p>
      )}
      {testMutation.error && <InlineError className="text-xs">{testMutation.error.message}</InlineError>}
      {updateMutation.error && <InlineError className="text-xs">{updateMutation.error.message}</InlineError>}
      {updateMutation.isSuccess && <p className="text-xs text-ok">Settings saved.</p>}

      <div className="mt-1 flex flex-wrap justify-end gap-2.5">
        <Button icon={Plug} onClick={handleTest} disabled={!canTest || testMutation.isPending}>
          {testMutation.isPending ? 'Testing…' : 'Test connection'}
        </Button>
        <Button variant="primary" onClick={handleSave} disabled={isPending}>
          {isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </>
  )
}

function Field({ label, value, placeholder, source, tag, onChange, disabled, type = 'text', autoComplete = 'off' }: {
  label: string
  value: string
  placeholder: string
  source: Source
  tag?: string
  onChange: (v: string) => void
  disabled?: boolean
  type?: 'text' | 'password'
  autoComplete?: string
}) {
  const sourceTag = tag ?? sourceLabel(source)
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="flex items-center gap-2 text-xs text-fg-2">
        {label}
        {sourceTag && <Badge>{sourceTag}</Badge>}
      </span>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        disabled={disabled}
        className="min-w-0 rounded-ctl border border-line-2 bg-field px-3 py-[9px] font-mono text-[13px] text-fg outline-none placeholder:text-fg-3 focus:border-fg-3 disabled:opacity-45"
      />
    </label>
  )
}
