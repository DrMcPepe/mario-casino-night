const socket = io();
const overlay = new URLSearchParams(location.search).get("overlay") === "1";
if (overlay) document.body.classList.add("overlay");
let state = null;
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);

socket.on("connect", () => socket.emit("viewer:join", { role: "tv" }));
socket.on("state:snapshot", (snapshot) => { state = snapshot; render(); });
fetch("/api/config").then((response) => response.json()).then((data) => { $("#join-url").textContent = data.publicUrl; });

function statusText(status) { return ({ draft: "Coming up", betting_open: "Bets open", betting_locked: "Bets closed", live: "Live", resolved: "Final", void: "Void" })[status] || "Lobby"; }

function render() {
  if (!state) return;
  const match = state.currentMatch;
  $("#tv-title").textContent = match?.title || (state.players.length ? "Next match loading" : "Scan. Join. Bet.");
  $("#tv-sport").textContent = match ? match.sport : `${state.players.length}/13 drivers checked in`;
  $("#tv-status").textContent = statusText(match?.status);
  $("#tv-status").className = `status ${match?.status === "betting_open" ? "open" : match?.status === "live" ? "live" : ""}`;
  $("#tv-pot").textContent = `Pot ${state.totalPot}s`;
  $("#tv-markets").innerHTML = match ? match.markets.map((market) => `<div class="odds-line"><strong>${esc(market.label)}</strong><span>${market.selections.map((selection) => `${esc(selection.label)} <b style="color:var(--green)">${selection.odds.label}</b>`).join(" &nbsp; ")}</span></div>`).join("") : "";

  const grouped = new Map();
  for (const entry of state.unpaidBar) {
    const key = `${entry.playerId}:${entry.unit}`;
    const current = grouped.get(key) || { name: entry.playerName, unit: entry.unit, amount: 0 };
    current.amount += entry.amount;
    grouped.set(key, current);
  }
  const debts = [...grouped.values()];
  $("#tv-ledger").innerHTML = debts.length ? debts.map((item) => `<div class="ledger-item"><span>${esc(item.name)}</span><strong>${item.amount} ${esc(item.unit)}</strong></div>`).join("") : `<p class="muted">The bar is clear.</p>`;
  $("#ticker").innerHTML = debts.length ? `<strong>BAR TAB</strong>${debts.map((item) => `<span>${esc(item.name)} <b>${item.amount} ${esc(item.unit)}</b></span>`).join("")}` : `<strong>BAR TAB</strong><span>All clear</span>`;
  renderCountdown();
}

function renderCountdown() {
  if (!state?.currentMatch || state.currentMatch.status !== "betting_open") {
    $("#tv-countdown").textContent = state?.currentMatch ? statusText(state.currentMatch.status) : "--";
    return;
  }
  const seconds = Math.max(0, Math.ceil((Date.parse(state.currentMatch.bettingClosesAt) - Date.now()) / 1000));
  $("#tv-countdown").textContent = `${seconds}s`;
}
setInterval(renderCountdown, 200);
