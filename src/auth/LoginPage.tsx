import { useState } from 'react';
import { authErrorMessage, useAuth } from './AuthProvider';
import { MAX_USERNAME } from '../db/users';
import { Mascot } from '../Mascot';

const inputCls =
  'w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 ' +
  'focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:bg-slate-100';

/**
 * The sign-in screen.
 *
 * Sign up refuses a name that is taken and says so; sign in cannot tell you whether the name or the
 * password was wrong, so it cannot be used to find out who has an account.
 */
export default function LoginPage() {
  const { signIn, signUp, configured } = useAuth();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      await (mode === 'in' ? signIn(username, password) : signUp(username, password));
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const swap = () => {
    setMode(m => (m === 'in' ? 'up' : 'in'));
    setError('');
  };

  return (
    <main className="flex min-h-full items-center justify-center p-6">
      <div className="card-in w-full max-w-sm rounded-[2rem] bg-white/85 p-6 shadow-xl shadow-pink-200/60 ring-2 ring-white backdrop-blur-sm">
        <div className="mb-5 flex items-center gap-3">
          <Mascot busy={busy} />
          <div>
            <h1 className="text-xl font-bold text-slate-900">Q-Print</h1>
            <p className="text-sm text-slate-500">
              {mode === 'in' ? 'Sign in to print your labels.' : 'Create an account to keep your labels.'}
            </p>
          </div>
        </div>

        {!configured && (
          <p role="alert" className="mb-4 rounded-xl bg-amber-50 p-3 text-xs text-amber-900 ring-1 ring-amber-200">
            The database is not configured. Copy <code>.env.example</code> to <code>.env</code>, fill in the
            Turso URL and token, and restart the dev server.
          </p>
        )}

        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1">
            <label htmlFor="username" className="text-sm font-medium text-slate-700">Username</label>
            <input id="username" autoFocus autoComplete="username" value={username} maxLength={MAX_USERNAME}
              disabled={busy || !configured} onChange={e => setUsername(e.target.value)}
              className={inputCls} />
          </div>

          <div className="space-y-1">
            <label htmlFor="password" className="text-sm font-medium text-slate-700">Password</label>
            <input id="password" type="password" value={password}
              autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
              disabled={busy || !configured} onChange={e => setPassword(e.target.value)}
              className={inputCls} />
            {mode === 'up' && <p className="text-xs text-slate-500">At least 4 characters.</p>}
          </div>

          {error && (
            <p role="alert" className="alert-shake break-words rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">
              {error}
            </p>
          )}

          <button type="submit" disabled={busy || !configured || !username.trim() || !password}
            className="w-full cursor-pointer rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50">
            {busy ? 'Please wait…' : mode === 'in' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <button onClick={swap} disabled={busy || !configured}
          className="mt-3 w-full cursor-pointer rounded-full border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">
          {mode === 'in' ? 'Need an account? Sign up' : 'Already have an account? Sign in'}
        </button>
      </div>
    </main>
  );
}
