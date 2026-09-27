import { Link } from 'react-router-dom'
import type { Job } from '../api'
import { Empty, StatusBadge, fmtDuration, fmtTime } from './ui'

export function JobTable({ jobs }: { jobs: Job[] }) {
  if (!jobs.length) return <Empty>No jobs yet.</Empty>
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs text-muted">
        <tr>
          <th className="pb-2 font-normal">#</th>
          <th className="pb-2 font-normal">Kind</th>
          <th className="pb-2 font-normal">Status</th>
          <th className="pb-2 font-normal">Created</th>
          <th className="pb-2 font-normal">Duration</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((j) => (
          <tr key={j.id} className="border-t border-line hover:bg-panel-2">
            <td className="py-2">
              <Link to={`/jobs/${j.id}`} className="font-mono text-accent hover:underline">#{j.id}</Link>
            </td>
            <td className="py-2">{j.kind}</td>
            <td className="py-2"><StatusBadge status={j.status} /></td>
            <td className="py-2 text-muted">{fmtTime(j.created_at)}</td>
            <td className="py-2 font-mono text-muted">{fmtDuration(j.started_at, j.finished_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
