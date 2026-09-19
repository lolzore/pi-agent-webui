// Defaults for the Pi Agent bridge.
//
// Platform matters here: on Windows the app runs on the same machine as the
// bridge, so `localhost` is right and needs no setup prompt. A phone is a
// different machine, so it needs the PC's LAN address.
import { Platform } from 'react-native';

const LAN_IP = '192.168.1.39';

export const DEFAULT_HOST = Platform.OS === 'windows' ? 'localhost' : LAN_IP;
export const DEFAULT_PORT = 3080;

/** Build the ws:// URL for a host/port pair. */
export function wsUrl(host, port) {
  const h = String(host || '').trim().replace(/^wss?:\/\//i, '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const p = String(port || '').trim() || '3080';
  return `ws://${h}:${p}/ws`;
}

/** HTTP base derived from the same host/port (bridge REST endpoints). */
export function httpUrl(host, port) {
  const h = String(host || '').trim().replace(/^wss?:\/\//i, '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const p = String(port || '').trim() || '3080';
  return `http://${h}:${p}`;
}
