# Real-Time Cement Production Intelligence Platform

This is a real-time-ready MVP scaffold for predicting high free lime/off-spec clinker and diagnosing clinker-to-cement production conversion gaps.

## Run

```powershell
cd outputs\realtime-clinker-platform
npm start
```

Then open:

```text
http://localhost:8787
```

## What It Includes

- Live data collector loop
- Simulated SCADA/historian source
- Prediction service for free lime, liter weight, and off-spec risk
- Clinker-to-cement conversion bridge
- Cement-equivalent opportunity loss analysis
- JSONL history storage
- Live browser dashboard
- Tag mapping file for later plant integration

## How To Connect Real SCADA Later

Edit `config/tag-map.json` to match the real plant tag names, then replace the simulator function inside `server.js` with an adapter for:

- OPC UA
- PI historian
- SQL historian
- MQTT
- Vendor API

Start with read-only access. Do not write kiln setpoints from this platform until it has passed process control and safety validation.

## Conversion Bridge Module

The conversion bridge explains why expected cement production may not become actual cement output, even when clinker is available. These are opportunity losses measured as cement-equivalent tons per day, not necessarily physical material losses.

Current loss categories:

- Mill downtime
- Low grinding rate
- No clinker feed
- Additive shortage
- Power restriction
- Silo full
- Packing bottleneck
- Dispatch/truck constraint
- Planning mismatch

The dashboard has a `Conversion bridge` view showing expected cement, actual cement, conversion gap, efficiency, top loss, ranked loss bars, recommended actions, and current conversion variables.

Challenge 3 deliverables now represented in the app:

- Clinker-to-cement conversion framework
- Loss bridge
- Loss tree with likely root-cause hypotheses
- Daily plant review summary
- Action plan with owners by system
- Current conversion variables for mill, additive, power, silo, packing, dispatch, and planning constraints

The Home status page now summarizes the whole platform: clinker quality, cement conversion gap, live feed health, confidence, main concern, and recommended actions.
