import test from "node:test";
import assert from "node:assert/strict";
import { EventStore, RULES, parseNameList } from "../src/store.js";

const names = Array.from({ length: 13 }, (_, index) => `Player ${index + 1}`);

function setup() {
  const store = new EventStore();
  store.importPlayers(names);
  return store;
}

function createOpenMatch(store, options = {}) {
  const [one, two] = store.state.players;
  const match = store.createMatch({
    sport: "tennis",
    competitorOneId: one.id,
    competitorTwoId: two.id,
    oddsOne: 2,
    oddsTwo: 1,
    propOdds: 1.5,
    ...options
  });
  store.openBetting(30);
  return match;
}

function outcomesFor(match, firstWinner = true) {
  return Object.fromEntries(match.markets.map((market, index) => [
    market.id,
    index === 0 ? market.selections[firstWinner ? 0 : 1].id : "void"
  ]));
}

test("name parser accepts lines, commas, and an optional header", () => {
  assert.deepEqual(parseNameList("name\nAda\nGrace"), ["Ada", "Grace"]);
  assert.deepEqual(parseNameList("Ada, Grace; Linus"), ["Ada", "Grace", "Linus"]);
});

test("roster import requires exactly 13 unique names and starts every wallet at 15", () => {
  const store = new EventStore();
  assert.throws(() => store.importPlayers(names.slice(0, 12)), /exactly 13/i);
  assert.throws(() => store.importPlayers([...names.slice(0, 12), names[0]]), /unique/i);
  const players = store.importPlayers(names);
  assert.equal(players.length, 13);
  assert.ok(players.every((player) => player.walletSeconds === RULES.startingWallet));
});

test("a winning wager returns its stake and credits assignable profit", () => {
  const store = setup();
  const player = store.state.players[2];
  const match = createOpenMatch(store);
  const winner = match.markets[0].selections[0];
  store.placeBet(player.id, { marketId: match.markets[0].id, selectionId: winner.id, stakeSeconds: 5 });
  assert.equal(player.baseSeconds, 10);
  store.lockBetting();
  store.startMatch();
  store.resolveMatch(outcomesFor(match));
  assert.equal(player.baseSeconds, 15);
  assert.equal(player.profitSeconds, 10);
  assert.equal(player.baseSeconds + player.profitSeconds, 25);
  assert.equal(store.state.bets[0].creditedProfit, 10);
});

test("a lost wager creates equal self-drinking debt with no target-cap effect", () => {
  const store = setup();
  const player = store.state.players[2];
  const match = createOpenMatch(store);
  const loser = match.markets[0].selections[1];
  store.placeBet(player.id, { marketId: match.markets[0].id, selectionId: loser.id, stakeSeconds: 12 });
  store.lockBetting();
  store.startMatch();
  store.resolveMatch(outcomesFor(match));
  const debt = store.state.barEntries.find((entry) => entry.playerId === player.id);
  assert.equal(debt.amount, 12);
  assert.equal(debt.kind, "bet_loss");
  assert.equal(player.receivedAssignedSeconds, 0);
});

test("1.5:1 markets reject odd stakes", () => {
  const store = setup();
  const player = store.state.players[2];
  const match = createOpenMatch(store);
  const prop = match.markets[1];
  assert.throws(() => store.placeBet(player.id, {
    marketId: prop.id,
    selectionId: prop.selections[0].id,
    stakeSeconds: 3
  }), /even stake/i);
});

test("a player can undo all stakes in a market while betting remains open", () => {
  const store = setup();
  const player = store.state.players[2];
  player.profitSeconds = 5;
  const match = createOpenMatch(store);
  const selection = match.markets[0].selections[0];
  store.placeBet(player.id, { marketId: match.markets[0].id, selectionId: selection.id, stakeSeconds: 12 });
  store.placeBet(player.id, { marketId: match.markets[0].id, selectionId: selection.id, stakeSeconds: 8 });
  assert.equal(player.baseSeconds + player.profitSeconds, 0);
  const result = store.cancelMarketBets(player.id, match.markets[0].id);
  assert.equal(result.refundedSeconds, 20);
  assert.equal(player.baseSeconds, 15);
  assert.equal(player.profitSeconds, 5);
  assert.ok(store.state.bets.every((bet) => bet.status === "cancelled"));
  assert.equal(store.snapshot("guest").totalPot, 0);
});

