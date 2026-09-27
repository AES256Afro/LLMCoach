import json
import time

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import Conversation, Message, engine, get_session, utcnow
from ..services import kb, rag
from ..services.providers import ProviderError, client_for, list_providers, resolve
from .knowledge import retrieve
from .projects import get_project_or_404

router = APIRouter(prefix="/api/projects/{project_id}", tags=["chat"])


async def default_chat_model(session: Session) -> str:
    """The smallest chat model on the first reachable provider (built-in Ollama first):
    small is the right default on a CPU-only server."""
    for p in list_providers(session, enabled_only=True):
        st = await client_for(p).status()
        chat = [m for m in st["models"] if not m["embedding"]]
        if chat:
            chat.sort(key=lambda m: m["size_gb"] if m["size_gb"] is not None else 1e9)
            return f"{p.slug}/{chat[0]['name']}"
    raise HTTPException(409, "no chat model is available on any provider; pull one in Ollama or add a provider")


def _conv(session: Session, project_id: int, conversation_id: int) -> Conversation:
    c = session.get(Conversation, conversation_id)
    if c is None or c.project_id != project_id:
        raise HTTPException(404, "conversation not found")
    return c


def _conv_out(c: Conversation, messages: list[Message] | None = None) -> dict:
    d = c.model_dump(mode="json")
    if messages is not None:
        d["messages"] = [m.model_dump(mode="json") for m in messages]
    return d


@router.get("/conversations")
def list_conversations(project_id: int, session: Session = Depends(get_session)) -> list[dict]:
    get_project_or_404(session, project_id)
    q = select(Conversation).where(Conversation.project_id == project_id).order_by(Conversation.updated_at.desc())
    return [_conv_out(c) for c in session.exec(q)]


@router.get("/conversations/{conversation_id}")
def get_conversation(project_id: int, conversation_id: int, session: Session = Depends(get_session)) -> dict:
    c = _conv(session, project_id, conversation_id)
    msgs = list(session.exec(select(Message).where(Message.conversation_id == c.id).order_by(Message.id)))
    return _conv_out(c, msgs)


class ConversationUpdate(BaseModel):
    title: str | None = None
    model: str | None = None
    use_rag: bool | None = None
    system_prompt: str | None = None


@router.patch("/conversations/{conversation_id}")
def update_conversation(project_id: int, conversation_id: int, body: ConversationUpdate,
                        session: Session = Depends(get_session)) -> dict:
    c = _conv(session, project_id, conversation_id)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(c, field, value)
    session.add(c)
    session.commit()
    session.refresh(c)
    return _conv_out(c)


@router.delete("/conversations/{conversation_id}", status_code=204)
def delete_conversation(project_id: int, conversation_id: int, session: Session = Depends(get_session)) -> None:
    c = _conv(session, project_id, conversation_id)
    for m in session.exec(select(Message).where(Message.conversation_id == c.id)):
        session.delete(m)
    session.flush()  # children first: there are no ORM relationships to order the deletes
    session.delete(c)
    session.commit()


class ChatRequest(BaseModel):
    message: str
    conversation_id: int | None = None
    model: str | None = None
    use_rag: bool | None = None
    system_prompt: str | None = None
    temperature: float | None = None
    top_k: int | None = None
    think: bool = True


def _line(obj: dict) -> bytes:
    return (json.dumps(obj) + "\n").encode()


