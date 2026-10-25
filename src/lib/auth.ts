import 'server-only';
import { createClient } from '@/lib/supabase/server';

export async function requireUser() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims?.sub) throw new Error('Unauthorized');
  const email = String(data.claims.email ?? '');
  if (!process.env.OWNER_EMAIL || email.toLowerCase() !== process.env.OWNER_EMAIL.toLowerCase()) {
    throw new Error('Unauthorized');
  }
  return { supabase, user: { id: data.claims.sub, email } };
}
