'use client';

import { Trans } from '@lingui/react';
import { trpc } from '../utils/trpc';

export default function Index() {
  const healthcheck = trpc.healthcheck.useQuery();
  const greeting = trpc.greeting.useQuery({ name: 'tRPC' });

  return (
    <div>
      <Trans id="Test page." />
      <div>
        <h2>tRPC Demo</h2>
        <p>Healthcheck: {healthcheck.data ?? 'Loading...'}</p>
        <p>Greeting: {greeting.data ?? 'Loading...'}</p>
      </div>
    </div>
  );
}
