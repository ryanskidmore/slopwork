import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import type * as React from "react";
import { cn } from "../../lib/utils.js";

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export const SelectGroup = SelectPrimitive.Group;

export function SelectTrigger({
  className,
  children,
  size = "default",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & { size?: "default" | "sm" }) {
  return (
    <SelectPrimitive.Trigger
      data-size={size}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-md border border-input bg-background",
        "px-3 py-1 text-sm shadow-xs outline-none transition-colors",
        "data-[size=default]:h-9 data-[size=sm]:h-8",
        "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-4 opacity-50" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  position = "popper",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        className={cn(
          "z-50 max-h-(--radix-select-content-available-height) min-w-[8rem] overflow-y-auto",
          "rounded-md border border-border bg-popover text-popover-foreground shadow-md",
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
          "data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          position === "popper" && "translate-y-1",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pr-8 pl-2",
        "text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        "focus:bg-accent focus:text-accent-foreground",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <span className="absolute right-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  );
}
