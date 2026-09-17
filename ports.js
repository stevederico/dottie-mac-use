/**
 * Local service ports — package-owned (standalone).
 * Consumers that share a machine with Dottie.app should keep these numbers.
 */
export const PORTS = Object.freeze({
  AX_PORT: 1319,
  MAC_USE_HTTP_PORT: 1321,
});

export const AX_PORT = PORTS.AX_PORT;
export const MAC_USE_HTTP_PORT = PORTS.MAC_USE_HTTP_PORT;
