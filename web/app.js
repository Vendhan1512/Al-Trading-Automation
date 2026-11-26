// Countersign dashboard — dependency-free. Everything rendered from the agent's read-only API.
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const api = async (p) => {
  const r = await fetch(p, { cache: "no-store" });
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return r.json();
};
const post = async (p, body) => {
  const r = await fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};
const num = (x, d = 4) => (x === null || x === undefined || !Number.isFinite(+x) ? "—" : (+x).toFixed(d));
const sig = (x, d = 6) => (x === null || x === undefined || !Number.isFinite(+x) ? "—" : (+x).toPrecision(d));
const bps = (x) => (x === null || x === undefined || !Number.isFinite(+x) ? "—" : `${x >= 0 ? "+" : ""}${Math.round(x)} bps`);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
const ago = (t) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 60 ? `${s.toFixed(0)}s ago` : s < 3600 ? `${(s / 60).toFixed(0)}m ago` : `${(s / 3600).toFixed(1)}h ago`;
};

let CFG = null;
const ex = (kind, v) => (CFG ? `${CFG.explorer}/${kind}/${v}` : "#");
const link = (kind, v, label) => (v ? `<a class="mono" target="_blank" rel="noopener" href="${esc(ex(kind, v))}">${esc(label ?? short(v))}</a>` : "—");

// Status = icon + label + color, never color alone.
const STATUS = {
  VALID: ["good", "✓"], APPROVE: ["good", "✓"], EXECUTED: ["good", "✓"], CONFIRMED: ["good", "✓"], HIT: ["good", "✓"],
  WARNING: ["warning", "!"], WAIT: ["warning", "⏸"], SKIP: ["neutral", "–"], PENDING: ["warning", "…"], SUBMITTED: ["warning", "…"], ADVISORY: ["warning", "!"], EXPIRED: ["neutral", "⌛"],
  BLOCKED: ["good", "🛡"], ALLOWED: ["critical", "✕"],
  REJECT: ["critical", "✕"], REVERTED: ["critical", "✕"], FAILED: ["critical", "✕"], DROPPED: ["serious", "↓"], REPLACED: ["serious", "↺"], CANCELLED: ["serious", "⊘"], INVALIDATED: ["critical", "✕"], PAUSED: ["critical", "⏸"], TIGHTENED: ["warning", "↧"],
};
const badge = (s) => {
  const [cls, icon] = STATUS[s] ?? ["neutral", "•"];
  return `<span class="st ${cls}"><span aria-hidden="true">${icon}</span>${esc(s)}</span>`;
};

// ---------------------------------------------------------------- tabs
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => show(b.dataset.tab)));
document.querySelectorAll("[data-goto]").forEach((b) => (b.onclick = () => show(b.dataset.goto)));
function show(tab) {
  if (location.hash.slice(1) !== tab) history.replaceState(null, "", `${location.search}#${tab}`);
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".tab").forEach((s) => s.classList.toggle("active", s.id === `tab-${tab}`));
  refresh();
}
const activeTab = () => document.querySelector(".tabs button.active")?.dataset.tab;

// ---------------------------------------------------------------- sparkline (single series, crosshair tooltip)
const tip = $("#tip");
function sparkline(points, label) {
  if (points.length < 2) return `<span class="muted small">collecting…</span>`;
  const W = 180, H = 36, P = 3;
  const ys = points.map((p) => p.v);
  const lo = Math.min(0, ...ys), hi = Math.max(0, ...ys);
  const span = hi - lo || 1;
  const x = (i) => P + (i * (W - 2 * P)) / (points.length - 1);
  const y = (v) => H - P - ((v - lo) * (H - 2 * P)) / span;
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const id = `sp${Math.random().toString(36).slice(2, 8)}`;
  queueMicrotask(() => {
    const svg = document.getElementById(id);
    if (!svg) return;
    const xh = svg.querySelector(".xh"), dot = svg.querySelector(".dot");
    svg.onmousemove = (e) => {
      const r = svg.getBoundingClientRect();
      const i = Math.max(0, Math.min(points.length - 1, Math.round(((e.clientX - r.left) / r.width) * (points.length - 1))));
      xh.setAttribute("x1", x(i)); xh.setAttribute("x2", x(i)); xh.style.display = "";
      dot.setAttribute("cx", x(i)); dot.setAttribute("cy", y(points[i].v)); dot.style.display = "";
      tip.hidden = false;
      tip.textContent = `${label} · ${new Date(points[i].t).toLocaleTimeString()} · ${bps(points[i].v)}`;
      tip.style.left = `${e.clientX + 12}px`; tip.style.top = `${e.clientY - 28}px`;
    };
    svg.onmouseleave = () => { tip.hidden = true; xh.style.display = "none"; dot.style.display = "none"; };
  });
  return `<svg id="${id}" class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)} premium history, latest ${esc(bps(ys.at(-1)))}">
    <line class="base" x1="${P}" x2="${W - P}" y1="${y(0)}" y2="${y(0)}"/>
    <path class="line" d="${d}"/>
    <line class="xh" y1="0" y2="${H}" style="display:none"/><circle class="dot" r="4" style="display:none"/></svg>`;
}

