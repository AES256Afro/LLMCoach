"""Prompt building for answers grounded in the knowledge base.

Shared by the Playground and (later) eval runs, so "RAG" means the same thing everywhere.
"""
from __future__ import annotations

DEFAULT_SYSTEM = "You are a helpful, accurate assistant. Answer concisely."

RAG_INSTRUCTIONS = """Answer using the numbered context passages below.
- Cite the passages you use with their numbers in square brackets, like [1] or [2][3].
- If the context doesn't contain the answer, say so plainly instead of guessing.
- Don't mention "the context" or "the passages"; just answer."""


def format_context(hits: list[dict]) -> str:
    blocks = []
    for i, h in enumerate(hits, 1):
        where = h.get("filename", "document")
        if h.get("page") is not None:
            where += f", page {h['page']}"
        blocks.append(f"[{i}] ({where})\n{h['text'].strip()}")
    return "\n\n".join(blocks)


def build_messages(question: str, history: list[dict], hits: list[dict] | None,
                   system_prompt: str | None = None, max_history: int = 10) -> list[dict]:
    """history: prior {"role", "content"} turns, oldest first. Context goes in the system message,
    so it's refreshed each turn instead of piling up in the transcript."""
    system = (system_prompt or DEFAULT_SYSTEM).strip()
    if hits is not None:
        system += "\n\n" + RAG_INSTRUCTIONS
        system += "\n\nContext:\n\n" + (format_context(hits) if hits else "(no relevant passages were found)")
    turns = [m for m in history if m["role"] in ("user", "assistant") and m.get("content")][-max_history:]
    return [{"role": "system", "content": system}, *turns, {"role": "user", "content": question}]
