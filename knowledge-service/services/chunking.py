"""Text chunking strategies."""

import re


def chunk_by_sections(text: str, max_chars: int = 800) -> list[str]:
    """
    Split text by semantic sections (double newlines, headings),
    merging small sections into larger chunks up to max_chars.
    """
    # Split by double newlines first (paragraph boundaries)
    raw_sections = re.split(r"\n{2,}", text)
    sections = [s.strip() for s in raw_sections if s.strip()]

    chunks: list[str] = []
    current: list[str] = []
    current_len = 0

    for section in sections:
        # Detect section headings (typically short lines ending with colon, or ALL CAPS lines)
        is_heading = (
            len(section) < 120
            and (section.isupper() or section.rstrip().endswith(":"))
        )

        if is_heading or current_len + len(section) > max_chars:
            # Flush current chunk
            if current:
                chunks.append("\n\n".join(current))
            current = [section]
            current_len = len(section)
        else:
            current.append(section)
            current_len += len(section)

    if current:
        chunks.append("\n\n".join(current))

    return chunks


def chunk_by_fixed_size(
    text: str, chunk_size: int = 600, overlap: int = 100
) -> list[str]:
    """Split text into fixed-size overlapping chunks."""
    chunks: list[str] = []
    start = 0

    while start < len(text):
        end = min(start + chunk_size, len(text))

        # Try to break at a natural boundary (newline or space)
        if end < len(text):
            for sep in ["\n\n", "\n", ". ", " "]:
                pos = text.rfind(sep, start, end)
                if pos > start + chunk_size // 2:
                    end = pos + len(sep)
                    break

        chunks.append(text[start:end].strip())
        start = end - overlap

    return chunks


def chunk_text(
    text: str,
    strategy: str = "sections",
    chunk_size: int = 600,
    overlap: int = 100,
) -> list[str]:
    """
    Split text into chunks using the specified strategy.

    Args:
        text: Full document text.
        strategy: 'sections' or 'fixed'.
        chunk_size: Max chars per chunk (for 'fixed' strategy) or max section group size.
        overlap: Overlap in chars (for 'fixed' strategy).
    """
    if strategy == "fixed":
        return chunk_by_fixed_size(text, chunk_size, overlap)
    return chunk_by_sections(text, max_chars=chunk_size)
