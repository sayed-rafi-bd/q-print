import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';

export type Capabilities = {
  platform: 'windows' | 'linux' | 'android' | 'other';
  transport: string;
  /** prints without showing a dialog */
  silent: boolean;
  paperSelect: boolean;
  orientationSelect: boolean;
  dpiSelect: boolean;
  /** false => the backend can't enumerate printers (an "Add printer" UI would be needed) */
  printerList: boolean;
  /** the user can add network printers (IPP / raw socket) that print without a dialog */
  directPrinters: boolean;
};

const CapabilitiesContext = createContext<Capabilities | null>(null);

/** Asks the Rust side once what the current platform's print backend can do. */
export function CapabilitiesProvider({ children }: { children: ReactNode }) {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    invoke<Capabilities>('capabilities').then(setCaps).catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <div role="alert" className="p-6 text-sm text-red-700 break-words">Could not read capabilities: {error}</div>;
  if (!caps) return <div className="flex h-dvh items-center justify-center text-sm text-slate-500">Loading…</div>;
  return <CapabilitiesContext.Provider value={caps}>{children}</CapabilitiesContext.Provider>;
}

export function useCapabilities(): Capabilities {
  const c = useContext(CapabilitiesContext);
  if (!c) throw new Error('useCapabilities must be used inside <CapabilitiesProvider>');
  return c;
}
