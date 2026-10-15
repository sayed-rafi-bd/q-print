/**
 * Whether the app is running inside the Tauri shell (Windows, Linux, Android) or as a plain web
 * page in a browser. Tauri injects `__TAURI_INTERNALS__` into the webview before the app loads;
 * a browser never has it, and every `invoke()` call fails there.
 */
export const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
