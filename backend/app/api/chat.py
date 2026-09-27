import asyncio
import json
import logging
import time

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import Conversation, Message, engine, get_session, utcnow
from ..services import kb, rag
from ..services.providers import ProviderError, client_for, list_providers, resolve
from .datasets import learn_into_chat_dataset
from .knowledge import MAX_FILE_BYTES, retrieve, store_documents, submit_ingest
from .projects import get_project_or_404

log = logging.getLogger(__name__)

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


class ConversationCreate(BaseModel):
    title: str | None = None


@router.post("/conversations", status_code=201)
def create_conversation(project_id: int, body: ConversationCreate, session: Session = Depends(get_session)) -> dict:
    """An empty conversation, for when the first thing someone does is a command or a file drop."""
    project = get_project_or_404(session, project_id)
    c = Conversation(project_id=project_id, title=(body.title or "New chat")[:120],
                     system_prompt=project.effective_settings().get("system_prompt"))
    session.add(c)
    session.commit()
    session.refresh(c)
    return _conv_out(c, [])


class EventCreate(BaseModel):
    text: str
    data: dict = {}


def add_event(session: Session, conv: Conversation, text: str, data: dict) -> Message:
    """A card in the thread (files added, a run started, results). Never sent to the model."""
    msg = Message(conversation_id=conv.id, role="event", content=text, data=data)
    conv.updated_at = utcnow()
    session.add(conv)
    session.add(msg)
    session.commit()
    session.refresh(msg)
    return msg


@router.post("/conversations/{conversation_id}/events", status_code=201)
def create_event(project_id: int, conversation_id: int, body: EventCreate,
                 session: Session = Depends(get_session)) -> Message:
    if not body.text.strip():
        raise HTTPException(400, "event text is empty")
    if not isinstance(body.data.get("card"), str):
        raise HTTPException(400, "event data needs a 'card' type")
    return add_event(session, _conv(session, project_id, conversation_id), body.text.strip()[:2000], body.data)


def _files_phrase(n: int) -> str:
    return "1 file" if n == 1 else f"{n} files"


@router.post("/chat/attach", status_code=201)
async def attach(project_id: int, mode: str = Form("remember"), conversation_id: int | None = Form(None),
                 text: str = Form(""), title: str = Form(""), model: str | None = Form(None),
                 files: list[UploadFile] | None = File(None), session: Session = Depends(get_session)) -> dict:
    """Files dropped (or text pasted) into a chat.

    remember: add to the knowledge base, so answers can cite them within a minute.
    learn:    also write Q&A pairs from them into the "Learned in chat" dataset, for fine-tuning.
    Returns the event card added to the conversation (created if needed)."""
    project = get_project_or_404(session, project_id)
    if mode not in ("remember", "learn"):
        raise HTTPException(400, "mode must be 'remember' or 'learn'")
    items = [(f.filename or "file", await f.read(MAX_FILE_BYTES + 1)) for f in files or []]
    if text.strip():
        name = (title.strip() or f"Note {utcnow():%Y-%m-%d %H%M}")[:80]
        items.append((name if name.lower().endswith((".md", ".txt")) else f"{name}.md", text.encode("utf-8")))
    if not items:
        raise HTTPException(400, "nothing to add: drop a file or paste some text")

    if conversation_id is not None:
        conv = _conv(session, project_id, conversation_id)
    else:
        conv = Conversation(project_id=project_id, system_prompt=project.effective_settings().get("system_prompt"))
        session.add(conv)
        session.commit()
        session.refresh(conv)

    added, skipped = await store_documents(session, project_id, items)
    ingest = submit_ingest(session, project, [d.id for d in added]) if added else None
    # Learning also covers files that were already in the knowledge base.
    learn_ids = [d.id for d in added] + [s["doc_id"] for s in skipped if s.get("doc_id")]
    learn = None
    if mode == "learn" and learn_ids:
        cfg = project.effective_settings()
        model_ref = model or conv.model or cfg.get("chat_model") or await default_chat_model(session)
        dataset, job = learn_into_chat_dataset(session, project, model_ref, learn_ids,
                                               max_chunks=min(40, 8 * len(learn_ids)))
        learn = {"dataset_id": dataset.id, "dataset_name": dataset.name, "job_id": job.id, "model": model_ref}

    if added and learn:
        summary = f"Added {_files_phrase(len(added))} to the knowledge base and started learning from them"
    elif added:
        summary = f"Added {_files_phrase(len(added))} to the knowledge base"
    elif learn:
        summary = f"Learning from {_files_phrase(len(learn_ids))} already in the knowledge base"
    else:
        summary = "Nothing new was added"
    if conv.title == "New chat":
        conv.title = summary[:60]
    data = {
        "card": "attach", "mode": mode,
        "documents": [{"id": d.id, "filename": d.filename, "size_bytes": d.size_bytes} for d in added],
        "skipped": skipped, "ingest_job_id": ingest.id if ingest else None, "learn": learn,
    }
    msg = add_event(session, conv, summary, data)
    session.refresh(conv)
    return {"conversation": _conv_out(conv), "message": msg}


