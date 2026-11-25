// First Light — an original pump.fun paper-trading bot for agent-fun/replay/v2.
//
// Idea, from measuring the dev window (1222 coins, 544 reaching 5 SOL of real reserve):
// a coin's price typically spikes within ~60 slots of gathering real SOL and then fades
// (median ~0.91x of the 5-SOL-cross price after 600 slots, while ~9% run past 2x and the
// peak from the cross has a median of 1.62x). The 2-slot fill latency eats most of that
// spike (the fill lands ~14% above the decision price at the median), so filters that
// take time to confirm only buy the top — the measured edge sits at the 2-SOL cross
// itself, and only for coins that ALREADY show broad participation by then. So this bot
// buys a small stake (0.02 SOL) at the 2-SOL cross, only when the coin already has ≥11
// distinct buyers and ≥26 trades, a modest run-up from its create price, no dev sell,
// and no single large dump — then exits fast: a partial take-profit, a trailing stop
// once armed, a hard stop, and a short time cap. Losers are cut small; the rare runner
// is what pays. Guardrail probes (tiny distinct round trips, never repeated on a mint)
// keep the 20-mint bar safe on a quiet window.
//
// Deterministic by construction: no clock, no environment, no Math.random; iteration only
// over insertion-ordered maps fed by the batch stream. All money math is bigint lamports;
// only price ratios use floats, and those are pure functions of the batch data.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;
const CURVE_FEE_BPS = 125n; // protocol 95 + creator 30, from hello.fees

// ---- tunables (v1) ----
// Grouped in one object so a sweep can change one knob at a time.
const P = {
  stake: (SOL * 2n) / 100n, // 0.02 SOL per coin
  minBuy: (SOL * 12n) / 1000n, // 0.012 SOL: safely above the 0.01 SOL round-trip bar
  probeBuy: (SOL * 12n) / 1000n, // 0.012 SOL guardrail probe
  minRq: 2n * SOL, // enter at the 2-SOL cross (cap fits the 0.02 stake)
  maxRq: 80n * SOL,
  maxAge: 3600, // slots since CreateEvent (~24 min)
  minBuyers: 11, // broad participation already present at the cross
  minTrades: 26,
  minFlow60: SOL / 10n, // net inflow over the last 60 slots > 0.1 SOL
  minRunupNum: 102, // price/create price in [1.02, 1.35]
  maxRunupNum: 135,
  maxDevBuy: (SOL * 3n) / 2n, // 1.5 SOL
  maxSellShareNum: 25, // largest single non-dev sell <= 25% of real reserve
  buySlipBps: 1000, // refuse a buy that jumps >10% in the 2-slot latency: spikes reverse fast
  sellSlipBps: 10_000,
  tp1Num: 150, // partial take-profit at +50%: sell half
  trailArmNum: 108, // trailing stop arms at +8%
  trailNum: 85, // exit on a 15% fall from the peak value
  stopNum: 92, // hard stop at -8% of basis
  maxHold: 1200, // slots (~8 min); extended while up
  maxHoldUp: 3600,
  staleSlots: 1200,
  targetCoins: 30, // margin above the 20-mint bar
  targetFills: 40, // guardrail is distinct mints, not fills: probes add coins, not volume
  paceSecs: 21_600, // the 6h final window
  maxProbes: 3,
  flowWindow: 60,
  tapeKeep: 180, // slots of recent trades kept per coin
};
const {
  stake: STAKE, minBuy: MIN_BUY, probeBuy: PROBE_BUY, minRq: MIN_RQ, maxRq: MAX_RQ,
  maxAge: MAX_AGE, minBuyers: MIN_BUYERS, minTrades: MIN_TRADES, minFlow60: MIN_FLOW60,
  minRunupNum: MIN_RUNUP_NUM, maxRunupNum: MAX_RUNUP_NUM, maxDevBuy: MAX_DEV_BUY,
  maxSellShareNum: MAX_SELL_SHARE_NUM, buySlipBps: BUY_SLIP_BPS, sellSlipBps: SELL_SLIP_BPS,
  tp1Num: TP1_NUM, trailArmNum: TRAIL_ARM_NUM, trailNum: TRAIL_NUM, stopNum: STOP_NUM,
  maxHold: MAX_HOLD, maxHoldUp: MAX_HOLD_UP, staleSlots: STALE_SLOTS,
  targetCoins: TARGET_COINS, targetFills: TARGET_FILLS, paceSecs: PACE_SECS,
  maxProbes: MAX_PROBES, flowWindow: FLOW_WINDOW, tapeKeep: TAPE_KEEP,
} = P;

