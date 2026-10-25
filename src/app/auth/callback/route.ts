import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (code) {
    const client = await createClient();
    const { data, error } = await client.auth.exchangeCodeForSession(code);
    if (!error && data.user?.email?.toLowerCase() === process.env.OWNER_EMAIL?.toLowerCase()) {
      return NextResponse.redirect(new URL('/', url.origin));
    }
    await client.auth.signOut();
  }
  return NextResponse.redirect(new URL('/login?error=This+link+expired+or+was+opened+in+a+different+browser.+Request+a+new+one.', url.origin));
}
