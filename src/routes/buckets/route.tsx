import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/buckets")({
  component: () => <Outlet />,
});
