import { useState } from 'react';
import PrintPage from './PrintPage';
import DesignerPage from './DesignerPage';

type Tab = 'print' | 'designer';

export default function App() {
  const [tab, setTab] = useState<Tab>('print');
  const tabCls = (t: Tab) =>
    'cursor-pointer border-b-2 px-4 py-2.5 text-sm font-medium transition ' +
    (tab === t
      ? 'border-indigo-600 text-indigo-700'
      : 'border-transparent text-slate-500 hover:text-slate-800');

  return (
    <div className="flex h-screen flex-col bg-slate-100">
      <nav className="flex gap-1 border-b border-slate-200 bg-white px-4">
        <button className={tabCls('print')} onClick={() => setTab('print')}>Print</button>
        <button className={tabCls('designer')} onClick={() => setTab('designer')}>Designer</button>
      </nav>
      {/* Both pages stay mounted so unsaved designer edits survive switching tabs. */}
      <div className="relative min-h-0 flex-1">
        <section className={'absolute inset-0 overflow-auto ' + (tab === 'print' ? '' : 'invisible')}>
          <PrintPage />
        </section>
        <section className={'absolute inset-0 ' + (tab === 'designer' ? '' : 'invisible')}>
          <DesignerPage />
        </section>
      </div>
    </div>
  );
}
