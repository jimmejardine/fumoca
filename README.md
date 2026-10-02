# fumoca

**fumoca** (short for **Fu**ll **Mo**nte **Ca**rlo) is a web app that lets casual users run Monte Carlo simulations. You don't need statistics training or programming skills.

If you can use a spreadsheet, you can use fumoca. You build a model in a familiar grid of cells and formulas. Where a number is uncertain, you enter a range or distribution instead of a single value. fumoca then runs the model thousands of times and shows you the likely outcomes, not just one guess.

## Key ideas

- **Spreadsheet-style interface.** A grid of cells with Excel-like formulas and cell references. It should feel as easy to use as Excel.
- **Cells work like Excel's.** A cell can hold a value (a number, text or a date) or a formula.
- **Cells can also hold distributions.** Any cell can hold a probability distribution, such as normal, uniform or lognormal, in place of a fixed value. This is what makes fumoca different from a normal spreadsheet.
- **Always simulating.** There is no "run" button. The engine keeps sampling every distribution cell and pushing the samples through all the formulas. Every dependent cell builds up its own simulated distribution, and the results update live as you edit.
- **Multiple worksheets.** A model can have several worksheets, and formulas can refer to cells on other worksheets.
- **Scenario mode.** Pick input cells and output cells across worksheets, and give each input a list of alternative values. fumoca runs every combination and shows the output distributions side by side. For example, with `Cell1 = [1, 2]` and `Cell2 = [1, 2, 3]` it runs 6 combinations. The main grid is simply the **Baseline** scenario, the one with no overrides.
- **Sensitivity analysis.** A special kind of scenario that answers questions like "how sensitive are revenue and profit to a 10% change in price?" Results come as tornado charts, spider charts and elasticities.
- **Time-series worksheets.** Some worksheets have a built-in time dimension. Use them for data indexed by date or period, such as historical sales, historical and projected unit costs, stock prices, or assumed future interest rates. Other worksheets can look values up by date.
- **Distributions you can see at a glance.** An uncertain cell shows its mean ± 1 standard deviation, with a faint live histogram of its distribution behind the number. Select the cell for full statistics: percentiles, an S-curve, and the chance of a value being above or below a threshold.

## Example uses

- Forecasting revenue when sales volumes and prices are uncertain
- Estimating project cost and schedule risk
- Modelling how an investment might grow under a range of market returns
- Checking a budget against price changes forecast in a time-series worksheet

## Reference model: Tesla 2029

The **Tesla model** button loads a full valuation of Tesla in 2029, built from [ARK Invest's Tesla valuation model](https://github.com/ARKInvest/ARK-Invest-Tesla-Valuation-Model) ("Tesla 2029 Valuation Extract"). It shows what fumoca is for. ARK's Excel workbook needs about 45 hand-built `NORM.INV(RAND())` input formulas, three copies of the model and a 5,000-row data table to run its Monte Carlo. In fumoca it is one model whose inputs are named distributions, simulated continuously, with a scenario and a sensitivity analysis of the key drivers. Tesla's reported history sits in a yearly time-series sheet that the model looks up, and the robotaxi launch is a month, not a fractional year.

- **Same logic as ARK's:** fed the draws from ARK's saved run, the model computes every one of that run's 1,127 values (a 2029 share price of $2,309.46). Its own Monte Carlo matches ARK's results: a mean near $2,600, with quartiles near $2,020 and $3,150.
- **Credit:** the model's logic, inputs and notes are ARK Investment Management LLC's. `scripts/ark-tesla/generate.py` restructures ARK's workbook for fumoca. This is not investment advice.

## Tech stack

- **TypeScript throughout.** The formula engine, simulation engine and UI are all written in TypeScript.
- **React 19 + [Mantine](https://mantine.dev/)** for the UI, with [RevoGrid](https://rv-grid.com/) for the spreadsheet grid, [dockview](https://dockview.dev/) for tabbed and tiled sheets and [Apache ECharts](https://echarts.apache.org/) for charts.
- **Vite + pnpm workspaces** for building, with **Vitest** and **Playwright** for testing.
- **Runs in the browser.** Simulations run on the user's machine.
- **Uses every core.** The simulation engine runs on a pool of Web Workers. By default it uses all CPU cores except one, which is kept free so the UI stays responsive. The number of workers can be changed in settings.
- **GPU acceleration.** The entire workbook is compiled into a single WebGPU compute kernel, and each GPU thread runs one complete iteration of the model. By default the CPU and GPU engines **run side by side** and are checked against each other continuously. Cells where the two disagree are flagged, which uncovers bugs in either engine. Either engine can be turned off.

## Saving and collaboration

- **Local files:** save and load workbooks as files on your own machine. Work is also autosaved in the browser.
- **Cloud and realtime collaboration (planned):** these come through a **pluggable storage provider**. Cloud storage, and several people editing one model at the same time, will be offered as a separate cloud plan. The open-source core stays cloud-agnostic.

## Open source

fumoca is free, open-source software. Use it at [fumoca.com](https://fumoca.com), or clone this repo and run your own build.

## Status

Early development. The workspace and tooling are set up. The engine and UI are placeholders so far.

## Documentation

- [SPECS.md](SPECS.md): detailed functional and technical specifications
- [TBD.md](TBD.md): open design questions still to be decided

## Getting started

You need [Node.js](https://nodejs.org/) 24 or later. pnpm is provided through Corepack, which comes with Node.

```sh
corepack enable        # once per machine; makes the pinned pnpm version available
pnpm install
pnpm dev               # start the dev server
```

| Command | What it does |
|---|---|
| `pnpm dev` | Start the Vite dev server |
| `pnpm build` | Production build of the app (`packages/app/dist`) |
| `pnpm typecheck` | Type-check every package |
| `pnpm lint` / `pnpm format` | Check / fix lint and formatting (Biome) |
| `pnpm test` | Unit tests (Vitest) |
| `pnpm test:e2e` | Browser tests (Playwright). Run `pnpm --filter @fumoca/app exec playwright install chromium` once first |

The repo is a pnpm workspace:

| Package | Contents |
|---|---|
| `packages/engine` | Formula engine. Pure TypeScript, no DOM |
| `packages/sim` | Worker pool, scheduler, settling |
| `packages/gpu` | WGSL compiler, WebGPU runtime |
| `packages/storage` | Storage provider interface and built-in providers |
| `packages/app` | React + Mantine UI |

See [SPECS.md](SPECS.md) §9.1 for details.

## Licence

fumoca is dual-licensed under either of

- MIT licence ([LICENSE-MIT](LICENSE-MIT) or https://opensource.org/licenses/MIT)
- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE) or https://www.apache.org/licenses/LICENSE-2.0)

at your option. This is the same dual-licence arrangement used by the Rust project and by most of the Rust ecosystem.

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in fumoca by you, as defined in the Apache-2.0 licence, shall be dual-licensed as above, without any additional terms or conditions.
