const socket = io();
let state = null;
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);

function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast${error ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add("hidden"), 3500);
}

function send(event, payload = {}) {
  return new Promise((resolve, reject) => socket.emit(event, payload, (response) => response?.ok ? resolve(response.result) : reject(Object.assign(new Error(response?.error || "Request failed"), { code: response?.code }))));
}

socket.on("connect", () => { $("#connection").textContent = "Live"; $("#connection").classList.add("online"); });
socket.on("disconnect", () => { $("#connection").textContent = "Reconnecting"; $("#connection").classList.remove("online"); });
socket.on("operation:error", ({ error }) => toast(error, true));
socket.on("state:snapshot", (snapshot) => { state = snapshot; render(); });

$("#login-button").addEventListener("click", async () => {
  try { await send("admin:login", { pin: $("#pin").value }); toast("Control room unlocked"); }
  catch (error) { toast(error.message, true); }
});
$("#pin").addEventListener("keydown", (event) => { if (event.key === "Enter") $("#login-button").click(); });

function parseNames(text) {
  const values = [];
  let field = "";
  let quoted = false;
  const source = text.trim();
  for (let index = 0; index <= source.length; index += 1) {
    const character = source[index] || "\n";
    if (character === '"' && quoted && source[index + 1] === '"') { field += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (!quoted && /[,;\r\n]/.test(character)) {
      if (field.trim()) values.push(field.trim().normalize("NFC"));
      field = "";
      if (character === "\r" && source[index + 1] === "\n") index += 1;
    } else field += character;
  }
  if (/^(name|player|player name)$/i.test(values[0])) values.shift();
  return values;
}

$("#roster").addEventListener("input", () => { $("#roster-count").textContent = `${parseNames($("#roster").value).length} names detected`; });
$("#roster-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  $("#roster").value = await file.text();
  $("#roster").dispatchEvent(new Event("input"));
});
$("#import-roster").addEventListener("click", async () => {
  const names = parseNames($("#roster").value);
  if (names.length !== 13) return toast(`Exactly 13 names required; found ${names.length}.`, true);
  try {
    await send("admin:roster.import", { names, replace: false });
    toast("All 13 player profiles are ready");
  } catch (error) {
    if (error.code === "CONFIRM_REPLACE" && confirm("This will erase the active event and replace all users. Continue?")) {
      try { await send("admin:roster.import", { names, replace: true }); toast("Roster replaced and event reset"); }
      catch (retryError) { toast(retryError.message, true); }
    } else toast(error.message, true);
  }
});

function statusText(status) { return ({ draft: "Draft", betting_open: "Bets open", betting_locked: "Bets closed", live: "Live", resolved: "Resolved", void: "Void" })[status] || "Lobby"; }
function playerName(id) { return state?.players.find((player) => player.id === id)?.name || "Unknown"; }
function groupCopy(group) {
  if (group.kind === "bet_loss") return { title: "Bet losses", detail: group.matchTitle || "Previous match" };
  if (group.kind === "assignment") return { title: `Assigned by ${group.sourceName || "another player"}`, detail: group.matchTitle || "Opponent assignment" };
  if (group.kind === "buyback") return { title: "Buy-back shot", detail: "Serve to release 5 wallet seconds" };
  return { title: group.note || "Host entry", detail: "Manual bartender entry" };
}

