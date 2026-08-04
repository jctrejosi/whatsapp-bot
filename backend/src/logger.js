// ============================================================================
// Buffer circular en memoria para los últimos logs del backend.
// (persiste el tiempo de vida del proceso; exportado vía GET /logs)
// ============================================================================

const MAX_LOGS = 200;
const logs = [];

function log(level, message, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data,
  };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();

  // También a consola para los logs de Render / Docker
  if (level === 'error') console.error(`[${entry.timestamp}] ${message}`, data);
  else console.log(`[${entry.timestamp}] ${message}`, data);

  return entry;
}

/** Devuelve una copia, del más reciente al más antiguo. */
function getLogs() {
  return [...logs].reverse();
}

module.exports = { log, getLogs };
