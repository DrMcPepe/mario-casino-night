import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export const RULES = Object.freeze({
  playerCount: 13,
  startingWallet: 15,
  walletCap: 60,
  assignmentCap: 20,
  buybackCredit: 5,
  bettingDurations: [30, 45]
});

const SPORTS = new Set(["tennis", "bowling", "boxing", "golf"]);
const MONEYLINE_ODDS = new Set([1, 2]);
const PROP_ODDS = new Set([1.5, 2, 3]);

function fail(message, code = "RULE_VIOLATION") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function id(prefix) {
  return `${prefix}_${randomUUID()}`;
}

function now() {
  return new Date().toISOString();
}

function wallet(player) {
  return player.baseSeconds + player.profitSeconds;
}

function odds(value, allowed) {
  const number = Number(value);
  if (!allowed.has(number)) fail(`Unsupported odds: ${value}`);
  return number === 1.5
    ? { numerator: 3, denominator: 2, label: "1.5:1" }
    : { numerator: number, denominator: 1, label: `${number}:1` };
}

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    baseSeconds: player.baseSeconds,
    profitSeconds: player.profitSeconds,
    walletSeconds: wallet(player),
    receivedAssignedSeconds: player.receivedAssignedSeconds,
    assignmentRemaining: Math.max(0, RULES.assignmentCap - player.receivedAssignedSeconds),
    eligibleForAssignment: player.receivedAssignedSeconds < RULES.assignmentCap,
    claimed: Boolean(player.claimToken),
    connected: Boolean(player.connected)
  };
}

export function parseNameList(input) {
  if (Array.isArray(input)) return input.map(String).map((name) => name.trim().normalize("NFC")).filter(Boolean);
  const text = String(input || "").replace(/^\uFEFF/, "").trim();
  if (!text) return [];
  const names = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index <= text.length; index += 1) {
    const character = text[index] || "\n";
    if (character === '"' && quoted && text[index + 1] === '"') {
      field += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && (character === "," || character === ";" || character === "\n" || character === "\r")) {
      const value = field.trim().normalize("NFC");
      if (value) names.push(value);
      field = "";
      if (character === "\r" && text[index + 1] === "\n") index += 1;
    } else {
      field += character;
    }
  }
  if (/^(name|player|player name)$/i.test(names[0])) {
    names.shift();
  }
  return names;
}

export function initialState() {
  return {
    revision: 0,
    createdAt: now(),
    players: [],
    matches: [],
    currentMatchId: null,
    bets: [],
    assignments: [],
    buybacks: [],
    barEntries: [],
    walletTransactions: []
  };
}

export class EventStore extends EventEmitter {
  constructor(state = initialState()) {
    super();
    this.state = state;
    this.migrateCreditedProfit();
  }

