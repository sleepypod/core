import { Trans } from '@lingui/react/macro'

export default async function Page({
  params,
}: {
  params: Promise<{ lang: string }>
}) {
  const lang = (await params).lang

  return (
    <div>
      <h1>
        Current Language:
        {lang}
      </h1>
      <Trans>Hello, world!</Trans>
    </div>
  )
}
