from collections.abc import Iterator
from datetime import datetime, timezone
from enum import Enum
from typing import Any

import logging

from sqlalchemy import JSON, Column, event, inspect, text
from sqlmodel import Field, Session, SQLModel, create_engine

from .config import settings


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class JobStatus(str, Enum):
    queued = "queued"
    running = "running"
    done = "done"
    failed = "failed"
    cancelled = "cancelled"

    @property
    def is_final(self) -> bool:
        return self in (JobStatus.done, JobStatus.failed, JobStatus.cancelled)


log = logging.getLogger(__name__)

# Per-project defaults; stored values override these key by key.
# Model settings are "<provider slug>/<model>" references (see services/providers).
DEFAULT_PROJECT_SETTINGS: dict[str, Any] = {
    "embed_model": "ollama/nomic-embed-text",
    "chunk_size": 1000,  # characters
    "chunk_overlap": 150,
    "chat_model": None,  # None = first chat model the default provider reports
    "top_k": 5,
    "search_mode": "hybrid",  # "hybrid" (keywords + vectors) or "vector"
    "system_prompt": None,  # default system prompt for new chats
}


class Project(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(index=True, unique=True)
    description: str = ""
    settings: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow)

    def effective_settings(self) -> dict[str, Any]:
        return {**DEFAULT_PROJECT_SETTINGS, **(self.settings or {})}


class ProviderKind(str, Enum):
    ollama = "ollama"
    openai = "openai"  # any OpenAI-compatible API: llama.cpp server, vLLM, LM Studio, LocalAI, OpenRouter...


class Provider(SQLModel, table=True):
    """Somewhere models run. The built-in "ollama" row mirrors LLMCOACH_OLLAMA_URL."""

    id: int | None = Field(default=None, primary_key=True)
    slug: str = Field(index=True, unique=True)  # used in model refs: "<slug>/<model>"
    name: str
    kind: ProviderKind
    preset: str = "custom"  # key into services/providers/presets.PRESETS
    base_url: str
    api_key: str | None = None
    enabled: bool = True
    builtin: bool = False
    created_at: datetime = Field(default_factory=utcnow)


class DocStatus(str, Enum):
    pending = "pending"
    ingesting = "ingesting"
    ready = "ready"
    failed = "failed"