// ---------------------------------------------------------------- overview
const kpi = (l, n, s = "") => `<div class="kpi"><div class="l">${esc(l)}</div><div class="n">${n}</div><div class="s">${s}</div></div>`;

async function renderOverview() {
  const [pf, px, hl, dec] = await Promise.all([api("/api/portfolio").catch(() => null), api("/api/market/prices").catch(() => null), api("/api/strategies/health"), api("/api/agent/decisions?limit=6")]);
  $("#kpis").innerHTML = [
    kpi("Vault value", pf ? `${num(pf.totalValueUsdt, 2)} <span class="small muted">USDT</span>` : "—", pf ? `${num(pf.usdt, 2)} USDT cash · ${pf.paused ? "PAUSED" : "active"}` : ""),
    kpi("Open positions", pf ? pf.positions.length : "—", pf?.positions.map((p) => p.asset).join(", ") || "none"),
    kpi("Realized today", pf ? `${num(pf.today.realizedPnlUsdt, 4)}` : "—", pf ? `${num(pf.today.volumeUsdt, 2)} USDT volume today` : ""),
    kpi("Net P&L (after gas)", num(hl.netPnlUsdt, 4), `${hl.trades} fills · gas ${num(hl.gasUsdt, 4)} USDT`),
    kpi("Predictions graded", `${hl.predictions.resolved}/${hl.predictions.total}`, `Brier ${hl.predictions.brier === null ? "—" : num(hl.predictions.brier, 3)}`),
    kpi("Decisions journaled", dec.decisions[0]?.seq ?? 0, dec.decisions[0] ? `latest ${ago(dec.decisions[0].at)}` : ""),
  ].join("");

  if (px) {
    $("#mktTime").textContent = `updated ${ago(px.evaluatedAt)}`;
    const hist = await Promise.all(px.assets.map((a) => api(`/api/market/history?asset=${a.asset}&limit=240`).catch(() => ({ points: [] }))));
    $("#mktTable tbody").innerHTML = px.assets
      .map((a, i) => {
        const pts = hist[i].points.filter((p) => p.ref && p.dex).map((p) => ({ t: p.t, v: ((p.dex - p.ref) / p.ref) * 1e4 }));
        const src = a.sources.filter((s) => s.accepted).map((s) => s.source).join(", ");
        return `<tr><td><b>${esc(a.asset)}</b></td><td title="${esc(src)}">${badge(a.status)}</td><td class="r">${sig(a.dexSpot)}</td><td class="r">${sig(a.reference)}</td><td class="r">${bps(a.premiumBps)}</td><td>${sparkline(pts, a.asset)}</td></tr>`;
      })
      .join("");
  }

  if (pf) {
    $("#positions").innerHTML = pf.positions.length
      ? `<table class="t"><thead><tr><th>Asset</th><th class="r">Qty</th><th class="r">Cost</th><th class="r">Exit value</th><th class="r">uP&L</th><th>Exit signal</th></tr></thead><tbody>${pf.positions
          .map((p) => `<tr><td>${esc(p.asset)}</td><td class="r">${sig(p.qty)}</td><td class="r">${num(p.costUsdt, 4)}</td><td class="r">${num(p.exitValueUsdt, 4)}</td><td class="r">${num(p.unrealizedPnlUsdt, 4)} (${num(p.unrealizedPct, 2)}%)</td><td>${p.exit ? badge(p.exit.reason) : "—"}</td></tr>`)
          .join("")}</tbody></table>`
      : `<div class="empty">No open positions. ${pf.usdt < 0.1 ? "The vault holds no USDT yet — the agent has no buying power." : ""}</div>`;
    const m = pf.mandate;
    const tiers = ["A arb", "B spread", "C AI"].filter((_, i) => m.tiersMask & (1 << i)).join(" + ");
    const assets = ["WHSK", "WETH", "WBTC"].filter((_, i) => m.assetsMask & (1 << i)).join(", ");
    $("#mandate").innerHTML = [
      ["Max per trade", `${m.maxTradeUsdt} USDT`], ["Daily volume", `${m.dailyVolumeUsdt} USDT`], ["Daily loss stop", `${m.dailyLossUsdt} USDT`], ["Max per asset", `${m.maxExposureUsdt} USDT`],
      ["Cooldown", `${m.cooldownSec}s`], ["Slippage vs TWAP", `${m.maxSlippageBps} bps`], ["Min edge", `${m.minEdgeBps} bps`], ["Tiers", tiers], ["Assets", assets],
    ].map(([k, v]) => `<div><span>${esc(k)}</span> ${esc(v)}</div>`).join("");
    $("#mandateExp").textContent = `expires ${new Date(m.expiry * 1000).toLocaleString()}`;
  }
  $("#latestDecisions").innerHTML = decisionRows(dec.decisions);
}

