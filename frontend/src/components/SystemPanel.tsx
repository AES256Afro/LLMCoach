import { Area, AreaChart, ResponsiveContainer, YAxis } from 'recharts'
import type { StatsSample } from '../hooks/streams'
import type { SystemStats } from '../api'
import { Card, Meter } from './ui'

const BACKEND_LABEL = { cpu: 'CPU only', cuda: 'NVIDIA CUDA', rocm: 'AMD ROCm' }

function Spark({ data, k, color }: { data: StatsSample[]; k: keyof StatsSample; color: string }) {
  return (
    <ResponsiveContainer width="100%" height={36}>
      <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <YAxis hide domain={[0, 100]} />
        <Area type="monotone" dataKey={k} stroke={color} fill={color} fillOpacity={0.15} isAnimationActive={false} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

export function SystemPanel({ stats, history }: { stats: SystemStats | null; history: StatsSample[] }) {
  if (!stats) return <Card title="System"><div className="text-sm text-muted">Connecting…</div></Card>
  return (
    <Card
      title="System"
      actions={
        <span className={`rounded px-2 py-0.5 text-xs ${stats.backend === 'cpu' ? 'bg-warn/15 text-warn' : 'bg-ok/15 text-ok'}`}>
          {BACKEND_LABEL[stats.backend]}
        </span>
      }
    >
      <div className="grid gap-5 md:grid-cols-2">
        <div className="space-y-2">
          <Meter label="CPU" value={stats.cpu_pct} />
          <Spark data={history} k="cpu" color="#7c9cff" />
          <Meter label="RAM" value={stats.ram_used_gb} max={stats.ram_total_gb} unit=" GB"
                 detail={`/ ${stats.ram_total_gb.toFixed(0)} GB`} />
          <Spark data={history} k="ram" color="#c084fc" />
        </div>
        {stats.gpus.length === 0 ? (
          <div className="flex flex-col justify-center rounded-md border border-dashed border-line p-4 text-sm text-muted">
            <p className="font-medium text-text">No GPU detected</p>
            <p className="mt-1">RAG and inference run on CPU. Training is limited to tiny models until a GPU is installed.</p>
          </div>
        ) : (
          stats.gpus.map((g) => (
            <div key={g.index} className="space-y-2">
              <div className="text-xs font-medium">GPU {g.index} · {g.name}</div>
              <Meter label="Utilization" value={g.util_pct} />
              <Spark data={history} k="gpuUtil" color="#4ade80" />
              <Meter label="VRAM" value={g.vram_used_gb} max={g.vram_total_gb ?? 1} unit=" GB"
                     detail={g.vram_total_gb ? `/ ${g.vram_total_gb.toFixed(0)} GB` : undefined} />
              <div className="flex gap-4 text-xs text-muted">
                <span>🌡 {g.temp_c ?? '—'}°C</span>
                <span>⚡ {g.power_w?.toFixed(0) ?? '—'} W</span>
              </div>
            </div>
          ))
        )}
      </div>
    </Card>
  )
}
