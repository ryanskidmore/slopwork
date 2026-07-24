import * as TabsPrimitive from "@radix-ui/react-tabs";
import type * as React from "react";
import { cn } from "../../lib/utils.js";

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        // `max-w-full overflow-x-auto` — on a narrow viewport a tab row with
        // several longer labels (e.g. ticket detail's "Relationships") can
        // be wider than the screen; this scrolls the tab strip itself
        // instead of the whole page ever overflowing horizontally
        // (quality-floor requirement: no page-level horizontal scroll).
        "inline-flex h-9 w-fit max-w-full items-center justify-center overflow-x-auto rounded-md bg-muted p-1 text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "inline-flex h-[calc(100%-2px)] flex-1 items-center justify-center gap-1.5 rounded-sm",
        "px-3 py-1 text-sm font-medium whitespace-nowrap transition-colors",
        "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn("mt-3 outline-none", className)} {...props} />;
}