// ---------------------------------------------------------------- feed
function decisionRows(list) {
  if (!list.length) return `<div class="empty">No decisions yet — the agent journals one every tick.</div>`;
  return list.map((d) => `<div class="row" data-seq="${d.seq}"><div class="seq">#${d.seq}</div><div class="time">${esc(ago(d.at))}</div><div>${badge(d.outcome)}</div><div class="sum">${esc(d.summary)}</div></div>`).join("");
}
document.addEventListener("click", (e) => {
  const r = e.target.closest(".row[data-seq]");
  if (!r) return;
  if (activeTab() !== "feed") show("feed");
  document.querySelectorAll(".row").forEach((x) => x.classList.toggle("sel", x.dataset.seq === r.dataset.seq));
  renderDetail(Number(r.dataset.seq));
});
async function renderFeed() {
  const { decisions } = await api("/api/agent/decisions?limit=120");
  $("#feed").innerHTML = decisionRows(decisions);
}
async function renderDetail(seq) {
  const d = await api(`/api/agent/decision?seq=${seq}`);
  const p = d.payload || {};
  $("#detailTitle").textContent = `Decision #${seq}`;
  const parts = [`<div class="kv"><div>Hash</div><div class="mono">${esc(d.hash)}</div></div>`];
  if (p.candidate) {
    const c = p.candidate;
    parts.push(`<div class="sec"><h3>Candidate (deterministic)</h3><div class="kv">
      <div>Tier / strategy</div><div>${esc(c.tier)} · ${esc(c.strategyId)}</div><div>Trade</div><div>${esc(c.side)} ${esc(c.asset)} up to ${num(c.maxSizeUsdt, 4)} USDT</div>
      <div>Thesis</div><div>${esc(c.thesis)}</div><div>Gross edge</div><div>${bps(c.grossEdgeBps)}</div>
      <div>Entry / target / invalid.</div><div>${sig(c.entry)} / ${sig(c.target)} / ${sig(c.invalidation)}</div></div></div>`);
  }
  if (p.filter) parts.push(`<div class="sec"><h3>Strategy filter</h3>${badge(p.filter.outcome === "PASS" ? "VALID" : p.filter.outcome)} <span class="muted">${esc(p.filter.reasons.join("; ") || "all checks passed")}</span></div>`);
  if (p.strategist) parts.push(`<div class="sec"><h3>Strategist (${esc(p.strategist.source)})</h3><div class="kv"><div>Action</div><div>${esc(p.strategist.action)} · ${num(p.strategist.sizeUsdt, 4)} USDT · p=${num(p.strategist.probability, 2)}</div><div>Rationale</div><div>${esc(p.strategist.rationale)}</div>${p.strategist.adjustments?.length ? `<div>Overridden by code</div><div>${esc(p.strategist.adjustments.join("; "))}</div>` : ""}</div></div>`);
  if (p.prediction) parts.push(`<div class="sec"><h3>Sworn prediction</h3><div>${esc(p.prediction.statement)}</div><div class="mono muted small">${esc(p.predictionHash)}</div></div>`);
  const g = p.guardian;
  if (g) {
    const e = g.economics || {};
    parts.push(`<div class="sec"><h3>Guardian ${badge(g.decision)}${g.dryRun ? ' <span class="muted small">dry-run</span>' : ""}</h3>
      <div class="checks">${(g.checks || []).map((c) => `<div class="check ${c.pass ? "" : "fail"}"><b aria-hidden="true">${c.pass ? "✓" : "✕"}</b>${esc(c.name)}${c.value !== undefined && c.value !== null ? ` <span class="muted">${esc(c.value)}${c.limit !== undefined && c.limit !== null ? ` / ${esc(c.limit)}` : ""}</span>` : ""}</div>`).join("")}</div>
      <div class="kv"><div>Amount</div><div>${num(e.amountInUsdt, 4)} USDT</div><div>DEX / reference</div><div>${sig(e.dexSpot)} / ${sig(e.referencePrice)}</div>
      <div>Edge vs reference</div><div>${bps(e.edgeBps)}</div><div>Impact</div><div>${num(e.impactBps, 1)} bps</div><div>Gas (one swap)</div><div>${num(e.gasUsdt, 4)} USDT</div>
      <div>Expected net value</div><div><b>${num(e.expectedNetValueUsdt, 4)} USDT</b> <span class="muted small">after fees, impact, exit and gas both ways</span></div>
      <div>Plan</div><div>${esc(g.plan?.method ?? "—")}${g.plan?.reason ? ` — ${esc(g.plan.reason)}` : ""}</div>
      ${g.permit ? `<div>Permit tradeId</div><div class="mono">${esc(g.permit.tradeId)}</div>` : ""}${g.decisionHash ? `<div>Decision hash</div><div class="mono">${esc(g.decisionHash)}</div>` : ""}</div></div>`);
  }
  if (p.txStatus) parts.push(`<div class="sec"><h3>Execution</h3>${badge(p.txStatus)}</div>`);
  if (!p.candidate && p.health) parts.push(`<div class="sec"><h3>Market at this tick</h3>${(p.health || []).map((a) => `<div>${esc(a.asset)} ${badge(a.status)} ${bps(a.premiumBps)}</div>`).join("")}${p.cycles ? `<div class="muted small" style="margin-top:6px">Tier A: ${esc(p.cycles.note)}</div>` : ""}</div>`);
  $("#detail").innerHTML = parts.join("");
}

