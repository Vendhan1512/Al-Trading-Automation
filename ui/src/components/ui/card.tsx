import * as React from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-3xl border border-line/80 bg-panel/70 p-5 backdrop-blur-sm sm:p-6", className)} {...props} />;
}

export function CardHeader({ title, meta, className, children }: { title: React.ReactNode; meta?: React.ReactNode; className?: string; children?: React.ReactNode }) {
  return (
    <div className={cn("mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1", className)}>
      <h3 className="font-display text-lg font-semibold tracking-tight text-fog">{title}</h3>
      {meta && <div className="text-[13px] text-dim">{meta}</div>}
      {children}
    </div>
  );
}
