import pytest
from PIL import Image, ImageDraw, ImageFont

from app.services import parsing

needs_tesseract = pytest.mark.skipif(not parsing.ocr_available(), reason="Tesseract isn't installed here (CI and the image have it)")


def _scanned_pdf(path, lines: list[str]) -> None:
    """A PDF whose page is only a picture of text, like a scanner makes."""
    img = Image.new("RGB", (1700, 2200), "white")
    draw = ImageDraw.Draw(img)
    font = ImageFont.load_default(size=56)
    for i, line in enumerate(lines):
        draw.text((140, 180 + i * 110), line, fill="black", font=font)
    img.save(path, "PDF", resolution=200)


def test_a_scan_without_ocr_says_why(tmp_path, monkeypatch):
    pdf = tmp_path / "scan.pdf"
    _scanned_pdf(pdf, ["The ferry leaves at seven forty."])
    monkeypatch.setattr(parsing, "ocr_available", lambda: False)
    with pytest.raises(parsing.ParseError, match="needs Tesseract OCR"):
        parsing.parse(pdf)
    with pytest.raises(parsing.ParseError, match="read with OCR when it's indexed"):
        parsing.parse(pdf, ocr=False)  # an upload's check doesn't wait for OCR


@needs_tesseract
def test_a_scan_is_read_with_ocr_once(tmp_path, monkeypatch):
    pdf = tmp_path / "harbor-scan.pdf"
    _scanned_pdf(pdf, ["Harbor office hours", "The ferry leaves at seven forty."])
    sections = parsing.parse(pdf)
    text = " ".join(t for t, _ in sections).lower()
    assert "harbor" in text and "ferry" in text and sections[0][1] == 1  # page numbers kept

    # The result is cached by the file's hash: reading it again doesn't run OCR.
    import pytesseract

    def boom(*a, **k):
        raise AssertionError("OCR ran twice")
    monkeypatch.setattr(pytesseract, "image_to_string", boom)
    assert parsing.parse(pdf) == sections
