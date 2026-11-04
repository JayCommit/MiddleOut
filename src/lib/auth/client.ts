import { createAuthClient } from "better-auth/react";
export const authClient = createAuthClient();
export const authEnabled = true;
export async function signOut(): Promise<void> {
  const result = await authClient.signOut();
  if (result.error) throw new Error(result.error.message || "Sign out failed.");
  window.location.assign("/login");
}
