/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * Binance (free, no auth), calculates all indicators, runs safety check,
 * executes via BitGet if everything lines up.
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway, set env vars, Railway triggers on cron schedule
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY", "BITGET_PASSPHRASE"];
  const missing = required.filter((k) => !process.env[k]);

  if (!existsSync(".env")) {
    console.log(
      "\n⚠️  No .env file found — opening it for you to fill in...\n",
    );
    writeFileSync(
      ".env",
      [
        "# BitGet credentials",
        "BITGET_API_KEY=",
        "BITGET_SECRET_KEY=",
        "BITGET_PASSPHRASE=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSDT",
        "TIMEFRAME=4H",
      ].join("\n") + "\n",
    );
    try {
      execSync("open .env");
    } catch {}
    console.log(
      "Fill in your BitGet credentials in .env then re-run: node bot.js\n",
    );
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Opening .env for you now...\n");
    try {
      execSync("open .env");
    } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  // Always print the CSV location so users know where to find their trade log
  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbols: (process.env.SYMBOLS || process.env.SYMBOL || "BTCUSDT").split(",").map(s => s.trim()),
  timeframe: process.env.TIMEFRAME || "4H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  stopLossPct: parseFloat(process.env.STOP_LOSS_PCT || "2.0"),
  rrRatio: parseFloat(process.env.RR_RATIO || "2.0"),
  bitget: {
    apiKey: process.env.BITGET_API_KEY,
    secretKey: process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl: process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
  // Per-symbol risk sizing based on strategy rules
  symbolRiskPct: {
    "BTCUSDT":  1.0,
    "ETHUSDT":  1.0,
    "SOLUSDT":  0.5,
    "XAUTUSDT": 1.0,
  },
};

const LOG_FILE = "safety-check-log.json";

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Market Data (Binance public API — free, no auth) ───────────────────────

async function fetchCandles(symbol, interval, limit = 100) {
  // Map our timeframe format to Binance interval format
  const intervalMap = {
    "1m": "1m",
    "3m": "3m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1H": "1h",
    "4H": "4h",
    "1D": "1d",
    "1W": "1w",
  };
  const binanceInterval = intervalMap[interval] || "1m";

  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error ${res.status} for ${symbol}`);
  const data = await res.json();

  // Binance returns an error object instead of array if symbol not found
  if (!Array.isArray(data)) {
    throw new Error(`${symbol} not available on Binance: ${data.msg || JSON.stringify(data)}`);
  }
  if (data.length < 10) {
    throw new Error(`Not enough candle data for ${symbol} (got ${data.length})`);
  }

  return data.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// VWAP — session-based, resets at midnight UTC
function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume,
    0,
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── Safety Check ───────────────────────────────────────────────────────────

function runSafetyCheck(price, ema8, vwap, rsi3, rules) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");

  // Determine bias first
  const bullishBias = price > vwap && price > ema8;
  const bearishBias = price < vwap && price < ema8;

  if (bullishBias) {
    console.log("  Bias: BULLISH — checking long entry conditions\n");

    // 1. Price above VWAP
    check(
      "Price above VWAP (buyers in control)",
      `> ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price > vwap,
    );

    // 2. Price above EMA(8)
    check(
      "Price above EMA(8) (uptrend confirmed)",
      `> ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price > ema8,
    );

    // 3. RSI(3) pullback
    check(
      "RSI(3) below 30 (snap-back setup in uptrend)",
      "< 30",
      rsi3.toFixed(2),
      rsi3 < 30,
    );

    // 4. Not overextended from VWAP
    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else if (bearishBias) {
    console.log("  Bias: BEARISH — checking short entry conditions\n");

    check(
      "Price below VWAP (sellers in control)",
      `< ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price < vwap,
    );

    check(
      "Price below EMA(8) (downtrend confirmed)",
      `< ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price < ema8,
    );

    check(
      "RSI(3) above 70 (reversal setup in downtrend)",
      "> 70",
      rsi3.toFixed(2),
      rsi3 > 70,
    );

    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else {
    console.log("  Bias: NEUTRAL — no clear direction. No trade.\n");
    results.push({
      label: "Market bias",
      required: "Bullish or bearish",
      actual: "Neutral",
      pass: false,
    });
  }

  const allPass = results.every((r) => r.pass);
  return { results, allPass };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  if (tradeSize > CONFIG.maxTradeSizeUSD) {
    console.log(
      `🚫 Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}`,
    );
    return false;
  }

  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`,
  );

  return true;
}

// ─── BitGet Execution ────────────────────────────────────────────────────────

function signBitGet(timestamp, method, path, body = "") {
  const message = `${timestamp}${method}${path}${body}`;
  return crypto
    .createHmac("sha256", CONFIG.bitget.secretKey)
    .update(message)
    .digest("base64");
}

