import { AutopilotConsole } from '@/src/components/Autopilot/AutopilotConsole'
/** Open the Autopilot shell directly on its Remote mapping screen. */
export default function RemotePage() {
  return <AutopilotConsole initialScreen="remote" />
}
