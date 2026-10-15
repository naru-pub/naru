"use client";

import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";

import { cn } from "@/lib/utils";

// A square box with the ink rule every control has. Checked, it fills like a
// primary button; `checked="indeterminate"` (some of a list chosen) shows a
// dash instead of the check.
const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "peer group grid size-5 shrink-0 place-items-center border-2 border-line bg-card text-primary-foreground ring-offset-background transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=indeterminate]:bg-primary",
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="grid place-items-center">
      <Check
        className="size-3.5 group-data-[state=indeterminate]:hidden"
        strokeWidth={3.5}
        aria-hidden
      />
      <Minus
        className="hidden size-3.5 group-data-[state=indeterminate]:block"
        strokeWidth={3.5}
        aria-hidden
      />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
