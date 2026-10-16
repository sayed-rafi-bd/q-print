import { lazy, Suspense, useEffect, useState } from 'react';
import ApiBridge from './api/ApiBridge';
import ApiPage from './api/ApiPage';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import LoginPage from './auth/LoginPage';
import { useCapabilities } from './capabilities';
import GuidePage from './GuidePage';
import PrintHistoryPage from './PrintHistoryPage';
import PrintPage from './PrintPage';

// The Designer is the heaviest part of the front end by a wide margin — pdfme's editor and the UI
// kit behind it are most of the bundle — and an Android phone cannot show it at all. Loading it on
// demand keeps it out of the initial download on every phone, and only on the tab that needs it.
const DesignerPage = lazy(() => import('./DesignerPage'));

type Tab = 'print' | 'designer' | 'history' | 'api' | 'guide';

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
  const { status, user, signOut } = useAuth();
  const { platform } = useCapabilities();
  const width = useViewportWidth();
  // The web build is Designer-only: printing needs the Rust side, which a browser does not have.
  const web = platform === 'web';
  const designerAvailable = web || platform !== 'android' || width >= DESIGNER_MIN_WIDTH;
  const printAvailable = !web;

  const [chosen, setChosen] = useState<Tab>(web ? 'designer' : 'print');
  // The Guide and the History are available everywhere: the Guide reads nothing, and the History is
  // local storage that works on every platform. A tab that is not offered on this device falls back
  // to the first one that is, so resizing a window never leaves a blank page.
  const offered: Record<Tab, boolean> = {
    print: printAvailable,
    designer: designerAvailable,
    history: true,
    // The API is the one thing a web build cannot have: there is no local server behind it.
    api: !web,
    guide: true,
  };
  const tab: Tab = offered[chosen] ? chosen : printAvailable ? 'print' : 'designer';
  const tabCls = (t: Tab) =>
    'cursor-pointer rounded-full px-3 py-1.5 text-sm font-semibold transition sm:px-5 ' +
    (tab === t
      ? 'bg-indigo-500 text-white shadow-md shadow-indigo-300/60'
      : 'text-slate-500 hover:bg-indigo-100 hover:text-indigo-700');

  // Restoring the previous sign-in is the one thing that happens before there is a user to show.
  if (status === 'loading') {
    return (
      <div className="flex h-dvh items-center justify-center text-sm text-slate-500">
        <span className="text-4xl" style={{ animation: 'mascot-bounce 1.2s ease-in-out infinite' }} aria-hidden="true">
          🔐
        </span>
        Signing in…
      </div>
    );
  }

  if (status === 'signed-out' || !user) return <LoginPage />;

  return (
    // h-dvh (not h-screen) so the bottom is not clipped by Android's browser/navigation bars;
    // the env() padding keeps content clear of the status/navigation bars when drawn edge to edge.
    <div
      className="relative flex h-dvh flex-col"
      style={{ paddingTop: 'env(safe-area-inset-top, 0px)', paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      {/* Answers the local print API. Mounted above everything, once, so it keeps working whatever
          tab is open and while the window is hidden in the tray. It renders nothing. */}
      <ApiBridge />

      {/* drifting pastel blobs behind everything */}
      <div className="blobs" aria-hidden="true">
        <div className="blob blob-a" />
        <div className="blob blob-b" />
        <div className="blob blob-c" />
      </div>

      {/* Wraps rather than overflows: the tabs keep their size, and the sign-in group drops to its own
          line when there is no room beside them. Inside it the name is what gives way (it truncates)
          while Sign out never shrinks, so it cannot be pushed off the screen. */}
      <nav className="relative z-10 flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-slate-200/70 bg-white/60 px-4 py-2 backdrop-blur-md">
        {printAvailable && (
          <button type="button" className={`${tabCls('print')} shrink-0`} onClick={() => setChosen('print')}>
            🖨️ Print
          </button>
        )}
        {designerAvailable && (
          <button type="button" className={`${tabCls('designer')} shrink-0`} onClick={() => setChosen('designer')}>
            🎨 Designer
          </button>
        )}
        <button type="button" className={`${tabCls('history')} shrink-0`} onClick={() => setChosen('history')}>
          🕘 History
        </button>
        {!web && (
          <button type="button" className={`${tabCls('api')} shrink-0`} onClick={() => setChosen('api')}>
            🔌 API
          </button>
        )}
        <button type="button" className={`${tabCls('guide')} shrink-0`} onClick={() => setChosen('guide')}>
          📖 Guide
        </button>
        <div className="ml-auto flex min-w-0 max-w-full items-center gap-2">
          <span className="min-w-0 truncate text-xs text-slate-500" title={user.username}>
            Signed in as <span className="font-semibold text-slate-700">{user.username}</span>
          </span>
          <button
            type="button"
            onClick={() => {
              void signOut();
            }}
            className="shrink-0 cursor-pointer rounded-full border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
          >
            Sign out
          </button>
        </div>
      </nav>
      {/* Both pages stay mounted so unsaved designer edits survive switching tabs; once the
          Designer chunk has been loaded once, `lazy` keeps it. */}
      <div className="relative z-10 min-h-0 flex-1">
        {printAvailable && (
          <section className={`absolute inset-0 overflow-auto ${tab === 'print' ? 'tab-enter' : 'tab-hidden'}`}>
            <PrintPage active={tab === 'print'} />
          </section>
        )}
        {designerAvailable && (
          // The Designer scrolls vertically on a short screen (its canvas has a minimum height); sideways
          // it never does, so a wide child cannot give the whole page a horizontal scrollbar.
          <section
            className={`absolute inset-0 overflow-x-hidden overflow-y-auto ${tab === 'designer' ? 'tab-enter' : 'tab-hidden'}`}
          >
            <Suspense fallback={<DesignerLoading />}>
              <DesignerPage />
            </Suspense>
          </section>
        )}
        <section className={`absolute inset-0 overflow-auto ${tab === 'history' ? 'tab-enter' : 'tab-hidden'}`}>
          <PrintHistoryPage active={tab === 'history'} />
        </section>
        {!web && (
          <section className={`absolute inset-0 overflow-auto ${tab === 'api' ? 'tab-enter' : 'tab-hidden'}`}>
            <ApiPage />
          </section>
        )}
        <section className={`absolute inset-0 overflow-auto ${tab === 'guide' ? 'tab-enter' : 'tab-hidden'}`}>
          <GuidePage />
        </section>
      </div>
    </div>
  );
}

/** Shown for the moment the Designer chunk is arriving. */
function DesignerLoading() {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-500">
      <span className="text-4xl" style={{ animation: 'mascot-bounce 1.2s ease-in-out infinite' }} aria-hidden="true">
        🎨
      </span>
      Loading designer…
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
