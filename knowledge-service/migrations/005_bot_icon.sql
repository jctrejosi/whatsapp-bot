-- ============================================================================
-- Bot icon: emoji por bot para mostrar en sidebar, header y modal.
-- Idempotente: puede ejecutarse múltiples veces sin romper nada.
-- ============================================================================

ALTER TABLE bots ADD COLUMN IF NOT EXISTS icon VARCHAR(10) NOT NULL DEFAULT '🤖';
