export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <path
        d="M6.2 8.2 L13.6 16 L6.2 23.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M25.8 8.2 L18.4 16 L25.8 23.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="14.15" y="14.35" width="3.7" height="3.3" rx="0.45" className="fill-primary" />
    </svg>
  );
}

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-fg">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border bg-bg">
        <Mark className="h-6 w-6" />
      </span>
      {compact ? null : <span className="truncate text-sm font-semibold tracking-tight">Middle Out</span>}
    </span>
  );
}