  migrateCreditedProfit() {
    const legacyWins = this.state.bets.filter((bet) => bet.status === "won" && bet.creditedProfit === undefined);
    const groups = new Map();
    for (const bet of legacyWins) {
      const key = `${bet.matchId}:${bet.playerId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(bet);
    }
    for (const [key, bets] of groups) {
      const [matchId, playerId] = key.split(":");
      const settlement = this.state.walletTransactions.find((transaction) => transaction.kind === "match_settlement" && transaction.matchId === matchId && transaction.playerId === playerId);
      const settledBets = this.state.bets.filter((bet) => bet.matchId === matchId && bet.playerId === playerId && ["won", "void"].includes(bet.status));
      const returnedProfitStake = settledBets.reduce((sum, bet) => sum + Number(bet.profitStakeSeconds || 0), 0);
      let credited = settlement ? Math.max(0, settlement.profitDelta - returnedProfitStake) : bets.reduce((sum, bet) => sum + Number(bet.theoreticalProfit || 0), 0);
      for (const bet of bets) {
        bet.creditedProfit = Math.min(credited, Number(bet.theoreticalProfit || 0));
        credited -= bet.creditedProfit;
      }
    }
  }

  touch() {
    this.state.revision += 1;
    this.emit("change", this.state);
  }

  player(playerId) {
    const player = this.state.players.find((item) => item.id === playerId);
    if (!player) fail("Player not found", "NOT_FOUND");
    return player;
  }

  currentMatch() {
    return this.state.matches.find((match) => match.id === this.state.currentMatchId) || null;
  }

  importPlayers(input, { replace = false } = {}) {
    const names = parseNameList(input);
    if (names.length !== RULES.playerCount) {
      fail(`Import exactly ${RULES.playerCount} names; received ${names.length}.`, "INVALID_ROSTER");
    }
    const normalized = names.map((name) => name.toLocaleLowerCase());
    if (new Set(normalized).size !== names.length) fail("Player names must be unique.", "INVALID_ROSTER");
    if (names.some((name) => name.length > 40)) fail("Player names must be 40 characters or fewer.", "INVALID_ROSTER");
    const hasActivity = this.state.players.length || this.state.matches.length || this.state.bets.length || this.state.barEntries.length;
    if (hasActivity && !replace) fail("Replacing this roster will reset the current event.", "CONFIRM_REPLACE");

    const fresh = initialState();
    fresh.players = names.map((name) => ({
      id: id("player"),
      name,
      baseSeconds: RULES.startingWallet,
      profitSeconds: 0,
      receivedAssignedSeconds: 0,
      claimToken: null,
      connected: false
    }));
    fresh.revision = this.state.revision + 1;
    this.state = fresh;
    this.emit("change", this.state);
    return this.state.players.map(publicPlayer);
  }

  claimPlayer(playerId) {
    const player = this.player(playerId);
    if (player.claimToken) fail("That profile is already claimed.", "PROFILE_CLAIMED");
    player.claimToken = randomUUID();
    player.connected = true;
    this.touch();
    return { token: player.claimToken, player: publicPlayer(player) };
  }

  resumePlayer(token) {
    const player = this.state.players.find((item) => item.claimToken === token);
    if (!player) fail("Saved profile is no longer available.", "INVALID_SESSION");
    player.connected = true;
    this.touch();
    return publicPlayer(player);
  }

  validatePlayerSession(playerId, token) {
    const player = this.player(playerId);
    if (!token || player.claimToken !== token) fail("This player session has been released.", "UNAUTHORIZED");
    return player;
  }

  releasePlayer(playerId) {
    const player = this.player(playerId);
    player.claimToken = null;
    player.connected = false;
    this.touch();
  }

  setConnected(playerId, connected) {
    const player = this.state.players.find((item) => item.id === playerId);
    if (!player || player.connected === connected) return;
    player.connected = connected;
    this.touch();
  }

  createMatch({ sport, competitorOneId, competitorTwoId, oddsOne = 1, oddsTwo = 1, propOdds = 2 }) {
    const normalizedSport = String(sport || "").toLowerCase();
    if (!SPORTS.has(normalizedSport)) fail("Choose a supported sport.");
    if (competitorOneId === competitorTwoId) fail("Choose two different competitors.");
    const one = this.player(competitorOneId);
    const two = this.player(competitorTwoId);
    const existing = this.currentMatch();
    if (existing && !["resolved", "void"].includes(existing.status)) fail("Finish or void the current match first.");

    const matchId = id("match");
    const moneyline = {
      id: id("market"),
      label: "Match winner",
      type: "moneyline",
      selections: [
        { id: id("selection"), label: one.name, playerId: one.id, odds: odds(oddsOne, MONEYLINE_ODDS) },
        { id: id("selection"), label: two.name, playerId: two.id, odds: odds(oddsTwo, MONEYLINE_ODDS) }
      ],
      winningSelectionId: null,
      status: "pending"
    };
    const propDefinitions = {
      tennis: ["Ace occurs"],
      bowling: ["Strike in the 3rd frame", "Gutterball occurs"],
      boxing: ["Knockdown occurs"],
      golf: ["Green-in-one occurs", "Sand trap occurs", "Out-of-bounds occurs"]
    };
    const markets = [moneyline, ...propDefinitions[normalizedSport].map((label) => ({
      id: id("market"),
      label,
      type: label.includes("Gutterball") || label.includes("Sand") || label.includes("Out-of-bounds") ? "penalty_prop" : "prop",
      selections: ["Yes", "No"].map((answer) => ({ id: id("selection"), label: answer, odds: odds(propOdds, PROP_ODDS) })),
      winningSelectionId: null,
      status: "pending"
    }))];
    const match = {
      id: matchId,
      sport: normalizedSport,
      title: `${one.name} vs ${two.name}`,
      competitorOneId,
      competitorTwoId,
      status: "draft",
      bettingDuration: null,
      bettingClosesAt: null,
      markets,
      createdAt: now(),
      resolvedAt: null
    };
    this.state.matches.push(match);
    this.state.currentMatchId = match.id;
    this.touch();
    return match;
  }

  openBetting(durationSeconds) {
    const match = this.currentMatch();
    if (!match || match.status !== "draft") fail("Create a draft match before opening bets.");
    const duration = Number(durationSeconds);
    if (!RULES.bettingDurations.includes(duration)) fail("Betting must run for 30 or 45 seconds.");
    match.status = "betting_open";
    match.bettingDuration = duration;
    match.bettingClosesAt = new Date(Date.now() + duration * 1000).toISOString();
    this.touch();
    return match;
  }

  lockBetting() {
    const match = this.currentMatch();
    if (!match || match.status !== "betting_open") return match;
    match.status = "betting_locked";
    this.touch();
    return match;
  }

  startMatch() {
    const match = this.currentMatch();
    if (!match || match.status !== "betting_locked") fail("Lock betting before starting the match.");
    match.status = "live";
    this.touch();
    return match;
  }

  placeBet(playerId, { marketId, selectionId, stakeSeconds }) {
    const player = this.player(playerId);
    const match = this.currentMatch();
    if (!match || match.status !== "betting_open") fail("Betting is closed.", "BETS_CLOSED");
    if (Date.now() >= Date.parse(match.bettingClosesAt)) {
      this.lockBetting();
      fail("Betting is closed.", "BETS_CLOSED");
    }
    const market = match.markets.find((item) => item.id === marketId);
    const selection = market?.selections.find((item) => item.id === selectionId);
    if (!market || !selection) fail("Market selection not found.");
    const stake = Number(stakeSeconds);
    if (!Number.isInteger(stake) || stake <= 0) fail("Stake must be a positive whole number.");
    if (selection.odds.denominator === 2 && stake % 2 !== 0) fail("1.5:1 markets require an even stake.");
    if (stake > wallet(player)) fail("Stake exceeds your wallet.", "INSUFFICIENT_WALLET");
    const existing = this.state.bets.find((bet) => bet.matchId === match.id && bet.marketId === market.id && bet.playerId === playerId && bet.status === "pending");
    if (existing && existing.selectionId !== selectionId) fail("You already backed the other selection in this market.");

    const baseStake = Math.min(player.baseSeconds, stake);
    const profitStake = stake - baseStake;
    player.baseSeconds -= baseStake;
    player.profitSeconds -= profitStake;
    const bet = {
      id: id("bet"), matchId: match.id, marketId, playerId, selectionId,
      stakeSeconds: stake, baseStakeSeconds: baseStake, profitStakeSeconds: profitStake,
      odds: selection.odds, status: "pending", theoreticalProfit: 0, creditedProfit: 0, createdAt: now(), settledAt: null
    };
    this.state.bets.push(bet);
    this.transaction(playerId, "bet_placed", -baseStake, -profitStake, { matchId: match.id, betId: bet.id });
    this.touch();
    return bet;
  }

  cancelMarketBets(playerId, marketId) {
    const player = this.player(playerId);
    const match = this.currentMatch();
    if (!match || match.status !== "betting_open" || Date.now() >= Date.parse(match.bettingClosesAt)) {
      fail("Bets can be undone only while betting is open.", "BETS_CLOSED");
    }
    if (!match.markets.some((market) => market.id === marketId)) fail("Market not found.", "NOT_FOUND");
    const bets = this.state.bets.filter((bet) => bet.matchId === match.id && bet.marketId === marketId && bet.playerId === playerId && bet.status === "pending");
    if (!bets.length) fail("You do not have an active bet in this market.", "NOT_FOUND");

    const baseRefund = bets.reduce((sum, bet) => sum + bet.baseStakeSeconds, 0);
    const profitRefund = bets.reduce((sum, bet) => sum + bet.profitStakeSeconds, 0);
    if (wallet(player) + baseRefund + profitRefund > RULES.walletCap) fail("Undo would exceed the wallet cap. Ask the host to resolve the pending buy-back first.");
    player.baseSeconds += baseRefund;
    player.profitSeconds += profitRefund;
    const cancelledAt = now();
    for (const bet of bets) {
      bet.status = "cancelled";
      bet.settledAt = cancelledAt;
    }
    this.transaction(playerId, "bet_cancelled", baseRefund, profitRefund, { matchId: match.id, marketId });
    this.cancelIneligibleBuybacks(playerId);
    this.touch();
    return { marketId, refundedSeconds: baseRefund + profitRefund, cancelledBets: bets.length };
  }

  resolveMatch(outcomes) {
    const match = this.currentMatch();
    if (!match || match.status !== "live") fail("Start the match before resolving it.");
    for (const market of match.markets) {
      const outcome = outcomes?.[market.id];
      if (outcome !== "void" && !market.selections.some((selection) => selection.id === outcome)) {
        fail(`Choose an outcome for ${market.label}.`);
      }
    }

    const credits = new Map();
    const addCredit = (playerId) => {
      if (!credits.has(playerId)) credits.set(playerId, { base: 0, profitReturn: 0, earnedProfit: 0, winningBets: [] });
      return credits.get(playerId);
    };
    for (const market of match.markets) {
      const outcome = outcomes[market.id];
      market.winningSelectionId = outcome === "void" ? null : outcome;
      market.status = outcome === "void" ? "void" : "resolved";
      for (const bet of this.state.bets.filter((item) => item.matchId === match.id && item.marketId === market.id && item.status === "pending")) {
        bet.settledAt = now();
        if (outcome === "void") {
          bet.status = "void";
          const credit = addCredit(bet.playerId);
          credit.base += bet.baseStakeSeconds;
          credit.profitReturn += bet.profitStakeSeconds;
        } else if (bet.selectionId === outcome) {
          bet.status = "won";
          bet.theoreticalProfit = bet.stakeSeconds * bet.odds.numerator / bet.odds.denominator;
          const credit = addCredit(bet.playerId);
          credit.base += bet.baseStakeSeconds;
          credit.profitReturn += bet.profitStakeSeconds;
          credit.earnedProfit += bet.theoreticalProfit;
          credit.winningBets.push(bet);
        } else {
          bet.status = "lost";
          this.addBarEntry({ playerId: bet.playerId, kind: "bet_loss", amount: bet.stakeSeconds, unit: "seconds", matchId: match.id, betId: bet.id });
        }
      }
    }

    for (const [playerId, credit] of credits) {
      const player = this.player(playerId);
      let room = RULES.walletCap - wallet(player);
      const baseAdded = Math.min(room, credit.base);
      player.baseSeconds += baseAdded;
      room -= baseAdded;
      const profitReturned = Math.min(room, credit.profitReturn);
      player.profitSeconds += profitReturned;
      room -= profitReturned;
      const profitAdded = Math.min(room, credit.earnedProfit);
      player.profitSeconds += profitAdded;
      let unallocatedProfit = profitAdded;
      for (const bet of credit.winningBets) {
        bet.creditedProfit = Math.min(unallocatedProfit, bet.theoreticalProfit);
        unallocatedProfit -= bet.creditedProfit;
      }
      this.transaction(playerId, "match_settlement", baseAdded, profitReturned + profitAdded, { matchId: match.id });
      this.cancelIneligibleBuybacks(playerId);
    }
    match.status = "resolved";
    match.resolvedAt = now();
    this.touch();
    return match;
  }

  voidMatch() {
    const match = this.currentMatch();
    if (!match || ["resolved", "void"].includes(match.status)) fail("The current match cannot be voided.");
    const pending = this.state.bets.filter((bet) => bet.matchId === match.id && bet.status === "pending");
    for (const bet of pending) {
      const player = this.player(bet.playerId);
      let room = RULES.walletCap - wallet(player);
      const baseAdded = Math.min(room, bet.baseStakeSeconds);
      player.baseSeconds += baseAdded;
      room -= baseAdded;
      const profitAdded = Math.min(room, bet.profitStakeSeconds);
      player.profitSeconds += profitAdded;
      bet.status = "void";
      bet.settledAt = now();
      this.transaction(player.id, "bet_refund", baseAdded, profitAdded, { matchId: match.id, betId: bet.id });
      this.cancelIneligibleBuybacks(player.id);
    }
    for (const market of match.markets) market.status = "void";
    match.status = "void";
    match.resolvedAt = now();
    this.touch();
    return match;
  }

  assignSeconds(sourcePlayerId, targetPlayerId, amountSeconds) {
    const source = this.player(sourcePlayerId);
    const target = this.player(targetPlayerId);
    const amount = Number(amountSeconds);
    if (source.id === target.id) fail("You cannot assign seconds to yourself.");
    if (!Number.isInteger(amount) || amount <= 0) fail("Assignment must be a positive whole number.");
    if (amount > source.profitSeconds) fail("Only available profit may be assigned.", "INSUFFICIENT_PROFIT");
    if (target.receivedAssignedSeconds + amount > RULES.assignmentCap) {
      fail(`${target.name} can receive only ${RULES.assignmentCap - target.receivedAssignedSeconds} more seconds.`, "TARGET_CAP");
    }
    source.profitSeconds -= amount;
    target.receivedAssignedSeconds += amount;
    const sourceMatch = this.currentMatch();
    const sourceMatchId = sourceMatch?.status === "resolved" ? sourceMatch.id : null;
    const assignment = { id: id("assignment"), sourcePlayerId, targetPlayerId, amountSeconds: amount, sourceMatchId, createdAt: now() };
    this.state.assignments.push(assignment);
    const entry = this.addBarEntry({ playerId: targetPlayerId, sourcePlayerId, kind: "assignment", amount, unit: "seconds", matchId: sourceMatchId });
    assignment.barEntryId = entry.id;
    this.transaction(sourcePlayerId, "assignment", 0, -amount, { assignmentId: assignment.id });
    this.touch();
    return assignment;
  }

  requestBuyback(playerId) {
    const player = this.player(playerId);
    if (wallet(player) !== 0) fail("Buy-backs are available only at a zero wallet.");
    const match = this.currentMatch();
    const hasOpenBets = match?.status === "betting_open" && this.state.bets.some((bet) => bet.matchId === match.id && bet.playerId === playerId && bet.status === "pending");
    if (hasOpenBets) fail("Undo your open bets or wait for betting to lock before requesting a buy-back.");
    if (this.state.buybacks.some((item) => item.playerId === playerId && item.status === "pending")) fail("A buy-back is already pending.");
    const buyback = { id: id("buyback"), playerId, status: "pending", requestedAt: now(), servedAt: null };
    const entry = this.addBarEntry({ playerId, kind: "buyback", amount: 1, unit: "shot", buybackId: buyback.id });
    buyback.barEntryId = entry.id;
    this.state.buybacks.push(buyback);
    this.touch();
    return buyback;
  }

  cancelIneligibleBuybacks(playerId) {
    const player = this.player(playerId);
    if (wallet(player) === 0) return;
    for (const buyback of this.state.buybacks.filter((item) => item.playerId === playerId && item.status === "pending")) {
      buyback.status = "cancelled";
      const entry = this.state.barEntries.find((item) => item.id === buyback.barEntryId);
      if (entry?.status === "pending") entry.status = "cancelled";
    }
  }

  serveBarEntries(entryIds) {
    const ids = new Set(Array.isArray(entryIds) ? entryIds : [entryIds]);
    const servedAt = now();
    for (const entry of this.state.barEntries) {
      if (!ids.has(entry.id) || entry.status !== "pending" || entry.kind !== "buyback") continue;
      const buyback = this.state.buybacks.find((item) => item.id === entry.buybackId && item.status === "pending");
      if (buyback && wallet(this.player(buyback.playerId)) !== 0) {
        fail(`${this.player(buyback.playerId).name}'s wallet recovered; the buy-back is no longer eligible.`);
      }
    }
    for (const entry of this.state.barEntries) {
      if (!ids.has(entry.id) || entry.status !== "pending") continue;
      entry.status = "served";
      entry.servedAt = servedAt;
      if (entry.kind === "buyback") {
        const buyback = this.state.buybacks.find((item) => item.id === entry.buybackId && item.status === "pending");
        if (buyback) {
          const player = this.player(buyback.playerId);
          const credit = Math.min(RULES.buybackCredit, RULES.walletCap - wallet(player));
          player.baseSeconds += credit;
          buyback.status = "served";
          buyback.servedAt = servedAt;
          this.transaction(player.id, "buyback", credit, 0, { buybackId: buyback.id });
        }
      }
    }
    this.touch();
  }

  addManualBarEntry({ playerId, amount, unit = "seconds", note = "" }) {
    this.player(playerId);
    const number = Number(amount);
    if (!Number.isInteger(number) || number <= 0) fail("Bar amount must be a positive whole number.");
    if (!new Set(["seconds", "shot", "sips"]).has(unit)) fail("Choose a valid bar unit.");
    const entry = this.addBarEntry({ playerId, kind: "manual", amount: number, unit, note: String(note).slice(0, 120) });
    this.touch();
    return entry;
  }

  addBarEntry(data) {
    const entry = { id: id("bar"), status: "pending", sourcePlayerId: null, matchId: null, betId: null, buybackId: null, note: "", createdAt: now(), servedAt: null, ...data };
    this.state.barEntries.push(entry);
    return entry;
  }

  transaction(playerId, kind, baseDelta, profitDelta, references = {}) {
    this.state.walletTransactions.push({ id: id("tx"), playerId, kind, baseDelta, profitDelta, createdAt: now(), ...references });
  }

  resetEvent() {
    const fresh = initialState();
    fresh.revision = this.state.revision + 1;
    fresh.players = this.state.players.map((player) => ({
      ...player,
      baseSeconds: RULES.startingWallet,
      profitSeconds: 0,
      receivedAssignedSeconds: 0
    }));
    this.state = fresh;
    this.emit("change", this.state);
    return this.state.players.map(publicPlayer);
  }

  statistics(players) {
    const sports = ["tennis", "bowling", "boxing", "golf"];
    const records = new Map(players.map((player) => [player.id, {
      playerId: player.id,
      playerName: player.name,
      betting: { wins: 0, losses: 0, profitSeconds: 0, lostSeconds: 0, netSeconds: 0 },
      matches: { wins: 0, losses: 0, bySport: Object.fromEntries(sports.map((sport) => [sport, { wins: 0, losses: 0 }])) }
    }]));

    const settledMarkets = new Map();
    for (const bet of this.state.bets.filter((item) => ["won", "lost"].includes(item.status))) {
      const key = `${bet.playerId}:${bet.matchId}:${bet.marketId}`;
      if (!settledMarkets.has(key)) settledMarkets.set(key, { playerId: bet.playerId, status: bet.status, profitSeconds: 0, lostSeconds: 0 });
      const result = settledMarkets.get(key);
      result.profitSeconds += Number(bet.creditedProfit ?? 0);
      if (bet.status === "lost") result.lostSeconds += bet.stakeSeconds;
    }
    for (const result of settledMarkets.values()) {
      const record = records.get(result.playerId);
      if (!record) continue;
      if (result.status === "won") {
        record.betting.wins += 1;
        record.betting.profitSeconds += result.profitSeconds;
      } else {
        record.betting.losses += 1;
        record.betting.lostSeconds += result.lostSeconds;
      }
    }
    for (const record of records.values()) {
      record.betting.netSeconds = record.betting.profitSeconds - record.betting.lostSeconds;
    }

    for (const match of this.state.matches.filter((item) => item.status === "resolved")) {
      const moneyline = match.markets.find((market) => market.type === "moneyline");
      const winningSelection = moneyline?.selections.find((selection) => selection.id === moneyline.winningSelectionId);
      const winnerId = winningSelection?.playerId || players.find((player) => player.name === winningSelection?.label)?.id;
      const loserId = [match.competitorOneId, match.competitorTwoId].find((id) => id !== winnerId);
      const winner = records.get(winnerId);
      const loser = records.get(loserId);
      if (!winner || !loser || !winner.matches.bySport[match.sport]) continue;
      winner.matches.wins += 1;
      winner.matches.bySport[match.sport].wins += 1;
      loser.matches.losses += 1;
      loser.matches.bySport[match.sport].losses += 1;
    }
    return [...records.values()];
  }

  snapshot(role = "guest", playerId = null) {
    const players = this.state.players.map(publicPlayer);
    const statistics = this.statistics(players);
    const match = this.currentMatch();
    const currentBets = match ? this.state.bets.filter((bet) => bet.matchId === match.id) : [];
    const activeBets = currentBets.filter((bet) => !["cancelled", "void"].includes(bet.status));
    const totalPot = activeBets.reduce((sum, bet) => sum + bet.stakeSeconds, 0);
    const marketBetting = match ? match.markets.map((market) => ({
      marketId: market.id,
      totalStakeSeconds: currentBets
        .filter((bet) => bet.marketId === market.id && bet.status !== "cancelled")
        .reduce((sum, bet) => sum + bet.stakeSeconds, 0),
      selections: market.selections.map((selection) => {
        const bets = currentBets.filter((bet) => bet.marketId === market.id && bet.selectionId === selection.id && bet.status !== "cancelled");
        return {
          selectionId: selection.id,
          stakeSeconds: bets.reduce((sum, bet) => sum + bet.stakeSeconds, 0),
          bettorCount: new Set(bets.map((bet) => bet.playerId)).size
        };
      })
    })) : [];
    const unpaidBar = this.state.barEntries.filter((entry) => entry.status === "pending").map((entry) => ({
      ...entry,
      playerName: players.find((player) => player.id === entry.playerId)?.name || "Unknown",
      sourceName: players.find((player) => player.id === entry.sourcePlayerId)?.name || null,
      matchTitle: this.state.matches.find((item) => item.id === entry.matchId)?.title || null,
      sport: this.state.matches.find((item) => item.id === entry.matchId)?.sport || null
    }));
    const groupedBar = new Map();
    for (const entry of unpaidBar) {
      const context = entry.kind === "bet_loss" ? entry.matchId : entry.kind === "assignment" ? `${entry.sourcePlayerId}:${entry.matchId || "none"}` : entry.note || entry.id;
      const key = [entry.playerId, entry.kind, entry.unit, context || "none"].join(":");
      if (!groupedBar.has(key)) {
        groupedBar.set(key, {
          key,
          entryIds: [],
          playerId: entry.playerId,
          playerName: entry.playerName,
          kind: entry.kind,
          unit: entry.unit,
          amount: 0,
          sourcePlayerId: entry.sourcePlayerId,
          sourceName: entry.sourceName,
          matchId: entry.matchId,
          matchTitle: entry.matchTitle,
          sport: entry.sport,
          note: entry.note,
          count: 0
        });
      }
      const group = groupedBar.get(key);
      group.entryIds.push(entry.id);
      group.amount += entry.amount;
      group.count += 1;
    }
    const barGroups = [...groupedBar.values()];
    const common = {
      revision: this.state.revision,
      rules: RULES,
      players,
      currentMatch: match ? structuredClone(match) : null,
      totalPot,
      marketBetting,
      unpaidBar,
      barGroups,
      statistics
    };
    if (role === "player") {
      const self = players.find((player) => player.id === playerId) || null;
      const myAssignments = this.state.assignments
        .filter((assignment) => assignment.sourcePlayerId === playerId)
        .slice(-8)
        .reverse()
        .map((assignment) => ({
          ...assignment,
          targetName: players.find((player) => player.id === assignment.targetPlayerId)?.name || "Unknown",
          matchTitle: this.state.matches.find((item) => item.id === assignment.sourceMatchId)?.title || null
        }));
      return { ...common, role, self, selfStats: statistics.find((record) => record.playerId === playerId), myBets: currentBets.filter((bet) => bet.playerId === playerId), myAssignments };
    }
    if (role === "admin") {
      return {
        ...common,
        role,
        bets: structuredClone(this.state.bets),
        matches: structuredClone(this.state.matches),
        assignments: structuredClone(this.state.assignments),
        buybacks: structuredClone(this.state.buybacks),
        barEntries: structuredClone(this.state.barEntries),
        walletTransactions: structuredClone(this.state.walletTransactions)
      };
    }
    return { ...common, role };
  }
}
