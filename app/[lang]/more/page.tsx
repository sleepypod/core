import { redirect } from 'next/navigation'

/** Preserve bookmarks from the former five-tab layout. */
export default async function MorePage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params
  redirect(`/${lang}/settings`)
}
