import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { AppShell } from "./components/app-shell.js";
import { TooltipProvider } from "./components/ui/tooltip.js";
import { NotFoundPage } from "./pages/not-found-page.js";
import { QuestionsPage } from "./pages/questions-page.js";
import { ReviewPage } from "./pages/review-page.js";
import { StalePage } from "./pages/stale-page.js";
import { TicketDetailPage } from "./pages/ticket-detail-page.js";
import { TicketsPage } from "./pages/tickets-page.js";
import { TreePage } from "./pages/tree-page.js";

const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/tickets" replace /> },
      { path: "tickets", element: <TicketsPage /> },
      { path: "tickets/:ref", element: <TicketDetailPage /> },
      { path: "tree", element: <TreePage /> },
      { path: "review", element: <ReviewPage /> },
      { path: "questions", element: <QuestionsPage /> },
      { path: "stale", element: <StalePage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);

export function App() {
  return (
    <TooltipProvider delayDuration={200}>
      <RouterProvider router={router} />
    </TooltipProvider>
  );
}
