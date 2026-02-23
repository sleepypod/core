'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Home, Thermometer, Calendar, Settings, Activity } from 'lucide-react'

export function Navigation() {
  const pathname = usePathname()
  const lang = pathname.split('/')[1] || 'en'

  const links = [
    { href: `/${lang}`, label: 'Home', icon: Home },
    { href: `/${lang}/control`, label: 'Control', icon: Thermometer },
    { href: `/${lang}/schedules`, label: 'Schedules', icon: Calendar },
    { href: `/${lang}/settings`, label: 'Settings', icon: Settings },
    { href: `/${lang}/health`, label: 'Health', icon: Activity },
  ]

  return (
    <nav className="border-b">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center gap-8">
            <Link href={`/${lang}`} className="text-xl font-bold">
              SleepyPod
            </Link>

            <div className="hidden md:flex gap-4">
              {links.map((link) => {
                const Icon = link.icon
                const isActive = pathname === link.href

                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`flex items-center gap-2 px-3 py-2 rounded transition-colors ${
                      isActive
                        ? 'bg-primary text-primary-foreground'
                        : 'hover:bg-accent'
                    }`}
                  >
                    <Icon size={18} />
                    <span>{link.label}</span>
                  </Link>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Mobile navigation */}
      <div className="md:hidden border-t">
        <div className="flex justify-around py-2">
          {links.map((link) => {
            const Icon = link.icon
            const isActive = pathname === link.href

            return (
              <Link
                key={link.href}
                href={link.href}
                className={`flex flex-col items-center gap-1 px-3 py-2 ${
                  isActive ? 'text-primary' : 'text-muted-foreground'
                }`}
              >
                <Icon size={20} />
                <span className="text-xs">{link.label}</span>
              </Link>
            )
          })}
        </div>
      </div>
    </nav>
  )
}
