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
    // One bordered panel. The Data source form inside it is the `compact` variant, which draws no
    // border or background of its own: a card inside a card read as noise.
    <details open={fetched} className="card-quiet mb-3 px-3 py-2.5">
      {/* Named by test id rather than left to find by its text: the Guide page explains this same
          feature by name, and every tab stays mounted, so a page-wide text match finds two. */}
      <summary data-testid="test-api-summary" className="cursor-pointer text-body font-medium text-slate-700">
        Test with a real API
        {fetched && (
          <span className="ml-2 text-label font-normal text-emerald-700">
            {(sample ?? []).length} record(s) fetched
          </span>
        )}
      </summary>

      <div className="mt-3 space-y-3">
        {/* Its own test id because the Data source card nested below repeats "not saved with the
            label", and a test that wants this sentence has to be able to say which one it means. */}
        <p data-testid="test-api-note" className="field-hint mt-0">
          Give an address to fetch records from, so the preview shows real values instead of your placeholders. This is
          not saved with the label, which keeps only which path of a record each field needs.
        </p>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setApi({ ...emptyApi, url: MOCK_PRODUCTS_URL, listPath: MOCK_LIST_PATH })}
          >
            Use the sample API
          </button>
          {fetched && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                onSample(null);
                setApi(emptyApi);
                setChecked(false);
              }}
            >
              Forget these records
            </button>
          )}
        </div>

        <DataSourceCard
          api={api}
          onChange={setApi}
          remembered={{}}
          copies={1}
          variant="compact"
          onRecords={(records) => {
            setChecked(true);
            onSample(records);
          }}
        />
      </div>
    </details>
  );
}
