from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="LLMCOACH_", env_file=".env", extra="ignore")

    data_dir: Path = Path(__file__).resolve().parents[2] / "data"
    version: str = "dev"  # stamped into published images (LLMCOACH_VERSION), e.g. "0.8.0" or "0.8.0-cuda"
    host: str = "0.0.0.0"
    port: int = 8000
    ollama_url: str = "http://localhost:11434"
    # Sign-in. Auth is disabled when password is empty (local development).
    username: str = "owner"
    password: str = ""
    session_secret: str = ""
    # Hugging Face token, only needed for gated base models (Llama, Gemma).
    hf_token: str = ""
    # Allow the Vite dev server during development.
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    @property
    def db_path(self) -> Path:
        return self.data_dir / "llmcoach.db"

    # Where watched folders live. BoxPilot mounts the app's "inbox" volume here, and can share that
    # folder over SMB so other machines drop files into it. Defaults to data/inbox.
    inbox_dir: Path | None = None
    # Poll watched folders and run the nightly learning loop in the background (off in tests).
    watch: bool = True

    @property
    def runs_dir(self) -> Path:
        return self.data_dir / "runs"

    @property
    def inbox_root(self) -> Path:
        return (self.inbox_dir or self.data_dir / "inbox").resolve()

    def ensure_dirs(self) -> None:
        for sub in ("docs", "lancedb", "datasets", "runs", "models"):
            (self.data_dir / sub).mkdir(parents=True, exist_ok=True)
        self.inbox_root.mkdir(parents=True, exist_ok=True)


settings = Settings()
