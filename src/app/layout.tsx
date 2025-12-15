import { setI18n } from '@lingui/react/server';
import { ReactNode } from 'react';
import { getI18nInstance } from '../appRouterI18n';
import { LocaleClientProvider, TRPCProvider } from '../components';

type Props = {
  children: ReactNode;
};

export default function RootLayout({ children }: Props) {
  const i18n = getI18nInstance('en-US');
  setI18n(i18n);

  return (
    <html lang="en-US">
      <body>
        <TRPCProvider>
          <LocaleClientProvider
            initialLocale="en-US"
            initialMessages={i18n.messages}
          >
            {children}
          </LocaleClientProvider>
        </TRPCProvider>
      </body>
    </html>
  );
}
