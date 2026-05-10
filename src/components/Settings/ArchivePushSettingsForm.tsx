'use client'

import { useState } from 'react'
import { CheckCircle2, Copy, Globe, KeyRound, Loader2, Plug, Save, User, XCircle } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { Toggle } from './Toggle'

interface FormState {
  enabled: boolean
  host: string
  remoteUser: string
  remotePath: string
  port: number
  identity: string
  include: Array<'raw' | 'db'>
}

interface InitialConfig {
  config: FormState
  publicKey: string | null
}

/**
 * Settings form for the archive-push feature (sp-21). Lets the user
 * configure a remote scp target, generate an ssh keypair on the pod,
 * copy the pubkey into their remote's authorized_keys, and run a
 * non-destructive connection test before flipping ENABLED on.
 *
 * The inner editor uses a `key` prop bound to the loaded config so a
 * server-driven change (e.g. after generateKey) cleanly remounts and
 * picks up the new initial state without a setState-in-effect.
 */
export function ArchivePushSettingsForm() {
  const configQuery = trpc.archivePush.getConfig.useQuery({})

  if (configQuery.isLoading) {
    return <div className="h-40 animate-pulse rounded-2xl bg-zinc-900" />
  }

  const data = configQuery.data ?? {
    config: {
      enabled: false,
      host: '',
      remoteUser: '',
      remotePath: '',
      port: 22,
      identity: '/etc/sleepypod/archive-push.id_ed25519',
      include: ['raw', 'db'] as Array<'raw' | 'db'>,
    },
    publicKey: null,
  }

  // Stable key drawn from the server snapshot — when the user generates a
  // key (or another tab edits the conf) the snapshot changes, the key
  // changes, and the editor remounts cleanly with the latest defaults.
  const formKey = JSON.stringify({ c: data.config, k: data.publicKey })

  return <Editor key={formKey} initial={data} />
}