// Calculate SL and TP prices based on strategy rules
function calcSlTp(entryPrice, side) {
  const slPct = CONFIG.stopLossPct / 100;
  const tpPct = slPct * CONFIG.rrRatio;
  let stopLoss, takeProfit;
  if (side === "buy") {
    stopLoss   = parseFloat((entryPrice * (1 - slPct)).toFixed(2));
    takeProfit = parseFloat((entryPrice * (1 + tpPct)).toFixed(2));
  } else {
    stopLoss   = parseFloat((entryPrice * (1 + slPct)).toFixed(2));
    takeProfit = parseFloat((entryPrice * (1 - tpPct)).toFixed(2));
  }
  return { stopLoss, takeProfit };
}

async function placeBitGetOrder(symbol, side, sizeUSD, price) {
  const quantity = (sizeUSD / price).toFixed(6);
  const timestamp = Date.now().toString();
  const { stopLoss, takeProfit } = calcSlTp(price, side);

  const path =
    CONFIG.tradeMode === "spot"
      ? "/api/v2/spot/trade/placeOrder"
      : "/api/v2/mix/order/placeOrder";

  const body = JSON.stringify({
    symbol,
    side,
    orderType: "market",
    quantity,
    ...(CONFIG.tradeMode === "futures" && {
      productType: "USDT-FUTURES",
      marginMode: "isolated",
      marginCoin: "USDT",
      presetStopLossPrice: stopLoss.toString(),
      presetStopSurplusPrice: takeProfit.toString(),
    }),
  });

  const signature = signBitGet(timestamp, "POST", path, body);

  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body,
  });

  const data = await res.json();
  if (data.code !== "00000") {
    throw new Error(`BitGet order failed: ${data.msg}`);
  }

  // For spot: place a separate stop-loss limit order after entry
  if (CONFIG.tradeMode === "spot" && data.data?.orderId) {
    await placeSpotStopLoss(symbol, quantity, stopLoss);
  }

  return { ...data.data, stopLoss, takeProfit };
}

// Spot stop-loss via BitGet plan order
async function placeSpotStopLoss(symbol, quantity, stopLossPrice) {
  const timestamp = Date.now().toString();
  const path = "/api/v2/spot/trade/place-plan-order";
  const body = JSON.stringify({
    symbol,
    side: "sell",
    orderType: "market",
    triggerPrice: stopLossPrice.toString(),
    triggerType: "fill_price",
    size: quantity,
    planType: "profit_loss",
  });
  const signature = signBitGet(timestamp, "POST", path, body);
  try {
    const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ACCESS-KEY": CONFIG.bitget.apiKey,
        "ACCESS-SIGN": signature,
        "ACCESS-TIMESTAMP": timestamp,
        "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
      },
      body,
    });
    const data = await res.json();
    if (data.code === "00000") {
      console.log(`🛡️  Stop-loss order placed at $${stopLossPrice}`);
    } else {
      console.log(`⚠️  Stop-loss order failed: ${data.msg}`);
    }
  } catch (e) {
    console.log(`⚠️  Stop-loss order error: ${e.message}`);
  }
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

