import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth/client";

export function SignInPanel({ callbackURL = "/" }: { callbackURL?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const result = creating
        ? await authClient.signUp.email({ email, password, name })
        : await authClient.signIn.email({ email, password });
      if (result.error) {
        setError(
          result.error.message || "Sign in failed. Registration must be enabled by the operator.",
        );
        return;
      }
      window.location.assign(
        callbackURL.startsWith("/") && !callbackURL.startsWith("//") ? callbackURL : "/",
      );
    } catch {
      setError("Unable to connect. Please try again.");
    } finally {
      setPending(false);
    }
  }
  const inputClass = "h-11 w-full rounded-md border border-border bg-bg px-3 text-sm";
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      {creating && (
        <label className="text-sm">
          Name
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            required
          />
        </label>
      )}
      <label className="text-sm">
        Email
        <input
          className={inputClass}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          required
        />
      </label>
      <label className="text-sm">
        Password
        <input
          className={inputClass}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={creating ? "new-password" : "current-password"}
          minLength={creating ? 12 : undefined}
          required
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <button
        disabled={pending}
        className="h-11 rounded-md bg-primary text-primary-fg disabled:opacity-50"
      >
        {pending ? "Please wait…" : creating ? "Create account" : "Sign in"}
      </button>
      <button
        type="button"
        className="text-sm underline"
        onClick={() => {
          setCreating(!creating);
          setError("");
        }}
      >
        {creating ? "Use an existing account" : "Create an account (when enabled by operator)"}
      </button>
    </form>
  );
}
