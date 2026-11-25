// Steady Clipper — Pump.fun Sharpe Sprint (Cleanest Paper Bot Wins).
//
// Paper trading only: runs inside the make.fun pumpfun-replay/v2 harness on
// historical pump.fun events. It never touches real funds, mainnet, or any
// wallet. Capital is the harness's 10 paper SOL.
//
// Why this shape scores on HOURLY SHARPE, not raw PnL: the ranking rewards
// steady, low-variance hourly returns, so one moonshot held to the end of the
// window is worth less than many small, capped, diversified round trips.
// Every position is the same small size (0.025 SOL), every exit is decided
// up front (+12% take-profit, -7% stop, 250-slot timeout, whichever comes
// first), and no position is ever pyramided — a single coin can never
// dominate the equity curve. Entries only go to fresh coins whose recent
// tape is mostly buys with a modest (not vertical) rise, so the bot rides
// early momentum instead of chasing explosions or catching falling knives.
//
// Speed: the candidate list is maintained incrementally (remove + binary
// insert per tape that moved, freshest first) and the entry scan is skipped
// entirely when no order is possible (5/5 positions, or nothing left to
// buy). No per-batch re-sort of the whole tape list — that pattern timed
// out on this dataset in earlier entries.
//
// Deterministic by construction: every decision is a pure function of the
// batch stream (slots, reserves, trades). No clock, no environment, no
// randomness, so the two grading runs produce byte-identical action logs.
// Diagnostics, if any, go to stderr; stdout carries only the harness reply
// (the SDK shim handles that).

import type { Batch, BotState, BuyInput, OrderInput, SellInput } from './vendor/makefun-bot.ts';

