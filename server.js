const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const CONFIG_PATH = path.join(ROOT, "config", "tag-map.json");
const HISTORY_PATH = path.join(ROOT, "data", "prediction-history.jsonl");
const PORT = Number(process.env.PORT || 8787);

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
let tick = 0;
let latest = null;
let history = loadHistory();

function loadHistory() {
  if (!fs.existsSync(HISTORY_PATH)) return [];
  return fs.readFileSync(HISTORY_PATH, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-288)
    .map(line => JSON.parse(line));
}

function collectLiveSnapshot() {
  if (config.source_mode === "simulator") return simulatedSnapshot();
  return readScadaSnapshot();
}

function readScadaSnapshot() {
  throw new Error("SCADA adapter not configured. Use simulator or implement OPC/historian reads here.");
}

function simulatedSnapshot() {
  tick += 1;
  const wave = Math.sin(tick / 7);
  const slow = Math.sin(tick / 19);
  const disturbance = tick % 52 > 31 && tick % 52 < 44 ? 1 : 0;
  return {
    timestamp: new Date().toISOString(),
    quality: "GOOD",
    source: "simulator",
    kiln_feed_tph: round(246 + wave * 5 + disturbance * 8, 2),
    burning_zone_temp_c: round(1437 - disturbance * 26 + slow * 9, 2),
    kiln_inlet_temp_c: round(1074 - disturbance * 14 + wave * 7, 2),
    secondary_air_temp_c: round(1040 - disturbance * 25 + slow * 8, 2),
    cooler_grate_speed_pct: round(54 + disturbance * 10 + wave * 3, 2),
    fuel_rate_tph: round(18.8 - disturbance * 0.5 + slow * 0.25, 2),
    fuel_moisture_pct: round(8.4 + disturbance * 1.7 + wave * 0.5, 2),
    raw_meal_lsf: round(96.7 + disturbance * 2.5 + slow * 0.8, 2),
    silica_modulus: round(2.49 + disturbance * 0.08 + wave * 0.03, 3),
    alumina_modulus: round(1.5 - disturbance * 0.05 + slow * 0.02, 3),
    lab_free_lime_pct: null,
    liter_weight_g_per_l: round(1210 - disturbance * 72 - Math.max(0, wave) * 18, 1),
    cement_mill_runtime_pct: round(94 - disturbance * 13 - Math.max(0, -wave) * 7, 1),
    grinding_rate_tph: round(214 - disturbance * 32 + wave * 11, 1),
    clinker_feed_tph: round(166 - disturbance * 21 + slow * 8, 1),
    additive_availability_pct: round(96 - disturbance * 14 - Math.max(0, wave) * 5, 1),
    power_available_pct: round(98 - (tick % 67 > 49 ? 18 : 0) - disturbance * 5, 1),
    cement_silo_utilization_pct: round(72 + disturbance * 18 + Math.max(0, wave) * 8, 1),
    packing_rate_tph: round(204 - disturbance * 24 - Math.max(0, slow) * 10, 1),
    dispatch_truck_availability_pct: round(92 - (tick % 47 > 35 ? 24 : 0) - disturbance * 6, 1),
    planning_alignment_pct: round(93 - (tick % 59 > 42 ? 17 : 0) - disturbance * 4, 1)
  };
}

