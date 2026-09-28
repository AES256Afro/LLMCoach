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
| L0 | Studio framework | ✅ 0.3.0, finished in 0.7.0: registry, switcher that remembers the choice (`llmcoach.studio` in localStorage), lazy-loaded studio bundles, CSS-scope theming, and **switching keeps you on the same thing**: studios pass a `StudioContext` (conversation, fine-tune, evaluation, dataset, document) and `studioLink()` maps it to each studio's deep link (`/chat/1`, `/workbench?open=finetune:3`, `/notebook/report/2`, `/canvas?node=ds-1`, `?c=1` for the chat-based ones). |
| L1 | Just the Chat, with drag-and-drop learning | ✅ 0.3.0: drop onto Remember / Learn, cited answers with a context rail, `/train /compare /learn /logs /model /kb /help /classic` as live cards. **Not yet:** a "Review" drop target (look at generated Q&A before it joins the dataset). |
| L2 | Inbox and learning loop | ✅ 0.4.0 for the core, buckets and deleted files in 0.8.0; see below. |
| L3 | Pipeline Canvas | ✅ 0.6.0 at `/canvas`: the project drawn from its real objects (folders → documents → knowledge base → chat and datasets → fine-tunes → evaluations, with the learning loop as a gate), React Flow (MIT), drag to rearrange (remembered per project), a drawer per node, blue lineage for the selected node, and **Run pipeline**: looks at every folder (the ledger skips files it has seen), waits for indexing and Q&A, then retrains only if the data or the training settings changed. Phones get a list of cards. **Not yet:** drawing new connections by hand (steps are added from the drawers and the Add step menu), and schedules as their own nodes. |
| L4 | Mission Control | ✅ 0.5.0 at `/console`: F1–F9 views of live tiles, a read-only wall view (F9 / W) that follows the running job, earlier runs overlaid on the loss chart, GPU temperature and power in the header, a readable-contrast setting (C), and ntfy alerts (F8) for finished and failed jobs, loop decisions and held files. **Not yet:** a GPU history chart (power and temperature over time); the header only shows the current values. |
| L5 | Workbench | ✅ 0.7.0 at `/workbench`: an explorer tree of the project's real objects, tabs (chats, documents, datasets, fine-tunes, evaluations, jobs) remembered per project, an inspector for sources, logs docked below (Ctrl \`), a status bar, and Ctrl K reaching every object, command, studio and Classic page. Run settings as code: a new fine-tune is editable JSON with a dry run, and any run's config can be diffed against another's. `?open=finetune:3` deep-links a tab. **Not yet:** true split panes (two tabs side by side). |
| L6 | Field Notebook | ✅ 0.7.0 at `/notebook`: a four-step stepper (Documents → Dataset → Train → Evaluate) with "Ask your bot" set apart; answers as serif prose with the cited sentences highlighted and the quoted passages in the margin; each evaluation as a report with a headline finding written from the scores, a table, notes on how far to trust it, the fine-tune's loss figure and example answers, which copies as Markdown, downloads, or prints. The wording comes from `studios/findings.ts`, shared with the Friendly Studio. |
| L7 | Friendly Studio | ✅ 0.7.0 at `/friendly`: Home, Chat, Knowledge, Train and Results as big rounded cards; results as one sentence ("Your documents made answers 34% more accurate.") with a card per version (judge or accuracy ring, accuracy and speed bars); three recipes; one-button practice questions, teaching and testing with sensible defaults; and "What to try next" from `studios/recommend.ts`, which any studio can use. The word LoRA never appears. **Not yet:** the other studios don't show the recommendations yet. |
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
- **Deleted files**: a deleted file's document stays by default (the folder can be used as a drop box
  and cleared). With *Forget files deleted from this folder* (`mirror_deletes`), a file away for a
  minute takes its document out of the knowledge base, unless another watched copy holds the same
  content, and never while the whole folder looks empty (an unmounted share). A file put back is read
  again, and a kept document is recognised rather than added twice.
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

- **Buckets** (0.8.0): a source can read an S3-compatible bucket and prefix (MinIO, AWS, R2, Garage)
  instead of a folder. Each look mirrors new and changed objects into `data/buckets/<id>` and deletes
  mirror files whose object is gone; from there it is an ordinary folder, so settling, checks, the
  ledger and deletions behave the same. Objects that won't be read (too large, or a type LLMCoach
  can't parse) aren't downloaded: a sparse placeholder of the same size lets the ledger say why.
  Requests are signed with SigV4 in `services/s3.py` (checked against botocore's signatures in the
  tests) rather than through an SDK. A read-only key is enough; the secret is never returned by the
  API, and a new key is checked by listing the bucket before it's saved.

L2 is complete.

Added in 0.7.0: **export a fine-tune to Ollama** (`POST /finetunes/{id}/export`, the `export` job):
the adapter is merged into its base model, the safetensors and the base model's original tokenizer
files are uploaded to the Ollama server as blobs, and Ollama builds the model with `/api/create`,
quantized (q8_0 by default) and with a message template for the family (ChatML, Llama 3, Gemma).
It then works in every chat as `ollama/llmcoach-<project>-ft<id>`. Two traps, both handled: tokenizer
files re-saved by transformers 5 use a layout Ollama's converter misreads (the model answers in
question marks), and Ollama doesn't always recognise the chat format on its own.

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
0.5.0 (Mission Control and alerts), 0.6.0 (Pipeline Canvas), 0.7.0 (Field Notebook). BoxPilot PR #267 carries the catalog bump and the inbox volume.
