import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createClient }));

import { GET } from '@/app/auth/callback/route';

function makeClient() {
  return {
    auth: {
      verifyOtp: vi.fn(),
      exchangeCodeForSession: vi.fn(),
      signOut: vi.fn().mockResolvedValue({ error: null }),
    },
  };
}

function request(query = '') {
  return new Request(`https://porto.example/auth/callback${query}`);
}

function expectSafeRedirect(response: Response) {
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OWNER_EMAIL = 'owner@example.com';
});

describe('auth callback', () => {
  it('verifies portable email token hashes and redirects the owner to the inbox', async () => {
    const client = makeClient();
    client.auth.verifyOtp.mockResolvedValue({
      data: { user: { email: 'OWNER@example.com' } },
      error: null,
    });
    createClient.mockResolvedValue(client);

    const response = await GET(request('?token_hash=opaque-token&type=email'));

    expect(client.auth.verifyOtp).toHaveBeenCalledWith({ token_hash: 'opaque-token', type: 'email' });
    expect(client.auth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(response.headers.get('location')).toBe('https://porto.example/');
    expectSafeRedirect(response);
  });

  it('signs out an authenticated identity that does not own the app', async () => {
    const client = makeClient();
    client.auth.verifyOtp.mockResolvedValue({
      data: { user: { email: 'someone-else@example.com' } },
      error: null,
    });
    createClient.mockResolvedValue(client);

    const response = await GET(request('?token_hash=opaque-token&type=email'));

    expect(client.auth.signOut).toHaveBeenCalledOnce();
    expect(response.headers.get('location')).toContain('/login?error=');
    expect(new URL(response.headers.get('location')!).searchParams.get('error'))
      .toBe('This link expired or has already been used. Request a new one.');
    expectSafeRedirect(response);
  });

  it('rejects email token hashes with a different OTP type without calling auth', async () => {
    const response = await GET(request('?token_hash=opaque-token&type=recovery'));

    expect(createClient).not.toHaveBeenCalled();
    expect(new URL(response.headers.get('location')!).searchParams.get('error'))
      .toBe('This link expired or has already been used. Request a new one.');
    expectSafeRedirect(response);
  });

  it('continues to exchange legacy PKCE codes', async () => {
    const client = makeClient();
    client.auth.exchangeCodeForSession.mockResolvedValue({
      data: { user: { email: 'owner@example.com' } },
      error: null,
    });
    createClient.mockResolvedValue(client);

    const response = await GET(request('?code=legacy-code'));

    expect(client.auth.exchangeCodeForSession).toHaveBeenCalledWith('legacy-code');
    expect(client.auth.verifyOtp).not.toHaveBeenCalled();
    expect(response.headers.get('location')).toBe('https://porto.example/');
    expectSafeRedirect(response);
  });

  it('returns a helpful login redirect when verification fails', async () => {
    const client = makeClient();
    client.auth.verifyOtp.mockResolvedValue({
      data: { user: null },
      error: new Error('provider details must not leak'),
    });
    createClient.mockResolvedValue(client);

    const response = await GET(request('?token_hash=secret-token&type=email'));
    const location = response.headers.get('location')!;

    expect(new URL(location).searchParams.get('error'))
      .toBe('This link expired or has already been used. Request a new one.');
    expect(location).not.toContain('secret-token');
    expect(location).not.toContain('provider details');
    expect(client.auth.signOut).not.toHaveBeenCalled();
    expectSafeRedirect(response);
  });

  it('handles unexpected auth client failures without exposing provider details', async () => {
    createClient.mockRejectedValue(new Error('internal provider failure'));

    const response = await GET(request('?token_hash=secret-token&type=email'));
    const location = response.headers.get('location')!;

    expect(new URL(location).searchParams.get('error'))
      .toBe('This link expired or has already been used. Request a new one.');
    expect(location).not.toContain('secret-token');
    expect(location).not.toContain('internal provider failure');
    expectSafeRedirect(response);
  });

  it('handles a missing token without creating an auth client', async () => {
    const response = await GET(request());

    expect(createClient).not.toHaveBeenCalled();
    expect(new URL(response.headers.get('location')!).searchParams.get('error'))
      .toBe('This link expired or has already been used. Request a new one.');
    expectSafeRedirect(response);
  });
});
