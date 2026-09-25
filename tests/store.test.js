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

test("a pending buy-back is cancelled if the wallet recovers before service", () => {
  const store = setup();
  const player = store.state.players[2];
  const match = createOpenMatch(store);
  store.placeBet(player.id, {
    marketId: match.markets[0].id,
    selectionId: match.markets[0].selections[0].id,
    stakeSeconds: 15
  });
  const buyback = store.requestBuyback(player.id);
  store.lockBetting();
  store.startMatch();
  store.resolveMatch(outcomesFor(match));
  assert.equal(player.baseSeconds + player.profitSeconds, 45);
  store.serveBarEntries(buyback.barEntryId);
  assert.equal(player.baseSeconds + player.profitSeconds, 45);
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
