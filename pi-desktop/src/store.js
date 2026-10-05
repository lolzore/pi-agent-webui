// Tiny AsyncStorage-backed settings store for the standalone app.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_HOST, DEFAULT_PORT } from './config';

const KEY = 'piagent.settings.v1';

export const DEFAULTS = {
  host: DEFAULT_HOST,
  port: String(DEFAULT_PORT),
  shortsProvider: 'instagram',
  // RN-app only: open the shorts feed automatically when the agent starts
  // running, and close it again once the agent is fully settled.
  autoOpenShorts: false,
  // No first-run prompt: on Windows the bridge is on localhost, and the
  // address is editable from the unreachable screen or the settings modal.
  setupDone: true,
};

/** Load settings, merged over defaults. Never throws. */
export async function loadSettings() {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Persist a partial settings patch. Never throws.
 *
 * Reads the current settings straight out of storage rather than through
 * loadSettings(), so a save cannot interleave with a load that started before it
 * and write back a stale copy.
 *
 * Returns the merged settings on success, and null on failure. null is
 * deliberate: the caller in App.js tests it and shows "Could not save settings."
 * Returning DEFAULTS here instead made that check unreachable, so a failed save
 * looked like it worked and quietly reset the host the user had just typed to
 * localhost.
 */
export async function saveSettings(patch) {
  try {
    // Read current settings directly to avoid race condition
    let current;
    try {
      const raw = await AsyncStorage.getItem(KEY);
      current = raw ? JSON.parse(raw) : {};
      if (!current || typeof current !== 'object') current = {};
    } catch {
      current = {};
    }
    const next = { ...DEFAULTS, ...current, ...patch };
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
    return next;
  } catch {
    return null;
  }
}
