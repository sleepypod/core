import { DiagnosticsConsole } from '@/src/components/diagnostics/DiagnosticsConsole'

/** Open the Remote subpage within Diagnostics. */
export default function RemotePage() {
  return <DiagnosticsConsole initialSection="remote" />
}
