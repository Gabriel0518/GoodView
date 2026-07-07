// 零依赖 SVG 折线图（浅色：网格极浅、坐标轴 faint、序列色由调用方传入）
export function LineChart({
  labels,
  series,
  height = 180,
  valueFmt = (v: number) => String(Math.round(v)),
}: {
  labels: string[];
  series: { name: string; color: string; values: number[] }[];
  height?: number;
  valueFmt?: (v: number) => string;
}) {
  const w = 640;
  const h = height;
  const padL = 52;
  const padR = 14;
  const padT = 14;
  const padB = 24;
  const n = labels.length;
  const all = series.flatMap((s) => s.values);
  const max = Math.max(1, ...all);
  const min = Math.min(0, ...all);
  const span = max - min || 1;

  const X = (i: number) => padL + (n <= 1 ? 0 : (i / (n - 1)) * (w - padL - padR));
  const Y = (v: number) => padT + (1 - (v - min) / span) * (h - padT - padB);

  const grid = [0, 0.5, 1].map((t) => min + t * span);
  const xTicks = n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1];

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="none" style={{ height }}>
      {grid.map((g, i) => (
        <g key={i}>
          <line x1={padL} x2={w - padR} y1={Y(g)} y2={Y(g)} stroke="#F1F3F5" strokeWidth={1} />
          <text x={padL - 8} y={Y(g) + 3} textAnchor="end" fontSize={10} fill="#9CA3AF" className="tnum">
            {valueFmt(g)}
          </text>
        </g>
      ))}
      {series.map((s) => {
        const d = s.values.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
        return (
          <g key={s.name}>
            <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {s.values.map((v, i) => (
              <circle key={i} cx={X(i)} cy={Y(v)} r={n > 40 ? 0 : 1.6} fill={s.color} />
            ))}
          </g>
        );
      })}
      {xTicks.map((i) => (
        <text key={i} x={X(i)} y={h - 6} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} fontSize={10} fill="#9CA3AF">
          {labels[i]?.slice(5)}
        </text>
      ))}
    </svg>
  );
}

// 极简迷你趋势线（无坐标轴）
export function Sparkline({ values, color = "#4F46E5", height = 34 }: { values: number[]; color?: string; height?: number }) {
  const w = 120;
  const h = height;
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const n = values.length;
  const X = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * (w - 2)) + 1;
  const Y = (v: number) => 2 + (1 - (v - min) / span) * (h - 4);
  const d = values.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height }}>
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      {n > 0 && <circle cx={X(n - 1)} cy={Y(values[n - 1])} r={2} fill={color} />}
    </svg>
  );
}