function predict(record, recent) {
  const lsfTerm = (record.raw_meal_lsf - 96) * 0.055;
  const heatTerm = (1435 - record.burning_zone_temp_c) * 0.022;
  const airTerm = (1035 - record.secondary_air_temp_c) * 0.011;
  const coolerTerm = (record.cooler_grate_speed_pct - 54) * 0.018;
  const fuelTerm = (9 - record.fuel_moisture_pct) * -0.025 + (18.6 - record.fuel_rate_tph) * 0.045;
  const feedTerm = (record.kiln_feed_tph - 246) * 0.008;
  const chemistryTerm = (record.silica_modulus - 2.5) * 0.22 + (1.48 - record.alumina_modulus) * 0.18;
  const instability = processInstability(recent.concat(record));
  const predictedFreeLime = clamp(1.08 + lsfTerm + heatTerm + airTerm + coolerTerm + fuelTerm + feedTerm + chemistryTerm, 0.25, 4.8);
  const predictedLiterWeight = clamp(
    1215
      - Math.max(0, predictedFreeLime - 1.15) * 92
      - Math.max(0, record.cooler_grate_speed_pct - 58) * 5.2
      + Math.max(0, record.burning_zone_temp_c - 1430) * 1.1
      - instability * 42,
    980,
    1325
  );
  const literWeightRisk = clamp((config.liter_weight_low_limit_g_per_l - predictedLiterWeight) * 1.25, 0, 90);
  const freeLimeRisk = clamp((predictedFreeLime - 0.75) * 34 + instability * 16, 3, 99);
  const offSpecRisk = clamp(Math.max(freeLimeRisk, literWeightRisk) + instability * 8, 2, 99);
  const confidence = confidenceScore(record, recent.length);
  const status = offSpecRisk >= config.off_spec_risk_alert_pct || predictedFreeLime >= config.free_lime_high_limit_pct
    ? "ALERT"
    : offSpecRisk >= config.off_spec_risk_alert_pct - 20
      ? "WATCH"
      : "NORMAL";

  const qualityPrediction = {
    predicted_free_lime_pct: round(predictedFreeLime, 3),
    predicted_liter_weight_g_per_l: round(predictedLiterWeight, 1),
    off_spec_risk_pct: Math.round(offSpecRisk),
    confidence_pct: confidence,
    warning_horizon_minutes: config.expected_warning_horizon_minutes,
    status,
    drivers: driverScores(record, { lsfTerm, heatTerm, airTerm, coolerTerm, fuelTerm, feedTerm, chemistryTerm, instability }),
    recommendations: recommendations(record, predictedFreeLime, predictedLiterWeight, offSpecRisk)
  };

  return {
    timestamp: record.timestamp,
    process: record,
    prediction: qualityPrediction,
    conversion: conversionAnalysis(record, qualityPrediction)
  };
}

function conversionAnalysis(record, qualityPrediction) {
  const expected = config.expected_cement_tpd || 5200;
  const targetRate = config.target_grinding_rate_tph || 220;
  const targetPacking = config.target_packing_rate_tph || 210;
  const runtimeFactor = clamp(record.cement_mill_runtime_pct / 100, 0, 1);
  const losses = [
    lossItem("Mill downtime", "Mill stopped or unavailable", expected * (1 - runtimeFactor)),
    lossItem("Low grinding rate", "Mill running below target tph", expected * runtimeFactor * clamp((targetRate - record.grinding_rate_tph) / targetRate, 0, 1)),
    lossItem("No clinker feed", "Mill starved by clinker transport/feed constraint", expected * runtimeFactor * clamp((165 - record.clinker_feed_tph) / 165, 0, 1) * 0.7),
    lossItem("Additive shortage", "Gypsum/limestone/other additive availability constraint", expected * runtimeFactor * clamp((100 - record.additive_availability_pct) / 100, 0, 1) * 0.35),
    lossItem("Power restriction", "Power/load limitation reduces mill operation", expected * clamp((100 - record.power_available_pct) / 100, 0, 1) * 0.55),
    lossItem("Silo full", "Cement storage evacuation constraint", expected * clamp((record.cement_silo_utilization_pct - 88) / 12, 0, 1) * 0.4),
    lossItem("Packing bottleneck", "Packing/loading cannot evacuate cement fast enough", expected * clamp((targetPacking - record.packing_rate_tph) / targetPacking, 0, 1) * 0.45),
    lossItem("Dispatch/truck constraint", "Truck or dispatch readiness limits evacuation", expected * clamp((100 - record.dispatch_truck_availability_pct) / 100, 0, 1) * 0.3),
    lossItem("Planning mismatch", "Product mix or sequence not aligned with demand/storage", expected * clamp((100 - record.planning_alignment_pct) / 100, 0, 1) * 0.25)
  ].sort((a, b) => b.tons_lost - a.tons_lost);
  const rawLoss = losses.reduce((sum, item) => sum + item.tons_lost, 0);
  const totalLoss = round(clamp(rawLoss, 0, expected * 0.9), 1);
  const actual = round(expected - totalLoss, 1);
  const gapPct = Math.round((totalLoss / expected) * 100);
  const status = gapPct >= 25 ? "ALERT" : gapPct >= 12 ? "WATCH" : "NORMAL";
  const framework = conversionFramework(record, expected, actual, totalLoss);
  const actionPlan = conversionActionPlan(losses, gapPct, qualityPrediction);
  return {
    framework,
    expected_cement_tpd: round(expected, 1),
    actual_cement_tpd: actual,
    conversion_gap_tpd: totalLoss,
    conversion_efficiency_pct: Math.round((actual / expected) * 100),
    status,
    top_loss: losses[0],
    losses,
    loss_tree: conversionLossTree(losses),
    daily_review: dailyReview(record, losses, expected, actual, totalLoss, status),
    action_plan: actionPlan,
    recommendations: actionPlan.map(item => item.action)
  };
}