test("buy-backs wait until open all-in bets can no longer be undone", () => {
  const store = setup();
  const player = store.state.players[2];
  const match = createOpenMatch(store);
  store.placeBet(player.id, { marketId: match.markets[0].id, selectionId: match.markets[0].selections[0].id, stakeSeconds: 15 });
  assert.throws(() => store.requestBuyback(player.id), /wait for betting to lock/i);
  const refund = store.cancelMarketBets(player.id, match.markets[0].id);
  assert.equal(refund.refundedSeconds, 15);
  assert.equal(player.baseSeconds, 15);
});

test("bets cannot be undone after the book locks", () => {
  const store = setup();
  const player = store.state.players[2];
  const match = createOpenMatch(store);
  store.placeBet(player.id, { marketId: match.markets[0].id, selectionId: match.markets[0].selections[0].id, stakeSeconds: 5 });
  store.lockBetting();
  assert.throws(() => store.cancelMarketBets(player.id, match.markets[0].id), /only while betting is open/i);
});

test("only profit can be assigned and recipients have a lifetime 20-second cap", () => {
  const store = setup();
  const source = store.state.players[2];
  const target = store.state.players[3];
  source.profitSeconds = 25;
  assert.throws(() => store.assignSeconds(source.id, source.id, 1), /yourself/i);
  store.assignSeconds(source.id, target.id, 20);
  assert.equal(source.profitSeconds, 5);
  assert.equal(target.receivedAssignedSeconds, 20);
  assert.equal(store.state.barEntries[0].amount, 20);
  assert.throws(() => store.assignSeconds(source.id, target.id, 1), /0 more seconds/i);
  assert.equal(store.snapshot("guest").players.find((player) => player.id === target.id).eligibleForAssignment, false);
});

test("buy-back credit is granted only after the host serves the shot", () => {
  const store = setup();
  const player = store.state.players[2];
  const match = createOpenMatch(store);
  store.placeBet(player.id, {
    marketId: match.markets[0].id,
    selectionId: match.markets[0].selections[1].id,
    stakeSeconds: 15
  });
  store.lockBetting();
  store.startMatch();
  store.resolveMatch(outcomesFor(match));
  assert.equal(player.baseSeconds + player.profitSeconds, 0);
  const buyback = store.requestBuyback(player.id);
  assert.equal(player.baseSeconds, 0);
  store.serveBarEntries(buyback.barEntryId);
  assert.equal(player.baseSeconds, 5);
  assert.equal(store.state.buybacks[0].status, "served");
});

test("wallet settlement never exceeds 60 and clipped profit is not assignable", () => {
  const store = setup();
  const player = store.state.players[2];
  player.baseSeconds = 55;
  player.profitSeconds = 5;
  const match = createOpenMatch(store);
  store.placeBet(player.id, {
    marketId: match.markets[0].id,
    selectionId: match.markets[0].selections[0].id,
    stakeSeconds: 10
  });
  store.lockBetting();
  store.startMatch();
  store.resolveMatch(outcomesFor(match));
  assert.equal(player.baseSeconds + player.profitSeconds, 60);
  assert.equal(player.profitSeconds, 5);
});

test("replacing an active roster requires explicit confirmation and clears event data", () => {
  const store = setup();
  createOpenMatch(store);
  const replacement = names.map((name) => `New ${name}`);
  assert.throws(() => store.importPlayers(replacement), /reset the current event/i);
  store.importPlayers(replacement, { replace: true });
  assert.equal(store.state.matches.length, 0);
  assert.equal(store.state.players[0].name, "New Player 1");
});

test("a pending buy-back is cancelled if a voided locked bet restores the wallet before service", () => {
  const store = setup();
  const player = store.state.players[2];
  const match = createOpenMatch(store);
  store.placeBet(player.id, {
    marketId: match.markets[0].id,
    selectionId: match.markets[0].selections[0].id,
    stakeSeconds: 15
  });
  store.lockBetting();
  const buyback = store.requestBuyback(player.id);
  store.voidMatch();
  assert.equal(player.baseSeconds + player.profitSeconds, 15);
  store.serveBarEntries(buyback.barEntryId);
  assert.equal(player.baseSeconds + player.profitSeconds, 15);
  assert.equal(store.state.buybacks[0].status, "cancelled");
  assert.equal(store.state.barEntries.find((entry) => entry.id === buyback.barEntryId).status, "cancelled");
});

