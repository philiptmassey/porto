import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth';
import { signIn } from './actions';
import styles from './login.module.css';

export default async function Login({ searchParams }: { searchParams: Promise<{ sent?: string; error?: string }> }) {
  let signedIn = false;
  try { await requireUser(); signedIn = true; } catch { /* Display sign-in form. */ }
  if (signedIn) redirect('/');
  const params = await searchParams;
  return <main className={styles.page}>
    <Link href="/" className={styles.wordmark}>Porto<span> / </span></Link>
    <section className={styles.card}>
      <p className={styles.eyebrow}>A quieter place to catch up</p>
      <h1>Read what matters.<br />Then get on with your day.</h1>
      <p className={styles.description}>Your feeds, one small inbox. Open a story or clear it away.</p>
      {params.sent ? <div role="status" className={styles.notice}><strong>Check your email.</strong><p>Open the newest sign-in link in the browser where you want to read. The link signs you into that browser.</p><Link href="/login">Send a new link</Link></div> :
        <form action={signIn}>
          <label htmlFor="email">Email address</label>
          <input type="email" name="email" id="email" autoComplete="email" placeholder="you@example.com" required />
          <button type="submit">Email me a sign-in link <span aria-hidden="true">↗</span></button>
          {params.error && <p role="alert" className={styles.error}>{params.error}</p>}
        </form>}
      <p className={styles.note}>A personal reader. No password to remember.</p>
    </section>
    <footer>Make room for the rest of your day.</footer>
  </main>;
}