// ---------------------------------------------------------------- evidence & health
async function renderEvidence() {
  const [tx, tr, pr] = await Promise.all([api("/api/transactions"), api("/api/trades"), api("/api/predictions")]);
  const c = CFG?.contracts || {};
  $("#contracts").innerHTML = `<table class="t"><tbody>
    <tr><td>Owner vault</td><td>${link("address", CFG?.vault, CFG?.vault)}</td></tr>
    <tr><td>CountersignVault implementation</td><td>${link("address", c.vaultImplementation, c.vaultImplementation)}</td></tr>
    <tr><td>VaultFactory</td><td>${link("address", c.vaultFactory, c.vaultFactory)}</td></tr>
    <tr><td>HSKSwap SwapRouter02 (used by the vault)</td><td>${link("address", c.router, c.router)}</td></tr></tbody></table>`;
  $("#txs").innerHTML = tx.transactions.length
    ? `<table class="t"><thead><tr><th>Trade</th><th>Asset</th><th>Status</th><th class="r">Nonce</th><th>Tx</th><th>Updated</th></tr></thead><tbody>${tx.transactions
        .map((t) => `<tr><td class="mono">${esc(short(t.trade_id))}</td><td>${esc(t.side)} ${esc(t.asset)} (${esc(t.tier)})</td><td>${badge(t.status)}</td><td class="r">${t.nonce ?? "—"}</td><td>${link("tx", t.hash)}</td><td>${esc(ago(t.updated_at))}</td></tr>`)
        .join("")}</tbody></table>`
    : `<div class="empty">No transactions yet. In live mode every countersigned trade appears here with its full lifecycle.</div>`;
  $("#trades").innerHTML = tr.trades.length
    ? `<table class="t"><thead><tr><th>When</th><th>Trade</th><th class="r">Realized</th><th class="r">Guardian expected</th><th>Tx</th></tr></thead><tbody>${tr.trades
        .map((t) => `<tr><td>${esc(ago(t.at))}</td><td>${esc(t.side)} ${esc(t.asset)}</td><td class="r">${num(+t.realized_pnl / 1e6, 4)}</td><td class="r">${num(+t.expected_net / 1e6, 4)}</td><td>${link("tx", t.tx_hash)}</td></tr>`)
        .join("")}</tbody></table>`
    : `<div class="empty">No fills yet.</div>`;
  $("#preds").innerHTML = pr.predictions.length
    ? `<table class="t"><thead><tr><th>Asset</th><th class="r">p</th><th class="r">Target / invalid.</th><th>Outcome</th></tr></thead><tbody>${pr.predictions
        .map((p) => `<tr title="${esc(p.hash)}"><td>${esc(p.direction)} ${esc(p.asset)}</td><td class="r">${num(p.probability, 2)}</td><td class="r">${sig(p.target)} / ${sig(p.invalidation)}</td><td>${p.outcome ? badge(p.outcome) : '<span class="muted">open</span>'}</td></tr>`)
        .join("")}</tbody></table>`
    : `<div class="empty">No sworn predictions on executed trades yet.</div>`;
}
async function renderHealth() {
  const h = await api("/api/strategies/health");
  $("#healthKpis").innerHTML = [
    kpi("Fills", h.trades, `${h.closedTrades} closed`),
    kpi("Win rate", h.winRatePct === null ? "—" : `${num(h.winRatePct, 0)}%`, `${h.wins} wins / ${h.losses} losses`),
    kpi("Realized P&L", num(h.realizedPnlUsdt, 4), "USDT, from vault events"),
    kpi("Gas", num(h.gasUsdt, 4), "USDT, paid by the agent"),
    kpi("Net P&L", num(h.netPnlUsdt, 4), "realized − gas"),
    kpi("Max drawdown", num(h.maxDrawdownUsdt, 4), "USDT, on net equity"),
    kpi("Brier score", h.predictions.brier === null ? "—" : num(h.predictions.brier, 3), `${h.predictions.resolved} graded · lower is better`),
    kpi("Prediction accuracy", h.predictions.accuracyPct === null ? "—" : `${num(h.predictions.accuracyPct, 0)}%`, `${h.predictions.hits} hits`),
    kpi("Tx failure rate", h.tx.failureRatePct === null ? "—" : `${num(h.tx.failureRatePct, 0)}%`, `${h.tx.failed} of ${h.tx.total}`),
    kpi("Consecutive losses", h.consecutiveLosses, "breaker at 3"),
  ].join("");
}

