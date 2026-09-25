const socket = io();
let state = null;
let selectedStake = 1;
let resumed = false;

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);

function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast${error ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add("hidden"), 3200);
}

function send(event, payload = {}) {
  return new Promise((resolve, reject) => socket.emit(event, payload, (response) => {
    if (!response?.ok) reject(new Error(response?.error || "Request failed"));
    else resolve(response.result);
  }));
}

socket.on("connect", async () => {
  $("#connection").textContent = "Live";
  $("#connection").classList.add("online");
  const token = localStorage.getItem("casinoPlayerToken");
  if (token && !resumed) {
    resumed = true;
    try { await send("session:resume", { token }); }
    catch { localStorage.removeItem("casinoPlayerToken"); resumed = false; }
  }
});
socket.on("disconnect", () => { $("#connection").textContent = "Reconnecting"; $("#connection").classList.remove("online"); resumed = false; });
socket.on("operation:error", ({ error }) => toast(error, true));
socket.on("session:released", () => {
  localStorage.removeItem("casinoPlayerToken");
  resumed = false;
  toast("The host released this profile. Choose a profile again.", true);
});
socket.on("state:snapshot", (snapshot) => { state = snapshot; render(); });

function statusText(status) {
  return ({ draft: "Coming up", betting_open: "Bets open", betting_locked: "Bets closed", live: "Live", resolved: "Final", void: "Void" })[status] || "Lobby";
}

function currentStake(odds) {
  let stake = selectedStake === "all" ? state.self.walletSeconds : Number(selectedStake);
  if (odds.denominator === 2 && stake % 2) stake -= 1;
  return stake;
}

function betStatusLabel(status) {
  return ({ pending: "Active bet", won: "Won", lost: "Lost", void: "Refunded", cancelled: "Undone" })[status] || status;
}

function barGroupCopy(group) {
  if (group.kind === "bet_loss") return { title: `Bet losses${group.sport ? ` • ${group.sport[0].toUpperCase()}${group.sport.slice(1)}` : ""}`, detail: group.matchTitle || "Previous match" };
  if (group.kind === "assignment") return { title: `Assigned by ${group.sourceName || "another player"}`, detail: group.matchTitle || "Opponent assignment" };
  if (group.kind === "buyback") return { title: "Buy-back shot", detail: "Credit added after the host serves it" };
  return { title: group.note || "Host entry", detail: "Added by the bartender" };
}

function renderAssignmentPreview() {
  if (!state?.self) return;
  const target = state.players.find((player) => player.id === $("#assignment-target").value);
  const amount = Number($("#assignment-amount").value || 0);
  const maximum = target ? Math.min(state.self.profitSeconds, target.assignmentRemaining) : 0;
  const valid = target && Number.isInteger(amount) && amount > 0 && amount <= maximum;
  $("#assign-button").disabled = !valid;
  $("#assign-button").textContent = valid ? `Assign ${amount}s to ${target.name}` : "Assign seconds";
  $("#assignment-preview").innerHTML = target
    ? `<div class="row between"><span>${esc(target.name)} target capacity</span><strong>${target.receivedAssignedSeconds}/${state.rules.assignmentCap}s</strong></div><div class="progress"><span style="width:${target.receivedAssignedSeconds / state.rules.assignmentCap * 100}%"></span></div><p>${valid ? `This spends ${amount}s of your profit and adds ${amount}s to ${esc(target.name)}'s tab.` : maximum ? `Choose between 1 and ${maximum} seconds.` : "This player cannot receive more seconds from opponents."}</p>`
    : `<p>No eligible target selected.</p>`;
}

