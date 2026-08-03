-- ============================================================================
-- Knowledge Service — PostgreSQL + pgvector schema
-- ============================================================================

-- ─── Extensions ─────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- ─── Domain types ───────────────────────────────────────────────────────────

DO $$ BEGIN
    CREATE DOMAIN slug AS VARCHAR(200)
        CHECK (VALUE ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Enum types ─────────────────────────────────────────────────────────────

DO $$ BEGIN
    CREATE TYPE source_type AS ENUM ('file', 'url', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE ingestion_status AS ENUM (
        'pending',
        'extracting',
        'chunking',
        'embedding',
        'completed',
        'failed'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================================
-- TABLES
-- ============================================================================

-- ─── knowledge_sources ──────────────────────────────────────────────────────
-- Represents an original knowledge source (PDF file, URL, or manual text input).

CREATE TABLE IF NOT EXISTS knowledge_sources (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Polymorphic source
    source_type       source_type NOT NULL,
    title             VARCHAR(500) NOT NULL,
    description       TEXT,

    -- File upload
    original_filename VARCHAR(500),
    file_path         VARCHAR(1000),
    file_type         VARCHAR(50),
    file_size_bytes   BIGINT,

    -- URL
    url               VARCHAR(2000),

    -- Manual text
    raw_text          TEXT,

    -- Ingestion tracking
    status            ingestion_status NOT NULL DEFAULT 'pending',
    error_message     TEXT,
    retry_count       INT NOT NULL DEFAULT 0,

    -- Metadata (PDF author, tags, etc.)
    metadata          JSONB NOT NULL DEFAULT '{}',

    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sources_status ON knowledge_sources (status);
CREATE INDEX IF NOT EXISTS idx_sources_type  ON knowledge_sources (source_type);

-- ─── knowledge_documents ────────────────────────────────────────────────────
-- Full extracted text from a source. One source can have multiple documents
-- (e.g., multi-file uploads), but typically 1:1.

CREATE TABLE IF NOT EXISTS knowledge_documents (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_id   UUID NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,

    title       VARCHAR(500) NOT NULL,
    content     TEXT NOT NULL,

    page_count  INT,
    char_count  INT  NOT NULL,
    token_count INT,

    metadata    JSONB NOT NULL DEFAULT '{}',

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_documents_source ON knowledge_documents (source_id);

-- ─── knowledge_tags ─────────────────────────────────────────────────────────
-- Taxonomy tags for organizing documents (e.g., "pricing", "itinerary", "faq").

CREATE TABLE IF NOT EXISTS knowledge_tags (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name       VARCHAR(200) NOT NULL UNIQUE,
    slug       slug         NOT NULL UNIQUE,
    color      VARCHAR(7),                         -- hex color e.g. #FF5733

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Junction: documents <-> tags (many-to-many)
CREATE TABLE IF NOT EXISTS knowledge_document_tags (
    document_id UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    tag_id      UUID NOT NULL REFERENCES knowledge_tags(id)      ON DELETE CASCADE,
    PRIMARY KEY (document_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_doc_tags_tag ON knowledge_document_tags (tag_id);

-- ─── knowledge_chunks ───────────────────────────────────────────────────────
-- Text chunks created by splitting documents. Each chunk is independently
-- embeddable and searchable.

CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id       UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,

    chunk_index       INT  NOT NULL,               -- position within the document
    content           TEXT NOT NULL,

    char_count        INT  NOT NULL,
    token_count       INT,
    overlap_with_prev INT  NOT NULL DEFAULT 0,     -- overlap chars with previous chunk

    is_embedded       BOOLEAN NOT NULL DEFAULT FALSE, -- tracks whether embedding exists

    metadata          JSONB NOT NULL DEFAULT '{}',

    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chunks_document ON knowledge_chunks (document_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_doc_index ON knowledge_chunks (document_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_chunks_not_embedded ON knowledge_chunks (document_id, chunk_index)
    WHERE is_embedded = FALSE;

-- ─── knowledge_embeddings ───────────────────────────────────────────────────
-- Vector embeddings for each chunk. Uses pgvector's native VECTOR type.
-- Dimension is dynamic — set by the embedding model at insert time.

CREATE TABLE IF NOT EXISTS knowledge_embeddings (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chunk_id   UUID NOT NULL REFERENCES knowledge_chunks(id) ON DELETE CASCADE UNIQUE,

    embedding  VECTOR,                             -- e.g. vector(1536), vector(4096)

    model_name VARCHAR(200) NOT NULL,              -- e.g. "deepseek-embedding"
    model_version VARCHAR(100),                    -- model version for tracking
    dimension  INT NOT NULL,                       -- stored dimension for validation

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── ingestion_jobs ─────────────────────────────────────────────────────────
-- Tracks the lifecycle of an ingestion pipeline run.
-- Each source can have multiple job attempts (retries).

CREATE TABLE IF NOT EXISTS ingestion_jobs (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_id    UUID NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,

    status       ingestion_status NOT NULL DEFAULT 'pending',
    progress     INT  NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),

    attempt      INT  NOT NULL DEFAULT 1,          -- retry counter
    error_message TEXT,
    step_log     JSONB NOT NULL DEFAULT '[]',       -- [{timestamp, step, message}]

    started_at   TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ingestion_source   ON ingestion_jobs (source_id);
CREATE INDEX IF NOT EXISTS idx_ingestion_status   ON ingestion_jobs (status);
CREATE INDEX IF NOT EXISTS idx_ingestion_created  ON ingestion_jobs (created_at DESC);

-- ─── conversations ──────────────────────────────────────────────────────────
-- Optional: stores user-AI conversation history for analytics and context.

CREATE TABLE IF NOT EXISTS conversations (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    user_id     VARCHAR(100) NOT NULL,             -- WhatsApp phone number
    user_name   VARCHAR(200),

    message     TEXT NOT NULL,
    response    TEXT NOT NULL,

    chunks_used UUID[] NOT NULL DEFAULT '{}',      -- references knowledge_chunks(id)
    confidence  REAL,                              -- avg similarity score of chunks

    metadata    JSONB NOT NULL DEFAULT '{}',

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_user    ON conversations (user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations (created_at DESC);

-- ============================================================================
-- FUNCTIONS & TRIGGERS
-- ============================================================================

-- Auto-update updated_at on row modification
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
    CREATE TRIGGER trg_sources_updated_at
        BEFORE UPDATE ON knowledge_sources
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TRIGGER trg_documents_updated_at
        BEFORE UPDATE ON knowledge_documents
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Similarity search function ─────────────────────────────────────────────
-- Convenience function: returns top-K chunks for a query vector.

CREATE OR REPLACE FUNCTION search_chunks(
    query_embedding  VECTOR,
    top_k            INT    DEFAULT 5,
    min_similarity   REAL   DEFAULT 0.0
)
RETURNS TABLE (
    chunk_id        UUID,
    content         TEXT,
    document_title  VARCHAR,
    similarity      REAL
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        c.id,
        c.content,
        d.title::VARCHAR,
        (1 - (e.embedding <=> query_embedding))::REAL AS similarity
    FROM knowledge_embeddings e
    JOIN knowledge_chunks    c ON c.id = e.chunk_id
    JOIN knowledge_documents d ON d.id = c.document_id
    WHERE 1 - (e.embedding <=> query_embedding) >= min_similarity
    ORDER BY e.embedding <=> query_embedding
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- VECTOR INDEX (create after data is loaded for IVFFlat to train properly)
-- ============================================================================
-- Uncomment and run after inserting at least ~1000 rows:
--
-- CREATE INDEX idx_embeddings_ivfflat ON knowledge_embeddings
--     USING ivfflat (embedding vector_cosine_ops)
--     WITH (lists = 100);
