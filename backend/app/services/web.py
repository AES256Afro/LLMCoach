"""Fetching a web page (or a PDF or text file by URL) so it can join a knowledge base like an upload."""
from __future__ import annotations

import html
import re
from pathlib import PurePosixPath
from urllib.parse import unquote, urlsplit

import httpx

from .parsing import SUPPORTED

# What a server says it sent -> the parser that reads it.
_TYPES = {"text/html": ".html", "application/xhtml+xml": ".html", "application/pdf": ".pdf", "text/plain": ".txt",
          "text/markdown": ".md", "text/x-markdown": ".md", "application/json": ".json", "text/csv": ".csv",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx"}
_TITLE = re.compile(rb"<title[^>]*>(.*?)</title>", re.I | re.S)


class WebError(ValueError):
    pass


def check_url(url: str) -> str:
    url = (url or "").strip()
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise WebError("give a full address starting with http:// or https://")
    return url


def page_name(url: str, ext: str, data: bytes) -> str:
    """A file name for the page: its <title> when it has one, else the last part of its address."""
    title = None
    if ext == ".html" and (m := _TITLE.search(data[:200_000])):
        title = html.unescape(m.group(1).decode("utf-8", "replace"))
    if not title:
        parts = urlsplit(url)
        title = unquote(PurePosixPath(parts.path).name) or parts.netloc
    # Only characters a stored file name keeps, so the name shown is the name saved.
    title = re.sub(r"[^\w.\- ]+", " ", title)
    title = re.sub(r"\s+", " ", title).strip()[:80] or "page"
    return title if title.lower().endswith(ext) else f"{title}{ext}"


# Addresses listed by a sitemap (<loc>), an RSS feed (<item>…<link>) or an Atom feed (<entry>…<link href>).
_LOC = re.compile(rb"<loc>\s*(.*?)\s*</loc>", re.I | re.S)
_RSS_ITEM = re.compile(rb"<item\b.*?<link>\s*(.*?)\s*</link>", re.I | re.S)
_ATOM_ENTRY = re.compile(rb"<entry\b.*?<link\b[^>]*?href=[\"']([^\"']+)[\"']", re.I | re.S)


def is_listing(url: str) -> bool:
    """A sitemap or a feed: an address that stands for the pages it lists."""
    name = PurePosixPath(urlsplit(url).path).name.lower()
    return name.endswith((".xml", ".rss", ".atom")) or name in ("feed", "rss", "atom")


async def listed_pages(url: str, limit: int) -> list[str]:
    """The page addresses a sitemap or feed lists, following a sitemap index one level down."""
    async with httpx.AsyncClient(timeout=httpx.Timeout(20, read=60), follow_redirects=True, max_redirects=5) as client:
        async def links(u: str) -> list[str]:
            try:
                r = await client.get(check_url(u))
            except httpx.HTTPError as e:
                raise WebError(f"couldn't fetch {u}: {e}") from e
            if r.status_code >= 400:
                raise WebError(f"{u} answered {r.status_code} {r.reason_phrase}")
            body = r.content[:20_000_000]
            found = _LOC.findall(body) or _RSS_ITEM.findall(body) or _ATOM_ENTRY.findall(body)
            return [html.unescape(m.decode("utf-8", "replace")) for m in found]

        pages: list[str] = []
        for link in await links(url):
            if is_listing(link):
                pages += [p for p in await links(link) if not is_listing(p)]
            else:
                pages.append(link)
            if len(pages) >= limit:
                break
    return list(dict.fromkeys(pages))[:limit]


async def fetch(url: str, max_bytes: int) -> tuple[str, bytes, str]:
    """(file name, bytes, final URL). Follows redirects; refuses types LLMCoach can't read."""
    url = check_url(url)
    headers = {"User-Agent": "LLMCoach/1 (+https://github.com/AES256Afro/LLMCoach)", "Accept": "text/html,application/pdf,text/*;q=0.9,*/*;q=0.5"}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(20, read=60), follow_redirects=True, max_redirects=5,
                                     headers=headers) as client:
            async with client.stream("GET", url) as r:
                if r.status_code >= 400:
                    raise WebError(f"{url} answered {r.status_code} {r.reason_phrase}")
                ctype = r.headers.get("content-type", "").split(";")[0].strip().lower()
                suffix = PurePosixPath(urlsplit(str(r.url)).path).suffix.lower()
                ext = _TYPES.get(ctype) or (suffix if suffix in SUPPORTED else None)
                if ext is None:
                    raise WebError(f"{ctype or 'that kind of'} content can't be read; pages, PDFs and text files can")
                data = bytearray()
                async for chunk in r.aiter_bytes():
                    data += chunk
                    if len(data) > max_bytes:
                        raise WebError(f"larger than {max_bytes // 1024**2} MB")
                final = str(r.url)
    except httpx.HTTPError as e:
        raise WebError(f"couldn't fetch {url}: {e}") from e
    if not data:
        raise WebError(f"{url} sent nothing back")
    return page_name(final, ext, bytes(data)), bytes(data), final