function render() {
  if (!state) return;
  const signedIn = state.role === "player" && state.self;
  $("#profile-screen").classList.toggle("hidden", signedIn);
  $("#player-screen").classList.toggle("hidden", !signedIn);
  if (!signedIn) {
    $("#profiles").innerHTML = state.players.length
      ? state.players.map((player) => `<button class="profile ${player.claimed ? "claimed" : ""}" data-profile="${player.id}" ${player.claimed ? "disabled" : ""}>${esc(player.name)}<small style="display:block;color:var(--muted);margin-top:5px">${player.claimed ? "Claimed" : "Tap to join"}</small></button>`).join("")
      : `<div class="panel"><strong>Roster not loaded.</strong><p class="muted">Ask the host to import the 13 names in the admin panel.</p></div>`;
    return;
  }

  $("#player-name").textContent = state.self.name;
  $("#wallet").textContent = `${state.self.walletSeconds}s`;
  $("#profit").textContent = `${state.self.profitSeconds}s`;
  $("#received").textContent = `${state.self.receivedAssignedSeconds}/${state.rules.assignmentCap}`;
  $("#buyback").classList.toggle("hidden", state.self.walletSeconds !== 0);

  const myGroups = (state.barGroups || []).filter((group) => group.playerId === state.self.id);
  const owedSeconds = myGroups.filter((group) => group.unit === "seconds").reduce((sum, group) => sum + group.amount, 0);
  const owedShots = myGroups.filter((group) => group.unit === "shot").reduce((sum, group) => sum + group.amount, 0);
  const owedSips = myGroups.filter((group) => group.unit === "sips").reduce((sum, group) => sum + group.amount, 0);
  const owedParts = [`${owedSeconds}s`, owedShots ? `${owedShots} shot${owedShots === 1 ? "" : "s"}` : "", owedSips ? `${owedSips} sips` : ""].filter(Boolean);
  $("#owed").textContent = owedParts.join("+");
  $("#tab-total").innerHTML = `<strong>${owedSeconds}s${owedShots ? ` + ${owedShots} shot${owedShots === 1 ? "" : "s"}` : ""}${owedSips ? ` + ${owedSips} sips` : ""}</strong><span>Total currently owed</span>`;

  const stats = state.selfStats || { betting: { wins: 0, losses: 0, netSeconds: 0 }, matches: { wins: 0, losses: 0, bySport: {} } };
  $("#match-record").textContent = `${stats.matches.wins}-${stats.matches.losses}`;
  $("#bet-record").textContent = `${stats.betting.wins}-${stats.betting.losses}`;
  $("#bet-net").textContent = `net ${stats.betting.netSeconds >= 0 ? "+" : ""}${stats.betting.netSeconds}s`;
  $("#sport-records").innerHTML = Object.entries(stats.matches.bySport).map(([sport, record]) => `<div><span>${esc(sport)}</span><strong>${record.wins}-${record.losses}</strong></div>`).join("");

  const match = state.currentMatch;
  $("#match-title").textContent = match?.title || "Waiting for a match";
  $("#match-status").textContent = statusText(match?.status);
  $("#match-status").className = `status ${match?.status === "betting_open" ? "open" : match?.status === "live" ? "live" : ""}`;
  $("#stake-row").classList.toggle("hidden", !match || match.status !== "betting_open");
  $("#bet-hint").classList.toggle("hidden", !match || match.status !== "betting_open");
  renderCountdown();

  $("#markets").innerHTML = match ? match.markets.map((market) => {
    const myBets = state.myBets.filter((bet) => bet.marketId === market.id && bet.status !== "cancelled");
    const myStake = myBets.reduce((sum, bet) => sum + bet.stakeSeconds, 0);
    const backedSelection = market.selections.find((selection) => selection.id === myBets[0]?.selectionId);
    const betState = myBets[0]?.status;
    const creditedProfit = myBets.reduce((sum, bet) => sum + Number(bet.creditedProfit || 0), 0);
    const receiptDetail = betState === "won" ? `+${creditedProfit}s profit credited` : betState === "lost" ? `${myStake}s added to your tab` : betState === "void" ? `${myStake}s refunded` : `${backedSelection?.odds.label || ""} odds`;
    const receipt = myStake ? `<div class="bet-receipt ${esc(betState)}"><div><span>${betStatusLabel(betState)}</span><strong>${myStake}s on ${esc(backedSelection?.label || "selection")}</strong><small>${esc(receiptDetail)}</small></div>${match.status === "betting_open" && betState === "pending" ? `<button class="undo-bet" data-cancel-market="${market.id}">Undo</button>` : ""}</div>` : "";
    return `<article class="market"><div class="row between market-heading"><strong>${esc(market.label)}</strong>${myStake ? `<span class="pill accent">${betStatusLabel(betState)}</span>` : ""}</div>${receipt}<div class="selection-grid">${market.selections.map((selection) => {
      const stake = currentStake(selection.odds);
      const backed = backedSelection?.id === selection.id && betState === "pending";
      const blockedByChoice = Boolean(backedSelection && backedSelection.id !== selection.id && betState === "pending");
      const disabled = match.status !== "betting_open" || stake <= 0 || stake > state.self.walletSeconds || blockedByChoice;
      return `<button class="selection ${backed ? "backed" : ""}" data-market="${market.id}" data-selection="${selection.id}" data-odds-den="${selection.odds.denominator}" ${disabled ? "disabled" : ""}><span class="selection-name">${esc(selection.label)}</span><span class="odds">${selection.odds.label}</span><small>${blockedByChoice ? "Undo first to switch" : stake > 0 ? `${backed ? "Add" : "Bet"} ${stake}s` : "Need an even stake"}</small></button>`;
    }).join("")}</div></article>`;
  }).join("") : `<p class="muted">The host has not created the next matchup.</p>`;

  const pendingBets = state.myBets.filter((bet) => bet.status === "pending");
  const pendingTotal = pendingBets.reduce((sum, bet) => sum + bet.stakeSeconds, 0);
  $("#bet-summary").classList.toggle("hidden", !pendingTotal);
  $("#bet-summary").innerHTML = pendingTotal ? `<span>Your active card</span><strong>${pendingTotal}s at risk</strong><small>${new Set(pendingBets.map((bet) => bet.marketId)).size} market${new Set(pendingBets.map((bet) => bet.marketId)).size === 1 ? "" : "s"}</small>` : "";

  const targets = state.players.filter((player) => player.id !== state.self.id);
  const previousTarget = $("#assignment-target").value;
  $("#assignment-target").innerHTML = targets.map((player) => `<option value="${player.id}" ${!player.eligibleForAssignment ? "disabled" : ""}>${esc(player.name)} - ${player.eligibleForAssignment ? `${player.assignmentRemaining}s available` : "CAP REACHED"}</option>`).join("");
  if (targets.some((player) => player.id === previousTarget && player.eligibleForAssignment)) $("#assignment-target").value = previousTarget;
  const selectedTarget = targets.find((player) => player.id === $("#assignment-target").value);
  $("#assignment-amount").max = Math.max(1, Math.min(state.self.profitSeconds, selectedTarget?.assignmentRemaining || 0));
  renderAssignmentPreview();

  $("#assignment-history").innerHTML = (state.myAssignments || []).length ? `<h3>Recently assigned</h3>${state.myAssignments.map((assignment) => `<div class="assignment-record"><span>${esc(assignment.targetName)}</span><strong>${assignment.amountSeconds}s</strong></div>`).join("")}` : "";

  $("#my-ledger").innerHTML = myGroups.length ? myGroups.map((group) => {
    const copy = barGroupCopy(group);
    return `<div class="ledger-item"><div class="ledger-copy"><strong>${esc(copy.title)}</strong><span>${esc(copy.detail)}</span>${group.count > 1 ? `<small>${group.count} entries combined</small>` : ""}</div><strong class="ledger-amount">${group.amount} ${esc(group.unit)}</strong></div>`;
  }).join("") : `<div class="empty-state"><strong>Your tab is clear</strong><span>New losses and assignments will appear here.</span></div>`;
}

