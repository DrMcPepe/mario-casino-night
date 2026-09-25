const socket = io();
const parameters = new URLSearchParams(location.search);
const overlay = parameters.get("overlay") === "1";
if (overlay) {
  document.documentElement.classList.add("overlay-root");
  document.body.classList.add("overlay");
  if (parameters.get("side") === "left") document.body.classList.add("overlay-left");
  if (parameters.get("guide") === "1") document.body.classList.add("overlay-guide");
}
let state = null;
let boardIndex = 0;
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);

socket.on("connect", () => socket.emit("viewer:join", { role: "tv" }));
socket.on("state:snapshot", (snapshot) => {
  const previous = state;
  state = snapshot;
  render(previous);
});
fetch("/api/config").then((response) => response.json()).then((data) => { $("#join-url").textContent = data.publicUrl; });

function statusText(status) { return ({ draft: "Coming up", betting_open: "Bets open", betting_locked: "Bets closed", live: "Live", resolved: "Final", void: "Void" })[status] || "Lobby"; }

function marketSignature(snapshot) {
  return JSON.stringify({
    markets: snapshot?.currentMatch?.markets.map((market) => ({
      id: market.id,
      status: market.status,
      result: market.winningSelectionId,
      selections: market.selections.map((selection) => [selection.id, selection.odds.label])
    })) || [],
    betting: snapshot?.marketBetting || []
  });
}

function resultSignature(snapshot) {
  return JSON.stringify(snapshot?.currentMatch?.markets.map((market) => [market.id, market.status, market.winningSelectionId]) || []);
}

function animateElement(selector) {
  const element = $(selector);
  if (!element) return;
  element.classList.remove("tv-updated");
  void element.offsetWidth;
  element.classList.add("tv-updated");
  element.addEventListener("animationend", () => element.classList.remove("tv-updated"), { once: true });
}

function render(previous = null) {
  if (!state) return;
  const match = state.currentMatch;
  const matchChanged = previous?.currentMatch?.id !== match?.id;
  const statusChanged = previous?.currentMatch?.status !== match?.status;
  const oddsChanged = marketSignature(previous) !== marketSignature(state);
  const resultChanged = resultSignature(previous) !== resultSignature(state);
  const potChanged = previous?.totalPot !== state.totalPot;
  if (overlay) {
    document.body.classList.toggle("overlay-live", ["betting_locked", "live", "resolved"].includes(match?.status));
    document.body.classList.toggle("overlay-idle", !match || match.status === "void");
  }
  $("#tv-title").textContent = match?.title || (state.players.length ? "Next match loading" : "Scan. Join. Bet.");
  $("#tv-sport").textContent = match ? match.sport : `${state.players.length}/13 drivers checked in`;
  for (const selector of ["#tv-status", "#tv-inline-status"]) {
    $(selector).textContent = statusText(match?.status);
    $(selector).className = `status ${match?.status === "betting_open" ? "open" : match?.status === "live" ? "live" : ""}`;
  }
  for (const selector of ["#tv-pot", "#tv-inline-pot"]) $(selector).textContent = `Pot ${state.totalPot}s`;
  $("#tv-markets").innerHTML = match ? match.markets.map((market, index) => {
    const betting = state.marketBetting.find((item) => item.marketId === market.id) || { totalStakeSeconds: 0, selections: [] };
    const marketVoid = market.status === "void";
    return `<article class="odds-line${oddsChanged ? " odds-updated" : ""}${marketVoid ? " market-void" : ""}" style="--odds-delay:${index * 70}ms"><div class="market-line-head"><strong>${esc(market.label)}</strong><span>${betting.totalStakeSeconds}s wagered${marketVoid ? ` <em>VOID</em>` : ""}</span></div><div class="market-selections">${market.selections.map((selection) => {
      const totals = betting.selections.find((item) => item.selectionId === selection.id) || { stakeSeconds: 0, bettorCount: 0 };
      const winner = market.status === "resolved" && market.winningSelectionId === selection.id;
      const loser = market.status === "resolved" && market.winningSelectionId !== selection.id;
      return `<div class="tv-selection${winner ? " winner" : ""}${loser ? " loser" : ""}${winner && resultChanged ? " result-updated" : ""}"><div class="tv-selection-name"><span>${esc(selection.label)}</span>${winner ? `<em>WINNER</em>` : ""}</div><div class="tv-selection-data"><b>${esc(selection.odds.label)}</b><span>${totals.stakeSeconds}s • ${totals.bettorCount} bettor${totals.bettorCount === 1 ? "" : "s"}</span></div></div>`;
    }).join("")}</div></article>`;
  }).join("") : "";

  renderLeaderboard();
  renderCountdown();
  if (matchChanged) animateElement("#tv-title");
  if (statusChanged) {
    animateElement("#tv-status");
    animateElement("#tv-inline-status");
  }
  if (potChanged) {
    animateElement("#tv-pot");
    animateElement("#tv-inline-pot");
  }
  if (oddsChanged) animateElement(".tv-match");
}

