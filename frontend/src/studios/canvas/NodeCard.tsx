import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import { Database, FileText, FolderInput, MessagesSquare, Plus, Scale, Table2, Timer, Zap } from 'lucide-react'
import { COLOR, type CardData, type Kind } from './graph'

export const ICON: Record<Kind, typeof FileText> = {
  source: FolderInput, 'add-source': Plus, docs: FileText, kb: Database, chat: MessagesSquare,
  dataset: Table2, finetune: Zap, eval: Scale, loop: Timer,
}

/** Sources have no inputs; chat and evaluations have no outputs. */
const INPUT: Record<Kind, boolean> = { source: false, 'add-source': false, docs: true, kb: true, chat: true, dataset: true, finetune: true, eval: true, loop: true }
const OUTPUT: Record<Kind, boolean> = { source: true, 'add-source': true, docs: true, kb: true, chat: false, dataset: true, finetune: true, eval: false, loop: true }

export function CardBody({ data }: { data: CardData }) {
  const Icon = ICON[data.kind]
  return (
    <>
      {data.kind !== 'add-source' && <i className={`cv-st ${data.status}`} aria-label={data.status} />}
      <div className="cv-nh">
        <span className="cv-ic" style={{ background: COLOR[data.kind] }}><Icon className="h-3.5 w-3.5" /></span>
        <b title={data.title}>{data.title}</b>
      </div>
      <div className="cv-nb"><b>{data.main}</b><br />{data.rest}</div>
      {data.star && <span className="cv-star">{data.star}</span>}
      <span className="cv-type">{data.type}</span>
    </>
  )
}

export function NodeCard({ data }: NodeProps<Node<CardData>>) {
  return (
    <div className={`cv-node ${data.selected ? 'sel' : ''} ${data.kind === 'add-source' ? 'ghost' : ''}`}>
      {INPUT[data.kind] && <Handle type="target" position={Position.Left} isConnectable={false} />}
      <CardBody data={data} />
      {OUTPUT[data.kind] && <Handle type="source" position={Position.Right} isConnectable={false} />}
    </div>
  )
}
