from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from ..db import DEFAULT_PROJECT_SETTINGS, Project, get_session

router = APIRouter(prefix="/api/projects", tags=["projects"])


class ProjectCreate(BaseModel):
    name: str
    description: str = ""


class ProjectUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    settings: dict[str, Any] | None = None  # merged into existing settings; null values reset to default


def _out(p: Project) -> dict:
    return {**p.model_dump(mode="json"), "settings": p.effective_settings()}


def get_project_or_404(session: Session, project_id: int) -> Project:
    if (p := session.get(Project, project_id)) is None:
        raise HTTPException(404, "project not found")
    return p


@router.get("")
def list_projects(session: Session = Depends(get_session)) -> list[dict]:
    return [_out(p) for p in session.exec(select(Project).order_by(Project.name))]


@router.post("", status_code=201)
def create_project(body: ProjectCreate, session: Session = Depends(get_session)) -> dict:
    project = Project(name=body.name.strip(), description=body.description)
    if not project.name:
        raise HTTPException(400, "name is required")
    session.add(project)
    try:
        session.commit()
    except IntegrityError:
        raise HTTPException(409, "a project with that name already exists")
    session.refresh(project)
    return _out(project)


@router.get("/{project_id}")
def get_project(project_id: int, session: Session = Depends(get_session)) -> dict:
    return _out(get_project_or_404(session, project_id))


@router.patch("/{project_id}")
def update_project(project_id: int, body: ProjectUpdate, session: Session = Depends(get_session)) -> dict:
    p = get_project_or_404(session, project_id)
    if body.name is not None:
        if not body.name.strip():
            raise HTTPException(400, "name is required")
        p.name = body.name.strip()
    if body.description is not None:
        p.description = body.description
    if body.settings is not None:
        unknown = set(body.settings) - set(DEFAULT_PROJECT_SETTINGS)
        if unknown:
            raise HTTPException(400, f"unknown settings: {sorted(unknown)}")
        merged = {**(p.settings or {}), **body.settings}
        p.settings = {k: v for k, v in merged.items() if v is not None}
    session.add(p)
    try:
        session.commit()
    except IntegrityError:
        raise HTTPException(409, "a project with that name already exists")
    session.refresh(p)
    return _out(p)


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: int, session: Session = Depends(get_session)) -> None:
    p = get_project_or_404(session, project_id)
    session.delete(p)
    session.commit()
