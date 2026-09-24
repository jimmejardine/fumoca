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

## Tech stack

- **TypeScript throughout.** The formula engine, simulation engine and UI are all written in TypeScript.
- **React** for the UI, with [Glide Data Grid](https://github.com/glideapps/glide-data-grid) for the spreadsheet grid and [Apache ECharts](https://echarts.apache.org/) for charts.
- **Runs in the browser.** Simulations run on the user's machine.
- **Uses every core.** The simulation engine runs on a pool of Web Workers. By default it uses all CPU cores except one, which is kept free so the UI stays responsive. The number of workers can be changed in settings.
- **GPU acceleration.** The entire workbook is compiled into a single WebGPU compute kernel, and each GPU thread runs one complete iteration of the model. By default the CPU and GPU engines **run side by side** and are checked against each other continuously. Cells where the two disagree are flagged, which uncovers bugs in either engine. Either engine can be turned off.

## Saving and collaboration

- **Local files:** save and load workbooks as files on your own machine. Work is also autosaved in the browser.
- **Cloud and realtime collaboration (planned):** these come through a **pluggable storage provider**. Cloud storage, and several people editing one model at the same time, will be offered as a separate cloud plan. The open-source core stays cloud-agnostic.

## Open source

fumoca is free, open-source software. Use it at [fumoca.com](https://fumoca.com), or clone this repo and run your own build.

## Status

Early development. The repo has only documentation so far.

## Documentation

- [SPECS.md](SPECS.md): detailed functional and technical specifications
- [TBD.md](TBD.md): open design questions still to be decided

## Getting started

_To be added once the project is set up._

## Licence

fumoca is dual-licensed under either of

- MIT licence ([LICENSE-MIT](LICENSE-MIT) or https://opensource.org/licenses/MIT)
- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE) or https://www.apache.org/licenses/LICENSE-2.0)

at your option. This is the same dual-licence arrangement used by the Rust project and by most of the Rust ecosystem.

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in fumoca by you, as defined in the Apache-2.0 licence, shall be dual-licensed as above, without any additional terms or conditions.
