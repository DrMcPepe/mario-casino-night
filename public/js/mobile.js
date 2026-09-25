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

  const match = state.currentMatch;
  $("#match-title").textContent = match?.title || "Waiting for a match";
  $("#match-status").textContent = statusText(match?.status);
  $("#match-status").className = `status ${match?.status === "betting_open" ? "open" : match?.status === "live" ? "live" : ""}`;
  $("#stake-row").classList.toggle("hidden", !match || match.status !== "betting_open");
  renderCountdown();

  $("#markets").innerHTML = match ? match.markets.map((market) => {
    const myBets = state.myBets.filter((bet) => bet.marketId === market.id);
    const myStake = myBets.reduce((sum, bet) => sum + bet.stakeSeconds, 0);
    return `<article class="market"><div class="row between"><strong>${esc(market.label)}</strong>${myStake ? `<span class="pill">Your stake ${myStake}s</span>` : ""}</div><div class="selection-grid" style="margin-top:8px">${market.selections.map((selection) => {
      const stake = currentStake(selection.odds);
      const disabled = match.status !== "betting_open" || stake <= 0 || stake > state.self.walletSeconds;
      return `<button class="selection" data-market="${market.id}" data-selection="${selection.id}" data-odds-den="${selection.odds.denominator}" ${disabled ? "disabled" : ""}>${esc(selection.label)}<span class="odds">${selection.odds.label}</span><small>${stake > 0 ? `Bet ${stake}s` : "Need an even stake"}</small></button>`;
    }).join("")}</div></article>`;
  }).join("") : `<p class="muted">The host has not created the next matchup.</p>`;

  const targets = state.players.filter((player) => player.id !== state.self.id);
  $("#assignment-target").innerHTML = targets.map((player) => `<option value="${player.id}" ${!player.eligibleForAssignment ? "disabled" : ""}>${esc(player.name)} - ${player.eligibleForAssignment ? `${player.assignmentRemaining}s available` : "CAP REACHED"}</option>`).join("");
  $("#assignment-amount").max = Math.max(1, state.self.profitSeconds);
  $("#assign-button").disabled = state.self.profitSeconds <= 0 || !targets.some((player) => player.eligibleForAssignment);

  const mine = state.unpaidBar.filter((entry) => entry.playerId === state.self.id);
  $("#my-ledger").innerHTML = mine.length ? mine.map((entry) => `<div class="ledger-item"><span>${entry.kind === "assignment" ? `From ${esc(entry.sourceName)}` : entry.kind.replace("_", " ")}</span><strong>${entry.amount} ${esc(entry.unit)}</strong></div>`).join("") : `<p class="muted">Your tab is clear.</p>`;
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
  } catch (error) { toast(error.message, true); }
});

$("#assign-button").addEventListener("click", async () => {
  try {
    const amountSeconds = Number($("#assignment-amount").value);
    await send("assignment:create", { targetPlayerId: $("#assignment-target").value, amountSeconds });
    toast(`Assigned ${amountSeconds}s`);
  } catch (error) { toast(error.message, true); }
});

$("#buyback").addEventListener("click", async () => {
  try { await send("buyback:request"); toast("Buy-back sent to the bartender"); }
  catch (error) { toast(error.message, true); }
});

$("#forget-profile").addEventListener("click", async () => {
  if (!confirm("Release this profile so another phone can claim it?")) return;
  try { await send("session:release"); }
  catch (error) { toast(error.message, true); }
});
