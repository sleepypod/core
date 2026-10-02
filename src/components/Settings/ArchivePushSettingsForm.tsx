'use client'

import { useState } from 'react'
import { Copy, KeyRound, Plug } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, CardHeader, InlineError, Pill, SettingRow, Skeleton, StatusDot, TextField, Toggle } from '@/src/components/ds'
import { SectionColumns } from './SettingsLayout'

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
    return (
      <SectionColumns
        left={<Skeleton className="h-[360px]" />}
        right={<Skeleton className="h-[180px]" />}
      />
    )
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

  const left = (
    <Card>
      <CardHeader
        title="Nightly archive push"
        subtitle="Copies the biometrics archive (and a biometrics.db dump) to a host you control over SSH, once per night."
      />
      <SettingRow label="Enable nightly push">
        <Toggle
          label="Enable nightly push"
          on={form.enabled}
          onChange={() => setForm(f => ({ ...f, enabled: !f.enabled }))}
        />
      </SettingRow>
      <div className="grid grid-cols-[minmax(0,1fr)_90px] gap-3">
        <TextField
          label="Host"
          value={form.host}
          placeholder="nas.local"
          onChange={host => setForm(f => ({ ...f, host }))}
        />
        <TextField
          label="Port"
          type="number"
          value={form.port}
          onChange={(v) => {
            const parsed = Number(v)
            setForm(f => ({ ...f, port: Number.isFinite(parsed) ? parsed : 22 }))
          }}
        />
      </div>
      <TextField
        label="Remote user"
        value={form.remoteUser}
        placeholder="sleepypod"
        onChange={remoteUser => setForm(f => ({ ...f, remoteUser }))}
      />
      <TextField
        label="Remote path"
        value={form.remotePath}
        placeholder="/volume1/sleepypod-archive"
        onChange={remotePath => setForm(f => ({ ...f, remotePath }))}
      />
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-fg-2">Include</span>
        <div className="flex flex-wrap gap-2">
          {(['raw', 'db'] as const).map(key => (
            <Pill key={key} selected={form.include.includes(key)} onClick={() => toggleInclude(key)}>
              {key === 'raw' ? 'RAW waveforms' : 'biometrics.db'}
            </Pill>
          ))}
        </div>
      </div>
      {setConfig.error && <InlineError>{setConfig.error.message}</InlineError>}
      <div className="flex justify-end">
        <Button variant="primary" onClick={handleSave} disabled={setConfig.isPending}>
          {setConfig.isPending ? 'Saving…' : setConfig.isSuccess ? 'Saved' : 'Save'}
        </Button>
      </div>
    </Card>
  )

  const right = (
    <>
      <Card>
        <CardHeader
          title="SSH identity"
          subtitle={(
            <>
              {'Add this public key to the remote user’s '}
              <code className="font-mono text-fg">~/.ssh/authorized_keys</code>
            </>
          )}
        />
        {publicKey
          ? (
              <>
                <pre className="whitespace-pre-wrap break-all rounded-ctl border border-line bg-code p-3 font-mono text-xs leading-normal text-fg-2">
                  {publicKey}
                </pre>
                <div className="flex gap-2.5">
                  <Button icon={Copy} onClick={handleCopy}>
                    {copied ? 'Copied' : 'Copy key'}
                  </Button>
                </div>
              </>
            )
          : (
              <div className="flex">
                <Button icon={KeyRound} onClick={() => generateKey.mutate({})} disabled={generateKey.isPending}>
                  {generateKey.isPending ? 'Generating…' : 'Generate ed25519 keypair'}
                </Button>
              </div>
            )}
        {generateKey.error && <InlineError>{generateKey.error.message}</InlineError>}
      </Card>

      <Card>
        <CardHeader
          title="Test connection"
          subtitle={(
            <>
              {'Probes the remote with a non-destructive '}
              <code className="font-mono text-fg">ssh … true</code>
              . Save first if you’ve edited the form.
            </>
          )}
        />
        <div className="flex flex-wrap items-center gap-2.5">
          {testConnection.data && (
            <StatusDot
              tone={testConnection.data.ok ? 'ok' : 'danger'}
              label={testConnection.data.ok ? 'Reachable' : 'Failed'}
            />
          )}
          <span className="ml-auto">
            <Button icon={Plug} onClick={() => testConnection.mutate({})} disabled={testConnection.isPending}>
              {testConnection.isPending ? 'Testing…' : 'Test now'}
            </Button>
          </span>
        </div>
        {testConnection.data && (
          <p className="break-all font-mono text-xs text-fg-2">{testConnection.data.message}</p>
        )}
        {testConnection.error && <InlineError>{testConnection.error.message}</InlineError>}
      </Card>
    </>
  )

  return <SectionColumns left={left} right={right} />
}
