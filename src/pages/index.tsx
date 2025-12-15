/**
 * This is a Next.js page.
 */
import { trpc } from '../utils/trpc';
import { ReactNode, useEffect, useState } from 'react';

function QueryExample() {
  // 💡 Tip: CMD+Click (or CTRL+Click) on `greeting` to go to the server definition
  const result = trpc.greeting.useQuery({ name: 'client' });

  if (!result.data) {
    return (
      <div>
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div>
      {/**
       * The type is defined and can be autocompleted
       * 💡 Tip: Hover over `data` to see the result type
       * 💡 Tip: CMD+Click (or CTRL+Click) on `text` to go to the server definition
       * 💡 Tip: Secondary click on `text` and "Rename Symbol" to rename it both on the client & server
       */}
      <p>{result.data.text}</p>
    </div>
  );
}

function SubscriptionExample() {
  const subscription = trpc.loopData.useSubscription();
  return (
    <table>
      <tr>
        <th>Last data</th>
        <td>{subscription.data?.data}</td>
      </tr>
      <tr>
        <th>Last Event ID</th>
        <td>{subscription.data?.id}</td>
      </tr>
      <tr>
        <th>Status</th>
        <td>
          {subscription.status}
          {subscription.status === 'error' && (
            <div>
              <button onClick={() => subscription.reset()}>Reset</button>
            </div>
          )}
        </td>
      </tr>
    </table>
  );
}

let hasEverMounted = false;

function NoSSR(props: { children: ReactNode }) {
  const [hasMounted, setHasMounted] = useState(hasEverMounted);
  useEffect(() => {
    hasEverMounted = true;
    setHasMounted(true);
  }, []);
  return hasMounted ? <>{props.children}</> : null;
}

export default function IndexPage() {
  return (
    <div>
      <h2>Query</h2>
      <QueryExample />
      <h2>Subscription</h2>
      <NoSSR>
        <SubscriptionExample />
      </NoSSR>
    </div>
  );
}
