from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from ..db import Project, get_session

router = APIRouter(prefix="/api/projects", tags=["projects"])


class ProjectCreate(BaseModel):
    name: str
    description: str = ""


@router.get("")
def list_projects(session: Session = Depends(get_session)) -> list[Project]:
    return list(session.exec(select(Project).order_by(Project.name)))


@router.post("", status_code=201)
def create_project(body: ProjectCreate, session: Session = Depends(get_session)) -> Project:
    project = Project(name=body.name.strip(), description=body.description)
    if not project.name:
        raise HTTPException(400, "name is required")
    session.add(project)
    try:
        session.commit()
    except IntegrityError:
        raise HTTPException(409, "a project with that name already exists")
    session.refresh(project)
    return project


@router.get("/{project_id}")
def get_project(project_id: int, session: Session = Depends(get_session)) -> Project:
    if (p := session.get(Project, project_id)) is None:
        raise HTTPException(404, "project not found")
    return p


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: int, session: Session = Depends(get_session)) -> None:
    if (p := session.get(Project, project_id)) is None:
        raise HTTPException(404, "project not found")
    session.delete(p)
    session.commit()
