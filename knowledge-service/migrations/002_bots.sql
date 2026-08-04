-- ============================================================================
-- Bots & Bot Settings — multi-tenant bot configuration
-- ============================================================================

-- ─── bots ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bots (
    id          UUID PRIMARY KEY,
    name        VARCHAR(200) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── bot_settings ────────────────────────────────────────────────────────────
-- One row per bot (bot_id = bot UUID) + one row for global defaults (bot_id IS NULL).
-- The global row acts as fallback for any bot that doesn't override a setting.

CREATE TABLE IF NOT EXISTS bot_settings (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bot_id      UUID REFERENCES bots(id) ON DELETE CASCADE,
    settings    JSONB NOT NULL DEFAULT '{}',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ensure at most one global settings row (bot_id IS NULL)
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_settings_global
    ON bot_settings ((bot_id IS NULL)) WHERE bot_id IS NULL;

-- Ensure at most one settings row per bot
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_settings_bot
    ON bot_settings (bot_id) WHERE bot_id IS NOT NULL;

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_bot_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
    CREATE TRIGGER trg_bot_settings_updated_at
        BEFORE UPDATE ON bot_settings
        FOR EACH ROW EXECUTE FUNCTION update_bot_settings_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
