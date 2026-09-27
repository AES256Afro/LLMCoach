import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import auth
from .api import jobs, projects, system
from .config import settings
from .db import init_db
from .services.device import detect_backend
from .services.jobs import manager

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger().addHandler(system.app_logs)
log = logging.getLogger("llmcoach")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    log.info("data dir: %s", settings.data_dir)
    log.info("compute backend: %s", detect_backend())
    log.info("ollama: %s", settings.ollama_url)
    log.info("sign-in: %s", "enabled" if auth.auth_enabled() else "DISABLED (set LLMCOACH_PASSWORD)")
    await manager.start()
    yield
    await manager.stop()


app = FastAPI(title="LLMCoach", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(auth.AuthMiddleware)
app.include_router(auth.router)
app.include_router(projects.router)
app.include_router(jobs.router)
app.include_router(system.router)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


class SPAStaticFiles(StaticFiles):
    """Serves index.html for unknown paths so client-side routes survive a refresh."""

    async def get_response(self, path, scope):
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as e:
            if e.status_code == 404:
                return await super().get_response("index.html", scope)
            raise


# In production the built frontend is served from here (single port on BigBox).
_frontend = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _frontend.is_dir():
    app.mount("/", SPAStaticFiles(directory=_frontend, html=True), name="frontend")
