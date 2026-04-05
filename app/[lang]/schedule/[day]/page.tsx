import { ScheduleDayDetail } from '@/src/components/Schedule/ScheduleDayDetail'

export const dynamic = 'force-dynamic'
export const dynamicParams = true

export default async function ScheduleDayPage({
  params,
}: {
  params: Promise<{ day: string }>
}) {
  const { day } = await params
  return <ScheduleDayDetail day={day} />
}