// ---------------------------------------------------------------- owner session (signs a message only — no funds move)
const SESSION_KEY = "countersign.owner";
const getSession = () => {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    return s && Date.now() - Date.parse(s.issuedAt) < 14 * 60_000 ? s : null;
  } catch { return null; }
};
function renderOwner() {
  const s = getSession();
  $("#ownerBtn").textContent = s ? `Owner ${short(s.address)}` : "Owner sign-in";
  $("#ownerState").innerHTML = s
    ? `Signed in as owner <span class="mono">${esc(short(s.address))}</span> until ${new Date(Date.parse(s.issuedAt) + 15 * 60_000).toLocaleTimeString()}.
       <div style="margin-top:8px;display:flex;gap:6px"><button class="btn ghost small" id="pauseBtn">Pause vault</button><button class="btn ghost small" id="unpauseBtn">Unpause</button></div>`
    : "Not signed in as owner. Anyone can read and ask what-if questions; only the owner can apply mandate changes.";
  if (s) {
    $("#pauseBtn").onclick = () => ownerTx("0x8456cb59", "pause");
    $("#unpauseBtn").onclick = () => ownerTx("0x3f4ba83a", "unpause");
  }
}
async function ensureChain() {
  const hex = `0x${(CFG?.chainId ?? 177).toString(16)}`;
  try {
    await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    if (e.code === 4902) await ethereum.request({ method: "wallet_addEthereumChain", params: [{ chainId: hex, chainName: "HashKey Chain", rpcUrls: ["https://mainnet.hsk.xyz"], nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 }, blockExplorerUrls: [CFG.explorer] }] });
    else throw e;
  }
}
$("#ownerBtn").onclick = async () => {
  if (!window.ethereum) return alertBot("No browser wallet found. Install MetaMask or Rabby (a Ledger can be connected through them).");
  if (!CFG?.vault) return alertBot("This deployment has no vault configured.");
  try {
    const [address] = await ethereum.request({ method: "eth_requestAccounts" });
    const issuedAt = new Date().toISOString();
    const { message } = await api(`/api/owner/message?issuedAt=${encodeURIComponent(issuedAt)}`);
    const signature = await ethereum.request({ method: "personal_sign", params: [message, address] });
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ address, issuedAt, signature }));
    renderOwner();
    alertBot(`Signed in as ${short(address)}. This signature moves no funds; it only lets you confirm mandate changes for 15 minutes.`);
  } catch (e) {
    alertBot(`Sign-in cancelled: ${e.message}`);
  }
};
async function ownerTx(data, label) {
  const s = getSession();
  if (!s) return alertBot("Sign in as owner first.");
  try {
    await ensureChain();
    const hash = await ethereum.request({ method: "eth_sendTransaction", params: [{ from: s.address, to: CFG.vault, data }] });
    alertBot(`${label} sent: ${hash}`);
  } catch (e) {
    alertBot(`${label} failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------- Mission Control
const history = [];
const log = $("#chatLog");
function addMsg(role, html, src) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.innerHTML = role === "user" ? esc(html) : `<div class="bubble">${html}</div>${src ? `<div class="src">${esc(src)}</div>` : ""}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}
const alertBot = (t) => { show("copilot"); addMsg("bot", esc(t)); };

function renderCard(c) {
  const d = c.data || {};
  if (d.error) return `<div class="mini">${esc(d.error)}</div>`;
  switch (c.type) {
    case "positions":
      return `<div class="mini"><b>Vault</b> ${d.paused ? badge("PAUSED") : badge("VALID")} · ${num(d.usdt, 4)} USDT cash · total ≈ ${num(d.totalValueUsdt, 4)} USDT
        ${d.positions.length ? `<table class="t"><tbody>${d.positions.map((p) => `<tr><td>${esc(p.asset)}</td><td class="r">cost ${num(p.costUsdt, 4)}</td><td class="r">exit ${num(p.exitValueUsdt, 4)}</td><td class="r">${num(p.unrealizedPct, 2)}%</td></tr>`).join("")}</tbody></table>` : '<div class="muted">no open positions</div>'}</div>`;
    case "performance":
      return `<div class="mini">fills ${d.trades} · net ${num(d.netPnlUsdt, 4)} USDT (realized ${num(d.realizedPnlUsdt, 4)} − gas ${num(d.gasUsdt, 4)}) · win rate ${d.winRatePct === null ? "—" : num(d.winRatePct, 0) + "%"} · Brier ${d.predictions?.brier === null ? "—" : num(d.predictions.brier, 3)}</div>`;
    case "market":
      return `<div class="mini"><table class="t"><tbody>${d.assets.map((a) => `<tr><td>${esc(a.asset)}</td><td>${badge(a.status)}</td><td class="r">${sig(a.dexSpot)}</td><td class="r">${sig(a.reference)}</td><td class="r">${bps(a.premiumBps)}</td></tr>`).join("")}</tbody></table></div>`;
    case "decisions":
      return `<div class="mini">${d.map((x) => `<div class="row" data-seq="${x.seq}"><div class="seq">#${x.seq}</div><div class="time"></div><div>${badge(x.outcome)}</div><div class="sum">${esc(x.summary)}</div></div>`).join("")}</div>`;
    case "decision":
      return `<div class="mini">#${d.seq} ${d.guardian ? `Guardian ${badge(d.guardian.decision)} ${esc(d.guardian.reasons?.join("; ") ?? "")}` : ""} <a href="#" data-open="${d.seq}">open full record</a></div>`;
    case "why":
      return `<div class="mini">${d.reasons.length ? d.reasons.map((r) => `<div>• ${esc(r)}</div>`).join("") : "<div>no blocker on the vault</div>"}${d.lastDecisions.map((x) => `<div class="muted small">${esc(x)}</div>`).join("")}</div>`;
    case "whatif": {
      const e = d.economics || {};
      return `<div class="mini"><b>What-if:</b> ${esc(d.question)} → ${badge(d.decision)}
        <div class="kv" style="margin-top:6px"><div>Expected net</div><div><b>${num(e.expectedNetValueUsdt, 4)} USDT</b></div><div>Edge vs reference</div><div>${bps(e.edgeBps)}</div><div>Gas</div><div>${num(e.gasUsdt, 4)} USDT / swap</div><div>Failed checks</div><div>${esc((d.failed || []).map((f) => f.name).join(", ") || "none")}</div></div>
        <div class="muted small">${esc(d.note)}</div></div>`;
    }
    case "diff": {
      if (!d.changed) return `<div class="mini">No change versus the current mandate.</div>`;
      const id = `apply${Math.random().toString(36).slice(2, 8)}`;
      queueMicrotask(() => {
        const b = document.getElementById(id);
        if (b) b.onclick = () => applyDiff(d, b);
      });
      return `<div class="mini"><b>Proposed mandate change</b> — ${d.tighterOnly ? badge("TIGHTENED") + " stricter only" : badge("WARNING") + " loosens a limit"}
        <table class="t"><thead><tr><th>Field</th><th class="r">Now</th><th class="r">Proposed</th><th></th></tr></thead><tbody>${d.rows.map((r) => `<tr><td>${esc(r.label)}</td><td class="r">${esc(r.from)}</td><td class="r"><b>${esc(r.to)}</b></td><td class="small muted">${esc(r.direction)}</td></tr>`).join("")}</tbody></table>
        ${d.notes.map((n) => `<div class="small muted">• ${esc(n)}</div>`).join("")}
        <div style="margin-top:8px;display:flex;gap:8px;align-items:center"><button class="btn small" id="${id}">${d.tighterOnly ? "Confirm — agent applies via tighten()" : "Sign as owner — setMandate()"}</button><span class="small muted">${esc(d.howToApply)}</span></div></div>`;
    }
    default:
      return "";
  }
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-open]");
  if (!a) return;
  e.preventDefault();
  show("feed");
  renderDetail(Number(a.dataset.open));
});

