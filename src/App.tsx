import { useEffect, useState } from 'react';
import PrintPage from './PrintPage';
import DesignerPage from './DesignerPage';
import { useCapabilities } from './capabilities';

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

export default function App() {
  const { platform } = useCapabilities();
  const width = useViewportWidth();
  const designerAvailable = platform !== 'android' || width >= DESIGNER_MIN_WIDTH;

  const [chosen, setChosen] = useState<Tab>('print');
  const tab: Tab = designerAvailable ? chosen : 'print';
  const tabCls = (t: Tab) =>
    'cursor-pointer border-b-2 px-4 py-2.5 text-sm font-medium transition ' +
    (tab === t
      ? 'border-indigo-600 text-indigo-700'
      : 'border-transparent text-slate-500 hover:text-slate-800');

  return (
    // h-dvh (not h-screen) so the bottom is not clipped by Android's browser/navigation bars;
    // the env() padding keeps content clear of the status/navigation bars when drawn edge to edge.
    <div className="flex h-dvh flex-col bg-slate-100"
      style={{ paddingTop: 'env(safe-area-inset-top, 0px)', paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
      <nav className="flex gap-1 border-b border-slate-200 bg-white px-4">
        <button className={tabCls('print')} onClick={() => setChosen('print')}>Print</button>
        {designerAvailable && (
          <button className={tabCls('designer')} onClick={() => setChosen('designer')}>Designer</button>
        )}
      </nav>
      {/* Both pages stay mounted so unsaved designer edits survive switching tabs. */}
      <div className="relative min-h-0 flex-1">
        <section className={'absolute inset-0 overflow-auto ' + (tab === 'print' ? '' : 'invisible')}>
          <PrintPage />
        </section>
        {designerAvailable && (
          <section className={'absolute inset-0 ' + (tab === 'designer' ? '' : 'invisible')}>
            <DesignerPage />
          </section>
        )}
      </div>
    </div>
  );
}