function conversionFramework(record, expected, actual, totalLoss) {
  const clinkerFactor = 0.72;
  const clinkerAvailableTpd = round(expected * clinkerFactor * 1.08, 1);
  const theoreticalCementFromClinker = round(clinkerAvailableTpd / clinkerFactor, 1);
  return {
    clinker_factor_pct: Math.round(clinkerFactor * 100),
    clinker_available_tpd: clinkerAvailableTpd,
    theoretical_cement_from_clinker_tpd: theoreticalCementFromClinker,
    planned_cement_tpd: round(expected, 1),
    actual_cement_tpd: round(actual, 1),
    conversion_gap_tpd: round(totalLoss, 1),
    formula: "Available clinker / clinker factor -> theoretical cement potential; subtract runtime, rate, feed, additive, power, silo, packing, dispatch and planning losses -> actual cement."
  };
}

function conversionLossTree(losses) {
  const rootCauses = {
    "Mill downtime": ["Mechanical breakdown", "Electrical trip", "Planned maintenance overrun", "Lubrication/hydraulic fault", "Instrumentation interlock"],
    "Low grinding rate": ["Hard clinker or poor grindability", "Worn grinding media/liners", "Separator inefficiency", "Low mill ventilation", "Feed size or moisture issue"],
    "No clinker feed": ["Low clinker bin level", "Belt/elevator stoppage", "Feeder fault", "Blocked chute", "Clinker transport route unavailable"],
    "Additive shortage": ["Gypsum shortage", "Limestone/pozzolana/slag shortage", "Additive feeder trip", "Wrong cement type additive not ready", "Stock reconciliation error"],
    "Power restriction": ["Grid load shedding", "Generator limitation", "Plant load priority constraint", "Voltage instability", "Utility outage"],
    "Silo full": ["Mill inflow exceeds packing/dispatch outflow", "Wrong silo selected", "Silo extraction fault", "Packing evacuation too slow", "Dispatch delay"],
    "Packing bottleneck": ["Packer fault", "Bag shortage", "Loader/spout problem", "Bulk loading unavailable", "Loading bay congestion"],
    "Dispatch/truck constraint": ["Truck shortage", "Weighbridge congestion", "Customer pickup delay", "Road/logistics restriction", "Loading schedule mismatch"],
    "Planning mismatch": ["Wrong product sequence", "Sales demand changed", "Silo allocation conflict", "Poor shift handover", "Plan not aligned with additive/dispatch readiness"]
  };
  const owners = {
    "Mill downtime": "Mechanical / Electrical / Production",
    "Low grinding rate": "Process / Production / Mechanical",
    "No clinker feed": "Production / Mechanical",
    "Additive shortage": "Stores / Procurement / Production",
    "Power restriction": "Electrical / Utilities",
    "Silo full": "Production / Dispatch / Packing",
    "Packing bottleneck": "Packing Plant / Mechanical",
    "Dispatch/truck constraint": "Logistics / Dispatch / Sales",
    "Planning mismatch": "Production Planning / Sales / QC"
  };
  return losses.map(item => ({
    loss: item.name,
    owner: owners[item.name] || "Production",
    root_causes: rootCauses[item.name] || ["Confirm operating data and review with system owner"],
    evidence_to_check: evidenceToCheck(item.name),
    recommended_action: recommendedActionForLoss(item.name)
  }));
}

function recommendedActionForLoss(name) {
  const actions = {
    "Mill downtime": "Restore mill availability; confirm whether stop is mechanical, electrical, planned, or interlock-related.",
    "Low grinding rate": "Optimize mill rate by checking separator, ventilation, grinding media/liners, feed size, and clinker grindability.",
    "No clinker feed": "Restore stable clinker feed by checking bin level, belts, elevators, feeders, and chute blockages.",
    "Additive shortage": "Secure required additive stock and confirm feeder readiness for the active cement type.",
    "Power restriction": "Coordinate power/load priority and agree whether mill load should be reduced or production rescheduled.",
    "Silo full": "Open evacuation path through silo selection, extraction, packing, dispatch, or product changeover.",
    "Packing bottleneck": "Recover packing/loading capacity by checking packers, bags, loaders, spouts, and bay congestion.",
    "Dispatch/truck constraint": "Escalate truck, weighbridge, loading schedule, and customer pickup constraints.",
    "Planning mismatch": "Realign product sequence, silo allocation, sales demand, additives, and dispatch plan."
  };
  return actions[name] || "Confirm evidence, assign owner, and agree corrective action for next review.";
}

