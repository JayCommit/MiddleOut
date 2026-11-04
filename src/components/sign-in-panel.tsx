import { GROK_PROVIDERS, authEnabled, signIn } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export function SignInPanel({ callbackURL = "/" }: { callbackURL?: string }) {
  const { user, isPending } = useCurrentUserState();
  if (isPending) return <p className="text-sm text-muted">Checking your session…</p>;
  if (user || !authEnabled) return null;
  return (
    <div className="flex w-full max-w-sm flex-col gap-2">
      {GROK_PROVIDERS.map((provider) => (
        <button
          key={provider.providerId}
          type="button"
          onClick={() => signIn(provider.providerId, { callbackURL })}
          className="h-11 w-full rounded-md bg-primary text-sm font-medium text-primary-fg transition-opacity duration-200 hover:opacity-90"
        >
          Continue with {provider.label}
        </button>
      ))}
    </div>
  );
}
