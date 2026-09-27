"""Text extraction for knowledge-base documents.

Each parser returns sections: (text, page) pairs, where page is 1-based for PDFs and
None otherwise, so search results can say where a passage came from.
"""
from __future__ import annotations

import re
from pathlib import Path

SUPPORTED = {".pdf", ".md", ".markdown", ".txt", ".text", ".rst", ".csv", ".json", ".html", ".htm", ".docx"}

Section = tuple[str, int | None]


class ParseError(ValueError):
    pass


def _clean(text: str) -> str:
    text = text.replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _read_text(path: Path) -> str:
    raw = path.read_bytes()
    # UTF-16 only with a BOM: almost any even-length byte string "decodes" as UTF-16, which
    # would turn Windows-1252 / Latin-1 text into CJK garbage.
    encodings = ("utf-16",) if raw.startswith((b"\xff\xfe", b"\xfe\xff")) else ("utf-8-sig", "cp1252")
    for enc in encodings:
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1")


def parse(path: Path) -> list[Section]:
    ext = path.suffix.lower()
    if ext not in SUPPORTED:
        raise ParseError(f"unsupported file type {ext or '(none)'}; supported: {', '.join(sorted(SUPPORTED))}")
    if ext == ".pdf":
        sections = _pdf(path)
    elif ext == ".docx":
        sections = [(_docx(path), None)]
    elif ext in (".html", ".htm"):
        sections = [(_html(_read_text(path)), None)]
    else:
        sections = [(_read_text(path), None)]
    sections = [(_clean(t), p) for t, p in sections]
    sections = [(t, p) for t, p in sections if t]
    if not sections:
        hint = " It may be a scanned PDF with no text layer (OCR isn't supported yet)." if ext == ".pdf" else ""
        raise ParseError(f"no text found in {path.name}.{hint}")
    return sections


def _pdf(path: Path) -> list[Section]:
    from pypdf import PdfReader

    try:
        reader = PdfReader(str(path))
        if reader.is_encrypted:
            reader.decrypt("")
        return [(page.extract_text() or "", i + 1) for i, page in enumerate(reader.pages)]
    except Exception as e:  # pypdf raises many types for damaged files
        raise ParseError(f"couldn't read PDF: {e}") from e


def _docx(path: Path) -> str:
    import docx

    d = docx.Document(str(path))
    parts = [p.text for p in d.paragraphs]
    for table in d.tables:
        for row in table.rows:
            parts.append(" | ".join(cell.text.strip() for cell in row.cells))
    return "\n\n".join(parts)


def _html(html: str) -> str:
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "header", "footer", "noscript"]):
        tag.decompose()
    return soup.get_text("\n")
