import { Compass } from "lucide-react";
import { Link } from "react-router-dom";
import { EmptyState } from "../components/empty-state.js";
import { Button } from "../components/ui/button.js";

export function NotFoundPage() {
  return (
    <EmptyState
      icon={Compass}
      title="Nothing here"
      description="That page doesn't exist — try the ticket list or jump to a specific ticket with ⌘K."
      action={
        <Button asChild variant="outline" size="sm">
          <Link to="/tickets">Go to tickets</Link>
        </Button>
      }
    />
  );
}
