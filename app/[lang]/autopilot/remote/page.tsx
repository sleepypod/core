import { redirect } from 'next/navigation'

/** Preserve existing bookmarks after promoting Remote to its own destination. */
export default async function RemotePage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params
  redirect(`/${lang}/remote`)
}
