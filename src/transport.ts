/**
 * transport.ts — QUIC native capability detection.
 *
 * Checks whether gann-sdk-quic-native is loadable at runtime.
 * When the native module is absent (wrong platform, ARM64, etc.) the
 * plugin falls back to relay-only mode instead of crashing.
 */

let _nativeAvailable: boolean | null = null;

export function isNativeQuicAvailable(): boolean {
  if (_nativeAvailable !== null) return _nativeAvailable;
  try {
    // Dynamic require — never bundled, resolved at runtime only.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("gann-sdk-quic-native");
    _nativeAvailable = true;
  } catch {
    _nativeAvailable = false;
  }
  return _nativeAvailable;
}

export function transportModeLabel(): string {
  return isNativeQuicAvailable() ? "direct-first (QUIC + relay fallback)" : "relay-only";
}
