"""Answer-quality metrics against a reference answer. Pure Python, no downloads.

exact_match  normalized strings are identical (good for short factual answers)
f1           token overlap, SQuAD-style (partial credit for mostly-right answers)
rouge_l      longest common subsequence F-measure (rewards the same content in the same order)
"""
from __future__ import annotations

import re
import string
from collections import Counter

_ARTICLES = re.compile(r"\b(a|an|the)\b")
_PUNCT = str.maketrans("", "", string.punctuation)


def normalize(text: str) -> str:
    text = text.lower().translate(_PUNCT)
    text = _ARTICLES.sub(" ", text)
    return " ".join(text.split())


def tokens(text: str) -> list[str]:
    return normalize(text).split()


def exact_match(pred: str, ref: str) -> float:
    return float(normalize(pred) == normalize(ref))


def f1(pred: str, ref: str) -> float:
    p, r = tokens(pred), tokens(ref)
    if not p or not r:
        return float(p == r)
    common = Counter(p) & Counter(r)
    same = sum(common.values())
    if same == 0:
        return 0.0
    precision, recall = same / len(p), same / len(r)
    return 2 * precision * recall / (precision + recall)


def _lcs(a: list[str], b: list[str]) -> int:
    if len(a) < len(b):
        a, b = b, a
    prev = [0] * (len(b) + 1)
    for x in a:
        cur = [0]
        for j, y in enumerate(b):
            cur.append(prev[j] + 1 if x == y else max(prev[j + 1], cur[j]))
        prev = cur
    return prev[-1]


def rouge_l(pred: str, ref: str) -> float:
    p, r = tokens(pred), tokens(ref)
    if not p or not r:
        return float(p == r)
    lcs = _lcs(p, r)
    if lcs == 0:
        return 0.0
    precision, recall = lcs / len(p), lcs / len(r)
    return 2 * precision * recall / (precision + recall)


def score(pred: str, ref: str) -> dict[str, float]:
    return {"exact_match": exact_match(pred, ref), "f1": round(f1(pred, ref), 4), "rouge_l": round(rouge_l(pred, ref), 4)}
