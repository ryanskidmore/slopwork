import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type {
  ConfigDTO,
  ReviewResponseDTO,
  TicketSummaryDTO,
  TreeNodeDTO,
  TreeResponseDTO,
} from "../../api/types.js";
import { TooltipProvider } from "../components/ui/tooltip.js";
import { useApiQuery } from "../hooks/use-api-query.js";
import { ReviewPage } from "./review-page.js";
import { RouteErrorPage } from "./route-error-page.js";
import { TREE_EXPANSION_STORAGE_KEY, TreePage } from "./tree-page.js";

const config: ConfigDTO = {
  project: "test-project",
  warning: null,
  remotes: { repo: null, jira: null },
  defaults: { stale_after: "1h", review_stale_after: "24h" },
};

function ticket(id: string, name: string, state: TicketSummaryDTO["state"] = "open") {
  return {
    id,
    handle: `t-${id}`,
    name,
    slug: name.toLowerCase().replaceAll(" ", "-"),
    state,
    priority: 2,
    labels: [],
    owner: null,
    adhoc: false,
    last_activity_at: "2026-08-01T12:00:00.000Z",
    latest_note: null,
    created_at: "2026-08-01T12:00:00.000Z",
    updated_at: "2026-08-01T12:00:00.000Z",
    parent: { kind: "none" },
    overlay: {
      blocked: false,
      blocked_by: [],
      stale: false,
      stale_reason: null,
      awaiting_input: false,
      awaiting_input_reason: null,
    },
    review: null,
  } satisfies TicketSummaryDTO;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function PageHarness({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <TooltipProvider>{children}</TooltipProvider>
    </MemoryRouter>
  );
}

describe("abortable page queries", () => {
  it("turns a failed review request into an explicit retry that can recover", async () => {
    const reviewTicket = {
      ...ticket("review", "Review this change", "review"),
      review: {
        mr: null,
        requested_at: "2026-08-01T12:00:00.000Z",
        by: { name: "reviewer", kind: "human" as const },
        awaiting_ms: 10_000,
      },
    } satisfies TicketSummaryDTO;
    const success: ReviewResponseDTO = { config, tickets: [reviewTicket] };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ error: "storage temporarily unavailable" }, { status: 503 }),
      )
      .mockResolvedValueOnce(jsonResponse(success));
    vi.stubGlobal("fetch", fetchMock);

    render(<ReviewPage />, { wrapper: PageHarness });
    expect(await screen.findByRole("alert")).toHaveTextContent("Review queue unavailable");
    expect(screen.getByRole("alert")).toHaveTextContent("storage temporarily unavailable");

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("link", { name: "Review this change" })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts a stalled query at the shared timeout and reports a recoverable error", async () => {
    const observedSignals: AbortSignal[] = [];
    const query = vi.fn((signal: AbortSignal) => {
      observedSignals.push(signal);
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    });

    function Probe() {
      const result = useApiQuery(query, 10);
      return <div>{result.error?.message ?? (result.loading ? "loading" : result.data)}</div>;
    }

    render(<Probe />);
    expect(await screen.findByText(/request took too long/i)).toBeVisible();
    expect(observedSignals[0]?.aborted).toBe(true);
  });
});

describe("tree expansion", () => {
  const grandchild: TreeNodeDTO = {
    ticket: ticket("grandchild", "Grandchild"),
    children: [],
    external_parent: null,
  };
  const child: TreeNodeDTO = {
    ticket: ticket("child", "Child branch"),
    children: [grandchild],
    external_parent: null,
  };
  const tree: TreeResponseDTO = {
    config,
    total: 3,
    roots: [{ ticket: ticket("root", "Root ticket"), children: [child], external_parent: null }],
  };

  it("keeps roots visible, limits default depth, and persists keyboard-driven expansion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(jsonResponse(tree))),
    );
    const first = render(<TreePage />, { wrapper: PageHarness });

    expect(await screen.findByRole("tree", { name: "Ticket hierarchy" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Root ticket" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Child branch" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Grandchild" })).not.toBeInTheDocument();

    const expandChild = screen.getByRole("button", { name: "Expand children of Child branch" });
    expandChild.focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("link", { name: "Grandchild" })).toBeVisible();
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem(TREE_EXPANSION_STORAGE_KEY) ?? "[]")).toContain(
        "child",
      ),
    );

    first.unmount();
    render(<TreePage />, { wrapper: PageHarness });
    expect(await screen.findByRole("link", { name: "Grandchild" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Collapse all branches" }));
    expect(screen.queryByRole("link", { name: "Child branch" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Expand all branches" }));
    expect(await screen.findByRole("link", { name: "Grandchild" })).toBeVisible();
  });
});

describe("route error fallback", () => {
  it("renders a useful fallback when a route component throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    function BrokenRoute(): never {
      throw new Error("render exploded");
    }
    const router = createMemoryRouter(
      [{ path: "/", element: <BrokenRoute />, errorElement: <RouteErrorPage /> }],
      { initialEntries: ["/"] },
    );

    await act(async () => render(<RouterProvider router={router} />));
    expect(screen.getByRole("alert")).toHaveTextContent("unexpected error");
    expect(screen.getByRole("alert")).toHaveTextContent("render exploded");
    expect(screen.getByRole("button", { name: "Reload page" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Ticket list" })).toHaveAttribute("href", "/tickets");
  });
});