function render() {
  const authenticated = state?.role === "admin";
  $("#login").classList.toggle("hidden", authenticated);
  $("#admin").classList.toggle("hidden", !authenticated);
  $("#reset-event").classList.toggle("hidden", !authenticated);
  if (!authenticated) return;

  $("#player-count").textContent = `${state.players.length}/13`;
  $("#admin-players").innerHTML = state.players.length ? state.players.map((player) => {
    const stats = state.statistics.find((record) => record.playerId === player.id);
    return `<div class="profile"><div class="row between"><strong>${esc(player.name)}</strong><span class="connection ${player.connected ? "online" : ""}">${player.connected ? "online" : player.claimed ? "claimed" : "open"}</span></div><div class="player-metrics"><span>Wallet <b>${player.walletSeconds}s</b></span><span>Profit <b>${player.profitSeconds}s</b></span><span>Target <b>${player.receivedAssignedSeconds}/${state.rules.assignmentCap}</b></span><span>Sports <b>${stats.matches.wins}-${stats.matches.losses}</b></span></div>${player.claimed ? `<button class="button secondary small" data-release="${player.id}" style="margin-top:8px">Release</button>` : ""}</div>`;
  }).join("") : `<p class="muted">Import the roster to begin.</p>`;

  const optionHtml = state.players.map((player) => `<option value="${player.id}">${esc(player.name)}</option>`).join("");
  for (const selector of ["#competitor-one", "#competitor-two", "#manual-player"]) {
    const select = $(selector); const old = select.value; select.innerHTML = optionHtml;
    if (state.players.some((player) => player.id === old)) select.value = old;
  }
  if ($("#competitor-two").value === $("#competitor-one").value && state.players[1]) $("#competitor-two").value = state.players[1].id;

  const match = state.currentMatch;
  $("#admin-match-title").textContent = match?.title || "No active match";
  $("#admin-match-status").textContent = statusText(match?.status);
  $("#admin-match-status").className = `status ${match?.status === "betting_open" ? "open" : match?.status === "live" ? "live" : ""}`;
  $("#admin-match").innerHTML = match ? `<div class="table-wrap"><table><thead><tr><th>Market</th><th>Outcome</th></tr></thead><tbody>${match.markets.map((market) => `<tr><td><strong>${esc(market.label)}</strong><br><span class="muted">${market.selections.map((selection) => `${esc(selection.label)} ${selection.odds.label}`).join(" / ")}</span></td><td><select class="outcome" data-market="${market.id}" ${["resolved", "void"].includes(match.status) ? "disabled" : ""}><option value="">Choose...</option>${market.selections.map((selection) => `<option value="${selection.id}" ${market.winningSelectionId === selection.id ? "selected" : ""}>${esc(selection.label)}</option>`).join("")}<option value="void">Void market</option></select></td></tr>`).join("")}</tbody></table></div><p class="muted" style="margin-top:10px">Current pot: <strong>${state.totalPot}s</strong></p>` : `<p class="muted">Create a match card after importing players.</p>`;

  const tabSeconds = state.barGroups.filter((group) => group.unit === "seconds").reduce((sum, group) => sum + group.amount, 0);
  const tabShots = state.barGroups.filter((group) => group.unit === "shot").reduce((sum, group) => sum + group.amount, 0);
  const tabSips = state.barGroups.filter((group) => group.unit === "sips").reduce((sum, group) => sum + group.amount, 0);
  $("#admin-tab-total").textContent = `${tabSeconds}s${tabShots ? ` + ${tabShots} shot${tabShots === 1 ? "" : "s"}` : ""}${tabSips ? ` + ${tabSips} sips` : ""} currently owed`;
  $("#admin-ledger").innerHTML = state.barGroups.length ? state.barGroups.map((group) => {
    const copy = groupCopy(group);
    return `<div class="ledger-item"><div class="ledger-copy"><strong>${esc(group.playerName)}</strong><span>${esc(copy.title)} • ${esc(copy.detail)}</span>${group.count > 1 ? `<small>${group.count} entries combined</small>` : ""}</div><div class="row"><strong class="ledger-amount">${group.amount} ${esc(group.unit)}</strong><button class="button green small" data-serve-group="${group.entryIds.join(",")}">Served</button></div></div>`;
  }).join("") : `<div class="empty-state"><strong>No unpaid drinks</strong><span>The service queue is clear.</span></div>`;

  const standings = [...state.statistics].sort((a, b) => b.matches.wins - a.matches.wins || a.matches.losses - b.matches.losses || b.betting.netSeconds - a.betting.netSeconds);
  $("#standings").innerHTML = standings.length ? `<table class="standings-table"><thead><tr><th>Player</th><th>All sports</th><th>Tennis</th><th>Bowling</th><th>Boxing</th><th>Golf</th><th>Bet record</th><th>Bet net</th></tr></thead><tbody>${standings.map((record, index) => `<tr><td><span class="rank">${index + 1}</span><strong>${esc(record.playerName)}</strong></td><td>${record.matches.wins}-${record.matches.losses}</td><td>${record.matches.bySport.tennis.wins}-${record.matches.bySport.tennis.losses}</td><td>${record.matches.bySport.bowling.wins}-${record.matches.bySport.bowling.losses}</td><td>${record.matches.bySport.boxing.wins}-${record.matches.bySport.boxing.losses}</td><td>${record.matches.bySport.golf.wins}-${record.matches.bySport.golf.losses}</td><td>${record.betting.wins}-${record.betting.losses}</td><td class="${record.betting.netSeconds >= 0 ? "positive" : "negative"}">${record.betting.netSeconds >= 0 ? "+" : ""}${record.betting.netSeconds}s</td></tr>`).join("")}</tbody></table>` : `<p class="muted">Import players to see standings.</p>`;

  const canCreate = state.players.length === 13;
  $("#create-match").disabled = !canCreate;
  const controls = {
    "#lock-bets": match?.status !== "betting_open",
    "#start-match": match?.status !== "betting_locked",
    "#resolve-match": match?.status !== "live",
    "#void-match": !match || ["resolved", "void"].includes(match.status)
  };
  for (const [selector, disabled] of Object.entries(controls)) $(selector).disabled = disabled;
  document.querySelectorAll("[data-open]").forEach((button) => button.disabled = match?.status !== "draft");
}

