import os
import tempfile

from tests.fake_servers import FakeServer

# Must happen before app modules are imported: settings and the DB engine are module-level.
FAKE = FakeServer().__enter__()
os.environ["LLMCOACH_DATA_DIR"] = tempfile.mkdtemp(prefix="llmcoach-test-")
os.environ["LLMCOACH_OLLAMA_URL"] = FAKE.url
os.environ.pop("LLMCOACH_PASSWORD", None)

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def fake():
    return FAKE