async function applyDiff(d, btn) {
  const s = getSession();
  if (!s) return addMsg("bot", "Owner sign-in is required to apply mandate changes — use the button at the top right.");
  btn.disabled = true;
  try {
    const r = await post("/api/mandate/apply", { proposed: d.proposed, auth: s });
    if (r.status === "APPLIED") addMsg("bot", `Applied on-chain by the agent via tighten(): <a target="_blank" rel="noopener" href="${esc(ex("tx", r.txHash))}">${esc(short(r.txHash))}</a>`);
    else if (r.status === "OWNER_SIGNATURE_REQUIRED") {
      await ensureChain();
      const hash = await ethereum.request({ method: "eth_sendTransaction", params: [{ from: s.address, to: r.tx.to, data: r.tx.data }] });
      addMsg("bot", `Owner transaction sent (setMandate): <a target="_blank" rel="noopener" href="${esc(ex("tx", hash))}">${esc(short(hash))}</a>`);
    } else addMsg("bot", `Not applied: ${esc(r.reason)}`);
  } catch (e) {
    addMsg("bot", `Not applied: ${esc(e.message)}`);
  } finally {
    btn.disabled = false;
  }
}

async function send(text) {
  if (!text.trim()) return;
  addMsg("user", text);
  history.push({ role: "user", content: text });
  const pending = addMsg("bot", '<span class="muted">thinking…</span>');
  try {
    const r = await post("/api/copilot", { messages: history });
    history.push({ role: "assistant", content: r.reply });
    pending.innerHTML = `<div class="bubble">${esc(r.reply)}${(r.cards || []).map(renderCard).join("")}</div><div class="src">${esc(r.source === "llm" ? "Claude · tools on live data" : "rules (no LLM key configured)")}${r.note ? " · " + esc(r.note) : ""}</div>`;
  } catch (e) {
    pending.innerHTML = `<div class="bubble">Error: ${esc(e.message)}</div>`;
  }
  log.scrollTop = log.scrollHeight;
}
$("#chatForm").onsubmit = (e) => {
  e.preventDefault();
  const v = $("#chatInput").value;
  $("#chatInput").value = "";
  send(v);
};
$("#chips").onclick = (e) => {
  const c = e.target.closest(".chip");
  if (c) send(c.textContent);
};

