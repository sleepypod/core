import { redirect } from 'next/navigation'

/** Preserve remote bookmarks at its Diagnostics destination. */
export default async function RemotePage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params
  redirect(`/${lang}/debug/remote`)
}
