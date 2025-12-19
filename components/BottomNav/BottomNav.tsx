import { Activity, BarChart3, Calendar, Settings, Thermometer } from 'lucide-react'

const tabs = [
  { id: 'temp', icon: Thermometer, label: 'Temp' },
  { id: 'schedule', icon: Calendar, label: 'Schedule' },
  { id: 'data', icon: BarChart3, label: 'Data' },
  { id: 'status', icon: Activity, label: 'Status' },
  { id: 'settings', icon: Settings, label: 'Settings' },
]

/**
 * Global bottom navigation component used across the app.
 */
export const BottomNav = () => {
  return (
    <nav className="fixed bottom-0 inset-x-0 bg-black/80 backdrop-blur-lg border-t border-zinc-900 py-4 px-6">
      <div className="max-w-md mx-auto flex justify-between">
        {tabs.map((tab) => (
          <button key={tab.id} className="flex flex-col items-center gap-1 group">
            <tab.icon size={20} className="text-zinc-600 group-first:text-white" />
            <span className="text-[9px] font-bold uppercase text-zinc-600 group-first:text-white">
              {tab.label}
            </span>
          </button>
        ))}
      </div>
    </nav>
  )
}