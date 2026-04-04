import { ScheduleDayDetail } from '@/src/components/Schedule/ScheduleDayDetail'
import { DAYS } from '@/src/components/Schedule/DaySelector'

export function generateStaticParams() {
  return DAYS.map(d => ({ day: d.key }))
}

export default async function ScheduleDayPage({
  params,
}: {
  params: Promise<{ day: string }>
}) {
  const { day } = await params
  return <ScheduleDayDetail day={day} />
}
