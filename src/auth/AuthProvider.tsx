import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { dbErrorMessage, getDb, isDbConfigured } from '../db/client';
import { createUser, findById, InvalidCredentialsError, UsernameTakenError, verifyPassword, type User } from '../db/users';

const SESSION_KEY = 'q-print.userId';

/**
 * Who is signed in, and how that is decided.
 *
 * There is no server, so there is no session token: the signed-in account is remembered by id in
 * localStorage and re-checked against the database on launch. If the row has gone, or the database
 * cannot be reached, the login screen comes back rather than a half-usable app.
 */
export type AuthStatus = 'loading' | 'signed-out' | 'signed-in';

export type AuthContextValue = {
  status: AuthStatus;
  user: User | null;
  /** False when the build has no database credentials. */
  configured: boolean;
  signIn: (username: string, password: string) => Promise<void>;
  signUp: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

/** Turns a failure into a message meant for the sign-in form, not a log. */
function authErrorMessage(e: unknown): string {
  if (e instanceof UsernameTakenError) return e.message;
  if (e instanceof InvalidCredentialsError) return e.message;
  return dbErrorMessage(e);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<User | null>(null);

  // Restore the previous sign-in, if the account is still there.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let id: string | null = null;
      try {
        id = localStorage.getItem(SESSION_KEY);
      } catch {
        id = null; // storage unavailable: ask again next time
      }
      if (!id || !isDbConfigured()) {
        if (!cancelled) setStatus('signed-out');
        return;
      }
      try {
        const found = await findById(getDb(), id);
        if (cancelled) return;
        if (found) {
          setUser(found);
          setStatus('signed-in');
        } else {
          // The account is gone; do not keep offering a sign-in that cannot work.
          localStorage.removeItem(SESSION_KEY);
          setStatus('signed-out');
        }
      } catch {
        if (!cancelled) setStatus('signed-out');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const adopt = useCallback((next: User) => {
    setUser(next);
    setStatus('signed-in');
    try { localStorage.setItem(SESSION_KEY, next.id); } catch { /* not critical: sign-in still works */ }
  }, []);

  const signIn = useCallback(async (username: string, password: string) => {
    const found = await verifyPassword(getDb(), username, password);
    if (!found) throw new Error('Wrong username or password.');
    adopt(found);
  }, [adopt]);

  const signUp = useCallback(async (username: string, password: string) => {
    adopt(await createUser(getDb(), username, password));
  }, [adopt]);

  const signOut = useCallback(async () => {
    try { localStorage.removeItem(SESSION_KEY); } catch { /* not critical */ }
    setUser(null);
    setStatus('signed-out');
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, configured: isDbConfigured(), signIn, signUp, signOut }),
    [status, user, signIn, signUp, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>.');
  return ctx;
}

export { authErrorMessage };
