import { Link, createFileRoute } from "@tanstack/react-router";
import { ArrowRight, Download, Folder, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { accessHintFn, publicListingFn } from "@/lib/storage/api";
import { withBase } from "@/lib/storage/paths";
import { encodeKeyPath, formatBytes, leafName } from "@/lib/storage/pure";

export const Route = createFileRoute("/p/$name")({
  validateSearch: (search: Record<string, unknown>) => ({
    prefix: typeof search.prefix === "string" ? search.prefix : "",
  }),
  component: PublicBrowser,
});

function PublicBrowser() {
  const { name } = Route.useParams();
  const { prefix } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { user, isPending } = useCurrentUserState();
  const [state, setState] = useState<"loading" | "open" | "closed">("loading");
  const [owned, setOwned] = useState(false);
  const [data, setData] = useState<Extract<Awaited<ReturnType<typeof publicListingFn>>, { available: true }> | null>(null);

  const [startAfter, setStartAfter] = useState("");
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);

  function load(cursor = startAfter) {
    publicListingFn({ data: { bucket: name, prefix, startAfter: cursor } })
      .then((result) => {
        if (!result.available) {
          setState("closed");
          setData(null);
          return;
        }
        setState("open");
        setData(result);
      })
      .catch(() => {
        setState("closed");
      });
  }

  useEffect(() => {
    let cancelled = false;
    setStartAfter("");
    setCursorHistory([]);
    publicListingFn({ data: { bucket: name, prefix, startAfter: "" } })
      .then((result) => {
        if (cancelled) return;
        if (!result.available) {
          setState("closed");
          setData(null);
          return;
        }
        setState("open");
        setData(result);
      })
      .catch(() => {
        if (!cancelled) setState("closed");
      });
    return () => {
      cancelled = true;
    };
  }, [name, prefix]);

  useEffect(() => {
    if (!user?.id || state !== "closed") return;
    let cancelled = false;
    accessHintFn({ data: { bucket: name } })
      .then((hint) => {
        if (!cancelled) setOwned(hint.owned);
      })
      .catch(() => {
        if (!cancelled) setOwned(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id, state, name]);

  function handleNextPage() {
    if (!data?.nextStart) return;
    setCursorHistory((prev) => [...prev, startAfter]);
    setStartAfter(data.nextStart);
    load(data.nextStart);
  }

  function handlePrevPage() {
    if (cursorHistory.length === 0) return;
    const prevCursor = cursorHistory[cursorHistory.length - 1] ?? "";
    setCursorHistory((prev) => prev.slice(0, -1));
    setStartAfter(prevCursor);
    load(prevCursor);
  }

  const crumbs = prefix.split("/").filter(Boolean);

  return (
    <main className="min-h-screen bg-bg text-fg">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4">
          <Logo />
          <span className="text-xs text-muted">Public bucket</span>
        </div>
      </header>
      <div className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="truncate font-mono text-2xl font-semibold">{name}</h1>
        {state === "loading" ? <p className="mt-6 text-sm text-muted">Loading…</p> : null}
        {state === "closed" ? (
          <div className="mt-10 rounded-lg border border-border bg-surface px-6 py-12 text-center">
            <Lock className="mx-auto h-6 w-6 text-muted" />
            <h2 className="mt-3 text-lg font-medium">This bucket isn’t available</h2>
            <p className="mt-2 text-sm text-muted">It is private or it does not exist. Nothing inside it is listed here.</p>
            {!isPending && owned ? (
              <Link to="/buckets/$name" params={{ name }} search={{ prefix: "" }} className="mt-4 inline-block text-sm text-primary">
                Open in the console
              </Link>
            ) : null}
          </div>
        ) : null}
        {state === "open" && data ? (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted">
              <button type="button" className="hover:text-fg" onClick={() => navigate({ search: { prefix: "" } })}>
                root
              </button>
              {crumbs.map((crumb, index) => {
                const next = `${crumbs.slice(0, index + 1).join("/")}/`;
                return (
                  <span key={next} className="flex items-center gap-2">
                    <span>/</span>
                    <button type="button" className="hover:text-fg" onClick={() => navigate({ search: { prefix: next } })}>
                      {crumb}
                    </button>
                  </span>
                );
              })}
            </div>
            {data.folders.length === 0 && data.objects.length === 0 ? (
              <p className="mt-8 text-sm text-muted">This folder is empty.</p>
            ) : (
              <ul className="mt-6 overflow-hidden rounded-lg border border-border">
                {data.folders.map((folder) => (
                  <li key={folder} className="border-b border-border last:border-b-0">
                    <button
                      type="button"
                      className="flex h-12 w-full items-center gap-3 px-4 text-left hover:bg-surface"
                      onClick={() => navigate({ search: { prefix: folder } })}
                    >
                      <Folder className="h-4 w-4 text-primary" />
                      {leafName(folder, prefix)}
                    </button>
                  </li>
                ))}
                {data.objects.map((object) => (
                  <li key={object.key} className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 last:border-b-0">
                    <span className="min-w-0">
                      <span className="block truncate text-sm">{leafName(object.key, prefix)}</span>
                      <span className="text-xs text-muted">{formatBytes(object.size)}</span>
                    </span>
                    <a
                      className="grid h-11 w-11 place-items-center rounded-md text-muted hover:bg-raised hover:text-fg"
                      href={withBase(`/api/public/${encodeURIComponent(name)}/${encodeKeyPath(object.key)}`)}
                      download={leafName(object.key, "")}
                      aria-label={`Download ${leafName(object.key, prefix)}`}
                    >
                      <Download className="h-4 w-4" />
                    </a>
                  </li>
                ))}
              </ul>
            )}

            {/* Pagination Controls */}
            {data.truncated || cursorHistory.length > 0 ? (
              <div className="mt-4 flex items-center justify-between gap-3 text-sm">
                <Button type="button" variant="outline" disabled={cursorHistory.length === 0} onClick={handlePrevPage}>
                  Previous page
                </Button>
                <span className="text-xs text-muted">Page {cursorHistory.length + 1}</span>
                <Button type="button" variant="outline" disabled={!data.truncated} onClick={handleNextPage}>
                  Next page
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </main>
  );
}
