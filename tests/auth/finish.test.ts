import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, finishImplicitLogin, parseImplicitTokens } from '@/lib/supabase/client';

function mockClient(setSessionError: Error | null = null) {
  return {
    auth: {
      setSession: vi.fn().mockResolvedValue({ data: { session: null, user: null }, error: setSessionError }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
    },
  } as unknown as ReturnType<typeof createClient>;
}

describe('implicit auth finish', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('parses access and refresh tokens from a URL fragment', () => {
    expect(parseImplicitTokens('#access_token=access-value&refresh_token=refresh-value&token_type=bearer'))
      .toEqual({ accessToken: 'access-value', refreshToken: 'refresh-value' });
  });

  it.each([
    '',
    '#error=access_denied&error_description=link+expired',
    '#access_token=access-value',
    '#refresh_token=refresh-value',
  ])('rejects missing or error fragments (%s)', (fragment) => {
    expect(parseImplicitTokens(fragment)).toBeNull();
  });

  it('sets the session and verifies owner access through the inbox API', async () => {
    const client = mockClient();
    const verifyOwner = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    const result = await finishImplicitLogin(
      '#access_token=fake-access&refresh_token=fake-refresh',
      client,
      verifyOwner,
    );

    expect(result).toBe('success');
    expect(client.auth.setSession).toHaveBeenCalledWith({
      access_token: 'fake-access',
      refresh_token: 'fake-refresh',
    });
    expect(verifyOwner).toHaveBeenCalledOnce();
    expect(client.auth.signOut).not.toHaveBeenCalled();
  });

  it.each([401, 403])('signs out when the inbox rejects identity with status %s', async (status) => {
    const client = mockClient();
    const verifyOwner = vi.fn().mockResolvedValue(new Response(null, { status }));

    const result = await finishImplicitLogin(
      '#access_token=fake-access&refresh_token=fake-refresh',
      client,
      verifyOwner,
    );

    expect(result).toBe('unauthorized');
    expect(client.auth.signOut).toHaveBeenCalledOnce();
  });

  it('does not call the protected API if session validation fails', async () => {
    const client = mockClient(new Error('invalid session'));
    const verifyOwner = vi.fn();

    const result = await finishImplicitLogin(
      '#access_token=fake-access&refresh_token=fake-refresh',
      client,
      verifyOwner,
    );

    expect(result).toBe('invalid-link');
    expect(verifyOwner).not.toHaveBeenCalled();
    expect(client.auth.signOut).not.toHaveBeenCalled();
  });

  it('returns a generic failure if the owner check cannot complete', async () => {
    const client = mockClient();
    const verifyOwner = vi.fn().mockRejectedValue(new Error('private API details'));

    const result = await finishImplicitLogin(
      '#access_token=fake-access&refresh_token=fake-refresh',
      client,
      verifyOwner,
    );

    expect(result).toBe('failure');
  });
});