function leaderboardData() {
  const grouped = new Map();
  for (const group of state.barGroups || []) {
    const key = `${group.playerId}:${group.unit}`;
    const current = grouped.get(key) || { name: group.playerName, unit: group.unit, amount: 0 };
    current.amount += group.amount;
    grouped.set(key, current);
  }
  const debts = [...grouped.values()];
  const debtByPlayer = new Map();
  for (const debt of debts) {
    const current = debtByPlayer.get(debt.name) || { name: debt.name, seconds: 0, shots: 0, sips: 0 };
    if (debt.unit === "seconds") current.seconds += debt.amount;
    if (debt.unit === "shot") current.shots += debt.amount;
    if (debt.unit === "sips") current.sips += debt.amount;
    debtByPlayer.set(debt.name, current);
  }
  const debtLeaders = [...debtByPlayer.values()]
    .sort((a, b) => b.seconds - a.seconds || b.shots - a.shots || b.sips - a.sips || a.name.localeCompare(b.name))
    .slice(0, 5)
    .map((item) => ({ name: item.name, value: `${item.seconds}s${item.shots ? ` + ${item.shots} shot${item.shots === 1 ? "" : "s"}` : ""}${item.sips ? ` + ${item.sips} sips` : ""}` }));
  const matchLeaders = [...(state.statistics || [])]
    .filter((record) => record.matches.wins + record.matches.losses > 0)
    .sort((a, b) => b.matches.wins - a.matches.wins || a.matches.losses - b.matches.losses || a.playerName.localeCompare(b.playerName))
    .slice(0, 5)
    .map((record) => ({ name: record.playerName, value: `${record.matches.wins}-${record.matches.losses}` }));
  const walletLeaders = [...state.players]
    .sort((a, b) => b.walletSeconds - a.walletSeconds || a.name.localeCompare(b.name))
    .slice(0, 5)
    .map((player) => ({ name: player.name, value: `${player.walletSeconds}s` }));
  return [
    { kicker: "Service queue", title: "Top bar tabs", empty: "The bar is clear", items: debtLeaders },
    { kicker: "Wii Sports", title: "Match leaders", empty: "No matches settled", items: matchLeaders },
    { kicker: "Casino bankroll", title: "Coin holders", empty: "No players checked in", items: walletLeaders }
  ];
}

function renderLeaderboard() {
  if (!state) return;
  const board = leaderboardData()[boardIndex];
  $("#tv-board-kicker").textContent = board.kicker;
  $("#tv-board-title").textContent = board.title;
  $("#tv-ledger").innerHTML = board.items.length ? board.items.map((item, index) => `<div class="ledger-item leaderboard-row"><span class="leader-rank">${index + 1}</span><span class="leader-name">${esc(item.name)}</span><strong>${esc(item.value)}</strong></div>`).join("") : `<p class="muted">${esc(board.empty)}</p>`;
  $("#ticker").innerHTML = board.items.length ? `<strong>${esc(board.title)}</strong>${board.items.map((item, index) => `<span><i>${index + 1}</i> ${esc(item.name)} <b>${esc(item.value)}</b></span>`).join("")}` : `<strong>${esc(board.title)}</strong><span>${esc(board.empty)}</span>`;
  animateElement("#tv-board-title");
  animateElement("#ticker");
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
setInterval(() => {
  boardIndex = (boardIndex + 1) % 3;
  renderLeaderboard();
}, 8000);
