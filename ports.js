/**
 * Local service ports — package-owned (standalone). Keep in sync with
 * gateway/ports.js and Swift AppPorts when changing numbers.
 */
export const PORTS = Object.freeze({
  TTS_PORT: 1314,
  STT_PORT: 1315,
  LLM_PORT: 1316,
  GATEWAY_PORT: 1317,
  AX_PORT: 1319,
});

export const AX_PORT = PORTS.AX_PORT;
export const LLM_PORT = PORTS.LLM_PORT;