function evidenceToCheck(name) {
  const evidence = {
    "Mill downtime": ["Mill running hours", "stoppage log", "trip/alarm history", "maintenance notification"],
    "Low grinding rate": ["tph trend", "mill power", "separator speed", "residue/Blaine", "clinker hardness"],
    "No clinker feed": ["clinker bin level", "belt status", "elevator status", "feeder speed", "chute differential"],
    "Additive shortage": ["stock level", "feeder speed", "weigh feeder alarm", "cement type schedule"],
    "Power restriction": ["power availability", "load shedding log", "voltage trend", "utility event"],
    "Silo full": ["silo level trend", "mill-to-silo route", "silo extraction rate", "packing/dispatch outflow"],
    "Packing bottleneck": ["packer runtime", "bag stock", "loading rate", "packer alarm log"],
    "Dispatch/truck constraint": ["truck queue", "weighbridge rate", "loading tickets", "dispatch plan"],
    "Planning mismatch": ["daily plan", "product sequence", "silo allocation", "sales demand changes"]
  };
  return evidence[name] || ["shift log", "SCADA trend", "operator comments"];
}

function dailyReview(record, losses, expected, actual, totalLoss, status) {
  const topThree = losses.slice(0, 3);
  return {
    title: "Daily plant review",
    status,
    target_vs_actual: `${Math.round(expected)} t/d target vs ${Math.round(actual)} t/d actual`,
    total_gap_tpd: round(totalLoss, 1),
    top_losses: topThree,
    watch_items: [
      `Mill runtime ${round(record.cement_mill_runtime_pct, 1)}%`,
      `Grinding rate ${round(record.grinding_rate_tph, 1)} tph`,
      `Silo utilization ${round(record.cement_silo_utilization_pct, 1)}%`,
      `Packing rate ${round(record.packing_rate_tph, 1)} tph`,
      `Truck availability ${round(record.dispatch_truck_availability_pct, 1)}%`
    ],
    meeting_prompt: "Review the top three losses, confirm evidence, assign owner, agree action and due time before next shift review."
  };
}

function lossItem(name, cause, tons) {
  return {
    name,
    cause,
    tons_lost: round(Math.max(0, tons), 1)
  };
}

function conversionActionPlan(losses, gapPct, qualityPrediction) {
  const actions = [];
  const top = losses[0]?.name || "";
  const push = (owner, action, due = "Current shift") => actions.push({ owner, action, due, status: "Open" });
  if (top === "Mill downtime") push("Mechanical / Electrical / Production", "Restore cement mill availability first; this is lost production time, not lost clinker.");
  if (top === "Low grinding rate") push("Process / Production", "Check mill performance, separator condition, ventilation, feedability, and clinker grindability.");
  if (top === "No clinker feed") push("Production / Mechanical", "Check clinker transport, bin level, feeder, chute blockage, and mill feed continuity.");
  if (top === "Additive shortage") push("Stores / Procurement / Production", "Confirm gypsum/limestone/additive stock, feeder readiness, and cement type plan.");
  if (top === "Power restriction") push("Electrical / Utilities", "Coordinate power availability and load priorities before blaming kiln or mill performance.");
  if (top === "Silo full") push("Production / Dispatch / Packing", "Open evacuation path: silo planning, packing, dispatch, or product changeover.");
  if (top === "Packing bottleneck") push("Packing Plant / Mechanical", "Check packer availability, bag supply, loader status, and loading bay congestion.");
  if (top === "Dispatch/truck constraint") push("Logistics / Dispatch / Sales", "Escalate truck availability, weighbridge, loading, and dispatch planning constraints.");
  if (top === "Planning mismatch") push("Production Planning / Sales", "Align product mix, silo availability, sales demand, and mill production sequence.");
  if (qualityPrediction.status === "ALERT") push("QC / Process / Production", "Quality risk is also active; do not treat the conversion gap as only a downstream problem.", "Next quality review");
  if (!actions.length || gapPct < 12) push("Shift team", "Conversion performance is within the current watch band; continue monitoring mill, silo, packing, and dispatch flow.");
  return actions;
}

function processInstability(rows) {
  const recent = rows.slice(-6);
  if (recent.length < 3) return 0.1;
  const range = key => Math.max(...recent.map(r => r[key])) - Math.min(...recent.map(r => r[key]));
  return clamp(range("burning_zone_temp_c") / 52 + range("raw_meal_lsf") / 5 + range("fuel_rate_tph") / 2.2, 0, 1);
}

