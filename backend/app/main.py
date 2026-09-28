import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlmodel import Session
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import auth
from .api import chat, datasets, evals, inbox, jobs, knowledge, loop, notify, pipeline, projects, providers, system, tokens, training
from .config import settings
from .db import engine, init_db
from .services.device import detect_backend
from .services.jobs import manager
from .services.providers import ensure_builtin

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger().addHandler(system.app_logs)
log = logging.getLogger("llmcoach")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    with Session(engine) as s:
        ensure_builtin(s)
    log.info("data dir: %s", settings.data_dir)
    log.info("compute backend: %s", detect_backend())
    log.info("ollama: %s", settings.ollama_url)
    log.info("sign-in: %s", "enabled" if auth.auth_enabled() else "DISABLED (set LLMCOACH_PASSWORD)")
    if auth.auth_enabled() and not settings.session_secret:
        log.warning("LLMCOACH_SESSION_SECRET is not set: everyone is signed out whenever the server restarts")
    await manager.start()
    watcher = asyncio.create_task(inbox.watch_forever()) if settings.watch else None
    log.info("inbox: %s%s", settings.inbox_root, "" if watcher else " (watching is off)")
    yield
    if watcher:
        watcher.cancel()
    await manager.stop()


# The interactive API docs are for local development; with sign-in on they'd publish the whole API surface.
_docs = {"docs_url": None, "redoc_url": None, "openapi_url": None} if auth.auth_enabled() else {}
app = FastAPI(title="LLMCoach", lifespan=lifespan, **_docs)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(auth.AuthMiddleware)
app.include_router(auth.router)
app.include_router(projects.router)
app.include_router(providers.router)
app.include_router(knowledge.router)
app.include_router(chat.router)
app.include_router(datasets.router)
app.include_router(training.router)
app.include_router(evals.router)
app.include_router(jobs.router)
app.include_router(system.router)
app.include_router(inbox.router)
app.include_router(loop.router)
app.include_router(tokens.router)
app.include_router(notify.router)
app.include_router(pipeline.router)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


class SPAStaticFiles(StaticFiles):
    """Serves index.html for unknown paths so client-side routes survive a refresh.
    Unknown /api and /ws paths stay a JSON 404: an API client shouldn't get a web page."""

    async def get_response(self, path, scope):
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as e:
            if e.status_code == 404 and not scope["path"].startswith(("/api/", "/ws/")):
                return await super().get_response("index.html", scope)
            raise


# In production the built frontend is served from here (single port on BigBox).
_frontend = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _frontend.is_dir():
    app.mount("/", SPAStaticFiles(directory=_frontend, html=True), name="frontend")
