/**
 * Talking to the backend about the print API: its settings, and the list of calls it has seen.
 *
 * Separate from `snippets.ts` because this is the app asking the backend, and from the page itself
 * because the page then talks to the API over real HTTP -- the same way anybody else does.
 */

import { invoke } from '@tauri-apps/api/core';

export type ApiSettings = {
  enabled: boolean;
  port: number;
  token: string;
  allowedOrigins: string[];
};

/** What the backend says about the server right now. */
export type ApiStatus = {
  /** False on Android, where there is no server. */
  available: boolean;
  running: boolean;
  port: number;
  baseUrl: string;
  /** Why it is not running, when it is not. Empty while it is. */
  problem: string;
  settings: ApiSettings;
};

/** One request the server handled, for the recent-calls list. */
export type RecentCall = {
  /** A counter, unique and stable for the life of the app. Used as the list key. */
  seq: number;
  at: number;
  method: string;
  path: string;
  status: number;
  ms: number;
};

export const getStatus = () => invoke<ApiStatus>('api_status');
export const setSettings = (settings: ApiSettings) => invoke<ApiStatus>('api_set_settings', { settings });
export const regenerateToken = () => invoke<ApiStatus>('api_regenerate_token');
export const getRecent = () => invoke<RecentCall[]>('api_recent');

/** A stand-in for builds with no server, so the page can render the same way everywhere. */
export const UNAVAILABLE: ApiStatus = {
  available: false,
  running: false,
  port: 0,
  baseUrl: '',
  problem: 'The print API is only available in the desktop app.',
  settings: { enabled: false, port: 0, token: '', allowedOrigins: [] },
};
