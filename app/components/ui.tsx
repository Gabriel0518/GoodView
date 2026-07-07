import { cn } from "../lib/util";

// 浅色 SaaS 基础组件（UI-设计需求.md §4）。

export function Panel({
  title,
  subtitle,
  action,
  children,
  className,
}: {
  title?: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-xl border border-border bg-surface p-5 shadow-sm", className)}>
      {(title || action) && (
        <header className="mb-4 flex items-center justify-between gap-3">
          <div>
            {title && <h2 className="text-[15px] font-medium text-strong">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-surface px-5 py-4 shadow-sm">
      <div className="text-xs text-muted">{label}</div>
      <div className={cn("tnum mt-1 text-[28px] font-semibold leading-tight", accent ? "text-accent" : "text-strong")}>{value}</div>
      {sub && <div className="tnum mt-1 text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "default",
  disabled,
  title,
  type,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "ghost" | "danger";
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type || "button"}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" && "bg-accent text-white shadow-sm hover:bg-accent-600",
        variant === "default" && "border border-border bg-surface text-body hover:bg-subtle",
        variant === "ghost" && "text-muted hover:bg-subtle hover:text-body",
        variant === "danger" && "border border-danger/30 bg-surface text-danger hover:bg-danger-soft",
      )}
    >
      {children}
    </button>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-border bg-subtle p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-md px-3 py-1 text-xs font-medium transition",
            value === o.value ? "bg-surface text-accent shadow-sm" : "text-muted hover:text-body",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// 徽章/Pill（§4.4）
export function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "accent" | "success" | "danger" | "warning" }) {
  const tones: Record<string, string> = {
    neutral: "bg-subtle text-muted",
    accent: "bg-accent-soft text-accent",
    success: "bg-success-soft text-success",
    danger: "bg-danger-soft text-danger",
    warning: "bg-warning-soft text-warning",
  };
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium", tones[tone])}>{children}</span>;
}