interface Tick {
  slot: number;
  buy: boolean;
  sol: bigint;
}

interface Tape {
  created: number; // slot of CreateEvent, -1 if first seen via a trade
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  devSold: boolean;
  buyers: Set<Pubkey>; // distinct non-dev buyers, capped at 16
  trades: number;
  maxSell: bigint; // largest single non-dev sell, lamports
  lastTradeSlot: number;
  lastIsBuy: boolean;
  recent: Tick[]; // trades of the last TAPE_KEEP slots
  entered: boolean; // bought once already
  done: boolean; // never consider again
}

interface Held {
  opened: number; // slot of the first buy fill
  peak: bigint; // best net value seen (lamports)
  txPaid: bigint; // tx fees paid on buy fills for this position
  tookTp: boolean;
  exiting: boolean;
}

/** What selling `tokens` against (vq, vt) pays after the 125 bps curve fee. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * CURVE_FEE_BPS + 9_999n) / 10_000n;
}

/** The position's realizable value: what selling it all would actually pay. The raw
 * curve quote can exceed the real SOL reserve (a rugged curve holds ~0 real SOL),
 * and the harness rejects a sell whose gross output exceeds that reserve — so a
 * position whose quote is bigger than the reserve is only worth the reserve. */
function realizableValue(tokens: bigint, vq: bigint, vt: bigint, rq: bigint, tx: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return -tx;
  const q = (tokens * vq) / (vt + tokens);
  const eff = q > rq ? rq : q;
  return eff - (eff * CURVE_FEE_BPS + 9_999n) / 10_000n - tx;
}

/** Mints whose position is dust: selling it cannot cover its own tx fee, so the
 * bot stops trying (the replay writes it off at the end). Kept out of the exit
 * loop so one rugged coin cannot spam a sell on every batch for the rest of the run. */
const abandoned = new Set<Pubkey>();

/**
 * Tokens to sell so the gross SOL output stays under 90% of the real quote reserve.
 * The harness rejects a sell whose gross output exceeds the real reserve
 * (max_order_size), and a rejected sell leaves the position stuck: the bot would
 * re-send the same full-size sell every batch while the coin bleeds. Capping the
 * size up front keeps exits executable even after the reserve shrinks.
 */
function cappedSellTokens(tokens: bigint, vq: bigint, vt: bigint, rq: bigint): bigint {
  if (tokens <= 0n || vq <= 0n || vt <= 0n || rq <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  const target = (rq * 90n) / 100n;
  if (q <= target) return tokens;
  if (vq <= target) return tokens;
  const capped = (target * vt) / (vq - target);
  return capped > 0n ? capped : 0n;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
const probes = new Set<Pubkey>(); // probe mints: buy once, sell as soon as the buy lands
const probed = new Set<Pubkey>(); // every mint ever probed: probes never repeat on a mint
let myFills = 0;
const myCoins = new Set<Pubkey>();
let firstTime: number | null = null;
let lastTime: number | null = null;
let sweepAt = 0;

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = {
      created: -1, creator: '', vq0: 0n, vt0: 1n, devBuy: 0n, devSold: false,
      buyers: new Set(), trades: 0, maxSell: 0n, lastTradeSlot: -1,
      lastIsBuy: false, recent: [], entered: false, done: false,
    };
    tapes.set(mint, t);
  }
  return t;
}