function Editor({ initial }: { initial: InitialConfig }) {
  const utils = trpc.useUtils()
  const setConfig = trpc.archivePush.setConfig.useMutation({
    onSuccess: () => utils.archivePush.getConfig.invalidate(),
  })
  const generateKey = trpc.archivePush.generateKey.useMutation({
    onSuccess: () => utils.archivePush.getConfig.invalidate(),
  })
  const testConnection = trpc.archivePush.testConnection.useMutation()

  const [form, setForm] = useState<FormState>(() => ({
    ...initial.config,
    include: [...initial.config.include],
  }))
  const [copied, setCopied] = useState(false)

  const publicKey = initial.publicKey

  const handleSave = () => setConfig.mutate(form)

  const handleCopy = async () => {
    if (!publicKey) return
    try {
      await navigator.clipboard.writeText(publicKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
    catch {
      /* clipboard blocked — user can select manually */
    }
  }

  const toggleInclude = (key: 'raw' | 'db') => {
    setForm(f => ({
      ...f,
      include: f.include.includes(key)
        ? f.include.filter(k => k !== key)
        : [...f.include, key],
    }))
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-zinc-900 p-4">
        <h3 className="mb-1 text-sm font-semibold text-white">Nightly archive push</h3>
        <p className="mb-4 text-xs text-zinc-500">
          Rsync the cold archive (and a biometrics.db dump) to a host you control. Runs once per
          night via systemd timer. Disabled by default.
        </p>

        <div className="flex items-center justify-between">
          <span className="text-sm text-zinc-200">Enable nightly push</span>
          <Toggle
            label="Enable nightly push"
            enabled={form.enabled}
            onToggle={() => setForm(f => ({ ...f, enabled: !f.enabled }))}
          />
        </div>

        <div className="mt-4 space-y-3">
          <Field icon={Globe} label="Host">
            <input
              value={form.host}
              onChange={e => setForm(f => ({ ...f, host: e.target.value }))}
              placeholder="nas.local"
              className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-white outline-none focus:ring-1 focus:ring-sky-500"
            />
          </Field>
          <Field icon={User} label="Remote user">
            <input
              value={form.remoteUser}
              onChange={e => setForm(f => ({ ...f, remoteUser: e.target.value }))}
              placeholder="sleepypod"
              className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-white outline-none focus:ring-1 focus:ring-sky-500"
            />
          </Field>
          <Field icon={Globe} label="Remote path">
            <input
              value={form.remotePath}
              onChange={e => setForm(f => ({ ...f, remotePath: e.target.value }))}
              placeholder="/volume1/sleepypod-archive"
              className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-white outline-none focus:ring-1 focus:ring-sky-500"
            />
          </Field>
          <Field icon={Globe} label="Port">
            <input
              type="number"
              value={form.port}
              onChange={(e) => {
                const parsed = Number(e.target.value)
                setForm(f => ({ ...f, port: Number.isFinite(parsed) ? parsed : 22 }))
              }}
              className="w-32 rounded-lg bg-zinc-800 px-3 py-2 text-sm text-white outline-none focus:ring-1 focus:ring-sky-500"
            />
          </Field>

          <div>
            <span className="mb-2 block text-xs font-medium text-zinc-400">Include</span>
            <div className="flex gap-2">
              {(['raw', 'db'] as const).map(key => (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleInclude(key)}
                  className={`flex-1 rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                    form.include.includes(key)
                      ? 'bg-sky-600 text-white'
                      : 'bg-zinc-800 text-zinc-400'
                  }`}
                >
                  {key === 'raw' ? 'RAW waveforms' : 'biometrics.db'}
                </button>
              ))}
            </div>
          </div>
        </div>

        <button
          onClick={handleSave}
          disabled={setConfig.isPending}
          className="mt-4 flex w-full min-h-[44px] items-center justify-center gap-2 rounded-xl bg-sky-600 p-3 text-sm font-medium text-white active:bg-sky-700 disabled:opacity-50"
        >
          {setConfig.isPending ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
          {setConfig.isSuccess && !setConfig.isPending ? 'Saved' : 'Save'}
        </button>
      </div>

      <div className="rounded-2xl bg-zinc-900 p-4">
        <div className="mb-2 flex items-center gap-2">
          <KeyRound size={14} className="text-amber-400" />
          <h3 className="text-sm font-semibold text-white">SSH identity</h3>
        </div>
        <p className="mb-3 text-xs text-zinc-500">
          Generate an ed25519 keypair on the pod, then add the public key to
          {' '}
          <code className="text-zinc-300">~/.ssh/authorized_keys</code>
          {' '}
          on your remote.
        </p>

        {publicKey
          ? (
              <div className="space-y-2">
                <pre className="overflow-x-auto rounded-lg bg-zinc-800 p-3 font-mono text-[10px] text-zinc-300">
                  {publicKey}
                </pre>
                <button
                  onClick={handleCopy}
                  className="flex w-full min-h-[44px] items-center justify-center gap-2 rounded-xl bg-zinc-800 p-3 text-sm font-medium text-zinc-200 active:bg-zinc-700"
                >
                  <Copy size={14} />
                  {copied ? 'Copied' : 'Copy public key'}
                </button>
              </div>
            )
          : (
              <button
                onClick={() => generateKey.mutate({})}
                disabled={generateKey.isPending}
                className="flex w-full min-h-[44px] items-center justify-center gap-2 rounded-xl bg-zinc-800 p-3 text-sm font-medium text-zinc-200 active:bg-zinc-700 disabled:opacity-50"
              >
                {generateKey.isPending
                  ? <Loader2 size={14} className="animate-spin" />
                  : <KeyRound size={14} />}
                Generate ed25519 keypair
              </button>
            )}
        {generateKey.error && (
          <p className="mt-2 text-xs text-red-400">{generateKey.error.message}</p>
        )}
      </div>

      <div className="rounded-2xl bg-zinc-900 p-4">
        <div className="mb-2 flex items-center gap-2">
          <Plug size={14} className="text-emerald-400" />
          <h3 className="text-sm font-semibold text-white">Test connection</h3>
        </div>
        <p className="mb-3 text-xs text-zinc-500">
          Probe the remote with a non-destructive
          {' '}
          <code className="text-zinc-300">ssh ... true</code>
          . Save first if you&apos;ve edited the form.
        </p>
        <button
          onClick={() => testConnection.mutate({})}
          disabled={testConnection.isPending}
          className="flex w-full min-h-[44px] items-center justify-center gap-2 rounded-xl bg-zinc-800 p-3 text-sm font-medium text-zinc-200 active:bg-zinc-700 disabled:opacity-50"
        >
          {testConnection.isPending ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}
          Run test
        </button>
        {testConnection.data && (
          <div className={`mt-3 flex items-start gap-2 rounded-lg p-3 text-xs ${
            testConnection.data.ok
              ? 'bg-emerald-950/40 text-emerald-300'
              : 'bg-red-950/40 text-red-300'
          }`}
          >
            {testConnection.data.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
            <span className="font-mono break-all">{testConnection.data.message}</span>
          </div>
        )}
      </div>
    </div>
  )
}

function Field({ icon: Icon, label, children }: {
  icon: React.ComponentType<{ size?: number, className?: string }>
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-1.5 text-xs font-medium text-zinc-400">
        <Icon size={12} />
        {label}
      </span>
      {children}
    </label>
  )
}
