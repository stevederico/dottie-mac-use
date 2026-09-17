/**
 * Local service ports — package-owned (standalone). Keep in sync with
 * gateway/ports.js and Swift AppPorts when changing numbers.
 */
export const PORTS = Object.freeze({
  TTS_PORT: 1314,
  STT_PORT: 1315,
  GATEWAY_PORT: 1317,
  AX_PORT: 1319,
  TALK_HTTP_PORT: 1320,
  MAC_USE_HTTP_PORT: 1321,
});

export const AX_PORT = PORTS.AX_PORT;
export const MAC_USE_HTTP_PORT = PORTS.MAC_USE_HTTP_PORT;
