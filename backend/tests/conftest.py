import os
import tempfile

# Must be set before app modules are imported: settings and the DB engine are module-level.
os.environ["LLMCOACH_DATA_DIR"] = tempfile.mkdtemp(prefix="llmcoach-test-")

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:
        yield c
