"""Recursive character splitting.

Splits on the largest natural boundary that fits (paragraph, line, sentence, word),
then packs pieces into chunks of about `size` characters with `overlap` characters
carried over, so a fact spanning a boundary still appears whole in one chunk.
"""
from __future__ import annotations

from dataclasses import dataclass

# Markdown headings first, so a chunk tends to hold one section rather than the tail of one
# and the start of the next.
SEPARATORS = ["\n# ", "\n## ", "\n### ", "\n#### ", "\n\n", "\n", ". ", "? ", "! ", "; ", ", ", " ", ""]


@dataclass
class Chunk:
    text: str
    page: int | None
    index: int = 0


def _split(text: str, size: int, seps: list[str]) -> list[str]:
    """Pieces no longer than size, split on the first separator that helps."""
    if len(text) <= size:
        return [text]
    sep = next((s for s in seps if s and s in text), "")
    if not sep:
        return [text[i:i + size] for i in range(0, len(text), size)]
    rest = seps[seps.index(sep) + 1:]
    parts = text.split(sep)
    heading = sep.lstrip("\n").startswith("#")
    out: list[str] = []
    for i, part in enumerate(parts):
        if heading:
            # Keep the heading marker with the section it introduces.
            piece = (sep if i > 0 else "") + part
        else:
            piece = part + (sep if i < len(parts) - 1 else "")
        out.extend(_split(piece, size, rest) if len(piece) > size else [piece])
    return out


def _pack(pieces: list[str], size: int, overlap: int) -> list[str]:
    chunks: list[str] = []
    current = ""
    for piece in pieces:
        starts_section = piece.lstrip("\n").startswith("#") and len(current) > size // 3
        if current and (len(current) + len(piece) > size or starts_section):
            chunks.append(current)
            # Overlap carries context within a section, never into the next one.
            tail = current[-overlap:] if overlap and not piece.lstrip("\n").startswith("#") else ""
            # Start the overlap at a word boundary.
            if tail and " " in tail:
                tail = tail[tail.index(" ") + 1:]
            current = tail
        current += piece
    if current.strip():
        chunks.append(current)
    return [c.strip() for c in chunks if c.strip()]


def chunk_sections(sections: list[tuple[str, int | None]], size: int = 1000, overlap: int = 150) -> list[Chunk]:
    if size < 100:
        raise ValueError("chunk size must be at least 100 characters")
    overlap = max(0, min(overlap, size // 2))
    out: list[Chunk] = []
    for text, page in sections:
        for c in _pack(_split(text, size - overlap, SEPARATORS), size, overlap):
            out.append(Chunk(text=c, page=page))
    for i, c in enumerate(out):
        c.index = i
    return out