class Document(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    project_id: int = Field(foreign_key="project.id", index=True)
    filename: str
    path: str  # relative to data_dir
    size_bytes: int = 0
    sha256: str = Field(index=True)
    status: DocStatus = DocStatus.pending
    chunk_count: int = 0
    char_count: int = 0
    embed_model: str | None = None  # model the stored vectors came from
    error: str | None = None
    created_at: datetime = Field(default_factory=utcnow)
    ingested_at: datetime | None = None


class Job(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    project_id: int | None = Field(default=None, foreign_key="project.id", index=True)
    kind: str  # e.g. "demo", "smoke", "train", "eval", "export", "ingest"
    status: JobStatus = Field(default=JobStatus.queued, index=True)
    config: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    error: str | None = None
    exit_code: int | None = None
    created_at: datetime = Field(default_factory=utcnow)
    started_at: datetime | None = None
    finished_at: datetime | None = None


class DatasetStatus(str, Enum):
    generating = "generating"
    ready = "ready"
    failed = "failed"


class Dataset(SQLModel, table=True):
    """Training examples in chat format, stored as JSONL at `path` (relative to data_dir).
    Each line: {"messages": [...], "split": "train"|"val"|"test", "meta": {...}}."""

    id: int | None = Field(default=None, primary_key=True)
    project_id: int = Field(foreign_key="project.id", index=True)
    name: str
    source: str = "upload"  # "upload" | "generated"
    path: str = ""
    status: DatasetStatus = DatasetStatus.ready
    row_count: int = 0
    splits: dict[str, int] | None = Field(default=None, sa_column=Column(JSON))
    stats: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    job_id: int | None = None
    error: str | None = None
    created_at: datetime = Field(default_factory=utcnow)


class FineTuneStatus(str, Enum):
    queued = "queued"
    training = "training"
    ready = "ready"
    failed = "failed"
    cancelled = "cancelled"


class FineTune(SQLModel, table=True):
    """A LoRA adapter trained on a dataset, on top of a Hugging Face base model."""

    id: int | None = Field(default=None, primary_key=True)
    project_id: int = Field(foreign_key="project.id", index=True)
    name: str
    base_model: str  # Hugging Face model id
    dataset_id: int | None = Field(default=None, foreign_key="dataset.id")
    method: str = "lora"  # "lora" | "qlora"
    backend: str | None = None  # "hf" | "unsloth", resolved when training starts
    status: FineTuneStatus = FineTuneStatus.queued
    config: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    metrics: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    output_dir: str | None = None  # relative to data_dir
    job_id: int | None = None
    error: str | None = None
    created_at: datetime = Field(default_factory=utcnow)
    finished_at: datetime | None = None


class EvalRun(SQLModel, table=True):
    """Answers from several variants to the same test questions, scored against references.
    Per-question results live in data/evals/<id>.jsonl; `summary` holds the averages."""

    id: int | None = Field(default=None, primary_key=True)
    project_id: int = Field(foreign_key="project.id", index=True)
    name: str
    dataset_id: int | None = Field(default=None, foreign_key="dataset.id")
    split: str = "test"
    # [{"label", "kind": "model"|"finetune", "ref": "<provider>/<model>" | finetune id, "rag": bool}]
    variants: list[dict] | None = Field(default=None, sa_column=Column(JSON))
    judge_model: str | None = None
    status: str = "queued"  # queued | running | done | failed | cancelled
    summary: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    examples: int = 0
    job_id: int | None = None
    error: str | None = None
    created_at: datetime = Field(default_factory=utcnow)


class Conversation(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    project_id: int = Field(foreign_key="project.id", index=True)
    title: str = "New chat"
    model: str | None = None  # "<provider>/<model>" used for the last reply
    use_rag: bool = True
    system_prompt: str | None = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class Message(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    conversation_id: int = Field(foreign_key="conversation.id", index=True)
    role: str  # "user" | "assistant"
    content: str
    thinking: str | None = None
    model: str | None = None
    sources: list[dict] | None = Field(default=None, sa_column=Column(JSON))
    stats: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    error: str | None = None
    created_at: datetime = Field(default_factory=utcnow)


engine = create_engine(
    f"sqlite:///{settings.db_path}",
    connect_args={"check_same_thread": False, "timeout": 30},
)


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_conn, _record) -> None:
    # WAL lets job workers write while the API reads.
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.close()


def _add_missing_columns() -> None:
    """Minimal forward migration: add columns that models gained since the DB was created.

    create_all() only creates missing tables, and installs on BigBox keep their database
    across updates. New columns must therefore be nullable or have a Python-side default.
    """
    insp = inspect(engine)
    with engine.begin() as conn:
        for table in SQLModel.metadata.sorted_tables:
            if not insp.has_table(table.name):
                continue
            existing = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name not in existing:
                    ddl = col.type.compile(dialect=engine.dialect)
                    default = getattr(col.default, "arg", None)
                    if isinstance(default, Enum):
                        default = default.value
                    if isinstance(default, bool):
                        ddl += f" DEFAULT {int(default)}"
                    elif isinstance(default, (int, float)):
                        ddl += f" DEFAULT {default}"
                    elif isinstance(default, str):
                        ddl += " DEFAULT '" + default.replace("'", "''") + "'"
                    conn.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {ddl}'))
                    log.info("migrated: added %s.%s", table.name, col.name)


def init_db() -> None:
    settings.ensure_dirs()
    SQLModel.metadata.create_all(engine)
    _add_missing_columns()


def get_session() -> Iterator[Session]:
    with Session(engine) as session:
        yield session
