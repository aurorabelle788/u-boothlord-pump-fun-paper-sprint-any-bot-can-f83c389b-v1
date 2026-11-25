# First Light — Pump.fun Paper Sprint

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/aurorabelle788/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-v1/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/aurorabelle788/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-v1/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Entry for [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) — a paper-trading bot for the `agent-fun/replay/v2` harness (Node 22, stdlib only, fully deterministic).

## Strategy

Measured on the dev window (1,222 coins, 544 reaching 5 SOL of real reserve): a coin's
price typically spikes within ~60 slots of gathering real SOL and then fades (median
~0.91x of the 5-SOL-cross price after 600 slots), while a few run past 2x and the peak
from the cross has a median of 1.62x. But the 2-slot fill latency eats most of that
spike (the fill lands ~14% above the decision price at the median), so filters that
take time to confirm only buy the top — the measured edge sits at the 2-SOL cross
itself, and only for coins that ALREADY show broad participation by then:

- **Entry** (0.02 SOL): at the 2-SOL real-reserve cross, only when the coin already has
  ≥11 distinct buyers and ≥26 trades, price 1.02–1.35x its create price, creator hasn't
  sold, creator buys ≤ 1.5 SOL, no single non-creator sell above 25% of the real
  reserve, last trade a buy, and net inflow > 0.1 SOL over the last 60 slots.
- **Exits**: sell half at +50%; trailing stop (15% off the peak, armed at +8%);
  hard stop at −8%; time cap ~8 min (extended while up); exit on creator sell or
  1,200 slots with no trade. The replay closes completed curves itself. Sells are
  capped so their gross output stays under 90% of the real reserve (a rugged curve
  rejects full-size sells); a position that cannot be sold for more than its tx fee
  is abandoned instead of spamming zero-amount sells.
- **Guardrail pacing**: tiny 0.012 SOL probe round trips, never repeated on a mint,
  if filled-order / distinct-coin counts lag a linear pace toward 30 coins / 40 fills
  over the 6 h window, so the 20-mint × 0.01 SOL round-trip bar is met even on a
  quiet window.

No clock, no environment, no randomness — a pure function of the batches the harness
sends, so the two graded executions produce byte-identical action logs.

## Layout

- `main.ts` — the strategy (run by the grader as `node /bot/main.ts`).
- `vendor/makefun-bot.ts` — byte-identical copy of the kit's `sdk/ts/makefun-bot.ts` shim.
- `.makefun/owner.json` — entry owner wallet.

## Grade locally

```sh
node cli/makefun.mjs grade-local --kit . --bot /path/to/this/dir --driver process --stress 20
```
