'use client';

import { I18nProvider } from '@lingui/react';
import { type Messages, setupI18n } from '@lingui/core';
import { ReactNode, useState } from 'react';

export function LocaleClientProvider({
  children,
  initialLocale,
  initialMessages,
}: {
  children: ReactNode;
  initialLocale: string;
  initialMessages: Messages;
}) {
  const [i18n] = useState(() => {
    return setupI18n({
      locale: initialLocale,
      messages: { [initialLocale]: initialMessages },
    });
  });

  return <I18nProvider i18n={i18n}>{children}</I18nProvider>;
}