test("a losing penalty prop creates only its stake-sized seconds debt", () => {
  const store = setup();
  const player = store.state.players[2];
  const [one, two] = store.state.players;
  const match = store.createMatch({ sport: "golf", competitorOneId: one.id, competitorTwoId: two.id, oddsOne: 1, oddsTwo: 1, propOdds: 2 });
  store.openBetting(30);
  const penalty = match.markets.find((market) => market.type === "penalty_prop");
  store.placeBet(player.id, { marketId: penalty.id, selectionId: penalty.selections[0].id, stakeSeconds: 4 });
  store.lockBetting();
  store.startMatch();
  const outcomes = Object.fromEntries(match.markets.map((market) => [market.id, market.id === penalty.id ? penalty.selections[1].id : "void"]));
  store.resolveMatch(outcomes);
  const entries = store.state.barEntries.filter((entry) => entry.playerId === player.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "bet_loss");
  assert.equal(entries[0].unit, "seconds");
  assert.equal(entries[0].amount, 4);
});

test("bar snapshot groups match losses and assignments into readable obligations", () => {
  const store = setup();
  const source = store.state.players[2];
  const target = store.state.players[3];
  const match = createOpenMatch(store);
  store.placeBet(target.id, { marketId: match.markets[0].id, selectionId: match.markets[0].selections[1].id, stakeSeconds: 4 });
  store.placeBet(target.id, { marketId: match.markets[1].id, selectionId: match.markets[1].selections[1].id, stakeSeconds: 2 });
  store.lockBetting();
  store.startMatch();
  const outcomes = Object.fromEntries(match.markets.map((market, index) => [market.id, index < 2 ? market.selections[0].id : "void"]));
  store.resolveMatch(outcomes);
  source.profitSeconds = 5;
  store.assignSeconds(source.id, target.id, 5);
  const groups = store.snapshot("player", target.id).barGroups.filter((group) => group.playerId === target.id);
  const losses = groups.find((group) => group.kind === "bet_loss");
  const assignment = groups.find((group) => group.kind === "assignment");
  assert.equal(losses.amount, 6);
  assert.equal(losses.count, 2);
  assert.equal(losses.matchTitle, match.title);
  assert.equal(assignment.amount, 5);
  assert.equal(assignment.sourceName, source.name);
});

test("statistics track credited bet results and Wii Sports records by sport", () => {
  const store = setup();
  const [competitorOne, competitorTwo, bettor] = store.state.players;
  const match = createOpenMatch(store);
  store.placeBet(bettor.id, { marketId: match.markets[0].id, selectionId: match.markets[0].selections[0].id, stakeSeconds: 5 });
  store.placeBet(bettor.id, { marketId: match.markets[0].id, selectionId: match.markets[0].selections[0].id, stakeSeconds: 2 });
  store.placeBet(competitorTwo.id, { marketId: match.markets[0].id, selectionId: match.markets[0].selections[1].id, stakeSeconds: 4 });
  store.lockBetting();
  store.startMatch();
  store.resolveMatch(outcomesFor(match));
  const snapshot = store.snapshot("player", bettor.id);
  assert.equal(snapshot.selfStats.betting.wins, 1);
  assert.equal(snapshot.selfStats.betting.profitSeconds, 14);
  assert.equal(snapshot.statistics.find((record) => record.playerId === competitorTwo.id).betting.losses, 1);
  assert.equal(snapshot.statistics.find((record) => record.playerId === competitorOne.id).matches.bySport.tennis.wins, 1);
  assert.equal(snapshot.statistics.find((record) => record.playerId === competitorTwo.id).matches.bySport.tennis.losses, 1);
});

test("event reset clears scores, wallets, bets, and tabs while preserving users and claims", () => {
  const store = setup();
  const player = store.state.players[2];
  store.claimPlayer(player.id);
  const token = player.claimToken;
  const match = createOpenMatch(store);
  store.placeBet(player.id, { marketId: match.markets[0].id, selectionId: match.markets[0].selections[1].id, stakeSeconds: 5 });
  store.lockBetting();
  store.startMatch();
  store.resolveMatch(outcomesFor(match));
  store.resetEvent();
  assert.equal(store.state.players.length, 13);
  assert.equal(store.state.players[2].claimToken, token);
  assert.equal(store.state.players[2].baseSeconds, 15);
  assert.equal(store.state.players[2].profitSeconds, 0);
  assert.equal(store.state.matches.length, 0);
  assert.equal(store.state.bets.length, 0);
  assert.equal(store.state.barEntries.length, 0);
});
