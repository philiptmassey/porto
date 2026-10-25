'use server';
import { redirect } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';

export async function signIn(form: FormData) {
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  if (!process.env.OWNER_EMAIL || email !== process.env.OWNER_EMAIL.toLowerCase()) {
    redirect('/login?error=Use+the+email+address+configured+for+this+reader.');
  }
  // Email links can be opened in a different browser. The finish page accepts
  // Supabase's standard fragment response and persists its verified session.
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { flowType: 'implicit', persistSession: false, autoRefreshToken: false } }
  );
  const origin = process.env.NEXT_PUBLIC_APP_URL;
  if (!origin) redirect('/login?error=Sign-in+is+not+configured+yet.');
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: `${origin}/auth/finish` }
  });
  if (error) redirect('/login?error=Could+not+send+a+sign-in+link.+Please+try+again+in+a+few+minutes.');
  redirect('/login?sent=1');
}
