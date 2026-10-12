# Cement Production Intelligence

A Node.js and browser dashboard prototype for exploring clinker quality and cement production-conversion gaps with **simulated process data**.

## What it demonstrates

- A periodic data-collection loop with simulated kiln and downstream production variables.
- Rule-based free-lime, liter-weight, and off-spec estimates, with explanatory driver scores.
- A clinker-to-cement conversion bridge and ranked opportunity-loss categories.
- A browser dashboard with current conditions, history, loss explanations, and action-plan suggestions.
- JSONL history storage and a tag-mapping configuration for future read-only process-data adapters.

The estimates and confidence scores are illustrative heuristics. They have not been validated against plant measurements, and this prototype is not a production control or safety system.

## Stack and structure

Node.js built-in HTTP and filesystem modules · HTML · JavaScript · JSON / JSONL

| Path | Responsibility |
| --- | --- |
| `server.js` | Simulator, periodic collection, calculations, API routes, and static serving |
| `public/index.html` | Browser dashboard |
| `config/tag-map.json` | Source mode, thresholds, collection interval, and tag mapping |
| `data/prediction-history.jsonl` | Append-only local history |

## Run locally

Use Node.js 24 and npm. There are no external runtime dependencies to install.

```sh
npm start
```

Open `http://localhost:8787`. The server reads `PORT` from the environment and defaults to 8787. Keep `source_mode` set to `simulator` unless you implement the adapter.

## API

| Route | Response |
| --- | --- |
| `/api/current` | Latest process snapshot and estimates |
| `/api/history` | Recent history, up to 144 records |
| `/api/config` | Dashboard configuration |
| `/api/health` | Collection status, source mode, latest timestamp, and in-memory history count |

## Conversion bridge

The dashboard compares expected cement output with actual output and ranks contributing constraints: mill downtime, grinding rate, clinker feed, additives, power, silo capacity, packing, dispatch, and planning. Values represent cement-equivalent opportunity losses, not necessarily physical material losses.

## Integration and limitations

`readScadaSnapshot()` is an unimplemented adapter. A future integration would map approved read-only OPC UA, historian, SQL, MQTT, or vendor API data to the expected fields in `config/tag-map.json`.

No plant connection or kiln-setpoint control is implemented. Action plans and forecasts are prototype explanations, not validated operational instructions. There is no authentication or automated test suite. The dashboard should be evaluated using simulated or sample data.
