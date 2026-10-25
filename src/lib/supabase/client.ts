'use client';

import { createBrowserClient } from '@supabase/ssr';
import { createElement, useEffect, useRef, useState } from 'react';

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { detectSessionInUrl: false } },
  );
}

export type ImplicitTokens = { accessToken: string; refreshToken: string };

export function parseImplicitTokens(fragment: string): ImplicitTokens | null {
  const params = new URLSearchParams(fragment.startsWith('#') ? fragment.slice(1) : fragment);
  if (params.has('error') || params.has('error_description')) return null;

  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (!accessToken || !refreshToken) return null;
  return { accessToken, refreshToken };
}

export type FinishResult = 'success' | 'invalid-link' | 'unauthorized' | 'failure';

export async function finishImplicitLogin(
  fragment: string,
  client: ReturnType<typeof createClient>,
  verifyOwner: () => Promise<Response>,
): Promise<FinishResult> {
  const tokens = parseImplicitTokens(fragment);
  if (!tokens) return 'invalid-link';

  try {
    const { error } = await client.auth.setSession({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
    });
    if (error) return 'invalid-link';

    const response = await verifyOwner();
    if (response.status === 401 || response.status === 403) {
      await client.auth.signOut();
      return 'unauthorized';
    }
    return response.ok ? 'success' : 'failure';
  } catch {
    return 'failure';
  }
}

/** The page component is colocated with the browser-only auth helper. */
export function FinishAuth() {
  const job = useRef<Promise<FinishResult> | null>(null);
  const [message, setMessage] = useState('Finishing sign-in…');

  useEffect(() => {
    let cancelled = false;
    if (!job.current) {
      // Strip the fragment synchronously before any async auth or API request.
      const fragment = window.location.hash;
      window.history.replaceState(
        window.history.state,
        '',
        `${window.location.pathname}${window.location.search}`,
      );
      const client = createClient();
      job.current = finishImplicitLogin(fragment, client, () =>
        fetch('/api/inbox', { cache: 'no-store', credentials: 'same-origin' }),
      );
    }

    void job.current.then((result) => {
      if (cancelled) return;
      if (result === 'success') {
        window.location.replace('/');
      } else if (result === 'unauthorized') {
        setMessage("This account doesn't have access to Porto. Sign in with the owner account.");
      } else if (result === 'invalid-link') {
        setMessage('This sign-in link is invalid or expired. Request a new one.');
      } else {
        setMessage("We couldn't finish signing you in. Request a new link and try again.");
      }
    });

    return () => { cancelled = true; };
  }, []);

  return createElement(
    'main',
    { style: { minHeight: '100svh', display: 'grid', placeContent: 'center', gap: '1rem', textAlign: 'center' } },
    createElement('p', { role: 'status', 'aria-live': 'polite' }, message),
    createElement('a', { href: '/login' }, 'Return to sign in'),
  );
}
