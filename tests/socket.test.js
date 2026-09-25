import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { io as createClient } from "socket.io-client";

function emit(socket, event, payload = {}) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function nextSnapshot(socket, predicate = () => true) {
  return new Promise((resolve) => {
    const handler = (snapshot) => {
      if (!predicate(snapshot)) return;
      socket.off("state:snapshot", handler);
      resolve(snapshot);
    };
    socket.on("state:snapshot", handler);
  });
}

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for test server");
}

test("socket workflow imports 13 players and revokes a released phone", { timeout: 20_000 }, async (context) => {
  const port = 5600 + Math.floor(Math.random() * 300);
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), ADMIN_PIN: "test-pin", STATE_CHECKPOINT: "false", PUBLIC_URL: url },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const clients = [];
  context.after(() => {
    for (const client of clients) client.close();
    child.kill();
  });
  await waitForServer(url, child);
  assert.equal((await fetch(`${url}/`)).status, 200);
  assert.equal((await fetch(`${url}/tv`)).status, 200);
  assert.equal((await fetch(`${url}/admin`)).status, 200);
  assert.equal((await fetch(`${url}/rules`)).status, 200);
  assert.equal((await fetch(`${url}/js/mobile.js`)).status, 200);

  const admin = createClient(url, { transports: ["websocket"] });
  clients.push(admin);
  await new Promise((resolve) => admin.on("connect", resolve));
  assert.equal((await emit(admin, "admin:login", { pin: "test-pin" })).ok, true);
  const roster = Array.from({ length: 13 }, (_, index) => `Socket Player ${index + 1}`).join("\n");
  const imported = await emit(admin, "admin:roster.import", { names: roster, replace: false });
  assert.equal(imported.ok, true);
  assert.equal(imported.result.length, 13);

  const player = createClient(url, { transports: ["websocket"] });
  clients.push(player);
  await new Promise((resolve) => player.on("connect", resolve));
  const claim = await emit(player, "session:claim", { playerId: imported.result[0].id });
  assert.equal(claim.ok, true);

  const released = new Promise((resolve) => player.once("session:released", resolve));
  assert.equal((await emit(admin, "admin:player.release", { playerId: imported.result[0].id })).ok, true);
  await released;
  const rejected = await emit(player, "buyback:request");
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "UNAUTHORIZED");

  const reclaimed = await emit(player, "session:claim", { playerId: imported.result[0].id });
  assert.equal(reclaimed.ok, true);
  const created = await emit(admin, "admin:match.create", {
    sport: "tennis",
    competitorOneId: imported.result[0].id,
    competitorTwoId: imported.result[1].id,
    oddsOne: 1,
    oddsTwo: 1,
    propOdds: 2
  });
  assert.equal(created.ok, true);
  assert.equal((await emit(admin, "admin:betting.open", { durationSeconds: 30 })).ok, true);
  const moneyline = created.result.markets[0];
  assert.equal((await emit(player, "bet:place", {
    marketId: moneyline.id,
    selectionId: moneyline.selections[0].id,
    stakeSeconds: 1
  })).ok, true);
  const cancelled = await emit(player, "bet:cancel", { marketId: moneyline.id });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.result.refundedSeconds, 1);
  assert.equal((await emit(player, "bet:place", {
    marketId: moneyline.id,
    selectionId: moneyline.selections[1].id,
    stakeSeconds: 15
  })).ok, true);
  assert.equal((await emit(admin, "admin:betting.lock")).ok, true);
  assert.equal((await emit(admin, "admin:match.start")).ok, true);
  const outcomes = Object.fromEntries(created.result.markets.map((market, index) => [market.id, index === 0 ? market.selections[0].id : "void"]));
  assert.equal((await emit(admin, "admin:match.resolve", { outcomes })).ok, true);
  assert.equal((await emit(player, "buyback:request")).ok, true);

  const adminStatePromise = nextSnapshot(admin, (snapshot) => snapshot.role === "admin" && snapshot.unpaidBar.some((entry) => entry.kind === "buyback"));
  admin.emit("state:request");
  const adminState = await adminStatePromise;
  const buybackEntry = adminState.unpaidBar.find((entry) => entry.kind === "buyback" && entry.playerId === imported.result[0].id);
  const creditedPromise = nextSnapshot(player, (snapshot) => snapshot.self?.walletSeconds === 5);
  assert.equal((await emit(admin, "admin:bar.serve", { entryIds: [buybackEntry.id] })).ok, true);
  const credited = await creditedPromise;
  assert.equal(credited.self.walletSeconds, 5);

  const resetPromise = nextSnapshot(player, (snapshot) => snapshot.self?.walletSeconds === 15 && snapshot.currentMatch === null);
  assert.equal((await emit(admin, "admin:event.reset")).ok, true);
  const resetState = await resetPromise;
  assert.equal(resetState.selfStats.betting.wins, 0);
  assert.equal(resetState.selfStats.matches.wins, 0);
});
