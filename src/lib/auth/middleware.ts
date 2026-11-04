import { createMiddleware } from "@tanstack/react-start";
export const authMiddleware = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const { assertSameSiteRequest } = await import("./isolation.server");
  const { requireUserId } = await import("./verify.server");
  assertSameSiteRequest();
  return next({ context: { userId: await requireUserId() } });
});
