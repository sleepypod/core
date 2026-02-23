import { getI18nInstance } from '@/src/lib/i18n/appRouterI18n'
import { initLingui } from '@/src/lib/i18n/initLingui'
import { setI18n } from '@lingui/react/server'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/src/ui/card'

export default async function Page({
  params,
}: {
  params: Promise<{ lang: string }>
}) {
  const lang = (await params).lang
  const i18n = getI18nInstance(lang)
  initLingui(lang)
  setI18n(i18n)

  return (
    <div className="container mx-auto p-4 space-y-4">
      <h1 className="text-4xl font-bold mb-6">Welcome to SleepyPod</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <Link href={`/${lang}/control`}>
          <Card className="hover:shadow-lg transition-shadow cursor-pointer">
            <CardHeader>
              <CardTitle>Pod Control</CardTitle>
            </CardHeader>
            <CardContent>
              <p>Control temperature, power, and alarms for your pod</p>
            </CardContent>
          </Card>
        </Link>

        <Link href={`/${lang}/schedules`}>
          <Card className="hover:shadow-lg transition-shadow cursor-pointer">
            <CardHeader>
              <CardTitle>Schedules</CardTitle>
            </CardHeader>
            <CardContent>
              <p>Manage temperature and alarm schedules</p>
            </CardContent>
          </Card>
        </Link>

        <Link href={`/${lang}/settings`}>
          <Card className="hover:shadow-lg transition-shadow cursor-pointer">
            <CardHeader>
              <CardTitle>Settings</CardTitle>
            </CardHeader>
            <CardContent>
              <p>Configure device settings and preferences</p>
            </CardContent>
          </Card>
        </Link>

        <Link href={`/${lang}/health`}>
          <Card className="hover:shadow-lg transition-shadow cursor-pointer">
            <CardHeader>
              <CardTitle>Health</CardTitle>
            </CardHeader>
            <CardContent>
              <p>View system health and diagnostics</p>
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  )
}