class LearnRequest(BaseModel):
    conversation_id: int | None = None
    model: str | None = None
    max_chunks: int = 20


@router.post("/chat/learn", status_code=201)
async def learn_from_knowledge(project_id: int, body: LearnRequest, session: Session = Depends(get_session)) -> dict:
    """/learn: write Q&A pairs from the whole knowledge base into "Learned in chat"."""
    project = get_project_or_404(session, project_id)
    if await asyncio.to_thread(kb.count, project_id) == 0:
        raise HTTPException(400, "the knowledge base is empty: drop some files into the chat first")
    if not 1 <= body.max_chunks <= 500:
        raise HTTPException(400, "max_chunks must be 1-500")
    if body.conversation_id is not None:
        conv = _conv(session, project_id, body.conversation_id)
    else:
        conv = Conversation(project_id=project_id, title="Learning from the knowledge base",
                            system_prompt=project.effective_settings().get("system_prompt"))
        session.add(conv)
        session.commit()
        session.refresh(conv)
    cfg = project.effective_settings()
    model_ref = body.model or conv.model or cfg.get("chat_model") or await default_chat_model(session)
    dataset, job = learn_into_chat_dataset(session, project, model_ref, None, max_chunks=body.max_chunks)
    msg = add_event(session, conv, f"Writing Q&A pairs from up to {body.max_chunks} passages into “{dataset.name}”",
                    {"card": "learn", "learn": {"dataset_id": dataset.id, "dataset_name": dataset.name,
                                                "job_id": job.id, "model": model_ref}})
    session.refresh(conv)
    return {"conversation": _conv_out(conv), "message": msg}


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
    # Resolve the model and retrieve before anything is committed, so a failure here
    # (no model, provider down, index mismatch) doesn't leave an empty "New chat" behind.
    model_ref = body.model or conv.model or cfg.get("chat_model") or await default_chat_model(session)
    try:
        client, model, _ = resolve(model_ref, session)
    except ProviderError as e:
        raise HTTPException(400, str(e))

    sources = None
    retrieval_ms = None
    if conv.use_rag and await asyncio.to_thread(kb.count, project_id) > 0:
        r = await retrieve(session, project, question, body.top_k)
        sources, retrieval_ms = r["results"], r["total_ms"]

    conv.model = model_ref
    if conv.title == "New chat":
        conv.title = question[:60] + ("…" if len(question) > 60 else "")
    conv.updated_at = utcnow()
    session.add(conv)
    session.commit()
    session.refresh(conv)

    history = [{"role": m.role, "content": m.content} for m in
               session.exec(select(Message).where(Message.conversation_id == conv.id).order_by(Message.id))]

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
        except Exception as e:  # a bug or an unexpected reply: report it rather than call it "stopped"
            log.exception("chat stream failed")
            error = f"{type(e).__name__}: {e}"
        except BaseException:  # client disconnected (Stop) or cancelled: keep what we have
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
