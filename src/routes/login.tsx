import { createFileRoute, Navigate } from "@tanstack/react-router";
import { Logo } from "@/components/logo";
import { SignInPanel } from "@/components/sign-in-panel";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export const Route = createFileRoute("/login")({ component: LoginPage });

function LoginPage() {
  const { user, isPending } = useCurrentUserState();
  if (!isPending && user) return <Navigate to="/" />;
  return (
    <main className="grid min-h-screen place-items-center bg-bg px-6 text-fg">
      <div className="w-full max-w-sm">
        <Logo />
        <h1 className="mt-6 text-2xl font-semibold">Sign in</h1>
        <p className="mt-2 text-sm text-muted">Your buckets stay tied to this account.</p>
        <div className="mt-6">
          <SignInPanel />
        </div>
      </div>
    </main>
  );
}
