import type { ReactNode } from "react";
import { Logo } from "@/components/logo";
import { Shell } from "@/components/shell";
import { SignInPanel } from "@/components/sign-in-panel";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export function Authed({ children }: { children: ReactNode }) {
  const { user, isPending } = useCurrentUserState();
  if (isPending) {
    return (
      <Shell>
        <p className="text-sm text-muted">Loading your storage…</p>
      </Shell>
    );
  }
  if (!user) {
    return (
      <main className="grid min-h-screen place-items-center bg-bg px-6 text-fg">
        <div className="w-full max-w-sm">
          <Logo />
          <h1 className="mt-6 text-2xl font-semibold">Sign in to your node</h1>
          <p className="mt-2 text-sm text-muted">Buckets, keys, and private objects stay on this account.</p>
          <div className="mt-6">
            <SignInPanel />
          </div>
        </div>
      </main>
    );
  }
  return <>{children}</>;
}