function confidenceScore(record, historyLength) {
  const fields = [
    "kiln_feed_tph", "burning_zone_temp_c", "kiln_inlet_temp_c", "secondary_air_temp_c",
    "cooler_grate_speed_pct", "fuel_rate_tph", "fuel_moisture_pct", "raw_meal_lsf",
    "silica_modulus", "alumina_modulus", "liter_weight_g_per_l"
  ];
  const complete = fields.filter(key => Number.isFinite(record[key])).length / fields.length;
  const volume = Math.min(1, historyLength / 48);
  const quality = record.quality === "GOOD" ? 1 : 0.65;
  return Math.round((0.58 * complete + 0.27 * volume + 0.15 * quality) * 100);
}

function driverScores(record, terms) {
  const items = [
    ["Raw meal LSF pressure", Math.max(0, terms.lsfTerm), `LSF ${record.raw_meal_lsf}`],
    ["Burning zone heat deficit", Math.max(0, terms.heatTerm), `${Math.round(record.burning_zone_temp_c)} degC`],
    ["Secondary air weakness", Math.max(0, terms.airTerm), `${Math.round(record.secondary_air_temp_c)} degC`],
    ["Cooler/grate instability", Math.max(0, terms.coolerTerm), `${Math.round(record.cooler_grate_speed_pct)}% grate`],
    ["Fuel and moisture effect", Math.max(0, terms.fuelTerm), `${record.fuel_moisture_pct}% moisture`],
    ["Kiln feed loading", Math.max(0, terms.feedTerm), `${Math.round(record.kiln_feed_tph)} tph`],
    ["SM/AM chemistry balance", Math.max(0, terms.chemistryTerm), `SM ${record.silica_modulus}, AM ${record.alumina_modulus}`],
    ["Process swings", Math.max(0, terms.instability / 18), "recent variability"]
  ];
  return items
    .map(([name, score, detail]) => ({ name, score: round(score, 3), detail }))
    .sort((a, b) => b.score - a.score);
}

function recommendations(record, freeLime, literWeight, risk) {
  const notes = [];
  if (freeLime >= config.free_lime_high_limit_pct) {
    notes.push("High free lime forecast: stabilize burning intensity and review feed loading before the next lab result arrives.");
  }
  if (literWeight <= config.liter_weight_low_limit_g_per_l) {
    notes.push("Low liter weight risk: check nodulization, cooler bed condition, and burning stability.");
  }
  if (record.raw_meal_lsf > 98.3) {
    notes.push("Raw meal LSF is pushing the burnability limit; confirm corrective mix control.");
  }
  if (record.burning_zone_temp_c < 1420) {
    notes.push("Burning zone is below target; check flame shape, fuel feed, and draft stability.");
  }
  if (record.secondary_air_temp_c < 1025) {
    notes.push("Secondary air heat recovery is weak; inspect cooler grate speed, bed depth, and fan balance.");
  }
  if (record.fuel_moisture_pct > 9.5) {
    notes.push("Fuel moisture is elevated; expect slower thermal response and verify mill drying.");
  }
  if (!notes.length && risk < config.off_spec_risk_alert_pct) {
    notes.push("No immediate intervention. Continue monitoring chemistry, thermal stability, and cooler recovery.");
  }
  return notes;
}

function collectAndPredict() {
  try {
    const snapshot = collectLiveSnapshot();
    const recentProcess = history.slice(-24).map(row => row.process);
    latest = predict(snapshot, recentProcess);
    history.push(latest);
    history = history.slice(-288);
    fs.appendFileSync(HISTORY_PATH, JSON.stringify(latest) + "\n");
  } catch (error) {
    latest = {
      timestamp: new Date().toISOString(),
      error: error.message,
      prediction: { status: "DATA_LOSS", off_spec_risk_pct: 0, confidence_pct: 0, recommendations: ["Live data collection is unavailable. Check SCADA/historian connection."] }
    };
  }
}

function apiResponse(res, payload, code = 200) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json" };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname === "/api/current") return apiResponse(res, latest || {});
  if (parsed.pathname === "/api/history") return apiResponse(res, history.slice(-144));
  if (parsed.pathname === "/api/config") return apiResponse(res, config);
  if (parsed.pathname === "/api/health") return apiResponse(res, {
    ok: Boolean(latest && !latest.error),
    source_mode: config.source_mode,
    latest_timestamp: latest?.timestamp || null,
    records_in_memory: history.length
  });
  serveStatic(req, res, parsed.pathname);
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

collectAndPredict();
setInterval(collectAndPredict, config.prediction_interval_seconds * 1000);

server.listen(PORT, () => {
  console.log(`Real-time clinker platform running at http://localhost:${PORT}`);
  console.log(`Source mode: ${config.source_mode}`);
});