@router.post("/chat")
async def chat(project_id: int, body: ChatRequest, session: Session = Depends(get_session)):
    """Streams newline-delimited JSON events:
    {"type": "meta", "conversation", "model", "sources"}  then  {"type": "thinking"|"delta", "text"}...
    then {"type": "done", "message"} or {"type": "error", "message"}."""
    project = get_project_or_404(session, project_id)
    question = body.message.strip()
    if not question:
        raise HTTPException(400, "message is empty")
    cfg = project.effective_settings()

    if body.conversation_id is not None:
        conv = _conv(session, project_id, body.conversation_id)
    else:
        conv = Conversation(project_id=project_id, system_prompt=cfg.get("system_prompt"))
    if body.use_rag is not None:
        conv.use_rag = body.use_rag
    if body.system_prompt is not None:
        conv.system_prompt = body.system_prompt or None
    model_ref = body.model or conv.model or cfg.get("chat_model") or await default_chat_model(session)
    conv.model = model_ref
    if conv.title == "New chat":
        conv.title = question[:60] + ("…" if len(question) > 60 else "")
    conv.updated_at = utcnow()
    session.add(conv)
    session.commit()
    session.refresh(conv)

    history = [{"role": m.role, "content": m.content} for m in
               session.exec(select(Message).where(Message.conversation_id == conv.id).order_by(Message.id))]

    try:
        client, model, _ = resolve(model_ref, session)
    except ProviderError as e:
        raise HTTPException(400, str(e))

    sources = None
    retrieval_ms = None
    if conv.use_rag and kb.count(project_id) > 0:
        r = await retrieve(session, project, question, body.top_k)
        sources, retrieval_ms = r["results"], r["total_ms"]

    session.add(Message(conversation_id=conv.id, role="user", content=question))
    session.commit()

    messages = rag.build_messages(question, history, sources, conv.system_prompt)
    options = {"think": body.think}
    if body.temperature is not None:
        options["temperature"] = body.temperature
    conv_out = _conv_out(conv)

    async def stream():
        yield _line({"type": "meta", "conversation": conv_out, "model": model_ref, "sources": sources,
                     "retrieval_ms": retrieval_ms})
        answer, thinking, stats, error = "", "", None, None
        started = time.perf_counter()
        first_token_ms = None
        try:
            async for chunk in client.chat_stream(model, messages, options):
                if chunk.get("thinking"):
                    thinking += chunk["thinking"]
                    yield _line({"type": "thinking", "text": chunk["thinking"]})
                if chunk.get("delta"):
                    if first_token_ms is None:
                        first_token_ms = round((time.perf_counter() - started) * 1000)
                    answer += chunk["delta"]
                    yield _line({"type": "delta", "text": chunk["delta"]})
                if chunk.get("done"):
                    stats = chunk.get("stats")
        except ProviderError as e:
            error = str(e)
        except BaseException:  # client disconnected (Stop): keep what we have
            error = "stopped"
            _save(conv.id, model_ref, answer, thinking, sources, stats, first_token_ms, retrieval_ms, error)
            raise
        msg = _save(conv.id, model_ref, answer, thinking, sources, stats, first_token_ms, retrieval_ms, error)
        if error:
            yield _line({"type": "error", "message": error, "message_id": msg.id})
        else:
            yield _line({"type": "done", "message": msg.model_dump(mode="json")})

    return StreamingResponse(stream(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _save(conversation_id: int, model_ref: str, answer: str, thinking: str, sources, stats, first_token_ms,
          retrieval_ms, error: str | None) -> Message:
    with Session(engine) as s:
        stats = {**(stats or {}), "first_token_ms": first_token_ms, "retrieval_ms": retrieval_ms}
        msg = Message(conversation_id=conversation_id, role="assistant", content=answer, thinking=thinking or None,
                      model=model_ref, sources=sources, stats=stats, error=error)
        s.add(msg)
        conv = s.get(Conversation, conversation_id)
        if conv is not None:
            conv.updated_at = utcnow()
            s.add(conv)
        s.commit()
        s.refresh(msg)
        return msg


def delete_project_conversations(session: Session, project_id: int) -> None:
    for c in session.exec(select(Conversation).where(Conversation.project_id == project_id)):
        for m in session.exec(select(Message).where(Message.conversation_id == c.id)):
            session.delete(m)
        session.flush()
        session.delete(c)
    session.flush()
