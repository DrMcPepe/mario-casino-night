import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express from "express";
import QRCode from "qrcode";
import { Server } from "socket.io";
import { advertisedUrl, config, localUrls } from "./config.js";
import { EventStore, initialState } from "./store.js";

function loadState() {
  if (!config.checkpoint || !fs.existsSync(config.stateFile)) return initialState();
  try {
    const state = JSON.parse(fs.readFileSync(config.stateFile, "utf8"));
    const arrays = ["players", "matches", "bets", "assignments", "buybacks", "barEntries", "walletTransactions"];
    if (!arrays.every((key) => Array.isArray(state[key]))) throw new Error("Invalid state shape");
    for (const player of state.players) player.connected = false;
    return state;
  } catch (error) {
    console.error(`Could not restore ${config.stateFile}: ${error.message}`);
    return initialState();
  }
}

function saveState(state) {
  if (!config.checkpoint) return;
  fs.mkdirSync(config.dataDir, { recursive: true });
  const temporary = `${config.stateFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
  fs.renameSync(temporary, config.stateFile);
}

const store = new EventStore(loadState());
const app = express();
const server = http.createServer(app);
const io = new Server(server, { serveClient: true, maxHttpBufferSize: 100_000 });
let bettingTimer = null;

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use(express.static(config.publicDir, { extensions: ["html"] }));

app.get("/tv", (_request, response) => response.sendFile(path.join(config.publicDir, "tv.html")));
app.get("/admin", (_request, response) => response.sendFile(path.join(config.publicDir, "admin.html")));
app.get("/rules", (_request, response) => response.sendFile(path.join(config.publicDir, "rules.html")));
app.get("/health", (_request, response) => response.json({ ok: true, revision: store.state.revision }));
app.get("/api/config", (_request, response) => response.json({
  publicUrl: advertisedUrl(),
  localUrls: localUrls(),
  rules: store.snapshot().rules
}));
app.get("/api/qr.svg", async (_request, response, next) => {
  try {
    const svg = await QRCode.toString(advertisedUrl(), { type: "svg", margin: 1, color: { dark: "#10110f", light: "#f3efe3" } });
    response.type("image/svg+xml").send(svg);
  } catch (error) {
    next(error);
  }
});

function emitSnapshot(socket) {
  socket.emit("state:snapshot", store.snapshot(socket.data.role || "guest", socket.data.playerId || null));
}

function broadcast() {
  for (const socket of io.sockets.sockets.values()) emitSnapshot(socket);
}

function scheduleBettingLock() {
  if (bettingTimer) clearTimeout(bettingTimer);
  const match = store.currentMatch();
  if (!match || match.status !== "betting_open") return;
  const delay = Math.max(0, Date.parse(match.bettingClosesAt) - Date.now());
  bettingTimer = setTimeout(() => store.lockBetting(), delay + 10);
}

store.on("change", (state) => {
  try {
    saveState(state);
  } catch (error) {
    console.error(`State checkpoint failed: ${error.message}`);
  }
  broadcast();
});

function respond(ack, payload) {
  if (typeof ack === "function") ack(payload);
}

function on(socket, eventName, handler, { admin = false, player = false } = {}) {
  socket.on(eventName, async (payload = {}, ack) => {
    try {
      if (admin && socket.data.role !== "admin") throw Object.assign(new Error("Admin login required."), { code: "UNAUTHORIZED" });
      if (player && (!socket.data.playerId || socket.data.role !== "player")) throw Object.assign(new Error("Select a player profile first."), { code: "UNAUTHORIZED" });
      if (player) store.validatePlayerSession(socket.data.playerId, socket.data.playerToken);
      const result = await handler(payload);
      respond(ack, { ok: true, result });
    } catch (error) {
      const details = { ok: false, error: error.message, code: error.code || "ERROR" };
      respond(ack, details);
      socket.emit("operation:error", details);
    }
  });
}

io.on("connection", (socket) => {
  socket.data.role = "guest";
  socket.data.failedAdminLogins = 0;
  socket.data.adminLockedUntil = 0;
  emitSnapshot(socket);

  on(socket, "viewer:join", ({ role }) => {
    socket.data.role = role === "tv" ? "tv" : "guest";
    emitSnapshot(socket);
  });

  on(socket, "session:claim", ({ playerId }) => {
    const result = store.claimPlayer(playerId);
    socket.data.role = "player";
    socket.data.playerId = result.player.id;
    socket.data.playerToken = result.token;
    emitSnapshot(socket);
    return result;
  });

  on(socket, "session:resume", ({ token }) => {
    const player = store.resumePlayer(String(token || ""));
    socket.data.role = "player";
    socket.data.playerId = player.id;
    socket.data.playerToken = String(token || "");
    emitSnapshot(socket);
    return { player };
  });

  on(socket, "session:release", () => {
    const playerId = socket.data.playerId;
    store.validatePlayerSession(playerId, socket.data.playerToken);
    store.releasePlayer(playerId);
    socket.data.role = "guest";
    socket.data.playerId = null;
    socket.data.playerToken = null;
    socket.emit("session:released");
    emitSnapshot(socket);
  }, { player: true });

  on(socket, "admin:login", ({ pin }) => {
    if (Date.now() < socket.data.adminLockedUntil) throw Object.assign(new Error("Too many attempts. Try again in 30 seconds."), { code: "UNAUTHORIZED" });
    if (String(pin || "") !== config.adminPin) {
      socket.data.failedAdminLogins += 1;
      if (socket.data.failedAdminLogins >= 5) {
        socket.data.adminLockedUntil = Date.now() + 30_000;
        socket.data.failedAdminLogins = 0;
      }
      throw Object.assign(new Error("Incorrect admin PIN."), { code: "UNAUTHORIZED" });
    }
    socket.data.failedAdminLogins = 0;
    socket.data.role = "admin";
    emitSnapshot(socket);
    return { authenticated: true };
  });

  on(socket, "bet:place", (payload) => store.placeBet(socket.data.playerId, payload), { player: true });
  on(socket, "bet:cancel", ({ marketId }) => store.cancelMarketBets(socket.data.playerId, marketId), { player: true });
  on(socket, "assignment:create", ({ targetPlayerId, amountSeconds }) => store.assignSeconds(socket.data.playerId, targetPlayerId, amountSeconds), { player: true });
  on(socket, "buyback:request", () => store.requestBuyback(socket.data.playerId), { player: true });

  on(socket, "admin:roster.import", ({ names, replace }) => {
    const result = store.importPlayers(names, { replace: Boolean(replace) });
    if (bettingTimer) clearTimeout(bettingTimer);
    for (const candidate of io.sockets.sockets.values()) {
      if (candidate.data.role !== "player") continue;
      candidate.data.role = "guest";
      candidate.data.playerId = null;
      candidate.data.playerToken = null;
      candidate.emit("session:released");
      emitSnapshot(candidate);
    }
    return result;
  }, { admin: true });
  on(socket, "admin:player.release", ({ playerId }) => {
    store.releasePlayer(playerId);
    for (const candidate of io.sockets.sockets.values()) {
      if (candidate.data.playerId !== playerId) continue;
      candidate.data.role = "guest";
      candidate.data.playerId = null;
      candidate.data.playerToken = null;
      candidate.emit("session:released");
      emitSnapshot(candidate);
    }
  }, { admin: true });
  on(socket, "admin:match.create", (payload) => store.createMatch(payload), { admin: true });
  on(socket, "admin:betting.open", ({ durationSeconds }) => {
    const match = store.openBetting(durationSeconds);
    scheduleBettingLock();
    return match;
  }, { admin: true });
  on(socket, "admin:betting.lock", () => store.lockBetting(), { admin: true });
  on(socket, "admin:match.start", () => store.startMatch(), { admin: true });
  on(socket, "admin:match.resolve", ({ outcomes }) => store.resolveMatch(outcomes), { admin: true });
  on(socket, "admin:match.void", () => store.voidMatch(), { admin: true });
  on(socket, "admin:bar.serve", ({ entryIds }) => store.serveBarEntries(entryIds), { admin: true });
  on(socket, "admin:bar.manual", (payload) => store.addManualBarEntry(payload), { admin: true });
  on(socket, "admin:event.reset", () => {
    if (bettingTimer) clearTimeout(bettingTimer);
    bettingTimer = null;
    return store.resetEvent();
  }, { admin: true });

  on(socket, "state:request", () => emitSnapshot(socket));

  socket.on("disconnect", () => {
    const playerId = socket.data.playerId;
    if (!playerId) return;
    setTimeout(() => {
      const stillConnected = [...io.sockets.sockets.values()].some((candidate) => candidate.data.playerId === playerId);
      if (!stillConnected) store.setConnected(playerId, false);
    }, 100);
  });
});

const restored = store.currentMatch();
if (restored?.status === "betting_open") {
  if (Date.now() >= Date.parse(restored.bettingClosesAt)) store.lockBetting();
  else scheduleBettingLock();
}

server.listen(config.port, "0.0.0.0", () => {
  console.log(`Mario Casino Night is running at ${advertisedUrl()}`);
  for (const url of localUrls()) console.log(`LAN option: ${url}`);
  console.log(`Admin: ${advertisedUrl()}/admin`);
  console.log(`TV: ${advertisedUrl()}/tv`);
  if (config.adminPin === "2468") console.warn("Warning: using default ADMIN_PIN 2468. Change it in .env before the event.");
});

export { app, io, server, store };
