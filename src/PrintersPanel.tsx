import { useCallback, useEffect, useState } from 'react';
import {
  type DiscoveredPrinter,
  deletePrinter,
  discoverPrinters,
  listDevices,
  listSavedPrinters,
  type PickableDevice,
  type PrinterKind,
  type PrinterLanguage,
  type SavedPrinter,
  savePrinter,
  testPrinter,
} from './printApi';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const fieldCls =
  'w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm transition ' +
  'focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:bg-slate-100';

const EMPTY: SavedPrinter = {
  name: '',
  kind: 'ipp',
  host: '',
  port: 631,
  path: '/ipp/print',
  language: 'auto',
  dpi: 203,
};

const KIND_LABEL: Record<PrinterKind, string> = {
  ipp: 'Wi-Fi / LAN: IPP (port 631)',
  raw: 'Wi-Fi / LAN: raw socket (port 9100)',
  bluetooth: 'Bluetooth',
  usb: 'USB (OTG cable)',
};

const LANGUAGES: Record<PrinterKind, { value: PrinterLanguage; label: string }[]> = {
  ipp: [
    { value: 'auto', label: 'Automatic (PDF, or bitmap if the printer has no PDF)' },
    { value: 'pdf', label: 'PDF only' },
    { value: 'pwg', label: 'Bitmap (PWG raster)' },
  ],
  raw: [
    { value: 'pdf', label: 'PDF as-is' },
    { value: 'zpl', label: 'ZPL (Zebra and compatibles)' },
    { value: 'tspl', label: 'TSPL (TSC, Xprinter, ...)' },
    { value: 'escpos', label: 'ESC/POS (receipt printers)' },
    { value: 'cpcl', label: 'CPCL (Zebra / Brother mobile)' },
  ],
  bluetooth: [
    { value: 'escpos', label: 'ESC/POS (receipt printers)' },
    { value: 'zpl', label: 'ZPL (Zebra and compatibles)' },
    { value: 'tspl', label: 'TSPL (TSC, Xprinter, ...)' },
    { value: 'cpcl', label: 'CPCL (Zebra / Brother mobile)' },
  ],
  usb: [
    { value: 'escpos', label: 'ESC/POS (receipt printers)' },
    { value: 'zpl', label: 'ZPL (Zebra and compatibles)' },
    { value: 'tspl', label: 'TSPL (TSC, Xprinter, ...)' },
    { value: 'cpcl', label: 'CPCL (Zebra / Brother mobile)' },
  ],
};

const isDevice = (k: PrinterKind) => k === 'bluetooth' || k === 'usb';
/** Bitmap languages need the resolution the page is rendered at (IPP always uses 300 dpi). */
const usesDpi = (f: SavedPrinter) => (f.kind === 'raw' && f.language !== 'pdf') || isDevice(f.kind);

/**
 * Add / test / remove printers that print without a dialog: Wi-Fi/LAN (found automatically or typed
 * in), Bluetooth and USB. The app sends the page straight to the printer in a format it understands.
 */
