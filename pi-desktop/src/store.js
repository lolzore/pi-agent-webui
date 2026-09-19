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

/** Persist a partial settings patch. Never throws. */
export async function saveSettings(patch) {
  try {
    const current = await loadSettings();
    const next = { ...current, ...patch };
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
    return next;
  } catch {
    return null;
  }
}
