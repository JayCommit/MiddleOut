import { createRouter } from "@tanstack/react-router";
import { AppErrorComponent } from "@/lib/error-component";
import { previewPathRewrite } from "@/lib/preview-path-prefix";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    rewrite: previewPathRewrite(),
    defaultErrorComponent: AppErrorComponent,
    defaultNotFoundComponent: NotFound,
  });
}

function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center bg-bg px-6 text-center text-fg">
      <div>
        <p className="text-sm text-muted">404</p>
        <h1 className="mt-2 text-2xl font-semibold">That page isn’t here</h1>
        <a href="/" className="mt-4 inline-block text-sm text-primary">
          Back to Middle Out
        </a>
      </div>
    </main>
  );
}
