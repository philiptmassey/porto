'use server';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

export async function signIn(form: FormData) {
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  if (!process.env.OWNER_EMAIL || email !== process.env.OWNER_EMAIL.toLowerCase()) {
    redirect('/login?error=Use+the+email+address+configured+for+this+reader.');
  }
  const supabase = await createClient();
  const origin = process.env.NEXT_PUBLIC_APP_URL;
  if (!origin) redirect('/login?error=Sign-in+is+not+configured+yet.');
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: `${origin}/auth/callback` }
  });
  if (error) redirect('/login?error=Could+not+send+a+sign-in+link.+Please+try+again+in+a+few+minutes.');
  redirect('/login?sent=1');
}
