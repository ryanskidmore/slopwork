import { AlertTriangle, Home, RotateCcw } from "lucide-react";
import { isRouteErrorResponse, Link, useRouteError } from "react-router-dom";
import { Button } from "../components/ui/button.js";

function routeErrorMessage(error: unknown): string {
  if (isRouteErrorResponse(error)) return `${error.status} ${error.statusText}`.trim();
  if (error instanceof Error) return error.message;
  return "The page could not be rendered.";
}

export function RouteErrorPage() {
  const error = useRouteError();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl items-center px-4 py-12">
      <div role="alert" className="flex w-full flex-col items-start gap-3">
        <AlertTriangle className="size-8 text-destructive" aria-hidden="true" />
        <h1 className="text-lg font-semibold">This page hit an unexpected error</h1>
        <p className="text-sm text-muted-foreground">{routeErrorMessage(error)}</p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => window.location.reload()}>
            <RotateCcw aria-hidden="true" />
            Reload page
          </Button>
          <Button variant="outline" asChild>
            <Link to="/tickets">
              <Home aria-hidden="true" />
              Ticket list
            </Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
