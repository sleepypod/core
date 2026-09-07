import { DiagnosticsConsole } from '@/src/components/diagnostics/DiagnosticsConsole'

export default async function DebugPage({ searchParams }: { searchParams: Promise<{ section?: string }> }) {
  const { section } = await searchParams
  return <DiagnosticsConsole initialSection={section} />
}
