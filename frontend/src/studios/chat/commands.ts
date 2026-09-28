import { api, type Dataset, type Project } from '../../api'
import type { ChatSession } from './useChatSession'

export interface Command {
  name: string
  args?: string
  description: string
}

export const COMMANDS: Command[] = [
  { name: 'add', description: 'Add files to the knowledge base' },
  { name: 'learn', args: '[all]', description: 'Pick files to learn from, or "all" for the whole knowledge base' },
  { name: 'train', args: '[base model]', description: 'Fine-tune a model on what the chat has learned' },
  { name: 'compare', description: 'Score the model with and without your documents, and your latest fine-tune' },
  { name: 'model', args: '<name>', description: 'Switch the chat model' },
  { name: 'kb', args: 'on|off', description: 'Answer from the knowledge base, or not' },
  { name: 'logs', description: "Show the latest job's output" },
  { name: 'new', description: 'Start a new chat' },
  { name: 'help', description: 'What you can do here' },
  { name: 'classic', description: 'Open the Classic studio' },
]

export function matchCommands(text: string): Command[] {
  if (!text.startsWith('/') || text.includes('\n')) return []
  const typed = text.slice(1).split(/\s/)[0].toLowerCase()
  if (text.includes(' ')) return COMMANDS.filter((c) => c.name === typed)
  return COMMANDS.filter((c) => c.name.startsWith(typed))
}

export function parseCommand(text: string): { name: string; args: string } | null {
  const m = /^\/([a-z-]+)\s*(.*)$/is.exec(text.trim())
  if (!m) return null
  const name = m[1].toLowerCase() === 'add-docs' ? 'add' : m[1].toLowerCase()
  return COMMANDS.some((c) => c.name === name) ? { name, args: m[2].trim() } : null
}

export const HELP_TEXT = [
  'Drop files anywhere, onto **Remember** (the bot looks things up and cites them), **Learn** (it also writes practice Q&A for fine-tuning) or **Review first** (you tick which Q&A to keep).',
  'Attach a file and type a question to ask about it as soon as it is indexed.',
  '',
  ...COMMANDS.map((c) => `\`/${c.name}${c.args ? ` ${c.args}` : ''}\`: ${c.description}`),
].join('\n')

/** What the commands need from the studio. */
export interface CommandContext {
  project: Project
  session: ChatSession
  chatModel: () => Promise<string | null>
  kbChunks: number
  pickFiles: (mode: 'remember' | 'learn') => void
  goClassic: () => void
}

function trainable(datasets: Dataset[]): Dataset | null {
  const ready = datasets.filter((d) => d.status === 'ready' && (d.splits?.train ?? 0) > 0)
  return ready.find((d) => d.source === 'chat') ?? ready[0] ?? null
}

function testable(datasets: Dataset[]): Dataset | null {
  const ready = datasets.filter((d) => d.status === 'ready' && ((d.splits?.test ?? 0) + (d.splits?.val ?? 0)) > 0)
  return ready.find((d) => d.source === 'chat') ?? ready[0] ?? null
}

export async function runCommand(ctx: CommandContext, name: string, args: string): Promise<void> {
  const { project, session } = ctx
  const pid = project.id
  const fail = (text: string) => session.note('error', text)
  try {
    switch (name) {
      case 'help':
        session.note('help', HELP_TEXT)
        return
      case 'new':
        session.newChat()
        return
      case 'classic':
        ctx.goClassic()
        return
      case 'add':
        ctx.pickFiles('remember')
        return
      case 'kb': {
        const on = args ? !/^(off|no|false|0)$/i.test(args) : !session.settings.useRag
        session.setSettings((s) => ({ ...s, useRag: on }))
        session.note('info', on ? 'Answers will use the knowledge base.' : 'Answers will come from the model alone.')
        return
      }
      case 'model': {
        const models = await api.models('chat')
        if (!args) {
          session.note('info', `Chat models: ${models.map((m) => `\`${m.ref}\``).join(', ') || 'none found'}. Type \`/model <name>\` to switch.`)
          return
        }
        const want = args.toLowerCase()
        const found = models.find((m) => m.ref.toLowerCase() === want) ?? models.find((m) => m.ref.toLowerCase().includes(want))
        if (!found) return fail(`No chat model matches “${args}”. Available: ${models.map((m) => m.ref).join(', ')}`)
        session.setSettings((s) => ({ ...s, model: found.ref }))
        session.note('info', `Now chatting with \`${found.ref}\`.`)
        return
      }
      case 'learn': {
        if (!/^(all|kb|everything)$/i.test(args)) {
          ctx.pickFiles('learn')
          return
        }
        const conv = await session.ensureConversation()
        const model = await ctx.chatModel()
        await api.learnFromKnowledge(pid, { conversation_id: conv?.id, model: model ?? undefined, max_chunks: 20 })
        await session.reload(conv?.id)
        return
      }
      case 'train': {
        const [opts, datasets] = await Promise.all([api.trainingOptions(), api.datasets(pid)])
        const ds = trainable(datasets)
        if (!ds) return fail('Nothing to train on yet. Drop files onto **Learn**, or type `/learn all` to learn from the knowledge base.')
        const base = args || opts.recommended_base_model
        const r = await api.createFinetune(pid, { base_model: base, dataset_id: ds.id, preset: 'quick', method: 'lora', backend: 'auto', overrides: {} })
        if (!r.job || !r.finetune) return fail('Training could not start.')
        await session.addEvent(`Training ${base.split('/').pop()} on “${ds.name}”`, {
          card: 'train', job_id: r.job.id, finetune_id: r.finetune.id, base_model: base, dataset_id: ds.id,
          dataset_name: ds.name, total_steps: r.plan.total_steps, device: r.plan.device, backend: r.plan.backend,
        })
        return
      }
      case 'compare': {
        const [datasets, finetunes] = await Promise.all([api.datasets(pid), api.finetunes(pid)])
        const ds = testable(datasets)
        if (!ds) return fail('Comparing needs a dataset with test questions. Drop files onto **Learn** first.')
        const model = await ctx.chatModel()
        if (!model) return fail('No chat model is available. Pull one in Ollama first.')
        const ft = finetunes.find((f) => f.status === 'ready' && f.dataset_id === ds.id) ?? finetunes.find((f) => f.status === 'ready')
        const variants: { kind: 'model' | 'finetune'; ref: string; rag: boolean }[] = [{ kind: 'model', ref: model, rag: false }]
        if (ctx.kbChunks > 0) variants.push({ kind: 'model', ref: model, rag: true })
        if (ft) variants.push({ kind: 'finetune', ref: String(ft.id), rag: false })
        const r = await api.createEval(pid, { name: `Chat compare on ${ds.name}`, dataset_id: ds.id, variants, max_examples: 10 })
        await session.addEvent(`Comparing ${variants.length} versions on “${ds.name}”`, {
          card: 'eval', job_id: r.job.id, eval_id: r.eval.id, dataset_name: ds.name,
        })
        return
      }
      case 'logs': {
        const [job] = await api.jobs({ limit: 1, project_id: pid })
        if (!job) return fail('No jobs have run in this project yet.')
        await session.addEvent(`Output of job #${job.id} (${job.kind})`, { card: 'logs', job_id: job.id })
        return
      }
    }
  } catch (err) {
    fail(err instanceof Error ? err.message.replace(/^\d+: /, '') : String(err))
  }
}
