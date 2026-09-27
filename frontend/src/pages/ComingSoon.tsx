import { PageHeader } from '../components/Layout'
import { Card } from '../components/ui'

export function ComingSoon({ title, phase, bullets }: { title: string; phase: number; bullets: string[] }) {
  return (
    <>
      <PageHeader title={title} subtitle={`Planned for phase ${phase}`} />
      <Card>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          {bullets.map((b) => <li key={b}>{b}</li>)}
        </ul>
      </Card>
    </>
  )
}
