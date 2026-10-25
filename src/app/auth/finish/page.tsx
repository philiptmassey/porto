import type { Metadata } from 'next';
import { FinishAuth } from '@/lib/supabase/client';

export const metadata: Metadata = {
  title: 'Finishing sign-in — Porto',
  referrer: 'no-referrer',
};

export default function FinishPage() {
  return <FinishAuth />;
}
