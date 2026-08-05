"""Embedding service — multilingual model for cross-lingual semantic matching.

Uses intfloat/multilingual-e5-small (~118 MB).
Supports 100+ languages including Spanish ↔ English natively.
"""

from sentence_transformers import SentenceTransformer

VECTOR_DIM = 384  # e5-small produces 384-dimensional embeddings

_model: SentenceTransformer | None = None


def _get_model() -> SentenceTransformer:
    global _model
    if _model is None:
        _model = SentenceTransformer(
            "intfloat/multilingual-e5-small",
            device="cpu",
        )
    return _model


async def embed_texts(texts: list[str]) -> list[list[float]]:
    """
    Generate multilingual embeddings for a batch of texts.
    Same text in different languages maps to similar vectors.
    Dimension is always VECTOR_DIM (384).
    """
    if not texts:
        return []

    model = _get_model()
    embeddings = model.encode(
        texts,
        normalize_embeddings=True,  # L2-normalized for cosine similarity
        show_progress_bar=False,
    )
    return [e.tolist() for e in embeddings]


async def embed_text(text: str) -> list[float]:
    """Generate a single embedding vector."""
    results = await embed_texts([text])
    return results[0]


async def close_client() -> None:
    """Release model from memory."""
    global _model
    _model = None
