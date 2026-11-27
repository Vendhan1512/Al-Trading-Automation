"use client";
/**
 * Vault Pour. The vault drawn as a glass jar on a paper stage, filled with what it holds.
 * Picking a scenario knocks the current jar off the stage and pours the next one, with a small
 * hand-rolled physics loop: springs for the jar, gravity for the pour and splashes, damped
 * surface waves. Interaction model inspired by Aakash Mehra's "Coffee Pour Menu".
 */
import * as React from "react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

export type Liquid = "usdt" | "whsk" | "weth" | "wbtc";
export interface PourLayer { type: Liquid; amount: number }
export interface PourScene {
  id: string;
  name: string;
  subtitle: string;
  /** What happens, in one sentence, shown under the stage and read by screen readers. */
  caption: string;
  layers: PourLayer[];
  /** Price vs average cost, in %, shown on the gauge once poured. */
  pricePct?: number;
  effect?: "stop" | "breaker" | "seal";
}

export const LIQUID: Record<Liquid, { rgb: [number, number, number]; label: string }> = {
  usdt: { rgb: [52, 196, 150], label: "USDT" },
  whsk: { rgb: [238, 160, 62], label: "WHSK" },
  weth: { rgb: [120, 146, 236], label: "WETH" },
  wbtc: { rgb: [224, 120, 52], label: "WBTC" },
};

/* --------------------------------- geometry -------------------------------- */
const W = 360, H = 400, FLOOR = 336, CX = 196;
const P = 0.3; // ellipse squash
const SRC = -FLOOR - 12;
type Profile = { top: number; r: number; bot: number; rb: number; c: number };
const OUT: Profile = { top: -214, r: 70, bot: 0, rb: 62, c: 68 };
const INN: Profile = { top: -210, r: 65, bot: -14, rb: 56, c: 62 };
const PIVOT = 105;
const MAXF = 0.9;
const STOP_PCT = -3;

