# Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/jinan86/pump-fun-sharpe-sprint/rank.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/jinan86/pump-fun-sharpe-sprint/reward.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/competitions/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) competition on make.fun. It trades 10 SOL of paper money on a 6-hour replay of pump.fun bonding-curve activity, ranked by **hourly Sharpe ratio** — steady, controlled gains beat one lucky moonshot. Paper money only — it never touches real funds, mainnet, or any wallet.

## Strategy

One sleeve, uniform size (see `strategy.ts` for the full logic):

- **Entries:** fresh coins only (created within 5,000 slots), whose last 6 trades are at least 4 buys with net positive SOL flow and a modest price rise (+1% to +12% — momentum, not a vertical chase), with at least 1 SOL of real reserves. One entry per mint, 0.025 SOL each, at most 5 open positions.
- **Exits (decided before entry):** take-profit +12%, stop-loss −7%, or a 250-slot timeout, whichever comes first — full position, no pyramiding, no holding to the end of the window. A single coin can never dominate the equity curve.
- **Speed:** an incrementally maintained candidate list (freshest trade first) plus a skipped entry scan when no slot is free — no per-batch re-sort of the whole tape list.
- **Determinism:** every decision is a pure function of the batch stream (slots, reserves, trades). No clock, no environment, no randomness.

## Layout

- `main.ts` — entrypoint (Node 22, no build step): wires the strategy into the harness shim.
- `strategy.ts` — the steady-clipper strategy.
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` bot shim, copied unchanged from the competition kit.

## Run locally

```sh
node main.ts   # the harness speaks agent-fun/replay/v2 on stdin/stdout
```

Grade it with the kit's local grader (from the unpacked kit directory):

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```

## License

MIT — see [LICENSE](LICENSE).
