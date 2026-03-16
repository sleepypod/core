import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react'
import { Activity, BarChart3, Calendar, Settings, Thermometer } from 'lucide-react'

const tabs = [{ id: 'temp', icon: Thermometer, label: msg`Temp` },
  { id: 'schedule', icon: Calendar, label: msg`Schedule` },
  { id: 'data', icon: BarChart3, label: msg`Data` },
  { id: 'status', icon: Activity, label: msg`Status` },
  { id: 'settings', icon: Settings, label: msg`Settings` },
]

/**
 * Global bottom navigation component used across the app.
 */
export const BottomNav = () => {
  const { i18n } = useLingui()

  return (
    <nav className="pb-safe fixed inset-x-0 bottom-0 border-t border-zinc-900 bg-black/80 px-6 py-4 backdrop-blur-lg">
      <div className="mx-auto flex max-w-md justify-between">
        {tabs.map(tab => (
          <button key={tab.id} className="group flex flex-col items-center gap-1">
            <tab.icon size={20} className="text-zinc-600 group-first:text-sky-400" />
            <span className="text-[9px] font-bold text-zinc-600 uppercase group-first:text-white">
              {i18n._(tab.label)}
            </span>
          </button>
        ))}
      </div>
    </nav>
  )
}
