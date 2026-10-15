import { useState } from 'react';
import DataSourceCard, { type ApiState, emptyApi } from '../DataSourceCard';
import { MOCK_LIST_PATH, MOCK_PRODUCTS_URL } from '../generator/mockApi';

/**
 * Testing a label against a real API while designing.
 *
 * The address is typed here and goes nowhere: it is not part of the label, not saved with it and
 * not exported with it. It exists only so a preview can show real values instead of placeholders,
 * and it is dropped as soon as another label is opened. That is the whole difference from the Print
 * tab, which asks for the same thing but for a job that actually goes to a printer.
 */
export default function TestApiSection({
  sample,
  onSample,
}: {
  /** The records last fetched here, or null. The Data tab previews with them. */
  sample: unknown[] | null;
  onSample: (records: unknown[] | null) => void;
}) {
  // Starting empty on purpose: a label carries no address, so there is nothing to restore.
  const [api, setApi] = useState<ApiState>(emptyApi);
  // Set when a check succeeds, because the records have to stay while the panel is folded away.
  const [checked, setChecked] = useState(false);

  const fetched = checked && sample !== null;

  return (
    <details open={fetched} className="mb-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium text-slate-700">
        Test with a real API
        {fetched && (
          <span className="ml-2 text-xs font-normal text-emerald-700">{(sample ?? []).length} record(s) fetched</span>
        )}
      </summary>

      <p className="mt-2 text-xs text-slate-600">
        Give an address to fetch records from, so the preview shows real values instead of your placeholders. This is
        not saved with the label, which keeps only which path of a record each field needs.
      </p>

      <button
        type="button"
        className="mt-2 cursor-pointer rounded-full border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
        onClick={() => setApi({ ...emptyApi, url: MOCK_PRODUCTS_URL, listPath: MOCK_LIST_PATH })}
      >
        Use the sample API
      </button>

      <div className="mt-2">
        <DataSourceCard
          api={api}
          onChange={setApi}
          remembered={{}}
          copies={1}
          onRecords={(records) => {
            setChecked(true);
            onSample(records);
          }}
        />
      </div>

      {fetched && (
        <button
          type="button"
          className="mt-2 cursor-pointer rounded-full border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
          onClick={() => {
            onSample(null);
            setApi(emptyApi);
            setChecked(false);
          }}
        >
          Forget these records
        </button>
      )}
    </details>
  );
}