// ---- tunables (all in SOL / slots / basis points of price) -----------------
const STAKE_SOL = 0.025; // uniform size for every coin: diversification
const TAKE_PROFIT = 0.12; // sell at +12% vs entry price
const STOP_LOSS = -0.07; // sell at -7% vs entry price
const MAX_HOLD_SLOTS = 250; // sell after this many slots whatever the price
const MIN_TRADES = 6; // need at least this many trades before judging a tape
const TAPE_WINDOW = 6; // last N trades examined for the entry signal
const MIN_BUYS_IN_WINDOW = 4; // of the last 6 trades, at least 4 buys
const MIN_RISE = 0.01; // price rise over the window: at least +1% ...
const MAX_RISE = 0.12; // ... and at most +12% (do not chase vertical moves)
const MIN_REAL_SOL = 1.0; // real SOL reserves at decision time
const MAX_AGE_SLOTS = 5000; // only fresh coins (created within this many slots)
const COOLDOWN_SLOTS = 300; // wait this long after an exit before re-entry
const MAX_REJECTS = 2; // give up on a mint after this many rejected buys
const BUY_SLIPPAGE_BPS = 1000;
const SELL_SLIPPAGE_BPS = 10000;
const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Price of one token in SOL, from virtual reserves (0 when unusable). */
export function priceOf(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken <= 0n || virtualQuote <= 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

interface Tape {
  mint: string;
  seq: number; // first-seen order (tie-break, ascending)
  createdSlot: number | null;
  lastSlot: number;
  trades: number;
  // Ring of the last TAPE_WINDOW trades, oldest first.
  windowBuys: boolean[];
  windowSol: number[]; // signed SOL per trade (+buy / -sell)
  windowPrices: number[]; // price after each of those trades
  entered: boolean; // we already bought this mint once
  exitedSlot: number; // slot of our exit, 0 if never held
  rejects: number;
  complete: boolean;
}

interface OpenTrade {
  mint: string;
  entrySlot: number;
  entryPrice: number; // SOL per token, from cost / tokens at first sight
  priced: boolean; // entryPrice known yet (set once the fill lands)
}

export class SteadyClipper {
  #tapes = new Map<string, Tape>();
  #ranked: string[] = []; // mints, freshest trade first (lastSlot desc, seq asc)
  #nextSeq = 0;
  #open = new Map<string, OpenTrade>();
  #decidedSlot = -1;

  decide(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    this.#decidedSlot = batch.slot;

    // 1. Fold this batch's events into the tapes, keeping #ranked ordered.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const t = this.#tape(e.mint, e.slot);
        t.createdSlot = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = this.#tape(e.mint, e.slot);
        const price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        const sol = Number(BigInt(e.sol_amount)) / 1e9;
        t.windowBuys.push(e.is_buy);
        t.windowSol.push(e.is_buy ? sol : -sol);
        t.windowPrices.push(price);
        if (t.windowBuys.length > TAPE_WINDOW) {
          t.windowBuys.shift();
          t.windowSol.shift();
          t.windowPrices.shift();
        }
        t.trades += 1;
        t.lastSlot = e.slot;
        this.#reinsert(e.mint);
      } else {
        const t = this.#tapes.get(e.mint);
        if (t) t.complete = true;
      }
    }

    // 2. Learn entry prices / exits from fills, and drop finished positions.
    for (const f of batch.fills) {
      const o = this.#open.get(f.mint);
      if (!o) continue;
      if (f.side === 'buy' && f.status === 'filled') {
        const pos = state.positions.get(f.mint);
        if (pos && BigInt(pos.token_amount) > 0n) {
          o.entryPrice = Number(BigInt(pos.cost_lamports)) / Number(BigInt(pos.token_amount));
          o.priced = true;
        }
      }
      if (f.side === 'buy' && f.status === 'rejected') {
        const t = this.#tapes.get(f.mint);
        if (t) {
          t.rejects += 1;
          if (t.rejects >= MAX_REJECTS) this.#open.delete(f.mint);
        }
      }
    }
    for (const [mint, o] of this.#open) {
      if (!state.positions.has(mint) && !this.#hasPendingBuy(state, mint)) {
        // Position gone (sold, completed, or flattened by the harness).
        const t = this.#tapes.get(mint);
        if (t) t.exitedSlot = o.priced ? this.#decidedSlot : t.exitedSlot;
        this.#open.delete(mint);
      }
    }
    // Positions the harness closed for us (complete/flatten) also end the trade.
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_') && f.side === 'sell') {
        const t = this.#tapes.get(f.mint);
        if (t) t.exitedSlot = this.#decidedSlot;
        this.#open.delete(f.mint);
      }
    }

    // 3. Exits first: every open, priced position is checked against the
    // take-profit, the stop, and the hold timeout. Sells are full-position.
    for (const [mint, o] of this.#open) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (!pos || !curve || !o.priced) continue;
      const now = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (now <= 0 || o.entryPrice <= 0) continue;
      const ret = now / o.entryPrice - 1;
      const aged = this.#decidedSlot - o.entrySlot >= MAX_HOLD_SLOTS;
      if (ret >= TAKE_PROFIT || ret <= STOP_LOSS || aged) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: BigInt(pos.token_amount),
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        } satisfies SellInput);
      }
    }

    // 4. Entries: only when a slot is actually free. Walk the freshest
    // tapes first and stop as soon as the free slots are spoken for.
    const freeSlots = state.hello.caps.max_open_positions - state.committedPositionCount();
    if (freeSlots > 0 && orders.length < state.hello.caps.max_orders_per_batch) {
      const tx = state.txFeeLamports();
      let free = state.freeCashLamports();
      // Sells above free the cash only after they fill, so do not count them.
      let slotsLeft = freeSlots;
      const stake = BigInt(Math.round(STAKE_SOL * 1e9));
      for (const mint of this.#ranked) {
        if (slotsLeft <= 0 || orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (!this.#entryOk(state, mint)) continue;
        const cap = state.maxBuyLamports(mint);
        if (cap < 10_000_000n) continue; // round trip must be >= 0.01 SOL
        const amount = cap < stake ? cap : stake;
        if (free < amount + tx) continue;
        const t = this.#tapes.get(mint)!;
        t.entered = true;
        this.#open.set(mint, { mint, entrySlot: this.#decidedSlot, entryPrice: 0, priced: false });
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS } satisfies BuyInput);
        free -= amount + tx;
        slotsLeft -= 1;
      }
    }
    return orders;
  }

  #hasPendingBuy(state: BotState, mint: string): boolean {
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy' && p.order.mint === mint) return true;
    }
    return false;
  }

  #entryOk(state: BotState, mint: string): boolean {
    const t = this.#tapes.get(mint);
    if (!t || t.complete || t.entered) return false;
    if (t.rejects >= MAX_REJECTS) return false;
    if (t.trades < MIN_TRADES || t.windowBuys.length < TAPE_WINDOW) return false;
    if (t.createdSlot !== null && this.#decidedSlot - t.createdSlot > MAX_AGE_SLOTS) return false;
    if (t.exitedSlot > 0 && this.#decidedSlot - t.exitedSlot < COOLDOWN_SLOTS) return false;
    if (this.#open.has(mint) || state.positions.has(mint)) return false;
    let buys = 0;
    let netSol = 0;
    for (let i = 0; i < TAPE_WINDOW; i++) {
      if (t.windowBuys[i]) buys += 1;
      netSol += t.windowSol[i];
    }
    if (buys < MIN_BUYS_IN_WINDOW || netSol <= 0) return false;
    const first = t.windowPrices[0];
    const last = t.windowPrices[TAPE_WINDOW - 1];
    if (first <= 0 || last <= 0) return false;
    const rise = last / first - 1;
    if (rise < MIN_RISE || rise > MAX_RISE) return false;
    const curve = state.curves.get(mint);
    if (!curve || curve.complete) return false;
    if (curve.real_quote_reserves < BigInt(Math.round(MIN_REAL_SOL * 1e9))) return false;
    return true;
  }

  #tape(mint: string, slot: number): Tape {
    let t = this.#tapes.get(mint);
    if (!t) {
      t = {
        mint,
        seq: this.#nextSeq++,
        createdSlot: null,
        lastSlot: slot,
        trades: 0,
        windowBuys: [],
        windowSol: [],
        windowPrices: [],
        entered: false,
        exitedSlot: 0,
        rejects: 0,
        complete: false,
      };
      this.#tapes.set(mint, t);
      this.#insertRanked(mint);
    }
    return t;
  }

  // Ranked list, freshest trade first; ties break by first-seen order.
  // compare(a, b) < 0 means a sorts before b.
  #compare(a: string, b: string): number {
    const ta = this.#tapes.get(a)!;
    const tb = this.#tapes.get(b)!;
    if (ta.lastSlot !== tb.lastSlot) return tb.lastSlot - ta.lastSlot;
    return ta.seq - tb.seq;
  }

  #insertRanked(mint: string): void {
    let lo = 0;
    let hi = this.#ranked.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.#compare(mint, this.#ranked[mid]) < 0) hi = mid;
      else lo = mid + 1;
    }
    this.#ranked.splice(lo, 0, mint);
  }

  #reinsert(mint: string): void {
    const at = this.#ranked.indexOf(mint);
    if (at === -1) {
      this.#insertRanked(mint);
      return;
    }
    this.#ranked.splice(at, 1);
    this.#insertRanked(mint);
  }
}
