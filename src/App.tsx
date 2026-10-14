import { useEffect, useState } from 'react';
import PrintPage from './PrintPage';
import DesignerPage from './DesignerPage';
import { useCapabilities } from './capabilities';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import LoginPage from './auth/LoginPage';

type Tab = 'print' | 'designer';

// pdfme's Designer needs a large, pointer-driven screen. On Android it is tablet-only.
const DESIGNER_MIN_WIDTH = 768;

function useViewportWidth() {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}

function Workspace() {
  const { status, user } = useAuth();
  const { platform } = useCapabilities();
  const width = useViewportWidth();
  const designerAvailable = platform !== 'android' || width >= DESIGNER_MIN_WIDTH;

  const [chosen, setChosen] = useState<Tab>('print');
  const tab: Tab = designerAvailable ? chosen : 'print';
  const tabCls = (t: Tab) =>
    'cursor-pointer rounded-full px-5 py-1.5 text-sm font-semibold transition ' +
    (tab === t
      ? 'bg-indigo-500 text-white shadow-md shadow-indigo-300/60'
      : 'text-slate-500 hover:bg-indigo-100 hover:text-indigo-700');

  // Restoring the previous sign-in is the one thing that happens before there is a user to show.
  if (status === 'loading') {
    return (
      <div className="flex h-dvh items-center justify-center text-sm text-slate-500">
        <span className="text-4xl" style={{ animation: 'mascot-bounce 1.2s ease-in-out infinite' }} aria-hidden="true">🔐</span>
        Signing in…
      </div>
    );
  }

  if (status === 'signed-out' || !user) return <LoginPage />;

  return (
    // h-dvh (not h-screen) so the bottom is not clipped by Android's browser/navigation bars;
    // the env() padding keeps content clear of the status/navigation bars when drawn edge to edge.
    <div className="relative flex h-dvh flex-col"
      style={{ paddingTop: 'env(safe-area-inset-top, 0px)', paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
      {/* drifting pastel blobs behind everything */}
      <div className="blobs" aria-hidden="true">
        <div className="blob blob-a" />
        <div className="blob blob-b" />
        <div className="blob blob-c" />
      </div>

      <nav className="relative z-10 flex items-center gap-2 border-b border-slate-200/70 bg-white/60 px-4 py-2 backdrop-blur-md">
        <button className={tabCls('print')} onClick={() => setChosen('print')}>🖨️ Print</button>
        {designerAvailable && (
          <button className={tabCls('designer')} onClick={() => setChosen('designer')}>🎨 Designer</button>
        )}
        <span className="ml-auto text-xs text-slate-500">
          Signed in as <span className="font-semibold text-slate-700">{user.username}</span>
        </span>
      </nav>
      {/* Both pages stay mounted so unsaved designer edits survive switching tabs. */}
      <div className="relative z-10 min-h-0 flex-1">
        <section className={'absolute inset-0 overflow-auto ' + (tab === 'print' ? 'tab-enter' : 'tab-hidden')}>
          <PrintPage />
        </section>
        {designerAvailable && (
          <section className={'absolute inset-0 ' + (tab === 'designer' ? 'tab-enter' : 'tab-hidden')}>
            <DesignerPage />
          </section>
        )}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Workspace />
    </AuthProvider>
  );
}
