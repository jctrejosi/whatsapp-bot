-- ============================================================================
-- Cloudinary URL: guarda la URL de Cloudinary para descarga persistente.
-- El archivo local (uploads/) se borra en cada deploy en Render, así que
-- el download se sirve desde Cloudinary cuando existe esta URL.
-- Idempotente: puede ejecutarse múltiples veces sin romper nada.
-- ============================================================================

ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS cloudinary_url TEXT;
