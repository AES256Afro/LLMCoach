from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="LLMCOACH_", env_file=".env", extra="ignore")

    data_dir: Path = Path(__file__).resolve().parents[2] / "data"
    host: str = "0.0.0.0"
    port: int = 8000
    ollama_url: str = "http://localhost:11434"
    # Sign-in. Auth is disabled when password is empty (local development).
    username: str = "owner"
    password: str = ""
    session_secret: str = ""
    # Allow the Vite dev server during development.
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    @property
    def db_path(self) -> Path:
        return self.data_dir / "llmcoach.db"

    @property
    def runs_dir(self) -> Path:
        return self.data_dir / "runs"

    def ensure_dirs(self) -> None:
        for sub in ("docs", "lancedb", "datasets", "runs", "models"):
            (self.data_dir / sub).mkdir(parents=True, exist_ok=True)


settings = Settings()
