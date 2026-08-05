// ============================================================================
// Gestión de bots — persistencia en PostgreSQL (tabla bots).
// ============================================================================
const crypto = require('crypto');
const { query } = require('./db');

/** Lista todos los bots. */
async function listBots() {
  const { rows } = await query('SELECT id, name, description, icon, created_at FROM bots ORDER BY created_at DESC');
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    icon: r.icon || '🤖',
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  }));
}

/** Crea un bot nuevo e inicializa sus settings por defecto. */
async function createBot({ name, description = '', icon }) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const botIcon = (icon || '🤖').trim().slice(0, 10) || '🤖';

  await query(
    'INSERT INTO bots (id, name, description, icon, created_at) VALUES ($1, $2, $3, $4, $5)',
    [id, name.trim(), description.trim(), botIcon, now]
  );

  // Inicializa settings por defecto (hereda del global)
  const { getSettings } = require('./settings');
  await getSettings(id); // touch para crear la fila con defaults

  const settings = await getSettings(id);
  return { bot: { id, name: name.trim(), description: description.trim(), icon: botIcon, createdAt: now }, settings };
}

/** Elimina un bot y sus settings (CASCADE lo hace automático). */
async function deleteBot(id) {
  const result = await query('DELETE FROM bots WHERE id = $1', [id]);
  if (result.rowCount === 0) throw new Error('Bot no encontrado');

  const { clearSettingsCache } = require('./settings');
  clearSettingsCache(id);
}

/** Actualiza nombre/descripción/ícono de un bot. */
async function updateBot(id, { name, description, icon }) {
  const sets = [];
  const params = [];
  let p = 1;

  if (name !== undefined) {
    sets.push(`name = $${p++}`);
    params.push(name.trim());
  }
  if (description !== undefined) {
    sets.push(`description = $${p++}`);
    params.push((description || '').trim());
  }
  if (icon !== undefined) {
    sets.push(`icon = $${p++}`);
    params.push((icon || '🤖').trim().slice(0, 10) || '🤖');
  }

  if (sets.length === 0) {
    const { rows } = await query('SELECT id, name, description, icon, created_at FROM bots WHERE id = $1', [id]);
    if (rows.length === 0) throw new Error('Bot no encontrado');
    return rows[0];
  }

  params.push(id);
  const { rows } = await query(
    `UPDATE bots SET ${sets.join(', ')} WHERE id = $${p} RETURNING id, name, description, icon, created_at`,
    params
  );

  if (rows.length === 0) throw new Error('Bot no encontrado');
  const r = rows[0];
  return { id: r.id, name: r.name, description: r.description, icon: r.icon || '🤖', createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at };
}

module.exports = { listBots, createBot, deleteBot, updateBot };
