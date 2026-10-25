import 'server-only';
import { createClient } from '@supabase/supabase-js';

export function createAdminClient() {
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!secret) throw new Error('Supabase server key is not configured');
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, secret, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
}
