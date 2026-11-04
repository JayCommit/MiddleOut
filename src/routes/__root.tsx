import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { AuthProvider } from "@/lib/auth/provider";

import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Middle Out" },
      { name: "description", content: "Self-hosted S3-compatible object storage." },
      { name: "theme-color", content: "#0e1211" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  component: () => (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <AuthProvider>
          <Outlet />
        </AuthProvider>
        <Toaster
          theme="dark"
          toastOptions={{
            style: {
              background: "var(--color-surface)",
              color: "var(--color-fg)",
              border: "1px solid var(--color-border)",
            },
          }}
        />
        <Scripts />
      </body>
    </html>
  ),
});
