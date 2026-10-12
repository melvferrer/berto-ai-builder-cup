/**
 * Free-form health questions -> POST /api/llm (server/llm.js). The server decides the provider with
 * LLM_PROVIDER=local|vertex|off (local = MedGemma 1.5 4B via llama.cpp, pm2 'berto-llm'). The app asks
 * GET /api/llm/status at startup and falls back to the rule-based replies when the provider is off or down.
 * Safety rules (emergencies, dose questions) run on the phone first (shared/safety.js) and again on the server.
 */
export const LLM = {
  enabled: true,
  endpoint: '/api/llm',
  statusEndpoint: '/api/llm/status',
  timeoutMs: 30_000,
};