export default function PrintersPanel({
  onChanged,
  disabled,
}: {
  onChanged: (selectName?: string) => void;
  disabled: boolean;
}) {
  const [saved, setSaved] = useState<SavedPrinter[]>([]);
  const [form, setForm] = useState<SavedPrinter>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [found, setFound] = useState<DiscoveredPrinter[] | null>(null);
  const [devices, setDevices] = useState<PickableDevice[] | null>(null);

  const refresh = useCallback(
    () =>
      listSavedPrinters()
        .then(setSaved)
        .catch((e) => setMsg({ ok: false, text: errMsg(e) })),
    [],
  );
  useEffect(() => {
    refresh();
  }, [refresh]);

  const set = <K extends keyof SavedPrinter>(k: K, v: SavedPrinter[K]) => setForm((f) => ({ ...f, [k]: v }));

  // Switching type resets what depends on it (port, path, language, address) so no stale value is saved.
  const setKind = (kind: PrinterKind) => {
    setDevices(null);
    setForm((f) => ({
      ...f,
      kind,
      host: kind === f.kind ? f.host : '',
      port: kind === 'ipp' ? 631 : kind === 'raw' ? 9100 : 0,
      path: kind === 'ipp' ? '/ipp/print' : '',
      language: LANGUAGES[kind][0].value,
    }));
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ ok: false, text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };

  const onSearch = () =>
    run(async () => {
      setFound(null);
      const list = await discoverPrinters();
      setFound(list);
      if (list.length === 0) {
        setMsg({
          ok: false,
          text: 'No printers answered. Check that the phone and printer are on the same Wi-Fi, or type the IP address below.',
        });
      }
    });

  const pickFound = (d: DiscoveredPrinter) => {
    setForm({
      ...EMPTY,
      name: d.name,
      kind: d.kind,
      host: d.host,
      port: d.port,
      path: d.path,
      language: d.kind === 'ipp' ? 'auto' : 'pdf',
    });
    setMsg(null);
  };

  const onLoadDevices = () =>
    run(async () => {
      if (!isDevice(form.kind)) return;
      const list = await listDevices(form.kind);
      setDevices(list);
      if (list.length === 0) {
        setMsg({
          ok: false,
          text:
            form.kind === 'bluetooth'
              ? 'No paired Bluetooth devices. Pair the printer in the Android settings first, then refresh.'
              : 'No USB printer found. Plug it in with an OTG cable, then refresh.',
        });
      }
    });

  const pickDevice = (id: string) => {
    const d = devices?.find((x) => x.id === id);
    setForm((f) => ({ ...f, host: id, name: f.name.trim() ? f.name : (d?.name ?? '') }));
  };

  const onTest = () =>
    run(async () => {
      const r = await testPrinter(form);
      setMsg({ ok: r.supportsPdf !== false, text: r.summary });
    });

  const onSave = () =>
    run(async () => {
      await savePrinter(form);
      await refresh();
      onChanged(form.name.trim());
      setMsg({
        ok: true,
        text: `Saved "${form.name.trim()}". It is now selectable above and prints without a dialog.`,
      });
      setForm(EMPTY);
      setDevices(null);
    });

  const onDelete = (name: string) =>
    run(async () => {
      await deletePrinter(name);
      await refresh();
      onChanged();
    });

  const off = busy || disabled;
  const hasTarget = form.host.trim().length > 0;

  return (
    <div className="space-y-3 pt-2">
      <p className="text-xs text-slate-500">
        Add a printer and the app sends the label straight to it, with no print dialog. Wi-Fi printers can be found
        automatically; Bluetooth printers must be paired in the Android settings first.
      </p>

      {saved.length > 0 && (
        <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200">
          {saved.map((p) => (
            <li key={p.name} className="rise-row flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <button
                type="button"
                className="min-w-0 flex-1 cursor-pointer text-left"
                disabled={off}
                onClick={() => {
                  setForm(p);
                  setDevices(null);
                  setMsg(null);
                }}
              >
                <span className="block truncate font-medium text-slate-900">{p.name}</span>
                <span className="block truncate text-xs text-slate-500">
                  {p.kind.toUpperCase()} ·{' '}
                  {isDevice(p.kind) ? p.host : `${p.host}:${p.port}${p.kind === 'ipp' ? p.path : ''}`} ·{' '}
                  {p.language.toUpperCase()}
                </span>
              </button>
              <button
                type="button"
                disabled={off}
                onClick={() => onDelete(p.name)}
                className="shrink-0 cursor-pointer text-xs text-red-600 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2 rounded-xl border border-slate-200 p-3">
        <button
          type="button"
          onClick={onSearch}
          disabled={off}
          className="w-full cursor-pointer rounded-xl border border-indigo-300 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy && found === null ? 'Searching… 🔍' : '📡 Find Wi-Fi printers'}
        </button>
        {found && found.length > 0 && (
          <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
            {found.map((d) => (
              <li key={`${d.kind}-${d.name}-${d.host}`} className="rise-row">
                <button
                  type="button"
                  disabled={off}
                  onClick={() => pickFound(d)}
                  className="block w-full cursor-pointer px-3 py-2 text-left text-sm hover:bg-slate-50"
                >
                  <span className="block truncate font-medium text-slate-900">{d.name}</span>
                  <span className="block truncate text-xs text-slate-500">
                    {d.kind === 'ipp' ? 'IPP' : 'Raw socket'} · {d.host}:{d.port}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <label className="block text-xs font-medium text-slate-700">
          Name
          <input
            className={`${fieldCls} mt-0.5`}
            value={form.name}
            disabled={off}
            placeholder="Label printer"
            onChange={(e) => set('name', e.target.value)}
          />
        </label>

        <label className="block text-xs font-medium text-slate-700">
          Connection
          <select
            className={`${fieldCls} mt-0.5 cursor-pointer`}
            value={form.kind}
            disabled={off}
            onChange={(e) => setKind(e.target.value as PrinterKind)}
          >
            {(Object.keys(KIND_LABEL) as PrinterKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>

        {isDevice(form.kind) ? (
          <div className="space-y-1">
            <div className="flex gap-2">
              <select
                className={`${fieldCls} cursor-pointer`}
                value={form.host}
                disabled={off || !devices?.length}
                aria-label={form.kind === 'bluetooth' ? 'Paired Bluetooth printer' : 'USB printer'}
                onChange={(e) => pickDevice(e.target.value)}
              >
                <option value="">{devices === null ? 'Tap Refresh to list devices' : 'Choose a device'}</option>
                {devices?.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.id})
                  </option>
                ))}
                {/* a saved printer's address stays visible even before the list is loaded */}
                {hasTarget && !devices?.some((d) => d.id === form.host) && (
                  <option value={form.host}>{form.host}</option>
                )}
              </select>
              <button
                type="button"
                onClick={onLoadDevices}
                disabled={off}
                className="shrink-0 cursor-pointer rounded-xl border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Refresh
              </button>
            </div>
            <p className="text-xs text-slate-500">
              {form.kind === 'bluetooth'
                ? 'Only classic Bluetooth (serial) printers work. Pair it in the Android settings first; Android asks for "Nearby devices" access.'
                : 'Plug the printer into the phone with an OTG cable. Android asks once to allow the app to use it.'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <label className="col-span-2 block text-xs font-medium text-slate-700">
              IP address or host name
              <input
                className={`${fieldCls} mt-0.5`}
                value={form.host}
                disabled={off}
                placeholder="192.168.1.50"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                inputMode="url"
                onChange={(e) => set('host', e.target.value)}
              />
            </label>
            <label className="block text-xs font-medium text-slate-700">
              Port
              <input
                type="number"
                min={1}
                max={65535}
                className={`${fieldCls} mt-0.5`}
                value={form.port}
                disabled={off}
                onChange={(e) => set('port', Math.max(0, Math.min(65535, Math.floor(+e.target.value) || 0)))}
              />
            </label>
            {form.kind === 'ipp' && (
              <label className="block text-xs font-medium text-slate-700">
                IPP path
                <input
                  className={`${fieldCls} mt-0.5`}
                  value={form.path}
                  disabled={off}
                  placeholder="/ipp/print"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => set('path', e.target.value)}
                />
              </label>
            )}
          </div>
        )}

        <label className="block text-xs font-medium text-slate-700">
          What to send
          <select
            className={`${fieldCls} mt-0.5 cursor-pointer`}
            value={form.language}
            disabled={off}
            onChange={(e) => set('language', e.target.value as PrinterLanguage)}
          >
            {LANGUAGES[form.kind].map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </label>

        {usesDpi(form) && (
          <label className="block text-xs font-medium text-slate-700">
            Printer resolution (dpi)
            <input
              type="number"
              min={72}
              max={1200}
              className={`${fieldCls} mt-0.5`}
              value={form.dpi}
              disabled={off}
              onChange={(e) => set('dpi', Math.max(0, Math.min(1200, Math.floor(+e.target.value) || 0)))}
            />
            <span className="mt-0.5 block font-normal text-slate-500">
              Usually 203 (8 dots/mm) or 300 (12 dots/mm). The label is drawn at this resolution and keeps its own size.
            </span>
          </label>
        )}

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onTest}
            disabled={off || !hasTarget}
            className="cursor-pointer rounded-xl border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Test
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={off || !hasTarget || !form.name.trim()}
            className="cursor-pointer rounded-xl bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            Save printer
          </button>
        </div>
      </div>

      {msg && (
        <p
          key={msg.text}
          role={msg.ok ? 'status' : 'alert'}
          className={
            (msg.ok ? 'result-in ' : 'alert-shake ') +
            'rounded-xl border p-2 text-xs break-words ' +
            (msg.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700')
          }
        >
          {msg.text}
        </p>
      )}
    </div>
  );
}
