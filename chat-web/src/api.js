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
  const res = await fetch(`${API_URL}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
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
