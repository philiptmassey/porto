import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

const LINK_ERROR = 'This link expired or has already been used. Request a new one.';

function redirect(requestUrl: URL, path: string) {
  const response = NextResponse.redirect(new URL(path, requestUrl.origin));
  // Auth URLs contain credentials in their query string. Keep redirects out of
  // caches and prevent them from being sent as a referrer.
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

function loginError(url: URL) {
  const destination = new URL('/login', url.origin);
  destination.searchParams.set('error', LINK_ERROR);
  return redirect(url, `${destination.pathname}${destination.search}`);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type');
  const code = url.searchParams.get('code');

  // Keep support for older OTP-hash and PKCE callback links that were already sent.
  if (!tokenHash && !code) return loginError(url);
  if (tokenHash && type !== 'email') return loginError(url);

  const ownerEmail = process.env.OWNER_EMAIL?.trim().toLowerCase();
  if (!ownerEmail) return loginError(url);

  try {
    const client = await createClient();
    const result = tokenHash
      ? await client.auth.verifyOtp({ token_hash: tokenHash, type: 'email' })
      : await client.auth.exchangeCodeForSession(code!);

    if (result.error) return loginError(url);

    const email = result.data.user?.email?.trim().toLowerCase();
    if (email !== ownerEmail) {
      // A valid link for another identity must not leave that identity signed in.
      await client.auth.signOut();
      return loginError(url);
    }

    return redirect(url, '/');
  } catch {
    // Never include token_hash/code or provider error details in the response.
    return loginError(url);
  }
}