$("#create-match").addEventListener("click", async () => {
  try {
    await send("admin:match.create", {
      sport: $("#sport").value,
      competitorOneId: $("#competitor-one").value,
      competitorTwoId: $("#competitor-two").value,
      oddsOne: Number($("#odds-one").value), oddsTwo: Number($("#odds-two").value), propOdds: Number($("#prop-odds").value)
    });
    toast("Match card created");
  } catch (error) { toast(error.message, true); }
});

document.addEventListener("click", async (event) => {
  const release = event.target.closest("[data-release]");
  const open = event.target.closest("[data-open]");
  const serve = event.target.closest("[data-serve-group]");
  try {
    if (release && confirm("Release this phone profile?")) await send("admin:player.release", { playerId: release.dataset.release });
    if (open) await send("admin:betting.open", { durationSeconds: Number(open.dataset.open) });
    if (serve) await send("admin:bar.serve", { entryIds: serve.dataset.serveGroup.split(",") });
  } catch (error) { toast(error.message, true); }
});

$("#lock-bets").addEventListener("click", () => send("admin:betting.lock").catch((error) => toast(error.message, true)));
$("#start-match").addEventListener("click", () => send("admin:match.start").catch((error) => toast(error.message, true)));
$("#void-match").addEventListener("click", async () => { if (confirm("Void this match and refund pending stakes?")) try { await send("admin:match.void"); } catch (error) { toast(error.message, true); } });
$("#resolve-match").addEventListener("click", async () => {
  const outcomes = Object.fromEntries([...document.querySelectorAll(".outcome")].map((select) => [select.dataset.market, select.value]));
  try { await send("admin:match.resolve", { outcomes }); toast("Match settled"); }
  catch (error) { toast(error.message, true); }
});
$("#serve-all").addEventListener("click", async () => {
  if (!state.unpaidBar.length) return;
  try { await send("admin:bar.serve", { entryIds: state.unpaidBar.map((entry) => entry.id) }); toast("Visible tab served"); }
  catch (error) { toast(error.message, true); }
});
$("#manual-add").addEventListener("click", async () => {
  try {
    await send("admin:bar.manual", { playerId: $("#manual-player").value, amount: Number($("#manual-amount").value), unit: $("#manual-unit").value, note: $("#manual-note").value });
    toast("Manual entry added");
  } catch (error) { toast(error.message, true); }
});
$("#reset-event").addEventListener("click", async () => {
  const message = "Reset all wallets, bets, match records, assignments, tabs, and matches? Player names and claimed phones will stay connected.";
  if (!confirm(message)) return;
  if (!confirm("This cannot be undone. Reset the test event now?")) return;
  try { await send("admin:event.reset"); toast("Event data reset. All wallets are back to 15s."); }
  catch (error) { toast(error.message, true); }
});