function renderCountdown() {
  if (!state?.currentMatch || state.currentMatch.status !== "betting_open") {
    $("#countdown").textContent = state?.currentMatch ? statusText(state.currentMatch.status) : "--";
    return;
  }
  const seconds = Math.max(0, Math.ceil((Date.parse(state.currentMatch.bettingClosesAt) - Date.now()) / 1000));
  $("#countdown").textContent = `${seconds}s`;
}
setInterval(renderCountdown, 250);

document.addEventListener("click", async (event) => {
  const profile = event.target.closest("[data-profile]");
  const stake = event.target.closest("[data-stake]");
  const selection = event.target.closest("[data-selection]");
  const cancel = event.target.closest("[data-cancel-market]");
  const assignmentAmount = event.target.closest("[data-assign-amount]");
  try {
    if (profile) {
      const result = await send("session:claim", { playerId: profile.dataset.profile });
      localStorage.setItem("casinoPlayerToken", result.token);
      toast(`Welcome, ${result.player.name}`);
    }
    if (stake) {
      selectedStake = stake.dataset.stake === "all" ? "all" : Number(stake.dataset.stake);
      document.querySelectorAll("[data-stake]").forEach((button) => button.classList.toggle("active", button === stake));
      render();
    }
    if (selection) {
      const odds = { denominator: Number(selection.dataset.oddsDen) };
      const amount = currentStake(odds);
      await send("bet:place", { marketId: selection.dataset.market, selectionId: selection.dataset.selection, stakeSeconds: amount });
      toast(`Bet accepted: ${amount}s`);
    }
    if (cancel) {
      const result = await send("bet:cancel", { marketId: cancel.dataset.cancelMarket });
      toast(`Bet undone. ${result.refundedSeconds}s returned.`);
    }
    if (assignmentAmount) {
      const target = state.players.find((player) => player.id === $("#assignment-target").value);
      const maximum = Math.min(state.self.profitSeconds, target?.assignmentRemaining || 0);
      $("#assignment-amount").value = assignmentAmount.dataset.assignAmount === "max" ? maximum : Math.min(Number(assignmentAmount.dataset.assignAmount), maximum);
      renderAssignmentPreview();
    }
  } catch (error) { toast(error.message, true); }
});

$("#assign-button").addEventListener("click", async () => {
  try {
    const amountSeconds = Number($("#assignment-amount").value);
    const target = state.players.find((player) => player.id === $("#assignment-target").value);
    await send("assignment:create", { targetPlayerId: target.id, amountSeconds });
    toast(`${amountSeconds}s assigned to ${target.name}`);
  } catch (error) { toast(error.message, true); }
});

$("#assignment-target").addEventListener("change", () => {
  const target = state.players.find((player) => player.id === $("#assignment-target").value);
  $("#assignment-amount").max = Math.max(1, Math.min(state.self.profitSeconds, target?.assignmentRemaining || 0));
  renderAssignmentPreview();
});
$("#assignment-amount").addEventListener("input", renderAssignmentPreview);

$("#buyback").addEventListener("click", async () => {
  try { await send("buyback:request"); toast("Buy-back sent to the bartender"); }
  catch (error) { toast(error.message, true); }
});

$("#forget-profile").addEventListener("click", async () => {
  if (!confirm("Release this profile so another phone can claim it?")) return;
  try { await send("session:release"); }
  catch (error) { toast(error.message, true); }
});
