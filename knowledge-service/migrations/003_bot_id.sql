-- ============================================================================
-- Bots ↔ Knowledge: vinculación de fuentes de conocimiento a bots.
-- La columna bot_id permite filtrar fuentes por bot (list_sources, ingest).
-- Idempotente: puede ejecutarse múltiples veces sin romper nada.
-- ============================================================================

-- ─── knowledge_sources.bot_id ────────────────────────────────────────────────

ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS bot_id uuid;

CREATE INDEX IF NOT EXISTS idx_sources_bot ON knowledge_sources (bot_id);
