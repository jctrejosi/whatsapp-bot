const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

async function handleResponse(res, fallback) {
  if (res.ok) return res.json();
  let msg = fallback;
  try {
    const body = await res.json();
    if (body.error) msg = body.error;
    if (body.detail) msg = body.detail;
  } catch {}
  throw new Error(msg);
}

export async function chat(query) {
  const res = await fetch(`${API_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, user_id: 'web', user_name: 'Admin' }),
  });
  return handleResponse(res, `Error ${res.status} al enviar mensaje`);
}

export async function getSources() {
  const res = await fetch(`${API_URL}/sources`);
  return handleResponse(res, `Error ${res.status} al cargar fuentes`);
}

export async function getSource(id) {
  const res = await fetch(`${API_URL}/sources/${id}`);
  return handleResponse(res, `Error ${res.status} al cargar fuente`);
}

export async function ingestPdf(file) {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`${API_URL}/ingest`, {
    method: 'POST',
    body: formData,
  });
  return handleResponse(res, `Error ${res.status} al subir archivo`);
}

export async function healthCheck() {
  try {
    const res = await fetch(`${API_URL}/health`);
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

export async function getSettings() {
  const res = await fetch(`${API_URL}/settings`);
  return handleResponse(res, `Error ${res.status} al cargar configuración`);
}

export async function updateSettings(patch) {
  const res = await fetch(`${API_URL}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  return handleResponse(res, `Error ${res.status} al guardar configuración`);
}

export async function resetSettings() {
  const res = await fetch(`${API_URL}/settings/reset`, { method: 'POST' });
  return handleResponse(res, `Error ${res.status} al restablecer configuración`);
}

export async function sendTestEmail() {
  const res = await fetch(`${API_URL}/settings/test-email`, { method: 'POST' });
  return handleResponse(res, `Error ${res.status} al enviar correo de prueba`);
}

// ── Multi-bot APIs ──────────────────────

export async function getBots() {
  const res = await fetch(`${API_URL}/bots`);
  return handleResponse(res, `Error ${res.status} al cargar bots`);
}

export async function createBot(name, description) {
  const res = await fetch(`${API_URL}/bots`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description }) });
  return handleResponse(res, `Error ${res.status} al crear bot`);
}

export async function deleteBot(id) {
  const res = await fetch(`${API_URL}/bots/${id}`, { method: 'DELETE' });
  return handleResponse(res, `Error ${res.status} al eliminar bot`);
}

export async function updateBot(id, data) {
  const res = await fetch(`${API_URL}/bots/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  return handleResponse(res, `Error ${res.status} al actualizar bot`);
}

export async function getBotSettings(id) {
  const res = await fetch(`${API_URL}/bots/${id}/settings`);
  return handleResponse(res, `Error ${res.status} al cargar settings`);
}

export async function updateBotSettings(id, patch) {
  const res = await fetch(`${API_URL}/bots/${id}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  return handleResponse(res, `Error ${res.status} al guardar settings`);
}

export async function resetBotSettings(id) {
  const res = await fetch(`${API_URL}/bots/${id}/settings/reset`, { method: 'POST' });
  return handleResponse(res, `Error ${res.status} al restablecer`);
}

export async function sendBotTestEmail(id) {
  const res = await fetch(`${API_URL}/bots/${id}/settings/test-email`, { method: 'POST' });
  return handleResponse(res, `Error ${res.status} al enviar correo de prueba`);
}

export async function botChat(id, query) {
  const res = await fetch(`${API_URL}/bots/${id}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, user_id: 'web', user_name: 'Admin' }) });
  return handleResponse(res, `Error ${res.status} al enviar mensaje`);
}

export async function getBotKnowledge(id) {
  const res = await fetch(`${API_URL}/bots/${id}/knowledge`);
  return handleResponse(res, `Error ${res.status} al cargar conocimiento`);
}

export async function uploadBotFile(id, file) {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`${API_URL}/bots/${id}/knowledge/upload`, { method: 'POST', body: fd });
  return handleResponse(res, `Error ${res.status} al subir archivo`);
}

export async function deleteBotSource(id, sourceId) {
  const res = await fetch(`${API_URL}/bots/${id}/knowledge/${sourceId}`, { method: 'DELETE' });
  return handleResponse(res, `Error ${res.status} al eliminar fuente`);
}
