export function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="border-b border-edge px-3 py-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[11px] uppercase tracking-wide text-neutral-400">{title}</h3>
        {action}
      </div>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2 text-xs text-neutral-400">
      <span className="w-20 shrink-0">{label}</span>
      <div className="flex-1 flex items-center gap-2">{children}</div>
    </label>
  );
}

export function NumberField({
  value,
  onChange,
  min,
  max,
  step = 0.01,
  suffix,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
  return (
    <div className="flex items-center gap-1 flex-1">
      <input
        type="number"
        className="w-full bg-panelAlt border border-edge rounded px-1.5 py-0.5 text-xs
                   text-neutral-200 tabular-nums focus:outline-none focus:border-accent"
        value={Number.isFinite(value) ? Number(value.toFixed(3)) : 0}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
      />
      {suffix && <span className="text-[10px] text-neutral-600">{suffix}</span>}
    </div>
  );
}

export function Slider({
  value,
  onChange,
  onCommit,
  min,
  max,
  step,
}: {
  value: number;
  onChange: (v: number) => void;
  onCommit?: () => void;
  min: number;
  max: number;
  step: number;
}) {
  return (
    <input
      type="range"
      className="flex-1"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
      onMouseUp={onCommit}
    />
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-neutral-400 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-accent"
      />
      {label}
    </label>
  );
}
