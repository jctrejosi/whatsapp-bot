// ============================================================================
// Gestión de bots — persistencia en data/bots.json + settings por bot
// ============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BOTS_FILE = path.join(DATA_DIR, 'bots.json');

function load() {
  try {
    if (fs.existsSync(BOTS_FILE)) return JSON.parse(fs.readFileSync(BOTS_FILE, 'utf8'));
  } catch (e) { /* corrupto, se regenera */ }
  return [];
}

function save(bots) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(BOTS_FILE, JSON.stringify(bots, null, 2));
}

/** Lista todos los bots (sin datos sensibles). */
function listBots() {
  return load().map((b) => ({ id: b.id, name: b.name, description: b.description, createdAt: b.createdAt }));
}

/** Crea un bot nuevo y inicializa sus settings por defecto. */
function createBot({ name, description = '' }) {
  const bots = load();
  const bot = {
    id: crypto.randomUUID(),
    name: name.trim(),
    description: description.trim(),
    createdAt: new Date().toISOString(),
  };
  bots.push(bot);
  save(bots);

  // Inicializa settings por defecto para este bot (hereda del global si existe)
  const { getSettings } = require('./settings');
  const globalSettings = getSettings();
  const botSettings = getSettings(bot.id);
  // Mezcla: global defaults + cualquier override del bot (inicialmente nada)
  getSettings(bot.id); // touch para crear archivo con defaults

  return { bot, settings: botSettings };
}

/** Elimina un bot y sus settings. */
function deleteBot(id) {
  const bots = load().filter((b) => b.id !== id);
  save(bots);
  const dir = path.join(DATA_DIR, `bot-${id}`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  // Limpia caché de settings
  const { clearSettingsCache } = require('./settings');
  clearSettingsCache(id);
  return true;
}

/** Actualiza nombre/descripción de un bot. */
function updateBot(id, { name, description }) {
  const bots = load();
  const bot = bots.find((b) => b.id === id);
  if (!bot) throw new Error('Bot no encontrado');
  if (name !== undefined) bot.name = name.trim();
  if (description !== undefined) bot.description = (description || '').trim();
  save(bots);
  return bot;
}

module.exports = { listBots, createBot, deleteBot, updateBot };