// ---------------------------------------------------------------- try to break it
const RPCS = { 177: "https://mainnet.hsk.xyz", 133: "https://testnet.hsk.xyz" };
const EXPLORERS = { 177: "https://hsk.blockscout.com", 133: "https://testnet-explorer.hskchain.net" };
const DEMO_TESTNET_VAULT = "0xC425Bd94c290F5968CA2a2F10B8092c6152F03A1"; // v2, 2-of-2 committee
function initBreakIt() {
  const qs = new URLSearchParams(location.search);
  const net = qs.get("net") ?? (CFG?.v2Vault ? String(CFG.chainId) : "133");
  $("#bkNet").value = net;
  $("#bkVault").value = qs.get("vault") ?? (net === "133" ? DEMO_TESTNET_VAULT : (CFG?.v2Vault ?? ""));
  $("#bkNet").onchange = () => { if ($("#bkNet").value === "133" && !$("#bkVault").value) $("#bkVault").value = DEMO_TESTNET_VAULT; };
  $("#bkRun").onclick = async () => {
    const chainId = Number($("#bkNet").value);
    const vault = $("#bkVault").value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(vault)) return ($("#bkOut").textContent = "Enter a vault address.");
    $("#bkRun").disabled = true;
    $("#bkOut").innerHTML = '<span class="muted">running attacks against the live contract…</span>';
    try {
      const { runAttacks } = await import("/breakit.js");
      const r = await runAttacks({ rpc: RPCS[chainId], chainId, vault });
      const blocked = r.results.filter((x) => x.blocked).length;
      const ex2 = (k, v) => `<a class="mono" target="_blank" rel="noopener" href="${esc(EXPLORERS[chainId])}/${k}/${esc(v)}">${esc(short(v))}</a>`;
      $("#bkOut").innerHTML = `<div style="margin-bottom:8px"><b>${blocked} of ${r.results.length} attacks blocked</b> by vault ${ex2("address", vault)} · committee ${r.threshold}-of-${r.guardians.length} · agent ${ex2("address", r.agent)}</div>
        <table class="t"><thead><tr><th>Attack</th><th>As</th><th>Vault said</th><th>Result</th></tr></thead><tbody>${r.results
          .map((x) => `<tr><td>${esc(x.title)}</td><td class="muted">${esc(x.who)}</td><td class="mono">${esc(x.name ?? "—")}${x.args?.length ? `(${esc(x.args.join(", "))})` : ""}</td><td>${x.blocked ? badge("BLOCKED") : badge("ALLOWED")}</td></tr>`)
          .join("")}</tbody></table>`;
    } catch (e) {
      $("#bkOut").textContent = `Could not run: ${e.message}`;
    } finally {
      $("#bkRun").disabled = false;
    }
  };
  if (qs.get("run") === "1") $("#bkRun").click();
}

