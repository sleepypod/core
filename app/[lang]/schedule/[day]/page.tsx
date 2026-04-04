import { ScheduleDayDetail } from '@/src/components/Schedule/ScheduleDayDetail'

export function generateStaticParams() {
  return [
    { day: 'sunday' },
    { day: 'monday' },
    { day: 'tuesday' },
    { day: 'wednesday' },
    { day: 'thursday' },
    { day: 'friday' },
    { day: 'saturday' },
  ]
}

export default async function ScheduleDayPage({
  params,
}: {
  params: Promise<{ day: string }>
}) {
  const { day } = await params
  return <ScheduleDayDetail day={day} />
}