const f1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const wallR = (p: Profile, t: number) => (1 - t) * (1 - t) * p.r + 2 * t * (1 - t) * p.c + t * t * p.rb;
const levelY = (f: number) => lerp(INN.bot, INN.top, f);
const levelR = (f: number) => wallR(INN, 1 - f);
function silhouette(p: Profile) {
  const m = (p.top + p.bot) / 2;
  return `M${-p.r} ${p.top}A${p.r} ${f1(p.r * P)} 0 0 1 ${p.r} ${p.top}Q${p.c} ${m} ${p.rb} ${p.bot}A${p.rb} ${f1(p.rb * P)} 0 0 1 ${-p.rb} ${p.bot}Q${-p.c} ${m} ${-p.r} ${p.top}Z`;
}
function bodyPath(p: Profile) {
  const m = (p.top + p.bot) / 2;
  return `M${-p.r} ${p.top}Q${-p.c} ${m} ${-p.rb} ${p.bot}A${p.rb} ${f1(p.rb * P)} 0 0 0 ${p.rb} ${p.bot}Q${p.c} ${m} ${p.r} ${p.top}A${p.r} ${f1(p.r * P)} 0 0 1 ${-p.r} ${p.top}Z`;
}
function wallLine(p: Profile, k: number, t0: number, t1: number) {
  const y0 = lerp(p.top, p.bot, t0), y1 = lerp(p.top, p.bot, t1);
  return `M${f1(k * wallR(p, t0))} ${f1(y0)}Q${f1(k * wallR(p, (t0 + t1) / 2) * 1.02)} ${f1((y0 + y1) / 2)} ${f1(k * wallR(p, t1))} ${f1(y1)}`;
}
const rgb = (c: [number, number, number], a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const mix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/* --------------------------------- physics --------------------------------- */
const G = 3000, G_FALL = 2600, V0 = 220;
type Pour = { layer: number; phase: "fall" | "flow" | "tail" | "done"; head: number; headV: number; tail: number; tailV: number; poured: number; x: number; rip: number };
type Part = { x: number; y: number; vx: number; vy: number; r: number; col: string };
type Cup = {
  key: number; scene: PourScene; mode: "wait" | "enter" | "rest" | "fall"; wait: number;
  x: number; y: number; vx: number; vy: number; a: number; va: number;
  level: number; filled: number[]; pours: Pour[]; next: number; parts: Part[];
  w1: number; v1: number; w2: number; v2: number; w3: number;
  doneT: number; convert: number; gauge: number; gaugeV: number; lidY: number; lidV: number; seal: number; sealV: number;
};

const newCup = (key: number, scene: PourScene): Cup => ({
  key, scene, mode: "wait", wait: 0, x: W + 140, y: FLOOR, vx: 0, vy: 0, a: 0, va: 0,
  level: 0, filled: scene.layers.map(() => 0), pours: [], next: 0, parts: [],
  w1: 0, v1: 0, w2: 0, v2: 0, w3: 0, doneT: -1, convert: 0, gauge: 0, gaugeV: 0, lidY: -300, lidV: 0, seal: 0, sealV: 0,
});

const wave = (c: Cup, u: number, t: number) => c.w1 * u + c.w2 * Math.cos(Math.PI * u) + c.w3 * Math.sin(3 * Math.PI * u - t * 9);
const kick = (c: Cup, u: number, s: number) => { c.v1 += s * u * 40; c.v2 -= s * 50; c.w3 = Math.min(2.4, c.w3 + s * 0.9); };
const layerCol = (c: Cup, i: number) => {
  const l = c.scene.layers[i];
  const base = LIQUID[l.type].rgb;
  return c.scene.effect === "stop" && l.type !== "usdt" ? mix(base, LIQUID.usdt.rgb, c.convert) : base;
};

function splash(c: Cup, x: number, y: number, col: string, n: number, s: number) {
  for (let k = 0; k < n && c.parts.length < 26; k++)
    c.parts.push({ x: x + (Math.random() - 0.5) * 4, y: y - 1, vx: (Math.random() - 0.5) * 150 * s, vy: -(80 + Math.random() * 180) * s, r: 0.8 + Math.random() * 1.5, col });
}

function fillInstantly(c: Cup) {
  c.scene.layers.forEach((l, i) => { c.filled[i] = l.amount; c.level += l.amount; });
  c.next = c.scene.layers.length;
  c.doneT = 5; c.convert = 1; c.gauge = 1; c.lidY = 0; c.seal = 1;
}

/** Advance one jar; returns true while anything still moves. */
function step(c: Cup, dt: number, t: number): boolean {
  let busy = false;
  if (c.mode === "wait") { c.wait -= dt; if (c.wait <= 0) c.mode = "enter"; return true; }
  if (c.mode === "enter" || c.mode === "rest") {
    const ax = -130 * (c.x - CX) - 15.5 * c.vx;
    c.vx += ax * dt; c.x += c.vx * dt;
    const target = clamp(-ax * 0.00011, -0.14, 0.14);
    c.va += (-240 * (c.a - target) - 15 * c.va) * dt; c.a += c.va * dt;
    if (c.mode === "enter") {
      busy = true;
      if (Math.abs(c.x - CX) < 0.4 && Math.abs(c.vx) < 8 && Math.abs(c.a) < 0.003 && Math.abs(c.va) < 0.04) { c.x = CX; c.vx = 0; c.a = 0; c.va = 0; c.mode = "rest"; }
    }
  } else if (c.mode === "fall") {
    c.vy += G_FALL * dt; c.x += c.vx * dt; c.y += c.vy * dt; c.a += c.va * dt; busy = true;
  }

  const it = c.scene;
  const surfY = levelY(c.level);
  const rS = levelR(c.level);
  const arrived = c.mode === "rest" || (c.mode === "enter" && Math.abs(c.x - CX) < 16);
  const active = c.pours.find((p) => p.phase !== "done");
  if (arrived && !active && c.next < it.layers.length) {
    const side = c.next % 2 === 0 ? -1 : 1;
    c.pours.push({ layer: c.next++, phase: "fall", head: SRC, headV: V0, tail: SRC, tailV: V0, poured: 0, x: side * 0.16 * INN.r, rip: 0 });
  }
  for (const p of c.pours) {
    if (p.phase === "done") continue;
    busy = true;
    const col = rgb(layerCol(c, p.layer));
    const sy = surfY + wave(c, p.x / rS, t);
    if (p.phase === "fall") {
      p.headV += G * dt; p.head += p.headV * dt;
      if (p.head >= sy) { p.phase = "flow"; splash(c, p.x, sy, col, c.level > 0.02 ? 6 : 3, 1); kick(c, p.x / rS, c.level > 0.02 ? 1 : 0.3); }
    }
    if (p.phase === "flow" || p.phase === "tail") {
      const amt = it.layers[p.layer].amount;
      if (p.poured < amt) {
        const dv = Math.min(clamp(amt / 1.1, 0.22, 0.6) * dt, amt - p.poured);
        p.poured += dv; c.filled[p.layer] += dv; c.level = Math.min(MAXF, c.level + dv);
      }
      p.rip += dt;
      if (p.rip > 0.085) { p.rip = 0; splash(c, p.x, sy, col, 1, 0.7); kick(c, p.x / rS, 0.12); }
      if (p.phase === "flow" && p.poured >= amt) p.phase = "tail";
    }
    if (p.phase === "tail") { p.tailV += G * dt; p.tail += p.tailV * dt; if (p.tail >= sy) p.phase = "done"; }
  }
  for (let i = c.parts.length - 1; i >= 0; i--) {
    const q = c.parts[i];
    q.vy += G * dt; q.x += q.vx * dt; q.y += q.vy * dt;
    if (q.vy > 0 && q.y >= surfY + wave(c, clamp(q.x / rS, -1, 1), t)) c.parts.splice(i, 1);
  }
  if (c.parts.length) busy = true;

  const tilt = clamp(-Math.tan(c.a), -0.9, 0.9) * rS * (c.mode === "fall" ? 0.8 : 1);
  c.v1 += (-70 * (c.w1 - tilt) - 3.2 * c.v1) * dt; c.w1 += c.v1 * dt;
  c.v2 += (-190 * c.w2 - 5 * c.v2) * dt; c.w2 += c.v2 * dt;
  c.w3 *= Math.exp(-2.6 * dt);
  if (c.mode !== "fall") c.w2 = clamp(c.w2, -rS * P * 0.8, rS * P * 0.8);
  if (Math.abs(c.w1 - tilt) + Math.abs(c.v1) * 0.1 + Math.abs(c.w2) + Math.abs(c.v2) * 0.1 + c.w3 > 0.02) busy = true;

  // after the pour: the scenario's own ending
  const settled = c.mode === "rest" && c.next >= it.layers.length && !c.pours.some((p) => p.phase !== "done");
  if (settled) {
    if (c.doneT < 0) c.doneT = 0;
    c.doneT += dt;
    if (c.gauge < 1) {
      c.gaugeV += (-90 * (c.gauge - 1) - 11 * c.gaugeV) * dt; c.gauge += c.gaugeV * dt;
      if (Math.abs(c.gauge - 1) + Math.abs(c.gaugeV) * 0.05 < 0.002) c.gauge = 1; else busy = true;
    }
    if (it.effect === "stop" && c.doneT > 1.1 && c.convert < 1) {
      c.convert = Math.min(1, c.convert + dt / 1.4); busy = true;
      if (Math.random() < dt * 14) kick(c, Math.random() * 2 - 1, 0.25);
    }
    if (it.effect === "breaker" && c.doneT > 0.35 && (c.lidY < 0 || Math.abs(c.lidV) > 0)) {
      c.lidV += G_FALL * dt; c.lidY += c.lidV * dt;
      if (c.lidY >= 0) { c.lidY = 0; c.lidV = Math.abs(c.lidV) > 90 ? -c.lidV * 0.32 : 0; if (c.lidV) kick(c, 0, 0.8); }
      busy = true;
    }
    if (it.effect === "seal" && c.doneT > 0.3 && c.seal !== 1) {
      c.sealV += (-260 * (c.seal - 1) - 14 * c.sealV) * dt; c.seal += c.sealV * dt;
      if (Math.abs(c.seal - 1) + Math.abs(c.sealV) * 0.03 < 0.002) c.seal = 1; else busy = true;
    }
  }
  return busy;
}

/* -------------------------------- rendering -------------------------------- */
const K = 36;
const COS = Array.from({ length: K + 1 }, (_, i) => Math.cos((i / K) * Math.PI * 2 + Math.PI));
const SIN = Array.from({ length: K + 1 }, (_, i) => Math.sin((i / K) * Math.PI * 2 + Math.PI));

function JarView({ c, t, uid }: { c: Cup; t: number; uid: string }) {
  const id = (s: string) => `vp${uid}-${s}`;
  const surfY = levelY(c.level);
  const rS = levelR(c.level) * 1.02;
  const ry = rS * P;
  const pts: string[] = [];
  let back = "";
  for (let i = 0; i <= K; i++) {
    const u = COS[i];
    const pt = `${f1(rS * u)} ${f1(surfY + ry * SIN[i] + wave(c, u, t))}`;
    pts.push(pt);
    if (i <= K / 2) back += (i ? "L" : "M") + pt;
  }
  const surf = `M${pts.join("L")}Z`;
  const body = `${back}L${f1(rS + 40)} ${INN.bot + 40}L${f1(-rS - 40)} ${INN.bot + 40}Z`;

  // layered gradient: bottom -> top, soft boundaries
  const span = INN.top - INN.bot;
  const stops: { o: number; col: string }[] = [];
  let acc = 0;
  c.scene.layers.forEach((_, i) => {
    const f = c.filled[i];
    if (f <= 0) return;
    const col = rgb(layerCol(c, i), 0.93);
    const y0 = levelY(acc), y1 = levelY(acc + f);
    stops.push({ o: (y0 - INN.bot) / span + 0.012, col }, { o: (y1 - INN.bot) / span - 0.012, col });
    acc += f;
  });
  const topIdx = c.filled.reduce((last, f, i) => (f > 0 ? i : last), 0);
  const topCol = c.level > 0 ? layerCol(c, topIdx) : LIQUID.usdt.rgb;
  const sh = c.mode === "fall" ? Math.max(0, 1 - (c.y - FLOOR) / 120) : 1;

  const streams = c.pours.filter((p) => (p.phase === "fall" || p.phase === "flow" || p.phase === "tail") && c.mode !== "fall").map((p) => {
    const yTop = p.phase === "tail" ? p.tail : SRC;
    const yBot = p.phase === "fall" ? p.head : surfY + wave(c, p.x / rS, t) + 1;
    if (yBot - yTop < 1) return null;
    const w = 4.2, L: string[] = [], R: string[] = [];
    for (let i = 0; i <= 12; i++) {
      const y = lerp(yTop, yBot, i / 12);
      const v = Math.sqrt(V0 * V0 + 2 * G * Math.max(0, y - SRC));
      const hw = (w / 2) * Math.max(0.62, Math.pow(V0 / v, 0.3));
      const wob = Math.sin(y * 0.045 + t * 14) * 0.5 * (i / 12);
      L.push(`${f1(p.x - hw + wob)} ${f1(y)}`);
      R.unshift(`${f1(p.x + hw + wob)} ${f1(y)}`);
    }
    return <path key={p.layer} d={`M${L.join("L")}L${R.join("L")}Z`} fill={rgb(layerCol(c, p.layer))} />;
  });

  return (
    <g>
      <g transform={`translate(${f1(c.x)} ${FLOOR})`} opacity={sh}>
        <ellipse cx={8} cy={4} rx={OUT.rb * 1.5} ry={OUT.rb * P * 1.4} fill={`url(#${id("shadow")})`} />
      </g>
      <g transform={`translate(${f1(c.x)} ${f1(c.y)}) rotate(${((c.a * 180) / Math.PI).toFixed(2)} 0 ${-PIVOT})`}>
        <defs>
          <linearGradient id={id(`liq${c.key}`)} gradientUnits="userSpaceOnUse" x1={0} y1={INN.bot} x2={0} y2={INN.top}>
            {stops.length ? stops.map((s, i) => <stop key={i} offset={clamp(s.o, 0, 1)} stopColor={s.col} />) : <stop offset={0} stopColor="transparent" />}
          </linearGradient>
        </defs>
        {/* back of the jar */}
        <path d={silhouette(INN)} fill="rgba(255,250,240,0.22)" />
        <path d={`M${-INN.r} ${INN.top}A${INN.r} ${f1(INN.r * P)} 0 0 1 ${INN.r} ${INN.top}`} fill="none" stroke="rgba(90,58,32,0.3)" />
        {/* liquid */}
        {c.level > 0 && (
          <g clipPath={`url(#${id("clip")})`}>
            <path d={body} fill={`url(#${id(`liq${c.key}`)})`} />
            <path d={body} fill={`url(#${id("depth")})`} />
            <path d={surf} fill={rgb(mix(topCol, [255, 250, 240], 0.28), 0.98)} />
            <path d={surf} fill={`url(#${id("sheen")})`} />
          </g>
        )}
        {streams}
        {c.parts.map((q, i) => <circle key={i} cx={f1(q.x)} cy={f1(q.y)} r={q.r.toFixed(2)} fill={q.col} />)}
        {/* glass front */}
        <path d={`${silhouette(OUT)}${silhouette(INN)}`} fillRule="evenodd" fill={`url(#${id("wall")})`} />
        <path d={bodyPath(OUT)} fill={`url(#${id("face")})`} />
        <path d={wallLine(OUT, -0.78, 0.05, 0.86)} fill="none" stroke="white" strokeOpacity={0.5} strokeWidth={5} strokeLinecap="round" filter={`url(#${id("blur2")})`} />
        <path d={wallLine(OUT, -0.8, 0.07, 0.8)} fill="none" stroke="white" strokeOpacity={0.9} strokeWidth={1.1} strokeLinecap="round" />
        <path d={wallLine(OUT, 0.85, 0.1, 0.45)} fill="none" stroke="white" strokeOpacity={0.6} strokeWidth={1.6} strokeLinecap="round" />
        <path d={`M${-OUT.rb} ${OUT.bot}A${OUT.rb} ${f1(OUT.rb * P)} 0 0 0 ${OUT.rb} ${OUT.bot}`} fill="none" stroke="rgba(80,50,28,0.45)" />
        <ellipse cx={0} cy={OUT.top} rx={OUT.r} ry={OUT.r * P} fill="none" stroke="rgba(255,255,255,0.95)" strokeWidth={1.4} />
        <path d={`M${-OUT.r} ${OUT.top + 1.4}A${OUT.r} ${f1(OUT.r * P)} 0 0 0 ${OUT.r} ${OUT.top + 1.4}`} fill="none" stroke="rgba(90,58,32,0.28)" />
        {/* label plate */}
        <g transform={`translate(0 ${OUT.top + 150})`} opacity={0.9}>
          <rect x={-34} y={-11} width={68} height={22} rx={5} fill="rgba(251,244,234,0.82)" stroke="rgba(90,58,32,0.35)" />
          <text x={0} y={4.5} textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize={10.5} fontWeight={600} fill="#4a3526" letterSpacing={1.2}>VAULT</text>
        </g>
        {/* lid (drawdown breaker) */}
        {c.scene.effect === "breaker" && c.lidY > -290 && (
          <g transform={`translate(0 ${f1(OUT.top - 6 + c.lidY)})`}>
            <ellipse cx={0} cy={6} rx={OUT.r + 6} ry={(OUT.r + 6) * P} fill="#3b2b20" />
            <rect x={-OUT.r - 6} y={-8} width={(OUT.r + 6) * 2} height={14} fill="#4d3829" />
            <ellipse cx={0} cy={-8} rx={OUT.r + 6} ry={(OUT.r + 6) * P} fill="#6b4d38" />
            <g transform="translate(0 -26)">
              <rect x={-13} y={-2} width={26} height={20} rx={4} fill="#ef6f5e" />
              <path d="M-8 -2v-6a8 8 0 0 1 16 0v6" fill="none" stroke="#ef6f5e" strokeWidth={4} />
              <circle cx={0} cy={8} r={3} fill="#3b2b20" />
            </g>
          </g>
        )}
        {/* wax seal (countersigned) */}
        {c.scene.effect === "seal" && c.seal > 0.01 && (
          <g transform={`translate(30 ${OUT.top + 86}) rotate(-12) scale(${Math.max(0, c.seal).toFixed(3)})`}>
            <path d="M0 -27 C9 -29 15 -22 21 -18 C27 -12 29 -4 27 4 C29 12 22 20 15 23 C8 29 -2 28 -9 26 C-17 27 -24 20 -26 12 C-30 4 -27 -6 -24 -12 C-21 -21 -10 -27 0 -27Z" fill="#c2412f" />
            <circle r={18} fill="none" stroke="#e3725d" strokeWidth={2} />
            <text y={6} textAnchor="middle" fontFamily="Space Grotesk, sans-serif" fontWeight={700} fontSize={16} fill="#fbe9df">2/2</text>
          </g>
        )}
      </g>
    </g>
  );
}

function Gauge({ pct, show }: { pct: number; show: number }) {
  // price vs average cost, -6% .. +6%
  const y = (v: number) => 74 + ((6 - clamp(v, -6, 6)) / 12) * 210;
  const stopY = y(STOP_PCT);
  const cur = lerp(0, pct, show);
  const hit = cur <= STOP_PCT;
  return (
    <g transform="translate(58 0)" opacity={0.95}>
      <text x={-30} y={58} fontFamily="JetBrains Mono, monospace" fontSize={9} fontWeight={600} fill="#7a6250" letterSpacing={1}>PRICE vs COST</text>
      <rect x={14} y={74} width={8} height={210} rx={4} fill="rgba(90,58,32,0.14)" />
      <line x1={8} x2={28} y1={y(0)} y2={y(0)} stroke="rgba(90,58,32,0.4)" />
      <text x={6} y={y(0) + 3} opacity={Math.abs(cur) < 1.3 ? 0 : 1} textAnchor="end" fontFamily="JetBrains Mono, monospace" fontSize={9} fill="#7a6250">0%</text>
      <line x1={6} x2={30} y1={stopY} y2={stopY} stroke="#d4503d" strokeWidth={1.6} strokeDasharray="3 3" />
      <text x={4} y={stopY + 3} textAnchor="end" fontFamily="JetBrains Mono, monospace" fontSize={9} fontWeight={600} fill="#c2412f">stop {STOP_PCT}%</text>
      <circle cx={18} cy={y(cur)} r={7} fill={hit ? "#d4503d" : "#2b2018"} stroke="#fbf4ea" strokeWidth={2} />
      <text x={32} y={y(cur) + 3} fontFamily="JetBrains Mono, monospace" fontSize={9.5} fontWeight={700} fill={hit ? "#c2412f" : "#2b2018"}>
        {cur >= 0 ? "+" : ""}{cur.toFixed(1)}%
      </text>
    </g>
  );
}

export function VaultPour({ scenes, className, onSceneChange }: { scenes: PourScene[]; className?: string; onSceneChange?: (s: PourScene) => void }) {
  const [selectedId, setSelectedId] = React.useState(scenes[0]?.id);
  const selected = scenes.find((s) => s.id === selectedId) ?? scenes[0];
  const reduce = useReducedMotion() ?? false;
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, "");
  const id = (s: string) => `vp${uid}-${s}`;
  const sim = React.useRef(new Map<number, Cup>());
  const raf = React.useRef(0);
  const nextKey = React.useRef(1);
  const [, setFrame] = React.useState(0);
  const btns = React.useRef<(HTMLButtonElement | null)[]>([]);
  const time = React.useRef(0);
  const shown = React.useRef<string | null>(null);
  const sceneSig = selected ? JSON.stringify(selected) : "";

  const loop = React.useCallback(() => {
    if (raf.current) return;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(1 / 30, (now - last) / 1000);
      last = now;
      time.current = now / 1000;
      let busy = false;
      for (const c of [...sim.current.values()]) {
        busy = step(c, dt, time.current) || busy;
        if (c.mode === "fall" && c.y - 260 > H + 40) sim.current.delete(c.key);
      }
      setFrame((f) => (f + 1) % 1e6);
      raf.current = busy ? requestAnimationFrame(tick) : 0;
    };
    raf.current = requestAnimationFrame(tick);
  }, []);
  React.useEffect(() => () => { cancelAnimationFrame(raf.current); raf.current = 0; }, []);

  React.useEffect(() => {
    if (!selected) return;
    onSceneChange?.(selected);
    const key = `${selected.id}:${sceneSig}`;
    if (shown.current === key) return;
    const sameScene = shown.current?.startsWith(`${selected.id}:`);
    shown.current = key;
    let falling = 0;
    for (const c of [...sim.current.values()]) {
      if (c.mode === "fall") { falling++; continue; }
      if (c.mode === "wait" || reduce) { sim.current.delete(c.key); continue; }
      if (sameScene) { sim.current.delete(c.key); continue; } // live data refreshed: re-pour quietly
      c.mode = "fall";
      c.vy = -160 - Math.random() * 60;
      c.vx = -40 - Math.random() * 50;
      c.va = (Math.random() < 0.75 ? -1 : 1) * (1.4 + Math.random() * 1.3);
      c.pours = [];
      c.next = c.scene.layers.length;
      falling++;
    }
    const cup = newCup(nextKey.current++, selected);
    if (reduce || sameScene) { cup.mode = "rest"; cup.x = CX; fillInstantly(cup); }
    else cup.wait = falling ? 0.14 : 0.05;
    sim.current.set(cup.key, cup);
    loop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, sceneSig, reduce, loop]);

  const select = (sid: string) => { if (sid !== selectedId) setSelectedId(sid); };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = scenes.findIndex((s) => s.id === selectedId);
    let n = -1;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") n = (i + 1) % scenes.length;
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") n = (i - 1 + scenes.length) % scenes.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = scenes.length - 1;
    if (n < 0) return;
    e.preventDefault();
    select(scenes[n].id);
    btns.current[n]?.focus();
  };

  const cups = [...sim.current.values()];
  const front = cups.find((c) => c.mode !== "fall");
  const t = time.current;

  return (
    <div className={cn("grid w-full grid-cols-1 items-center gap-5 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] sm:gap-8", className)}>
      <div role="radiogroup" aria-label="Vault scenarios" onKeyDown={onKeyDown} className="grid grid-cols-2 gap-1.5 sm:flex sm:flex-col sm:gap-1">
        {scenes.map((s, i) => {
          const active = s.id === selected?.id;
          return (
            <button
              key={s.id}
              ref={(el) => { btns.current[i] = el; }}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              onPointerEnter={(e) => e.pointerType === "mouse" && select(s.id)}
              onFocus={() => select(s.id)}
              onClick={() => select(s.id)}
              className="group relative rounded-2xl px-3.5 py-3 text-left outline-none sm:px-5 sm:py-3.5"
            >
              {active && (
                <motion.span
                  layoutId={`${uid}-pill`}
                  className="absolute inset-0 rounded-2xl bg-panel-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),inset_0_0_0_1px_rgba(61,214,163,0.35),0_14px_30px_-16px_rgba(0,0,0,0.7)]"
                  transition={{ type: "spring", stiffness: 420, damping: 34 }}
                />
              )}
              <span className="relative flex flex-col">
                <span className={cn("font-display text-[17px] leading-tight font-semibold tracking-[-0.02em] transition-colors duration-300 sm:text-[24px]", active ? "text-fog" : "text-fog/45 group-hover:text-fog/75")}>{s.name}</span>
                <span className={cn("mt-0.5 font-mono text-[11px] tracking-tight transition-colors duration-300 sm:text-[12px]", active ? "text-mint" : "text-dim")}>{s.subtitle}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="min-w-0">
        <div className="paper-stage grain aspect-[9/10] w-full">
          <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full" aria-hidden="true">
            <defs>
              <filter id={id("blur2")} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation={2} /></filter>
              <radialGradient id={id("shadow")}><stop offset={0} stopColor="rgba(70,40,18,0.45)" /><stop offset={0.55} stopColor="rgba(70,40,18,0.16)" /><stop offset={1} stopColor="rgba(70,40,18,0)" /></radialGradient>
              <linearGradient id={id("wall")} x1={0} x2={1}>
                {([[0, "rgba(72,44,22,0.5)"], [0.05, "rgba(255,255,255,0.62)"], [0.13, "rgba(255,255,255,0.16)"], [0.5, "rgba(255,255,255,0.08)"], [0.84, "rgba(255,255,255,0.16)"], [0.94, "rgba(255,255,255,0.58)"], [1, "rgba(72,44,22,0.48)"]] as const).map(([o, c]) => <stop key={o} offset={o} stopColor={c} />)}
              </linearGradient>
              <linearGradient id={id("face")} x1={0} x2={1}>
                {([[0, "rgba(255,255,255,0)"], [0.1, "rgba(255,255,255,0.22)"], [0.18, "rgba(255,255,255,0.05)"], [0.6, "rgba(255,255,255,0)"], [0.88, "rgba(255,255,255,0.14)"], [1, "rgba(255,255,255,0)"]] as const).map(([o, c]) => <stop key={o} offset={o} stopColor={c} />)}
              </linearGradient>
              <linearGradient id={id("depth")} x1={0} x2={1}>
                {([[0, "rgba(18,8,3,0.45)"], [0.16, "rgba(18,8,3,0.08)"], [0.4, "rgba(255,240,220,0.10)"], [0.62, "rgba(18,8,3,0)"], [0.86, "rgba(18,8,3,0.1)"], [1, "rgba(18,8,3,0.5)"]] as const).map(([o, c]) => <stop key={o} offset={o} stopColor={c} />)}
              </linearGradient>
              <radialGradient id={id("sheen")} cx={0.38} cy={0.3} r={0.6}><stop offset={0} stopColor="rgba(255,255,255,0.35)" /><stop offset={1} stopColor="rgba(255,255,255,0)" /></radialGradient>
              <radialGradient id={id("pool")}><stop offset={0} stopColor="rgba(255,248,236,0.5)" /><stop offset={1} stopColor="rgba(255,248,236,0)" /></radialGradient>
              <linearGradient id={id("table")} x1={0} x2={0} y1={0} y2={1}><stop offset={0} stopColor="rgba(110,66,30,0)" /><stop offset={1} stopColor="rgba(110,66,30,0.16)" /></linearGradient>
              <clipPath id={id("clip")}><path d={silhouette(INN)} /></clipPath>
            </defs>
            <rect x={0} y={FLOOR - 36} width={W} height={H - FLOOR + 36} fill={`url(#${id("table")})`} />
            <ellipse cx={CX} cy={FLOOR + 2} rx={150} ry={42} fill={`url(#${id("pool")})`} />
            {front && <Gauge pct={front.scene.pricePct ?? 0} show={Math.max(0, front.gauge)} />}
            {[...cups].reverse().map((c) => <JarView key={c.key} c={c} t={t} uid={uid} />)}
          </svg>
          {front?.scene.effect === "stop" && front.convert > 0.05 && (
            <div className="absolute top-4 right-4 rounded-xl bg-paper-ink/90 px-3 py-2 font-mono text-[11px] text-paper shadow-lg" style={{ opacity: Math.min(1, front.convert * 2) }}>
              stopOut() · fired by a stranger · WHSK → USDT
            </div>
          )}
          {front?.scene.effect === "breaker" && front.lidY === 0 && (
            <div className="absolute top-4 right-4 rounded-xl bg-paper-ink/90 px-3 py-2 font-mono text-[11px] text-paper shadow-lg">breaker tripped · new entries locked · exits open</div>
          )}
          {front?.scene.effect === "seal" && front.seal > 0.9 && (
            <div className="absolute top-4 right-4 rounded-xl bg-paper-ink/90 px-3 py-2 font-mono text-[11px] text-paper shadow-lg">execute() · Guardian ✓ Risk Officer ✓</div>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13px] text-mist" aria-live="polite">{selected?.caption}</p>
          <div className="flex gap-3">
            {selected?.layers.filter((l, i, a) => a.findIndex((x) => x.type === l.type) === i).map((l) => (
              <span key={l.type} className="inline-flex items-center gap-1.5 font-mono text-[11px] text-mist">
                <span className="size-2.5 rounded-full" style={{ background: rgb(LIQUID[l.type].rgb) }} />
                {LIQUID[l.type].label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
