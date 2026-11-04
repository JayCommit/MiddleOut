import { Link, useMatchRoute } from "@tanstack/react-router";
import { Activity, BookOpen, Boxes, KeyRound, LayoutDashboard, Menu, Settings, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Logo } from "@/components/logo";
import { UserButton } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { cn } from "@/lib/cn";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, fuzzy: false },
  { to: "/buckets", label: "Buckets", icon: Boxes, fuzzy: true },
  { to: "/keys", label: "Access keys", icon: KeyRound, fuzzy: false },
  { to: "/activity", label: "Activity", icon: Activity, fuzzy: false },
  { to: "/settings", label: "Settings", icon: Settings, fuzzy: false },
  { to: "/docs", label: "Docs", icon: BookOpen, fuzzy: false },
] as const;

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const match = useMatchRoute();
  return (
    <nav className="flex flex-col gap-1">
      {NAV.map((item) => {
        const on = Boolean(match({ to: item.to, fuzzy: item.fuzzy }));
        const Icon = item.icon;
        return (
          <Link
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            className={cn(
              "flex h-11 items-center gap-3 rounded-md px-3 text-sm transition-colors duration-200",
              on ? "bg-raised text-fg" : "text-muted hover:bg-raised hover:text-fg",
            )}
          >
            <Icon className="h-4 w-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function AccountSlot() {
  const { user, isPending } = useCurrentUserState();
  if (isPending) return <div className="h-8 w-36 animate-pulse rounded-md bg-raised" />;
  if (!user) return null;
  return <UserButton />;
}

export function Shell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="min-h-screen bg-bg text-fg">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3 md:hidden">
        <button
          type="button"
          aria-label="Open menu"
          className="grid h-11 w-11 place-items-center rounded-md hover:bg-raised"
          onClick={() => setOpen(true)}
        >
          <Menu className="h-5 w-5" />
        </button>
        <Logo />
      </header>
      {open ? (
        <div className="fixed inset-0 z-40 md:hidden" onMouseDown={() => setOpen(false)}>
          <div className="absolute inset-0 bg-bg/80" />
          <div
            className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-border bg-surface p-4"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="mb-6 flex items-center justify-between">
              <Logo />
              <button type="button" aria-label="Close menu" className="grid h-11 w-11 place-items-center" onClick={() => setOpen(false)}>
                <X className="h-5 w-5" />
              </button>
            </div>
            <NavLinks onNavigate={() => setOpen(false)} />
            <div className="mt-auto pt-6">
              <AccountSlot />
            </div>
          </div>
        </div>
      ) : null}
      <div className="md:grid md:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="hidden min-h-screen flex-col border-r border-border bg-surface p-4 md:flex">
          <div className="mb-6 px-1">
            <Logo />
          </div>
          <NavLinks />
          <div className="mt-auto px-1 pt-6">
            <AccountSlot />
          </div>
        </aside>
        <main className="min-w-0 px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}
