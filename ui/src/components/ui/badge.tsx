import { Ban, Check, CircleDashed, Hourglass, Pause, RotateCcw, ShieldCheck, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type Tone = "good" | "warn" | "bad" | "neutral" | "info";
const TONE: Record<Tone, string> = {
  good: "bg-mint/12 text-mint ring-mint/30",
  warn: "bg-amber/12 text-amber ring-amber/30",
  bad: "bg-coral/12 text-coral ring-coral/30",
  neutral: "bg-mist/10 text-mist ring-mist/20",
  info: "bg-sky/12 text-sky ring-sky/30",
};

// A status always carries an icon and a word, never colour alone.
const STATUS: Record<string, [Tone, LucideIcon]> = {
  VALID: ["good", Check], APPROVE: ["good", Check], EXECUTED: ["good", Check], CONFIRMED: ["good", Check], HIT: ["good", Check], HWM: ["good", Check],
  BLOCKED: ["good", ShieldCheck], PASS: ["good", Check],
  WARNING: ["warn", TriangleAlert], WAIT: ["warn", Pause], PENDING: ["warn", Hourglass], SUBMITTED: ["warn", Hourglass], ADVISORY: ["warn", TriangleAlert], TIGHTENED: ["warn", RotateCcw],
  SKIP: ["neutral", CircleDashed], EXPIRED: ["neutral", Hourglass],
  ALLOWED: ["bad", X], REJECT: ["bad", Ban], REVERTED: ["bad", X], FAILED: ["bad", X], DROPPED: ["bad", X], REPLACED: ["warn", RotateCcw], CANCELLED: ["neutral", Ban],
  INVALIDATED: ["bad", X], PAUSED: ["bad", Pause], TRIPPED: ["bad", TriangleAlert], VETO: ["bad", Ban],
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const [tone, Icon] = STATUS[status] ?? ["neutral", CircleDashed];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold tracking-wide ring-1 ring-inset", TONE[tone], className)}>
      <Icon aria-hidden className="size-3" strokeWidth={2.6} />
      {status}
    </span>
  );
}

export function Pill({ tone = "neutral", className, children }: { tone?: Tone; className?: string; children: React.ReactNode }) {
  return <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium ring-1 ring-inset", TONE[tone], className)}>{children}</span>;
}
