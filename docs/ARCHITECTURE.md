# Architecture

## Runtime

Express serves four static interfaces. Socket.IO carries every state mutation and update. `EventStore` is the only component allowed to mutate event state, making the Node server authoritative for deadlines, balances, payouts, assignment eligibility, and bar entries.

The canonical runtime state is in memory. An optional JSON checkpoint supports restart recovery without introducing a database.

## Wallet Model

Every player has `baseSeconds` and `profitSeconds`. The displayed wallet is their sum and cannot exceed 60.

Base credits come from the starting 15 seconds, returned base stakes, and confirmed buy-backs. Profit credits come from betting profit and returned stakes originally funded by profit. Only `profitSeconds` can be assigned.

Bets consume base before profit. Settlement credits returned base, returned profit stake, and new profit in that order. Anything above the wallet cap is discarded.

While a match remains `betting_open`, a player can cancel all pending stakes in one market. The server returns each stake to its original base or profit bucket and removes it from the pot. Cancellation is rejected after the deadline or lock.

## Drinking Debt

A losing stake creates a `bet_loss` bar entry with the same number of seconds. These self-incurred entries are uncapped.

An assignment deducts source profit, increments the recipient's lifetime `receivedAssignedSeconds`, and creates an `assignment` bar entry. The server rejects any assignment that would put a recipient above 20 seconds. Serving the entry does not lower `receivedAssignedSeconds`.

Buy-backs create a pending one-shot entry. The 5-second base credit is awarded only when the host marks that entry served.

Raw bar entries remain immutable for audit purposes. Snapshots additionally group pending entries by player, source, and match so clients can show one readable obligation while sending all underlying entry IDs when the host serves it.

## Statistics

Betting records count settled winning and losing markets. Bet net is actual credited profit minus lost stake seconds, so wallet-cap clipping is reflected correctly.

Wii Sports records use the resolved moneyline outcome to count match wins and losses overall and by Tennis, Bowling, Boxing, and Golf. Voided moneylines do not affect records.

## Match State

```text
draft -> betting_open -> betting_locked -> live -> resolved
   \----------- any pre-resolution state ----------> void
```

Markets and odds are frozen by the domain API after the match leaves `draft`. The server stores an odds snapshot on each bet. Resolution is accepted only once.

## Socket Trust

Player phones store an opaque profile token in local storage. Admin access requires the configured PIN. Neither mechanism is intended for an untrusted public network; the event should run only on a private home LAN.

All client payloads are revalidated by `EventStore`. UI-disabled buttons are convenience, not security boundaries.

## Important Events

| Event | Direction | Purpose |
|---|---|---|
| `session:claim` | player to server | Claim an open profile |
| `session:resume` | player to server | Reconnect with saved token |
| `bet:place` | player to server | Submit a validated wager |
| `bet:cancel` | player to server | Undo one market's pending stakes before lock |
| `assignment:create` | player to server | Spend profit against an eligible target |
| `buyback:request` | player to server | Request a pending buy-back shot |
| `admin:roster.import` | admin to server | Validate and set exactly 13 users |
| `admin:match.create` | admin to server | Create preset markets |
| `admin:betting.open` | admin to server | Start the authoritative timer |
| `admin:match.resolve` | admin to server | Settle every market atomically |
| `admin:bar.serve` | admin to server | Mark entries served and credit buy-backs |
| `admin:event.reset` | admin to server | Clear event activity while preserving roster and claims |
| `state:snapshot` | server to client | Role-filtered current state |

Each request uses a Socket.IO acknowledgement containing `{ ok, result }` or `{ ok, error, code }`.
