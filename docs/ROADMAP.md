# LLMCoach roadmap: studios

LLMCoach becomes six studios that share one engine, so everyone trains models the way they like to
work. Each studio is a separate front end over the same projects, documents, datasets, jobs and
models; nothing a studio does is invisible to the others. The visual plan (with mockups of all six)
is the owner's roadmap page; this file is the working copy for whoever picks the work up next.

BoxPilot, which hosts LLMCoach on BigBox, has its own plan: `HANDOFF-UI-REDESIGN.md` in the BoxPilot
repo. What LLMCoach needs from it is listed there (section 6) and at the end of this file.

## Where things stand

| | Milestone | State |
|---|---|---|
| L0 | Studio framework | ✅ 0.3.0: registry, switcher that remembers the choice (`llmcoach.studio` in localStorage), lazy-loaded studio bundles, CSS-scope theming. **Not yet:** switching keeps you on the same document or run (it keeps the project only). |
| L1 | Just the Chat, with drag-and-drop learning | ✅ 0.3.0: drop onto Remember / Learn, cited answers with a context rail, `/train /compare /learn /logs /model /kb /help /classic` as live cards. **Not yet:** a "Review" drop target (look at generated Q&A before it joins the dataset). |
| L2 | Inbox and learning loop | ✅ 0.4.0 for the core, see below. |
| L3 | Pipeline Canvas | ✅ 0.6.0 at `/canvas`: the project drawn from its real objects (folders → documents → knowledge base → chat and datasets → fine-tunes → evaluations, with the learning loop as a gate), React Flow (MIT), drag to rearrange (remembered per project), a drawer per node, blue lineage for the selected node, and **Run pipeline**: looks at every folder (the ledger skips files it has seen), waits for indexing and Q&A, then retrains only if the data or the training settings changed. Phones get a list of cards. **Not yet:** drawing new connections by hand (steps are added from the drawers and the Add step menu), and schedules as their own nodes. |
| L4 | Mission Control | ✅ 0.5.0 at `/console`: F1–F9 views of live tiles, a read-only wall view (F9 / W) that follows the running job, earlier runs overlaid on the loss chart, GPU temperature and power in the header, a readable-contrast setting (C), and ntfy alerts (F8) for finished and failed jobs, loop decisions and held files. **Not yet:** a GPU history chart (power and temperature over time); the header only shows the current values. |
| L5 | Workbench | Not started. Explorer tree, tabs and split panes, Ctrl K to every command, docked logs, run settings as code with diffs. |
| L6 | Field Notebook | Not started. Guided four steps, margin citations, a report builder with export, findings written from evaluation results. |
| L7 | Friendly Studio | Not started. Recipes and wizards, plain-language results, a shared "what to try next" service. |
| L8 | Accounts and sharing | Not started. Owner / trainer / viewer roles, a default studio per person, an audit log. Move it up if other people start using LLMCoach. |

## L2 in detail

Done (backend `api/inbox.py`, `api/loop.py`, `api/tokens.py`, `services/scan.py`; UI `pages/Inbox.tsx`
in Classic and an Inbox section in the Chat studio's context rail):

- **Watched folders** under one inbox root (`LLMCOACH_INBOX_DIR`, default `data/inbox`; BoxPilot mounts
  its `inbox` volume at `/inbox`). Sources are relative folders, so the API can't read elsewhere on disk;
  nested sources are refused. Subfolders are included; hidden and temp files are ignored.
- **Settling**: a file is read once it looks the same on two looks five seconds apart, or was last
  written more than 30 seconds ago, so half-copied files from a network share aren't read.
- **Ledger**: every file's fate (added, already known, skipped, held, kept out, failed). A file that
  changes replaces the document it added; a touched-but-unchanged file does nothing.
- **Checks before adding**: secrets (private keys, cloud and service tokens, JWTs, `password = …`) and
  personal data (SSNs, card numbers that pass Luhn, lists of five or more emails or phone numbers).
  Findings are stored masked. Held files wait in a review queue: *Add anyway* or *Keep out*.
- **Learn mode** writes practice Q&A into "Learned from the inbox" after indexing.
- **API tokens**: SHA-256 stored, shown once. `inbox` scope may only list projects and sources and upload
  into a source; no token may manage tokens or sign-in. Uploads land in the folder exactly as if copied.
- **Learning loop**: at a set time (stored in UTC, shown in local time) it trains on the learned dataset
  if it grew enough, evaluates the new adapter against the promoted one on the test split, and promotes
  it only when F1 beats the current one by the margin. Runs chain through `AFTER_HOOKS` in
  `services/jobs.py`. The promoted adapter is marked by `FineTune.promoted_at` (the model registry).

Still to do for L2:

- **Buckets** (MinIO / S3 prefixes) as a source kind, polled like folders.
- **Export the promoted adapter to Ollama** (merge + GGUF, or Ollama's safetensors adapter import where
  the architecture allows) so the chat can use it. Until then "promoted" means "the current best",
  used as the loop's baseline and shown in the registry.
- Deleted files in a watched folder leave their documents in place; offer "remove documents whose
  files are gone".

Fixed along the way (0.6.0): a learn run that found nothing to learn from used to empty the dataset
it appends to; now it keeps what was there. An indexing job cut short by a restart (an app update)
now starts again instead of failing.

## What LLMCoach needs from BoxPilot

- The `inbox` volume and `LLMCOACH_INBOX_DIR=/inbox` in `catalog/llmcoach.yaml` (shipped with the 0.4.0
  catalog bump), and BoxPilot's SMB share pointed at that folder.
- `gpu: optional` on the LLMCoach manifest once a CUDA image exists.
- Whisper and ntfy in the catalog, for voice notes and alerts.

## Shipping

Tag `vX.Y.Z` → the image workflow tests and publishes `ghcr.io/aes256afro/llmcoach:X.Y.Z` → bump
`catalog/llmcoach.yaml` in BoxPilot → release BoxPilot. Released: 0.3.0 (Chat studio), 0.4.0 (inbox and learning loop),
0.5.0 (Mission Control and alerts), 0.6.0 (Pipeline Canvas). BoxPilot PR #267 carries the catalog bump and the inbox volume.
