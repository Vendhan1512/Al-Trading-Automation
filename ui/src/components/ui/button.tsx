import * as React from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "ghost" | "paper" | "danger";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-mint text-ink hover:bg-[#5ee3b6] shadow-[0_10px_30px_-12px_rgba(61,214,163,0.7)]",
  ghost: "border border-line bg-panel/60 text-fog hover:border-mint/50 hover:bg-panel",
  paper: "bg-paper-ink text-paper hover:bg-[#3d2e23]",
  danger: "bg-coral text-ink hover:bg-[#f48a7c]",
};
const SIZES: Record<Size, string> = { sm: "h-8 px-3 text-[13px] rounded-lg", md: "h-10 px-4 text-sm rounded-xl", lg: "h-12 px-6 text-[15px] rounded-2xl" };

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant = "primary", size = "md", ...props }, ref) => (
  <button
    ref={ref}
    className={cn(
      "inline-flex items-center justify-center gap-2 font-medium whitespace-nowrap transition-[background,border,transform,box-shadow] duration-200 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50",
      VARIANTS[variant],
      SIZES[size],
      className,
    )}
    {...props}
  />
));
Button.displayName = "Button";
