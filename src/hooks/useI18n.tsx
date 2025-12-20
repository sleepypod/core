'use client'

import type { MessageDescriptor } from '@lingui/core'
import { useLingui } from '@lingui/react'

export function useI18n() {
  const { i18n } = useLingui()
  const t = (m: MessageDescriptor | string) => (typeof m === 'string' ? m : i18n._(m))
  return { i18n, t, locale: i18n?.locale }
}