/** Net SOL (buys minus sells) over the last `w` slots, pruning older ticks. */
function netFlow(t: Tape, now: number, w: number): bigint {
  let drop = 0;
  while (drop < t.recent.length && t.recent[drop]!.slot <= now - TAPE_KEEP) drop++;
  if (drop > 0) t.recent.splice(0, drop);
  let net = 0n;
  for (let i = t.recent.length - 1; i >= 0; i--) {
    const tk = t.recent[i]!;
    if (tk.slot <= now - w) break;
    net += tk.buy ? tk.sol : -tk.sol;
  }
  return net;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();
    const orders: OrderInput[] = [];
    const traded = new Set<Pubkey>();

    // Fills: count our own, track buy tx fees per position, note probe buys landing.
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        // Harness close (complete / flatten / writeoff): position is gone.
        held.delete(f.mint);
        probes.delete(f.mint);
        continue;
      }
      if (f.status === 'filled') {
        myFills++;
        myCoins.add(f.mint);
        if (f.side === 'buy') {
          const tb = tapes.get(f.mint);
          if (tb !== undefined) tb.entered = true; // only a filled buy claims the coin: a rejected buy may be retried
          let h = held.get(f.mint);
          if (h === undefined) {
            h = { opened: f.slot, peak: 0n, txPaid: 0n, tookTp: false, exiting: false };
            held.set(f.mint, h);
          }
          h.txPaid += BigInt(f.tx_fee_lamports);
        }
      }
    }

    // Events: fold the batch's trades into the tapes.
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        const t = tapeOf(e.mint);
        t.created = e.slot;
        t.creator = e.creator;
        t.vq0 = BigInt(e.virtual_quote_reserves);
        t.vt0 = BigInt(e.virtual_token_reserves);
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        const sol = BigInt(e.sol_amount);
        t.trades++;
        t.lastTradeSlot = e.slot;
        t.lastIsBuy = e.is_buy;
        t.recent.push({ slot: e.slot, buy: e.is_buy, sol });
        const isDev = e.user === t.creator;
        if (e.is_buy) {
          if (isDev) t.devBuy += sol;
          else if (t.buyers.size < 16) t.buyers.add(e.user);
        } else if (isDev) {
          t.devSold = true;
        } else if (sol > t.maxSell) {
          t.maxSell = sol;
        }
        traded.add(e.mint);
      } else {
        // CompleteEvent: the curve is over.
        const t = tapes.get(e.mint);
        if (t !== undefined) t.done = true;
      }
    }

    const pendingSell = new Set<Pubkey>();
    const pendingBuy = new Set<Pubkey>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSell.add(p.order.mint);
      else pendingBuy.add(p.order.mint);
    }
    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    const reserves = (mint: Pubkey): { vq: bigint; vt: bigint; rq: bigint } | null => {
      const mk = marks.get(mint);
      if (mk !== undefined) return { vq: BigInt(mk.virtual_quote_reserves), vt: BigInt(mk.virtual_token_reserves), rq: BigInt(mk.real_quote_reserves) };
      const cv = state.curves.get(mint);
      if (cv === undefined) return null;
      return { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves, rq: cv.real_quote_reserves };
    };
    // Mints an order was already sent for on this batch (entries below, probes later):
    // pending only covers earlier batches, so this stops a probe double-buying an entry.
    const boughtThisBatch = new Set<Pubkey>();

    // ---- exits first ----
    for (const [mint, pos] of state.positions) {
      if (orders.length >= cap) break;
      if (pendingSell.has(mint) || abandoned.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      let h = held.get(mint);
      if (h === undefined) {
        h = { opened: now, peak: 0n, txPaid: tx, tookTp: false, exiting: false };
        held.set(mint, h);
      }
      if (probes.has(mint)) {
        // Probe: sell the whole thing as soon as the buy has landed.
        const r0 = reserves(mint);
        const amt0 = r0 === null ? pos.token_amount : cappedSellTokens(pos.token_amount, r0.vq, r0.vt, r0.rq);
        if (amt0 > 0n && r0 !== null && sellValue(amt0, r0.vq, r0.vt) > tx) {
          orders.push({ side: 'sell', mint, token_amount: amt0, max_slippage_bps: SELL_SLIP_BPS });
        } else if (r0 !== null && realizableValue(pos.token_amount, r0.vq, r0.vt, r0.rq, tx) <= 0n) {
          abandoned.add(mint);
          probes.delete(mint);
        }
        continue;
      }
      const r = reserves(mint);
      if (r === null) continue;
      // Dust check first: if the position cannot be sold for more than its tx fee,
      // abandon it instead of spamming sells the harness rejects as zero_amount.
      if (realizableValue(pos.token_amount, r.vq, r.vt, r.rq, tx) <= 0n) {
        abandoned.add(mint);
        continue;
      }
      const value = sellValue(pos.token_amount, r.vq, r.vt) - tx;
      const basis = pos.cost_lamports + h.txPaid;
      if (basis <= 0n) continue;
      if (value > h.peak) h.peak = value;
      const t = tapes.get(mint);
      let exit = false;
      let partial = false;
      // Partial take-profit: sell half at +35%, then let the rest ride the trail.
      if (!h.tookTp && value * 100n >= basis * BigInt(TP1_NUM)) partial = true;
      else if (h.peak * 100n >= basis * BigInt(TRAIL_ARM_NUM) && value * 100n <= h.peak * BigInt(TRAIL_NUM)) exit = true;
      else if (value * 100n <= basis * BigInt(STOP_NUM)) exit = true;
      else if (now - h.opened > (value * 100n >= basis * BigInt(TRAIL_ARM_NUM) ? MAX_HOLD_UP : MAX_HOLD)) exit = true;
      else if (t !== undefined && t.devSold) exit = true;
      else if (t !== undefined && now - t.lastTradeSlot > STALE_SLOTS) exit = true;
      if (!partial && !exit) continue;
      if (partial) {
        const half = cappedSellTokens(pos.token_amount / 2n, r.vq, r.vt, r.rq);
        if (half <= 0n) continue;
        orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: SELL_SLIP_BPS });
        h.tookTp = true;
        h.peak = 0n; // re-arm the trail on the remaining half
      } else {
        const amt = cappedSellTokens(pos.token_amount, r.vq, r.vt, r.rq);
        if (amt <= 0n) continue;
        orders.push({ side: 'sell', mint, token_amount: amt, max_slippage_bps: SELL_SLIP_BPS });
        h.exiting = true;
      }
    }

    // Drop held records whose position is gone and nothing is pending.
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint) && !pendingBuy.has(mint) && !pendingSell.has(mint)) {
        held.delete(mint);
        const t = tapes.get(mint);
        if (t !== undefined) t.done = true;
      }
    }
    for (const mint of [...probes]) {
      if (!state.positions.has(mint) && !pendingBuy.has(mint)) probes.delete(mint);
    }

    // ---- entries: coins that traded on this batch ----
    let free = state.freeCashLamports() - tx * BigInt(orders.length);
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const mint of traded) {
      if (orders.length >= cap || slotsLeft <= 0) break;
      if (pendingBuy.has(mint) || pendingSell.has(mint) || state.positions.has(mint)) continue;
      if (probes.has(mint)) continue;
      const t = tapes.get(mint);
      const curve = state.curves.get(mint);
      if (t === undefined || curve === undefined || curve.complete || t.done || t.entered) continue;
      if (t.created < 0 || now - t.created > MAX_AGE) continue;
      const rq = curve.real_quote_reserves;
      if (rq < MIN_RQ || rq > MAX_RQ) continue;
      if (t.buyers.size < MIN_BUYERS || t.trades < MIN_TRADES) continue;
      if (!t.lastIsBuy) continue;
      if (t.devSold || t.devBuy > MAX_DEV_BUY) continue;
      if (t.maxSell * 100n > rq * BigInt(MAX_SELL_SHARE_NUM)) continue;
      if (netFlow(t, now, FLOW_WINDOW) <= MIN_FLOW60) continue;
      // Price run-up from create, in [1.02, 1.35].
      if (t.vq0 <= 0n || t.vt0 <= 0n) continue;
      const runup = (Number(curve.virtual_quote_reserves) * Number(t.vt0)) / (Number(curve.virtual_token_reserves) * Number(t.vq0));
      if (!(runup >= MIN_RUNUP_NUM / 100 && runup <= MAX_RUNUP_NUM / 100)) continue;
      let amount = state.maxBuyLamports(mint);
      if (amount > STAKE) amount = STAKE;
      if (amount < MIN_BUY || free < amount + tx) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIP_BPS });
      boughtThisBatch.add(mint);
      free -= amount + tx;
      slotsLeft--;
    }

    // ---- guardrail pacing: tiny probe round trips when fills/coins lag ----
    if (probes.size < MAX_PROBES && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
      const pace = Math.min(1, (lastTime - firstTime) / PACE_SECS);
      const needCoins = myCoins.size < Math.ceil(TARGET_COINS * pace);
      const needFills = myFills < Math.ceil(TARGET_FILLS * pace);
      if (needCoins || needFills) {
        for (const mint of traded) {
          if (orders.length >= cap || probes.size >= MAX_PROBES) break;
          if (held.has(mint) || probes.has(mint) || probed.has(mint) || pendingBuy.has(mint) || boughtThisBatch.has(mint) || state.positions.has(mint)) continue;
          if (needCoins && !needFills && myCoins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (curve.real_quote_reserves < 2n * SOL) continue;
          if (free < PROBE_BUY + 2n * tx) break;
          orders.push({ side: 'buy', mint, quote_lamports: PROBE_BUY, max_slippage_bps: SELL_SLIP_BPS });
          probes.add(mint);
          probed.add(mint);
          free -= PROBE_BUY + tx;
          slotsLeft--;
        }
      }
    }

    // ---- periodic tape sweep: drop old coins we no longer hold ----
    if (++sweepAt >= 1000) {
      sweepAt = 0;
      for (const [mint, t] of tapes) {
        if (!held.has(mint) && t.created >= 0 && now - t.created > 6000) tapes.delete(mint);
      }
    }
    return orders;
  },
});
