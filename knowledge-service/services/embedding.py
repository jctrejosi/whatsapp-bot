"""Embedding service — HashingVectorizer (stateless, fixed dimensions)."""

from sklearn.feature_extraction.text import HashingVectorizer
from sklearn.preprocessing import normalize

VECTOR_DIM = 512  # Fixed dimension — stateless, always consistent

_vectorizer: HashingVectorizer | None = None


def _get_vectorizer() -> HashingVectorizer:
    global _vectorizer
    if _vectorizer is None:
        _vectorizer = HashingVectorizer(
            n_features=VECTOR_DIM,
            ngram_range=(1, 2),
            strip_accents="unicode",
            lowercase=True,
            alternate_sign=False,  # positive-only counts for cosine
            norm=None,             # we normalize manually after
        )
    return _vectorizer


async def embed_texts(texts: list[str]) -> list[list[float]]:
    """
    Generate hashing-based embeddings for a batch of texts.
    Stateless — same text always produces the same vector.
    Dimension is always VECTOR_DIM (512).
    """
    if not texts:
        return []

    vec = _get_vectorizer()
    matrix = vec.transform(texts)
    # L2-normalize so cosine similarity via pgvector <=> works correctly
    matrix = normalize(matrix, norm="l2")
    return [row.toarray()[0].tolist() for row in matrix]


async def embed_text(text: str) -> list[float]:
    """Generate a single embedding vector."""
    results = await embed_texts([text])
    return results[0]


async def close_client() -> None:
    """No-op for local model."""
    pass
