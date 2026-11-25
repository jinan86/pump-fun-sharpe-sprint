// Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins.
//
// Paper trading only: this bot runs inside the make.fun replay harness on
// historical pump.fun events. It never touches real funds, mainnet, or any
// wallet. Capital is the harness's 10 paper SOL.
//
// Strategy (see strategy.ts for the full logic): the ranking is by hourly
// Sharpe ratio, so the bot optimises for steady, low-variance returns.
// Two sleeves share the 5 position slots: CORE (max 3, 0.06 SOL) buys early
// on a buy-dominated tape, holds to the end of the window, cuts at -12%
// and trails winners from +30% — a few runners pay for the many small
// losers. FILLER (0.02 SOL) runs small capped round trips (+15% take-profit,
// -5% stop, 180-slot timeout) that smooth the equity curve and carry the
// run far past the 20-distinct-mint guardrail. No pyramiding: a single coin
// can never dominate the equity curve. The
// guardrails are met by construction: at most 5 open positions (the harness
// cap, checked before every entry), every round trip is at least 0.025 SOL
// (above the 0.01 SOL minimum), and the bot keeps entering fresh coins all
// window, far past the 20-distinct-mint minimum.
//
// Deterministic by construction: every decision is a pure function of the
// batch stream (slots, reserves, trades). No clock, no environment, no
// randomness, so the two grading runs produce byte-identical action logs.
// Diagnostics, if any, go to stderr; stdout carries only the harness reply
// (the SDK shim handles that).

import { runBot } from './vendor/makefun-bot.ts';
import { SteadyClipper } from './strategy.ts';

const engine = new SteadyClipper();

await runBot({
  onBatch(state, batch) {
    return engine.decide(state, batch);
  },
});