// ---------------------------------------------------------------- boot
async function refresh() {
  try {
    const t = activeTab();
    if (t === "overview") await renderOverview();
    else if (t === "feed") await renderFeed();
    else if (t === "evidence") await renderEvidence();
    else if (t === "health") await renderHealth();
  } catch (e) {
    console.error(e);
  }
}
(async () => {
  CFG = await api("/api/config").catch(() => null);
  if (CFG) {
    $("#modeBadge").textContent = CFG.mode === "live" ? "● LIVE trading" : "● SHADOW (no transactions)";
    $("#modeBadge").className = `pill ${CFG.mode === "live" ? "live" : "shadow"}`;
    $("#netBadge").textContent = `HashKey Chain ${CFG.chainId}`;
    $("#rAgent").textContent = short(CFG.agent);
    $("#rGuardian").textContent = short(CFG.guardian);
    $("#rOwner").textContent = short(CFG.owner);
    const v = $("#rVault");
    v.textContent = short(CFG.vault);
    if (CFG.vault) v.href = ex("address", CFG.vault);
    $("#copilotMode").textContent = CFG.copilot === "llm" ? "Claude with tools" : "rules mode (add ANTHROPIC_API_KEY for Claude)";
  }
  renderOwner();
  initBreakIt();
  const fromHash = location.hash.slice(1);
  if (["overview", "feed", "copilot", "breakit", "evidence", "health"].includes(fromHash)) show(fromHash);
  addMsg("bot", "I'm Mission Control. Ask how the agent is doing, why it's waiting, what-if questions — or tell me how to trade: size, frequency, risk appetite, target assets. I only propose; the owner confirms.");
  await refresh();
  const ask = new URLSearchParams(location.search).get("ask");
  if (ask) {
    show("copilot");
    send(ask.slice(0, 300));
  }
  setInterval(() => { if (!document.hidden) refresh(); }, 10_000);
})();
