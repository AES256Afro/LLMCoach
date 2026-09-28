"""Just enough S3 to watch a bucket: list a prefix and read objects.

Works with MinIO (BoxPilot's catalog has it), AWS, Garage, Cloudflare R2 and other S3-compatible
stores, using path-style URLs (endpoint/bucket/key). Requests are signed with Signature Version 4
here rather than through an SDK, which would be the biggest dependency in the image.
"""
from __future__ import annotations

import hashlib
import hmac
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import quote, urlsplit

import httpx

EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()
_NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"


class S3Error(Exception):
    pass


@dataclass
class S3Object:
    key: str
    size: int
    mtime: float  # LastModified, as a Unix time
    etag: str


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def signing_key(secret_key: str, date: str, region: str, service: str = "s3") -> bytes:
    k = _hmac(("AWS4" + secret_key).encode(), date)
    return _hmac(_hmac(_hmac(k, region), service), "aws4_request")


def _enc(s: str) -> str:
    return quote(s, safe="-_.~")


def canonical_query(params: list[tuple[str, str]]) -> str:
    return "&".join(f"{_enc(k)}={_enc(v)}" for k, v in sorted(params))


def sign(method: str, host: str, path: str, params: list[tuple[str, str]], access_key: str, secret_key: str,
         region: str, now: datetime | None = None, payload_sha256: str = EMPTY_SHA256) -> dict[str, str]:
    """Headers that authenticate one request. `path` must already be URI-encoded, as sent."""
    stamp = (now or datetime.now(UTC)).strftime("%Y%m%dT%H%M%SZ")
    date = stamp[:8]
    headers = {"host": host, "x-amz-content-sha256": payload_sha256, "x-amz-date": stamp}
    names = sorted(headers)
    request = "\n".join([method, path, canonical_query(params), "".join(f"{h}:{headers[h]}\n" for h in names),
                         ";".join(names), payload_sha256])
    scope = f"{date}/{region}/s3/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", stamp, scope, hashlib.sha256(request.encode()).hexdigest()])
    signature = hmac.new(signing_key(secret_key, date, region), to_sign.encode(), hashlib.sha256).hexdigest()
    headers["authorization"] = (f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, "
                                f"SignedHeaders={';'.join(names)}, Signature={signature}")
    return headers


def normalize_endpoint(endpoint: str) -> str:
    """http(s)://host[:port], nothing after it."""
    raw = (endpoint or "").strip().rstrip("/")
    if raw and "://" not in raw:
        raw = "http://" + raw
    parts = urlsplit(raw)
    if parts.scheme not in ("http", "https") or not parts.netloc or parts.path not in ("", "/") or parts.query:
        raise ValueError("the endpoint must look like http://minio:9000 or https://s3.amazonaws.com")
    return f"{parts.scheme}://{parts.netloc}"


class Bucket:
    def __init__(self, endpoint: str, bucket: str, access_key: str, secret_key: str, region: str = "us-east-1",
                 timeout: float = 30) -> None:
        self.endpoint, self.bucket = normalize_endpoint(endpoint), bucket
        self.access_key, self.secret_key, self.region = access_key, secret_key, region or "us-east-1"
        self.host = urlsplit(self.endpoint).netloc
        self.client = httpx.Client(timeout=httpx.Timeout(timeout, read=120))

    def __enter__(self) -> Bucket:
        return self

    def __exit__(self, *exc) -> None:
        self.client.close()

    def _request(self, path: str, params: list[tuple[str, str]], stream: bool = False) -> httpx.Response:
        headers = sign("GET", self.host, path, params, self.access_key, self.secret_key, self.region)
        query = canonical_query(params)
        url = f"{self.endpoint}{path}" + (f"?{query}" if query else "")
        try:
            req = self.client.build_request("GET", url, headers=headers)
            r = self.client.send(req, stream=stream)
        except httpx.HTTPError as e:
            raise S3Error(f"couldn't reach {self.endpoint}: {e}") from e
        if r.status_code >= 400:
            r.read()
            code = re.search(r"<Code>([^<]*)</Code>", r.text)
            msg = re.search(r"<Message>([^<]*)</Message>", r.text)
            detail = ": ".join(x.group(1) for x in (code, msg) if x) or r.reason_phrase
            raise S3Error(f"{self.bucket}: {r.status_code} {detail}")
        return r

    def list(self, prefix: str = "", limit: int | None = None) -> list[S3Object]:
        out: list[S3Object] = []
        token = None
        while True:
            params = [("list-type", "2"), ("prefix", prefix)]
            if token:
                params.append(("continuation-token", token))
            if limit:
                params.append(("max-keys", str(limit)))
            root = ET.fromstring(self._request(f"/{quote(self.bucket)}", params).content)
            for c in root.iter(f"{_NS}Contents"):
                modified = datetime.fromisoformat(c.findtext(f"{_NS}LastModified", "").replace("Z", "+00:00"))
                out.append(S3Object(key=c.findtext(f"{_NS}Key", ""), size=int(c.findtext(f"{_NS}Size", "0")),
                                    mtime=modified.timestamp(), etag=c.findtext(f"{_NS}ETag", "").strip('"')))
            token = root.findtext(f"{_NS}NextContinuationToken")
            if limit or root.findtext(f"{_NS}IsTruncated") != "true" or not token:
                return out

    def download(self, key: str, dest: Path) -> None:
        r = self._request(f"/{quote(self.bucket)}/{quote(key)}", [], stream=True)
        try:
            with open(dest, "wb") as f:
                for block in r.iter_bytes(1 << 20):
                    f.write(block)
        finally:
            r.close()
