"""Checks a document's text for secrets and personal data before it enters a knowledge base.

Anything in the knowledge base can be quoted back by the chat and copied into training data,
so a file that holds an API key or a list of card numbers is held for review instead.

Findings carry a masked sample ("AKIA…7Q"), never the value itself: the review screen must
not become a second place the secret is shown.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass

SECRET = "secret"
PERSONAL = "personal"

# (kind, label, pattern). Secrets are specific formats, so one match is enough to hold a file.
_SECRETS: list[tuple[str, str, re.Pattern]] = [
    ("private_key", "Private key", re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----")),
    ("aws_key", "AWS access key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("github_token", "GitHub token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b")),
    ("slack_token", "Slack token", re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{10,}\b")),
    ("api_key", "API key", re.compile(r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}\b")),
    ("google_key", "Google API key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("hf_token", "Hugging Face token", re.compile(r"\bhf_[A-Za-z0-9]{30,}\b")),
    ("jwt", "Access token (JWT)", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")),
    # key = value where the key says it is a secret and the value looks like one (no spaces, 8+ chars,
    # not a placeholder such as <your-token> or ${TOKEN}).
    ("assigned_secret", "Password or secret in a setting", re.compile(
        r"(?i)\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|client[_-]?secret)\b"
        r"[\"']?\s*[:=]\s*[\"']?(?![<$%{])([^\s\"'<>]{8,})")),
]

_EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
_SSN = re.compile(r"\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b")
_CARD = re.compile(r"\b(?:\d[ -]?){12,18}\d\b")
_PHONE = re.compile(r"(?<![\w.])(?:\+?\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\w.])")

# A single address in a signature is normal; a list of them is a contact export.
LIST_THRESHOLD = 5


@dataclass
class Finding:
    category: str  # SECRET | PERSONAL
    kind: str
    label: str
    count: int
    sample: str  # masked


def mask(value: str) -> str:
    value = value.strip()
    if len(value) <= 6:
        return "•" * len(value)
    return f"{value[:4]}…{value[-2:]}"


def _luhn(digits: str) -> bool:
    total, parity = 0, len(digits) % 2
    for i, ch in enumerate(digits):
        d = int(ch)
        if i % 2 == parity:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def scan_text(text: str, personal: bool = True) -> list[Finding]:
    """Everything that should hold a file for review. `personal=False` checks secrets only."""
    findings: list[Finding] = []
    for kind, label, pattern in _SECRETS:
        hits = [m.group(m.lastindex or 0) for m in pattern.finditer(text)]
        if hits:
            findings.append(Finding(SECRET, kind, label, len(hits), mask(hits[0])))
    if not personal:
        return findings

    ssns = _SSN.findall(text)
    if ssns:
        findings.append(Finding(PERSONAL, "ssn", "US Social Security number", len(ssns), mask(ssns[0])))
    cards = [m for m in _CARD.findall(text) if 13 <= len(d := re.sub(r"\D", "", m)) <= 19 and _luhn(d)]
    if cards:
        findings.append(Finding(PERSONAL, "card", "Payment card number", len(cards), mask(re.sub(r"\D", "", cards[0]))))
    emails = sorted({e.lower() for e in _EMAIL.findall(text)})
    if len(emails) >= LIST_THRESHOLD:
        findings.append(Finding(PERSONAL, "emails", "List of email addresses", len(emails), mask(emails[0])))
    phones = sorted({re.sub(r"\D", "", p) for p in _PHONE.findall(text)})
    if len(phones) >= LIST_THRESHOLD:
        findings.append(Finding(PERSONAL, "phones", "List of phone numbers", len(phones), mask(phones[0])))
    return findings


def as_dicts(findings: list[Finding]) -> list[dict]:
    return [asdict(f) for f in findings]