// Always ensure trades.csv exists with headers — open it in Excel/Sheets any time
function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let mode = "";
  let notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "PAPER";
    notes = "All conditions met";
  } else {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";
  }

  const row = [
    date,
    time,
    "BitGet",
    logEntry.symbol,
    side,
    quantity,
    logEntry.price.toFixed(2),
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  // Retry up to 3 times in case file is locked (e.g. open in Excel)
  const writeWithRetry = (attempt) => {
    try {
      appendFileSync(CSV_FILE, row + "\n");
      console.log(`  Tax record saved → ${CSV_FILE}`);
    } catch (e) {
      if (attempt >= 3) console.log(`  ⚠️  Could not write to trades.csv (file locked?) — ${e.message}`);
      else setTimeout(() => writeWithRetry(attempt + 1), 500);
    }
  };
  writeWithRetry(1);
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Analyse one symbol ──────────────────────────────────────────────────────

async function analyseSymbol(symbol, rules, log) {
  console.log(`\n${"─".repeat(57)}`);
  console.log(`  📊 ${symbol}`);
  console.log(`${"─".repeat(57)}\n`);

  // Per-symbol risk sizing
  const riskPct = CONFIG.symbolRiskPct[symbol] ?? 1.0;
  const tradeSize = Math.min(
    CONFIG.portfolioValue * (riskPct / 100),
    CONFIG.maxTradeSizeUSD,
  );

  // Fetch candles
  const candles = await fetchCandles(symbol, CONFIG.timeframe, 500);
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];

  const ema8 = calcEMA(closes, 8);
  const vwap = calcVWAP(candles);
  const rsi3 = calcRSI(closes, 3);

  console.log(`  Price:   $${price.toFixed(2)}`);
  console.log(`  EMA(8):  $${ema8.toFixed(2)}`);
  console.log(`  VWAP:    $${vwap ? vwap.toFixed(2) : "N/A"}`);
  console.log(`  RSI(3):  ${(rsi3 !== null && rsi3 !== undefined && !isNaN(rsi3)) ? rsi3.toFixed(2) : "N/A (flat market)"}`);
  console.log(`  Risk:    ${riskPct}% = $${tradeSize.toFixed(2)}`);

  if (vwap === null || vwap === undefined || isNaN(vwap) ||
      rsi3 === null || rsi3 === undefined || isNaN(rsi3)) {
    console.log(`\n  ⚠️  Skipping ${symbol} — VWAP: ${vwap}, RSI: ${rsi3}`);
    return null;
  }

  const { results, allPass } = runSafetyCheck(price, ema8, vwap, rsi3, rules);

  console.log(`\n  Safety Check:`);
  results.forEach(r => console.log(`  ${r.pass ? "✅" : "🚫"} ${r.label}`));

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol,
    timeframe: CONFIG.timeframe,
    price,
    indicators: { ema8, vwap, rsi3 },
    conditions: results,
    allPass,
    tradeSize,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    },
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`\n  🚫 BLOCKED — ${failed.length} condition(s) failed`);
  } else {
    console.log(`\n  ✅ ALL CONDITIONS MET`);
    if (CONFIG.paperTrading) {
      const { stopLoss, takeProfit } = calcSlTp(price, "buy");
      const riskUSD = (price - stopLoss) / price * tradeSize;
      const rewardUSD = (takeProfit - price) / price * tradeSize;
      console.log(`\n  📋 PAPER TRADE — ${symbol} ~$${tradeSize.toFixed(2)}`);
      console.log(`     Entry:       $${price.toFixed(2)}`);
      console.log(`     Stop Loss:   $${stopLoss.toFixed(2)}  (-${CONFIG.stopLossPct}%) → risk $${riskUSD.toFixed(2)}`);
      console.log(`     Take Profit: $${takeProfit.toFixed(2)}  (+${(CONFIG.stopLossPct * CONFIG.rrRatio).toFixed(1)}%) → reward $${rewardUSD.toFixed(2)}`);
      console.log(`     R:R Ratio:   1:${CONFIG.rrRatio}`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
      logEntry.stopLoss = stopLoss;
      logEntry.takeProfit = takeProfit;
    } else {
      console.log(`\n  🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} BUY ${symbol}`);
      try {
        const order = await placeBitGetOrder(symbol, "buy", tradeSize, price);
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderId;
        logEntry.stopLoss = order.stopLoss;
        logEntry.takeProfit = order.takeProfit;
        console.log(`  ✅ ORDER PLACED — ${order.orderId}`);
        console.log(`  🛡️  SL: $${order.stopLoss} | TP: $${order.takeProfit}`);
      } catch (err) {
        console.log(`  ❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }
  }

  return logEntry;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log(`  Scanning: ${CONFIG.symbols.join(", ")}`);
  console.log("═══════════════════════════════════════════════════════════");

  // Load strategy
  const rulesRaw = process.env.RULES_JSON
    ? process.env.RULES_JSON
    : readFileSync("rules.json", "utf8");
  const rules = JSON.parse(rulesRaw);
  const strategyName = rules.strategy_name || (rules.strategy && rules.strategy.name) || "Custom Strategy";
  console.log(`\nStrategy: ${strategyName}`);
  console.log(`Timeframe: ${CONFIG.timeframe}`);

  // Load log and check daily limits
  const log = loadLog();
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  // Scan every symbol
  for (const symbol of CONFIG.symbols) {
    try {
      const logEntry = await analyseSymbol(symbol, rules, log);
      if (logEntry) {
        log.trades.push(logEntry);
        saveLog(log);
        writeTradeCsv(logEntry);
        // Stop if daily trade limit reached mid-scan
        if (!checkTradeLimits(log)) {
          console.log("\n⛔ Daily trade limit reached — stopping scan.");
          break;
        }
      }
    } catch (err) {
      console.log(`\n⚠️  Error scanning ${symbol}: ${err.message}`);
    }
    // Small delay between symbols to avoid rate limits
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\n${"═".repeat(57)}`);
  console.log(`  Scan complete — ${CONFIG.symbols.length} symbols checked`);
  console.log(`  Log → ${LOG_FILE}`);
  console.log(`${"═".repeat(57)}\n`);
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
