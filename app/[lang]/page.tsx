// You now have access to the current locale

import { Trans } from '@lingui/react/macro'

// e.g. /en-US/products -> `lang` is "en-US"
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
