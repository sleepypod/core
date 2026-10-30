import Link from 'next/link'
import { House, MoonStar, Sunrise, Wind } from 'lucide-react'
import { PageHeader } from '@/src/components/ds'
import { RoomContext } from '@/src/components/Home/RoomContext'
import { BedroomSensors } from '@/src/components/Home/BedroomSensors'

export default async function HomePage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params
  return (
    <>
      <PageHeader title="Home" />
      <BedroomSensors />
      <section className="rounded-card border border-line bg-surface p-4">
        <House className="mb-5 text-cool" size={36} aria-hidden />
        <h2 className="text-base font-medium">Connect your room</h2>
        <p className="mt-3 max-w-xl text-fg-2">Bring your bedroom measurements into sleep insights and reviewable Autopilot rules. Existing Home Assistant entities provide sensor input; house scenes remain separately controlled.</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href={`/${lang}/settings?section=mqtt`} className="rounded-ctl border border-line-2 px-4 py-3 text-fg">MQTT connection</Link>
          <Link href={`/${lang}/settings?section=homekit`} className="rounded-ctl border border-line-2 px-4 py-3 text-fg">Apple Home bridge</Link>
        </div>
      </section>
      <details className="rounded-card border border-line p-4">
        <summary className="cursor-pointer text-sm text-fg-2">Existing single-source MQTT mappings</summary>
        <div className="mt-4"><RoomContext /></div>
      </details>
      <div className="grid gap-4 sm:grid-cols-3">
        {[{ icon: MoonStar, title: 'Wind down', text: 'Lighting and shades follow your evening.' }, { icon: Sunrise, title: 'Wake together', text: 'Coordinate your alarm with a Home scene.' }, { icon: Wind, title: 'Room comfort', text: 'Understand humidity, temperature and air quality.' }].map(item => (
          <section key={item.title} className="rounded-card border border-line bg-surface p-4">
            <item.icon size={22} className="mb-4 text-warm" aria-hidden />
            <h2 className="font-medium">{item.title}</h2>
            <p className="mt-2 text-sm text-fg-2">{item.text}</p>
            <p className="mt-4 text-xs text-fg-2">Template · inactive</p>
          </section>
        ))}
      </div>
      <p className="text-sm text-fg-2">Existing Apple Home scenes can be run from the native app after you authorize Home access. Missing room readings never trigger bed adjustments.</p>
    </>
  )
}
