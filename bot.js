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
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "12.5"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  maxConcurrentTrades: parseInt(process.env.MAX_CONCURRENT_TRADES || "2"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  leverage: parseInt(process.env.LEVERAGE || "1"),   // 1 = spot, 10 = futures 10x
  stopLossPct: parseFloat(process.env.STOP_LOSS_PCT || "2.0"),
  rrRatio: parseFloat(process.env.RR_RATIO || "2.0"),
  // Early exit: cut trade when this % of SL distance is reached AND momentum confirms
  earlyExitSlPct: parseFloat(process.env.EARLY_EXIT_SL_PCT || "0.65"),
  bitget: {
    apiKey: process.env.BITGET_API_KEY,
    secretKey: process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl: process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
  // All symbols get equal $12.5 sizing — 1.0 = full size
  symbolRiskPct: {
    "BTCUSDT":  1.0,
    "ETHUSDT":  1.0,
    "SOLUSDT":  1.0,
    "XAUTUSDT": 1.0,
  },
};

const LOG_FILE = "safety-check-log.json";
const LEARN_FILE = "learning.json";

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

// ─── Learning System ─────────────────────────────────────────────────────────

function loadLearning() {
  if (!existsSync(LEARN_FILE)) return {
    totalTrades: 0, wins: 0, losses: 0, winRate: 0,
    // Adaptive thresholds — bot adjusts these based on performance
    rsiEntryThreshold: 30,        // Default: RSI < 30 to enter long
    vwapProximityPct: 1.5,        // Default: price within 1.5% of VWAP
    entryTF: "15m",               // Default lower TF for entry timing
    symbolStats: {},              // Per-symbol win/loss tracking
    lastUpdated: null,
    notes: []
  };
  return JSON.parse(readFileSync(LEARN_FILE, "utf8"));
}

function saveLearning(learning) {
  writeFileSync(LEARN_FILE, JSON.stringify(learning, null, 2));
}

// Check all open paper trades — did they hit SL or TP since last scan?
function updateTradeOutcomes(log, learning, currentPrices) {
  let updated = false;
  for (const trade of log.trades) {
    if (!trade.orderPlaced || trade.outcome) continue; // skip if already resolved
    const currentPrice = currentPrices[trade.symbol];
    if (!currentPrice || !trade.stopLoss || !trade.takeProfit) continue;

    let outcome = null;
    if (currentPrice <= trade.stopLoss) outcome = "LOSS";
    else if (currentPrice >= trade.takeProfit) outcome = "WIN";

    if (outcome) {
      const lev = trade.leverage || 1;
      trade.outcome = outcome;
      trade.exitPrice = currentPrice;
      trade.closedAt = new Date().toISOString();
      trade.pnlPct = outcome === "WIN"
        ? ((trade.takeProfit - trade.price) / trade.price * 100 * lev).toFixed(2)
        : ((trade.stopLoss  - trade.price) / trade.price * 100 * lev).toFixed(2);
      trade.pnlUSD = (parseFloat(trade.pnlPct) / 100 * (trade.tradeSize || 0)).toFixed(2);

      // Update learning stats
      learning.totalTrades++;
      if (outcome === "WIN") learning.wins++;
      else learning.losses++;
      learning.winRate = parseFloat((learning.wins / learning.totalTrades * 100).toFixed(1));

      // Per-symbol stats
      if (!learning.symbolStats[trade.symbol]) {
        learning.symbolStats[trade.symbol] = { wins: 0, losses: 0, winRate: 0 };
      }
      const sym = learning.symbolStats[trade.symbol];
      if (outcome === "WIN") sym.wins++; else sym.losses++;
      sym.winRate = parseFloat((sym.wins / (sym.wins + sym.losses) * 100).toFixed(1));

      console.log(`\n  📚 TRADE CLOSED — ${trade.symbol} ${outcome}`);
      console.log(`     Entry: $${trade.price} | Exit: $${currentPrice} | P&L: ${trade.pnlPct}%`);
      writeExitCsv(trade, log);
      updated = true;
    }
  }

  if (updated) {
    // Auto-adapt thresholds based on last 10 closed trades
    adaptThresholds(log, learning);
    learning.lastUpdated = new Date().toISOString();
  }
  return updated;
}

function adaptThresholds(log, learning) {
  const closed = log.trades.filter(t => t.outcome).slice(-10);
  if (closed.length < 5) return; // need at least 5 trades to adapt

  const recentWinRate = closed.filter(t => t.outcome === "WIN").length / closed.length * 100;

  const note = [];

  // Win rate too low → tighten entry (require more oversold RSI)
  if (recentWinRate < 45 && learning.rsiEntryThreshold > 20) {
    learning.rsiEntryThreshold = Math.max(20, learning.rsiEntryThreshold - 2);
    note.push(`Win rate ${recentWinRate.toFixed(0)}% — tightened RSI threshold to ${learning.rsiEntryThreshold}`);
  }
  // Win rate high → can relax slightly to catch more setups
  else if (recentWinRate > 70 && learning.rsiEntryThreshold < 35) {
    learning.rsiEntryThreshold = Math.min(35, learning.rsiEntryThreshold + 1);
    note.push(`Win rate ${recentWinRate.toFixed(0)}% — relaxed RSI threshold to ${learning.rsiEntryThreshold}`);
  }

  // VWAP proximity: tighten if losing too much
  if (recentWinRate < 40 && learning.vwapProximityPct > 0.8) {
    learning.vwapProximityPct = Math.max(0.8, learning.vwapProximityPct - 0.2);
    note.push(`Tightened VWAP proximity to ${learning.vwapProximityPct}%`);
  } else if (recentWinRate > 65 && learning.vwapProximityPct < 2.0) {
    learning.vwapProximityPct = Math.min(2.0, learning.vwapProximityPct + 0.1);
    note.push(`Relaxed VWAP proximity to ${learning.vwapProximityPct}%`);
  }

  if (note.length > 0) {
    const entry = { date: new Date().toISOString(), changes: note, recentWinRate };
    learning.notes.push(entry);
    console.log(`\n  🧠 STRATEGY ADAPTED:`);
    note.forEach(n => console.log(`     → ${n}`));
  }
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

function countOpenTrades(log) {
  return log.trades.filter(t => t.orderPlaced && !t.outcome).length;
}

// ─── Early Exit System ───────────────────────────────────────────────────────
//
//  Runs on every hourly scan. For each open trade it checks:
//  1. Price crossed back over VWAP against the trade → setup invalidated
//  2. Price crossed back over EMA(8) against the trade → momentum gone
//  3. Trade is 65%+ of the way to the stop loss AND RSI confirms no recovery
//
//  Any one of these triggers an early exit: closes at current price instead of
//  waiting to get stopped out, saving up to 35% of the risk amount.

async function checkEarlyExits(log, learning, currentPrices) {
  const openTrades = log.trades.filter(t => t.orderPlaced && !t.outcome);
  if (openTrades.length === 0) return false;

  let updated = false;

  for (const trade of openTrades) {
    const currentPrice = currentPrices[trade.symbol];
    if (!currentPrice || !trade.stopLoss || !trade.takeProfit) continue;
    // Infer side if missing (old log entries): TP above entry = long, below = short
    const tradeSide = trade.side || (trade.takeProfit > trade.price ? "buy" : "sell");

    try {
      const candles = await fetchCandles(trade.symbol, CONFIG.timeframe, 500);
      const closes  = candles.map(c => c.close);
      const ema20   = calcEMA(closes, 20);
      const vwap    = calcVWAP(candles);
      const rsi3    = calcRSI(closes, 3);

      if (vwap === null || rsi3 === null || isNaN(rsi3)) continue;

      let shouldExit = false;
      let exitReason = "";

      const totalRange = Math.abs(trade.price - trade.stopLoss);
      const toSL       = Math.abs(currentPrice - trade.stopLoss);
      const slProgress = totalRange > 0 ? (totalRange - toSL) / totalRange : 0;

      // ── Trailing stop: protect profit once trade moves in our favour ──────
      // At 50% to TP → move SL to breakeven (entry price)
      // At 75% to TP → lock in +1% on position  (never lose a big winner)
      const tpRange     = Math.abs(trade.takeProfit - trade.price);
      const toTP        = Math.abs(trade.takeProfit - currentPrice);
      const tpProgress  = tpRange > 0 ? (tpRange - toTP) / tpRange : 0;
      const lev         = trade.leverage || CONFIG.leverage || 1;
      const currentPnlPct = tradeSide === "buy"
        ? (currentPrice - trade.price) / trade.price * 100 * lev
        : (trade.price - currentPrice) / trade.price * 100 * lev;

      if (tpProgress >= 0.75 && trade.stopLoss) {
        // Lock in +1% of margin above entry
        const lockedSL = tradeSide === "buy"
          ? trade.price * (1 + 0.01 / lev)
          : trade.price * (1 - 0.01 / lev);
        const improved = tradeSide === "buy"
          ? lockedSL > trade.stopLoss
          : lockedSL < trade.stopLoss;
        if (improved) {
          console.log(`  🔒 Trailing SL updated → locked in +1% (75% to TP) | New SL: $${lockedSL.toFixed(2)}`);
          trade.stopLoss = parseFloat(lockedSL.toFixed(2));
        }
      } else if (tpProgress >= 0.50 && trade.stopLoss) {
        // Move SL to breakeven
        const improved = tradeSide === "buy"
          ? trade.price > trade.stopLoss
          : trade.price < trade.stopLoss;
        if (improved) {
          console.log(`  🔒 Trailing SL → moved to breakeven $${trade.price} (50% to TP)`);
          trade.stopLoss = trade.price;
        }
      }

      // ── Early exit: stricter rules — require CONFIRMED reversal signals ──
      // Single VWAP dip = normal noise, not an exit signal.
      // Exit only when MULTIPLE conditions confirm the setup is broken.
      if (tradeSide === "buy") {
        const hardInvalidation = currentPrice < vwap && currentPrice < ema20 && rsi3 < 30;
        const approachingSL    = slProgress >= CONFIG.earlyExitSlPct && rsi3 < 30;

        if (hardInvalidation || approachingSL) {
          // Require 2 consecutive bad scans before exiting (avoid one-candle fakeouts)
          trade._earlyExitWarnings = (trade._earlyExitWarnings || 0) + 1;
          if (trade._earlyExitWarnings >= 2) {
            shouldExit = true;
            exitReason = hardInvalidation
              ? `Setup invalidated — price below VWAP, EMA(20) AND RSI(3)=${rsi3.toFixed(1)} (confirmed over 2 scans)`
              : `${(slProgress * 100).toFixed(0)}% to SL, RSI(3)=${rsi3.toFixed(1)} — no recovery (confirmed)`;
          } else {
            console.log(`  ⚠️  ${trade.symbol} LONG — weak signal (scan ${trade._earlyExitWarnings}/2) | RSI: ${rsi3.toFixed(1)} | Watching next scan...`);
          }
        } else {
          // Conditions improved — reset warning counter
          if (trade._earlyExitWarnings > 0) {
            console.log(`  ✅ ${trade.symbol} LONG — warning cleared, setup intact`);
            trade._earlyExitWarnings = 0;
          }
        }

      } else if (tradeSide === "sell") {
        const hardInvalidation = currentPrice > vwap && currentPrice > ema20 && rsi3 > 70;
        const approachingSL    = slProgress >= CONFIG.earlyExitSlPct && rsi3 > 70;

        if (hardInvalidation || approachingSL) {
          trade._earlyExitWarnings = (trade._earlyExitWarnings || 0) + 1;
          if (trade._earlyExitWarnings >= 2) {
            shouldExit = true;
            exitReason = hardInvalidation
              ? `Setup invalidated — price above VWAP, EMA(20) AND RSI(3)=${rsi3.toFixed(1)} (confirmed over 2 scans)`
              : `${(slProgress * 100).toFixed(0)}% to SL, RSI(3)=${rsi3.toFixed(1)} — no reversal (confirmed)`;
          } else {
            console.log(`  ⚠️  ${trade.symbol} SHORT — weak signal (scan ${trade._earlyExitWarnings}/2) | RSI: ${rsi3.toFixed(1)} | Watching next scan...`);
          }
        } else {
          if (trade._earlyExitWarnings > 0) {
            console.log(`  ✅ ${trade.symbol} SHORT — warning cleared, setup intact`);
            trade._earlyExitWarnings = 0;
          }
        }
      }

      if (shouldExit) {
        const lev = trade.leverage || CONFIG.leverage || 1;
        const pnlPct = tradeSide === "buy"
          ? ((currentPrice - trade.price) / trade.price * 100 * lev)
          : ((trade.price - currentPrice) / trade.price * 100 * lev);

        const isProfit  = pnlPct >= 0;
        trade.outcome   = isProfit ? "EARLY_EXIT_PROFIT" : "EARLY_EXIT_LOSS";
        trade.exitPrice = currentPrice;
        trade.closedAt  = new Date().toISOString();
        trade.exitReason = exitReason;
        trade.pnlPct    = pnlPct.toFixed(2);
        trade.pnlUSD    = (pnlPct / 100 * (trade.tradeSize || 0)).toFixed(2);

        // Update learning
        learning.totalTrades++;
        if (isProfit) learning.wins++; else learning.losses++;
        learning.winRate = parseFloat((learning.wins / learning.totalTrades * 100).toFixed(1));

        if (!learning.symbolStats[trade.symbol])
          learning.symbolStats[trade.symbol] = { wins: 0, losses: 0, winRate: 0 };
        const sym = learning.symbolStats[trade.symbol];
        if (isProfit) sym.wins++; else sym.losses++;
        sym.winRate = parseFloat((sym.wins / (sym.wins + sym.losses) * 100).toFixed(1));

        const emoji = isProfit ? "💰" : "✂️";
        console.log(`\n  ${emoji} EARLY EXIT — ${trade.symbol} (${trade.outcome})`);
        console.log(`     Reason:  ${exitReason}`);
        console.log(`     Entry:   $${trade.price} | Exit: $${currentPrice} | P&L: ${trade.pnlPct}%`);
        console.log(`     Saved: ~${((1 - slProgress) * CONFIG.stopLossPct).toFixed(2)}% vs waiting for full SL`);
        writeExitCsv(trade, log);

        // For live mode: place a market close order on BitGet
        if (!CONFIG.paperTrading) {
          try {
            await closePosition(trade.symbol, tradeSide, trade.quantity || (trade.tradeSize / trade.price));
          } catch (e) {
            console.log(`  ⚠️  Could not close live position: ${e.message}`);
          }
        }

        updated = true;
      }
    } catch (err) {
      // Don't crash — just skip this trade's early exit check
    }

    await new Promise(r => setTimeout(r, 600));
  }

  return updated;
}

// Close an open position on BitGet (live mode only)
async function closePosition(symbol, originalSide, quantity) {
  const closeSide = originalSide === "buy" ? "sell" : "buy";
  const timestamp = Date.now().toString();
  const path = CONFIG.tradeMode === "futures"
    ? "/api/v2/mix/order/placeOrder"
    : "/api/v2/spot/trade/placeOrder";

  const body = JSON.stringify({
    symbol,
    side: closeSide,
    orderType: "market",
    quantity: parseFloat(quantity).toFixed(6),
    ...(CONFIG.tradeMode === "futures" && {
      productType: "USDT-FUTURES",
      marginMode: "isolated",
      marginCoin: "USDT",
      reduceOnly: "YES",
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
  if (data.code !== "00000") throw new Error(`Close order failed: ${data.msg}`);
  return data;
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

// RSI(14) — standard momentum indicator for trend context
function calcRSI14(closes) { return calcRSI(closes, 14); }

// Volume trend — is volume increasing or decreasing over last N candles?
function calcVolumeTrend(candles, period = 5) {
  if (candles.length < period * 2) return { trend: "unknown", ratio: 1 };
  const recent = candles.slice(-period).reduce((s, c) => s + c.volume, 0) / period;
  const prior  = candles.slice(-period * 2, -period).reduce((s, c) => s + c.volume, 0) / period;
  const ratio  = prior > 0 ? recent / prior : 1;
  return { trend: ratio < 0.7 ? "exhaustion" : ratio > 1.3 ? "surging" : "normal", ratio: parseFloat(ratio.toFixed(2)) };
}

// Consecutive oversold candles — how many 4H candles in a row has RSI(3) been < threshold?
function calcOversoldStreak(candles, threshold = 10) {
  const closes = candles.map(c => c.close);
  let streak = 0;
  for (let i = candles.length - 1; i >= Math.max(0, candles.length - 20); i--) {
    const slice = closes.slice(0, i + 1);
    const rsi = calcRSI(slice, 3);
    if (rsi !== null && !isNaN(rsi) && rsi < threshold) streak++;
    else break;
  }
  return streak;
}

// Consecutive overbought candles — how many 4H candles in a row has RSI(3) been > threshold?
function calcOverboughtStreak(candles, threshold = 90) {
  const closes = candles.map(c => c.close);
  let streak = 0;
  for (let i = candles.length - 1; i >= Math.max(0, candles.length - 20); i--) {
    const slice = closes.slice(0, i + 1);
    const rsi = calcRSI(slice, 3);
    if (rsi !== null && !isNaN(rsi) && rsi > threshold) streak++;
    else break;
  }
  return streak;
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

function runSafetyCheck(price, ema8, ema20, ema50, vwap, rsi3, rsi14, rules, marketRegime) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    console.log(`  ${pass ? "✅" : "🚫"} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");

  const rsiThreshold  = rules._rsiThreshold  || 30;
  const vwapProximity = rules._vwapProximity || 1.5;
  const distFromVWAP  = Math.abs((price - vwap) / vwap) * 100;

  // ── Market Regime Override ──────────────────────────────────────────────
  // EXTREME BOUNCE MODE: RSI(3) < 5 for 3+ consecutive candles
  // → selling exhaustion → LONG snap-back to VWAP
  if (marketRegime?.mode === "extreme_bounce") {
    console.log(`  🔥 EXTREME BOUNCE MODE — RSI(3) exhausted for ${marketRegime.streak} candles`);
    console.log(`     Strategy: look for LONG snap-back to VWAP (mean reversion)\n`);

    check("RSI(3) in extreme exhaustion (< 5)",
      "< 5", rsi3.toFixed(2), rsi3 < 5);
    check("Price near or below VWAP (snap-back target above)",
      `≤ ${(vwap * 1.005).toFixed(2)}`, price.toFixed(2), price <= vwap * 1.005);
    check(`Price within 2% of VWAP (not too far to bounce)`,
      "< 2%", `${distFromVWAP.toFixed(2)}%`, distFromVWAP < 2.0);
    const volExhaustion = marketRegime.volumeTrend === "exhaustion";
    check("Volume drying up (sellers exhausted)",
      "exhaustion", marketRegime.volumeTrend, volExhaustion);

    const allPass = results.every(r => r.pass);
    return { results, allPass, bias: "extreme_bounce" };
  }

  // EXTREME RESISTANCE MODE: RSI(3) > 90 for 3+ consecutive candles
  // → buying exhaustion → SHORT snap-back to VWAP
  if (marketRegime?.mode === "extreme_resistance") {
    console.log(`  🔻 EXTREME RESISTANCE MODE — RSI(3) overbought for ${marketRegime.streak} candles`);
    console.log(`     Strategy: look for SHORT snap-back to VWAP (mean reversion)\n`);

    check("RSI(3) in extreme overbought (> 90)",
      "> 90", rsi3.toFixed(2), rsi3 > 90);
    check("Price near or above VWAP (snap-back target below)",
      `≥ ${(vwap * 0.995).toFixed(2)}`, price.toFixed(2), price >= vwap * 0.995);
    check(`Price within 2% of VWAP (not too far to snap back)`,
      "< 2%", `${distFromVWAP.toFixed(2)}%`, distFromVWAP < 2.0);
    const volExhaustion = marketRegime.volumeTrend === "exhaustion";
    check("Volume drying up (buyers exhausted)",
      "exhaustion", marketRegime.volumeTrend, volExhaustion);

    const allPass = results.every(r => r.pass);
    return { results, allPass, bias: "extreme_resistance" };
  }

  // ── Standard Momentum Mode ──────────────────────────────────────────────
  // Trend direction from EMA stack: 20 vs 50 is more reliable than EMA8 alone
  const ema20AboveEma50 = ema20 > ema50;
  const bullishBias = price > vwap && price > ema20 && ema20AboveEma50;
  const bearishBias = price < vwap && price < ema20 && !ema20AboveEma50;

  if (bullishBias) {
    console.log(`  Bias: BULLISH — EMA20 $${ema20.toFixed(2)} > EMA50 $${ema50.toFixed(2)}\n`);

    check("Price above VWAP (buyers in control)",
      `> ${vwap.toFixed(2)}`, price.toFixed(2), price > vwap);
    check("Price above EMA(20) + EMA(20) > EMA(50)",
      `> ${ema20.toFixed(2)}`, price.toFixed(2), price > ema20 && ema20AboveEma50);
    check(`RSI(3) below ${rsiThreshold} (pullback in uptrend)`,
      `< ${rsiThreshold}`, rsi3.toFixed(2), rsi3 < rsiThreshold);
    check(`Price within ${vwapProximity}% of VWAP`,
      `< ${vwapProximity}%`, `${distFromVWAP.toFixed(2)}%`, distFromVWAP < vwapProximity);

  } else if (bearishBias) {
    // Two SHORT entry modes:
    // A) Short the bounce  — RSI(3) bounced to >70, rejecting → fade the bounce
    // B) Momentum short    — RSI(3) < 50 + RSI(14) < 50 → short the trend continuation
    const shortBounce    = rsi3 > (100 - rsiThreshold);          // e.g. RSI(3) > 70
    const shortMomentum  = rsi3 < 50 && (rsi14 !== null && rsi14 < 50); // trend continuation

    if (shortBounce) {
      console.log(`  Bias: BEARISH 📉 (bounce rejection) — EMA20 $${ema20.toFixed(2)} < EMA50 $${ema50.toFixed(2)}\n`);
      check("Price below VWAP (sellers in control)",
        `< ${vwap.toFixed(2)}`, price.toFixed(2), price < vwap);
      check("EMA(20) < EMA(50) — downtrend confirmed",
        `< ${ema50.toFixed(2)}`, ema20.toFixed(2), !ema20AboveEma50);
      check(`RSI(3) overbought bounce (> ${100 - rsiThreshold}) — short the rejection`,
        `> ${100 - rsiThreshold}`, rsi3.toFixed(2), rsi3 > (100 - rsiThreshold));
      check(`Price within ${vwapProximity}% of VWAP`,
        `< ${vwapProximity}%`, `${distFromVWAP.toFixed(2)}%`, distFromVWAP < vwapProximity);

    } else if (shortMomentum) {
      console.log(`  Bias: BEARISH 📉 (momentum short) — EMA20 $${ema20.toFixed(2)} < EMA50 $${ema50.toFixed(2)}\n`);
      check("Price below VWAP (sellers in control)",
        `< ${vwap.toFixed(2)}`, price.toFixed(2), price < vwap);
      check("EMA(20) < EMA(50) — downtrend confirmed",
        `< ${ema50.toFixed(2)}`, ema20.toFixed(2), !ema20AboveEma50);
      check("RSI(3) below 50 — momentum confirming short",
        `< 50`, rsi3.toFixed(2), rsi3 < 50);
      check("RSI(14) below 50 — medium-term trend is bearish",
        `< 50`, (rsi14 !== null ? rsi14.toFixed(2) : "N/A"), rsi14 !== null && rsi14 < 50);
      check(`Price within ${vwapProximity}% of VWAP`,
        `< ${vwapProximity}%`, `${distFromVWAP.toFixed(2)}%`, distFromVWAP < vwapProximity);

    } else {
      console.log(`  Bias: BEARISH 📉 — RSI(3) ${rsi3.toFixed(1)} in no-trade zone (need <50 or >70)\n`);
      results.push({ label: "RSI entry signal", required: "< 50 or > 70", actual: rsi3.toFixed(2), pass: false });
    }

  } else {
    console.log(`  Bias: NEUTRAL — EMA20 $${ema20.toFixed(2)} | EMA50 $${ema50.toFixed(2)} | No clear edge\n`);
    results.push({ label: "Market bias", required: "Bullish or bearish", actual: "Neutral", pass: false });
  }

  const allPass = results.every(r => r.pass);
  const bias = bullishBias ? "bullish" : bearishBias ? "bearish" : "neutral";
  return { results, allPass, bias };
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

  console.log(
    `✅ Max trade size: $${CONFIG.maxTradeSizeUSD} — configured`,
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
  "Action",
  "Quantity",
  "Price",
  "Margin USD",
  "P&L USD",
  "P&L %",
  "Balance After",
  "Result",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

// Calculate running account balance from all closed trades in the log
function calcRunningBalance(log) {
  const start   = CONFIG.portfolioValue;  // $30
  const closedPnl = (log?.trades || [])
    .filter(t => t.outcome && t.pnlUSD != null)
    .reduce((sum, t) => sum + parseFloat(t.pnlUSD || 0), 0);
  return parseFloat((start + closedPnl).toFixed(2));
}

// Write a trade OPEN row
function writeTradeCsv(logEntry) {
  const now  = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let action = "", quantity = "", totalUSD = "", orderId = "", mode = "", notes = "";

  if (!logEntry.allPass) {
    const failed = (logEntry.conditions || []).filter(c => !c.pass).map(c => c.label).join("; ");
    action = "BLOCKED"; orderId = "BLOCKED"; mode = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else {
    const side = logEntry.side || "buy";
    const lev  = logEntry.leverage || CONFIG.leverage || 1;
    action   = side.toUpperCase() === "BUY" ? "OPEN LONG" : "OPEN SHORT";
    quantity = ((logEntry.tradeSize || 0) / logEntry.price).toFixed(6);
    totalUSD = (logEntry.tradeSize || 0).toFixed(2);
    orderId  = logEntry.orderId || "";
    mode     = logEntry.paperTrading ? "PAPER" : "LIVE";
    notes    = logEntry.isScalp
      ? `⚡ SCALP ${lev}x | SL $${logEntry.stopLoss || "-"} | TP $${logEntry.takeProfit || "-"}`
      : `${lev}x leverage | SL $${logEntry.stopLoss || "-"} | TP $${logEntry.takeProfit || "-"}`;
  }

  // Open rows: no P&L yet — leave those columns blank
  appendCsvRow([date, time, "BitGet", logEntry.symbol, action, quantity,
    logEntry.price.toFixed(2), totalUSD, "", "", "", "",
    orderId, mode, `"${notes}"`]);
}

// Write a trade CLOSE row — this is the one that shows the actual profit/loss
function writeExitCsv(trade, log) {
  const now     = new Date(trade.closedAt || new Date());
  const date    = now.toISOString().slice(0, 10);
  const time    = now.toISOString().slice(11, 19);
  const side    = trade.side || (trade.takeProfit > trade.price ? "buy" : "sell");
  const action  = side === "buy" ? "CLOSE LONG" : "CLOSE SHORT";
  const qty     = parseFloat(trade.quantity || (trade.tradeSize / trade.price)).toFixed(6);

  // P&L — pnlPct is already leverage-adjusted (e.g. 3% move × 10x = 30% of margin)
  const pnlPct  = parseFloat(trade.pnlPct || "0");
  // pnlUSD = leverage-adjusted % × margin (already stored on trade if available)
  const pnlUSD  = trade.pnlUSD != null
    ? parseFloat(trade.pnlUSD)
    : parseFloat((pnlPct / 100 * (trade.tradeSize || 0)).toFixed(2));

  // Running balance after this trade closes
  const balance = calcRunningBalance(log);

  // Visual result label
  const outcome = trade.outcome || "CLOSED";
  const isWin   = pnlUSD >= 0;
  const result  = isWin
    ? `✅ WIN +$${Math.abs(pnlUSD).toFixed(2)}`
    : `❌ LOSS -$${Math.abs(pnlUSD).toFixed(2)}`;

  const mode    = trade.paperTrading !== false ? "PAPER" : "LIVE";
  const notes   = trade.exitReason
    ? `${outcome}: ${trade.exitReason}`
    : outcome;

  appendCsvRow([
    date, time, "BitGet", trade.symbol, action, qty,
    (trade.exitPrice || trade.price).toFixed(2),
    (trade.tradeSize || 0).toFixed(2),
    (isWin ? "+" : "") + pnlUSD.toFixed(2),   // P&L USD  e.g. +3.75 or -1.88
    (isWin ? "+" : "") + pnlPct.toFixed(2) + "%", // P&L %
    "$" + balance,                              // Balance After
    `"${result}"`,                              // Result (WIN/LOSS with $)
    trade.orderId || "", mode, `"${notes}"`
  ]);

  console.log(`  📝 Logged → trades.csv | ${result} | Balance: $${balance}`);
}

function appendCsvRow(cols) {
  const row = cols.join(",");
  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  const writeWithRetry = (attempt) => {
    try {
      appendFileSync(CSV_FILE, row + "\n");
    } catch (e) {
      if (attempt >= 3) console.log(`  ⚠️  Could not write to trades.csv — ${e.message}`);
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

// ─── Confidence Engine ($10–$15 sizing based on 5-factor market confidence) ──
//
//  Scores the setup out of 100% across 5 independent factors, then maps
//  that confidence directly to a position size between $10 and $15.
//
//  Factors:
//   1. Lower-TF confirmation  (35 pts) — how many of 4 entry checks pass
//   2. RSI depth              (25 pts) — how far past the threshold
//   3. VWAP proximity         (15 pts) — closer to VWAP = more mean-reversion room
//   4. Symbol win rate        (15 pts) — this coin's historical performance
//   5. Overall strategy WR    (10 pts) — bot's rolling win rate
//
//  Final size = flat $15 (Option A — push for $60 target, keep strict entry rules)

function calcConfidence(symbol, bias, price, vwap, rsi3, entryConfirm, learning) {
  let score = 0;
  const breakdown = {};

  // ── 1. Lower-TF confirmation (max 35 pts) ──
  const ltfChecks = entryConfirm?.passCount ?? 3;
  const ltfPts = (ltfChecks / 4) * 35;
  score += ltfPts;
  breakdown.lowerTF = `${ltfChecks}/4 checks → ${ltfPts.toFixed(1)}pts`;

  // ── 2. RSI depth — how far past the entry threshold (max 25 pts) ──
  const rsiThreshold = learning.rsiEntryThreshold || 30;
  let rsiDepth = 0;
  if (rsi3 !== null && !isNaN(rsi3)) {
    if (bias === "bullish") {
      rsiDepth = Math.min(1, Math.max(0, (rsiThreshold - rsi3) / rsiThreshold));
    } else {
      const upper = 100 - rsiThreshold;
      rsiDepth = Math.min(1, Math.max(0, (rsi3 - upper) / (100 - upper)));
    }
  }
  const rsiPts = rsiDepth * 25;
  score += rsiPts;
  breakdown.rsi = `depth ${(rsiDepth * 100).toFixed(0)}% → ${rsiPts.toFixed(1)}pts`;

  // ── 3. VWAP proximity — closer = stronger mean-reversion signal (max 15 pts) ──
  const vwapDist   = Math.abs((price - vwap) / vwap) * 100;
  const vwapLimit  = learning.vwapProximityPct || 1.5;
  const vwapScore  = Math.max(0, 1 - vwapDist / vwapLimit);
  const vwapPts    = vwapScore * 15;
  score += vwapPts;
  breakdown.vwap = `${vwapDist.toFixed(2)}% from VWAP → ${vwapPts.toFixed(1)}pts`;

  // ── 4. Symbol-specific win rate from learning history (max 15 pts) ──
  const symStats = learning.symbolStats?.[symbol];
  const symTotal  = symStats ? symStats.wins + symStats.losses : 0;
  // Need at least 3 trades on this symbol before trusting its WR; default 50%
  const symWR    = symTotal >= 3 ? symStats.winRate / 100 : 0.50;
  const symPts   = symWR * 15;
  score += symPts;
  breakdown.symbolWR = symTotal >= 3
    ? `${symStats.winRate}% on ${symTotal} trades → ${symPts.toFixed(1)}pts`
    : `no history yet → default ${symPts.toFixed(1)}pts`;

  // ── 5. Overall bot win rate (max 10 pts) ──
  const overallWR = learning.totalTrades >= 5 ? learning.winRate / 100 : 0.55;
  const overallPts = overallWR * 10;
  score += overallPts;
  breakdown.overallWR = learning.totalTrades >= 5
    ? `${learning.winRate}% overall → ${overallPts.toFixed(1)}pts`
    : `new bot, default 55% → ${overallPts.toFixed(1)}pts`;

  // ── Final confidence % and trade size ──
  const confidencePct = Math.min(100, Math.round(score));
  // Option A: flat $15 per trade — maximise gains toward $60 target
  const finalSize  = Math.min(CONFIG.maxTradeSizeUSD, 15);

  return { finalSize, confidencePct, score: parseFloat(score.toFixed(1)), breakdown };
}

// ─── Multi-Timeframe Entry Confirmation ─────────────────────────────────────

async function confirmEntryOnLowerTF(symbol, bias, learning) {
  const entryTF = learning.entryTF || "15m";
  console.log(`\n  🔍 Checking ${entryTF} for precise entry...`);

  try {
    // Fetch lower TF candles
    const candles5m = await fetchCandles(symbol, entryTF, 100);
    const closes5m = candles5m.map(c => c.close);
    const price5m = closes5m[closes5m.length - 1];

    const ema8_5m = calcEMA(closes5m, 8);
    const vwap5m = calcVWAP(candles5m);
    const rsi3_5m = calcRSI(closes5m, 3);

    if (!vwap5m || rsi3_5m === null || isNaN(rsi3_5m)) {
      console.log(`  ⚠️  Lower TF data unavailable — using 4H entry only`);
      return { confirmed: true, reason: "Lower TF unavailable — 4H entry used" };
    }

    const lastCandle = candles5m[candles5m.length - 1];
    const prevCandle = candles5m[candles5m.length - 2];
    const confirmationCandle = bias === "bullish"
      ? lastCandle.close > lastCandle.open   // bullish candle
      : lastCandle.close < lastCandle.open;  // bearish candle

    const distFromVwap5m = Math.abs((price5m - vwap5m) / vwap5m) * 100;
    const rsiThreshold = learning.rsiEntryThreshold || 30;

    const checks = {
      rsiOversold: bias === "bullish" ? rsi3_5m < rsiThreshold : rsi3_5m > (100 - rsiThreshold),
      nearVwap: distFromVwap5m < (learning.vwapProximityPct || 1.5),
      confirmCandle: confirmationCandle,
      emaAligned: bias === "bullish" ? price5m > ema8_5m : price5m < ema8_5m,
    };

    console.log(`  ${entryTF} Price: $${price5m.toFixed(2)} | EMA8: $${ema8_5m.toFixed(2)} | VWAP: $${vwap5m.toFixed(2)} | RSI: ${rsi3_5m.toFixed(1)}`);
    console.log(`  ${checks.rsiOversold ? "✅" : "🚫"} RSI(3) ${bias === "bullish" ? "< " + rsiThreshold : "> " + (100 - rsiThreshold)} on ${entryTF} — actual: ${rsi3_5m.toFixed(1)}`);
    console.log(`  ${checks.nearVwap ? "✅" : "🚫"} Within ${learning.vwapProximityPct || 1.5}% of ${entryTF} VWAP — actual: ${distFromVwap5m.toFixed(2)}%`);
    console.log(`  ${checks.confirmCandle ? "✅" : "🚫"} ${bias === "bullish" ? "Bullish" : "Bearish"} confirmation candle on ${entryTF}`);
    console.log(`  ${checks.emaAligned ? "✅" : "🚫"} Price ${bias === "bullish" ? "above" : "below"} EMA(8) on ${entryTF}`);

    // Need at least 3 of 4 lower TF checks to pass
    const passCount = Object.values(checks).filter(Boolean).length;
    const confirmed = passCount >= 3;

    return {
      confirmed,
      passCount,
      checks,
      entryTF,
      rsi: rsi3_5m,
      reason: confirmed
        ? `${entryTF} entry confirmed (${passCount}/4 checks passed)`
        : `${entryTF} entry rejected (only ${passCount}/4 checks passed — waiting for better entry)`
    };
  } catch (err) {
    console.log(`  ⚠️  Lower TF check failed: ${err.message} — proceeding with 4H entry`);
    return { confirmed: true, reason: "Lower TF error — 4H entry used" };
  }
}

// ─── Analyse one symbol ──────────────────────────────────────────────────────

async function analyseSymbol(symbol, rules, log, learning) {
  console.log(`\n${"─".repeat(57)}`);
  console.log(`  📊 ${symbol}`);
  console.log(`${"─".repeat(57)}\n`);

  // Concurrent trade limit — protect capital
  const openCount = countOpenTrades(log);
  if (openCount >= CONFIG.maxConcurrentTrades) {
    console.log(`\n  ⏸️  ${openCount}/${CONFIG.maxConcurrentTrades} trades already open — skipping ${symbol}`);
    return null;
  }

  // Per-symbol risk sizing
  // symbolRiskPct acts as a multiplier on MAX_TRADE_SIZE_USD:
  //   1.0 → full size ($12.5), 0.5 → half size ($6.25)
  const riskMultiplier = CONFIG.symbolRiskPct[symbol] ?? 1.0;
  const tradeSize = parseFloat((CONFIG.maxTradeSizeUSD * riskMultiplier).toFixed(2));

  // Fetch candles
  const candles = await fetchCandles(symbol, CONFIG.timeframe, 500);
  const closes  = candles.map(c => c.close);
  const price   = closes[closes.length - 1];

  const ema8  = calcEMA(closes, 8);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const vwap  = calcVWAP(candles);
  const rsi3  = calcRSI(closes, 3);
  const rsi14 = calcRSI14(closes);
  const volTrend = calcVolumeTrend(candles, 5);

  // ── Market Regime Detection ──────────────────────────────────────────────
  // Extreme bounce:     RSI(3) < 5  for 3+ candles = selling exhaustion → LONG
  // Extreme resistance: RSI(3) > 90 for 3+ candles = buying exhaustion  → SHORT
  const oversoldStreak   = calcOversoldStreak(candles, 5);
  const overboughtStreak = calcOverboughtStreak(candles, 90);
  const extremeBounce    = oversoldStreak >= 3 && rsi3 < 5;
  const extremeResist    = overboughtStreak >= 3 && rsi3 > 90;
  const marketRegime     = extremeBounce
    ? { mode: "extreme_bounce",     streak: oversoldStreak,   volumeTrend: volTrend.trend }
    : extremeResist
    ? { mode: "extreme_resistance", streak: overboughtStreak, volumeTrend: volTrend.trend }
    : { mode: "standard", streak: 0, volumeTrend: volTrend.trend };

  const trendPct = ema50 > 0 ? ((ema20 - ema50) / ema50 * 100).toFixed(2) : "0";
  const regimeLabel = extremeBounce   ? `🔥 EXTREME BOUNCE (oversold ${oversoldStreak} candles)`
                    : extremeResist   ? `🔻 EXTREME RESISTANCE (overbought ${overboughtStreak} candles)`
                    : "📊 Standard";

  console.log(`  Price:    $${price.toFixed(2)}`);
  console.log(`  EMA8/20/50: $${ema8.toFixed(2)} / $${ema20.toFixed(2)} / $${ema50.toFixed(2)}  (trend: ${parseFloat(trendPct) > 0 ? "+" : ""}${trendPct}%)`);
  console.log(`  VWAP:     $${vwap ? vwap.toFixed(2) : "N/A"}`);
  console.log(`  RSI(3):   ${rsi3 !== null && !isNaN(rsi3) ? rsi3.toFixed(2) : "N/A"}  |  RSI(14): ${rsi14 !== null && !isNaN(rsi14) ? rsi14.toFixed(2) : "N/A"}`);
  console.log(`  Volume:   ${volTrend.trend} (ratio ${volTrend.ratio}x vs prior 5 candles)`);
  console.log(`  Regime:   ${regimeLabel}`);
  console.log(`  Size:     $${tradeSize.toFixed(2)}`);

  if (vwap === null || vwap === undefined || isNaN(vwap) ||
      rsi3 === null || rsi3 === undefined || isNaN(rsi3)) {
    console.log(`\n  ⚠️  Skipping ${symbol} — VWAP: ${vwap}, RSI: ${rsi3}`);
    return null;
  }

  // Use adaptive thresholds from learning system
  const adaptedRules = {
    ...rules,
    _rsiThreshold: learning.rsiEntryThreshold || 30,
    _vwapProximity: learning.vwapProximityPct || 1.5,
  };

  const { results, allPass, bias } = runSafetyCheck(
    price, ema8, ema20, ema50, vwap, rsi3, rsi14, adaptedRules, marketRegime
  );

  console.log(`\n  Safety Check (RSI threshold: ${adaptedRules._rsiThreshold}, VWAP proximity: ${adaptedRules._vwapProximity}%):`);
  results.forEach(r => console.log(`  ${r.pass ? "✅" : "🚫"} ${r.label}`));

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol,
    timeframe: CONFIG.timeframe,
    price,
    indicators: { ema8, ema20, ema50, vwap, rsi3, rsi14, volumeTrend: volTrend },
    marketRegime,
    conditions: results,
    allPass,
    bias,
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
    // ── Step 2: Multi-timeframe entry confirmation ──
    const entryConfirm = await confirmEntryOnLowerTF(symbol, bias, learning);
    logEntry.entryConfirmation = entryConfirm;

    if (!entryConfirm.confirmed) {
      console.log(`\n  ⏳ 4H CONDITIONS MET — but ${entryConfirm.reason}`);
      console.log(`     Waiting for better entry on ${entryConfirm.entryTF}...`);
      logEntry.allPass = false;
      logEntry.blockedReason = entryConfirm.reason;
    } else {
      // ── Confidence engine: $10-$15 based on 5-factor market confidence ──
      const conf = calcConfidence(symbol, bias, price, vwap, rsi3, entryConfirm, learning);
      const finalTradeSize = conf.finalSize;
      logEntry.tradeSize = finalTradeSize;
      logEntry.confidence = conf;

      console.log(`\n  ✅ ALL CONDITIONS MET — ${entryConfirm.reason}`);
      console.log(`\n  🧠 CONFIDENCE — ${conf.confidencePct}% | Size: $${finalTradeSize} (flat — Option A)`);
      Object.entries(conf.breakdown).forEach(([k, v]) =>
        console.log(`     ${k.padEnd(12)}: ${v}`)
      );
      console.log(`     ${"─".repeat(44)}`)
      console.log(`     Total score : ${conf.score}/100 → size $${finalTradeSize}`);
      const side = (bias === "bearish" || bias === "extreme_resistance") ? "sell" : "buy";

      if (CONFIG.paperTrading) {
        const { stopLoss, takeProfit } = calcSlTp(price, side);
        const lev = CONFIG.leverage;
        const positionUSD = finalTradeSize * lev;
        const riskUSD   = Math.abs(price - stopLoss)   / price * positionUSD;
        const rewardUSD = Math.abs(takeProfit - price)  / price * positionUSD;
        console.log(`\n  📋 PAPER TRADE — ${side.toUpperCase()} ${symbol}`);
        console.log(`     Margin:      $${finalTradeSize} × ${lev}x = $${positionUSD.toFixed(2)} position`);
        console.log(`     Entry:       $${price.toFixed(2)}`);
        console.log(`     Stop Loss:   $${stopLoss.toFixed(2)}  (-${CONFIG.stopLossPct}%) → risk  $${riskUSD.toFixed(2)}`);
        console.log(`     Take Profit: $${takeProfit.toFixed(2)}  (+${(CONFIG.stopLossPct * CONFIG.rrRatio).toFixed(1)}%) → reward $${rewardUSD.toFixed(2)}`);
        console.log(`     R:R Ratio:   1:${CONFIG.rrRatio}`);
        logEntry.orderPlaced = true;
        logEntry.orderId = `PAPER-${Date.now()}`;
        logEntry.stopLoss = stopLoss;
        logEntry.takeProfit = takeProfit;
        logEntry.side = side;
        logEntry.quantity = finalTradeSize / price;
        logEntry.leverage = CONFIG.leverage;
      } else {
        console.log(`\n  🔴 PLACING LIVE ORDER — $${finalTradeSize.toFixed(2)} ${side.toUpperCase()} ${symbol}`);
        try {
          const order = await placeBitGetOrder(symbol, side, finalTradeSize, price);
          logEntry.orderPlaced = true;
          logEntry.orderId = order.orderId;
          logEntry.stopLoss = order.stopLoss;
          logEntry.takeProfit = order.takeProfit;
          logEntry.side = side;
          logEntry.quantity = finalTradeSize / price;
          console.log(`  ✅ ORDER PLACED — ${order.orderId}`);
          console.log(`  🛡️  SL: $${order.stopLoss} | TP: $${order.takeProfit}`);
        } catch (err) {
          console.log(`  ❌ ORDER FAILED — ${err.message}`);
          logEntry.error = err.message;
        }
      }
    }
  }

  return logEntry;
}

// ─── Scalp Scanner (5m chart) ────────────────────────────────────────────────
//
//  Runs after the main 4H scan on every symbol.
//  Looks for high-probability micro setups on the 5m chart:
//    LONG scalp: RSI(3) < 20 + price at VWAP + volume surge + bullish candle
//    SHORT scalp: RSI(3) > 80 + price at VWAP + volume surge + bearish candle
//
//  Scalp params: $10 margin × 10x = $100 position | SL 0.25% | TP 0.50% (2:1 RR)
//  Max 3 scalps/day | Only fires if total open margin stays under $25

function countOpenMargin(log) {
  return log.trades
    .filter(t => t.orderPlaced && !t.outcome)
    .reduce((sum, t) => sum + (t.tradeSize || 0), 0);
}

async function scanForScalps(symbol, log, learning) {
  // Don't scalp if margin budget is full ($25 cap)
  const openMargin = countOpenMargin(log);
  if (openMargin + 10 > 25) return null;

  // Max 3 scalps/day
  const today = new Date().toISOString().slice(0, 10);
  const scalpsToday = log.trades.filter(t =>
    t.timestamp.startsWith(today) && t.isScalp && t.orderPlaced
  ).length;
  if (scalpsToday >= 3) return null;

  // No existing open trade on this symbol
  const openOnSymbol = log.trades.filter(t =>
    t.symbol === symbol && t.orderPlaced && !t.outcome
  ).length;
  if (openOnSymbol > 0) return null;

  try {
    const candles5m = await fetchCandles(symbol, "5m", 60);
    const closes5m  = candles5m.map(c => c.close);
    const price     = closes5m[closes5m.length - 1];
    const ema8_5m   = calcEMA(closes5m, 8);
    const vwap5m    = calcVWAP(candles5m);
    const rsi3_5m   = calcRSI(closes5m, 3);

    if (!vwap5m || rsi3_5m === null || isNaN(rsi3_5m)) return null;

    const lastC  = candles5m[candles5m.length - 1];
    const avgVol = candles5m.slice(-6, -1).reduce((s, c) => s + c.volume, 0) / 5;
    const volRatio   = avgVol > 0 ? lastC.volume / avgVol : 1;
    const volSurge   = volRatio >= 1.5;
    const distVwap   = Math.abs((price - vwap5m) / vwap5m) * 100;
    const bullCandle = lastC.close > lastC.open;
    const bearCandle = lastC.close < lastC.open;

    let scalpBias = null;
    let reason    = "";

    // ── LONG scalp: extreme 5m oversold + at VWAP + volume spike + bullish reversal candle ──
    if (rsi3_5m < 20 && price <= vwap5m * 1.003 && distVwap < 0.6 && volSurge && bullCandle) {
      scalpBias = "buy";
      reason = `5m RSI(3)=${rsi3_5m.toFixed(1)} oversold + vol surge ${volRatio.toFixed(1)}x + bullish reversal candle`;
    }

    // ── SHORT scalp: extreme 5m overbought + at VWAP + volume spike + bearish reversal candle ──
    if (rsi3_5m > 80 && price >= vwap5m * 0.997 && distVwap < 0.6 && volSurge && bearCandle) {
      scalpBias = "sell";
      reason = `5m RSI(3)=${rsi3_5m.toFixed(1)} overbought + vol surge ${volRatio.toFixed(1)}x + bearish reversal candle`;
    }

    if (!scalpBias) return null;

    // Scalp always uses $10 margin (minimum, safe sizing)
    const scalpSize  = 10;
    const scalpSlPct = 0.25;
    const scalpTpPct = 0.50;
    const lev        = CONFIG.leverage;
    const posUSD     = scalpSize * lev;

    const stopLoss   = scalpBias === "buy"
      ? parseFloat((price * (1 - scalpSlPct / 100)).toFixed(4))
      : parseFloat((price * (1 + scalpSlPct / 100)).toFixed(4));
    const takeProfit = scalpBias === "buy"
      ? parseFloat((price * (1 + scalpTpPct / 100)).toFixed(4))
      : parseFloat((price * (1 - scalpTpPct / 100)).toFixed(4));

    const riskUSD   = posUSD * scalpSlPct / 100;
    const rewardUSD = posUSD * scalpTpPct / 100;

    console.log(`\n  ⚡ SCALP SIGNAL — ${scalpBias.toUpperCase()} ${symbol}`);
    console.log(`     ${reason}`);
    console.log(`     5m: Price $${price.toFixed(2)} | VWAP $${vwap5m.toFixed(2)} | EMA8 $${ema8_5m.toFixed(2)}`);
    console.log(`     Margin: $${scalpSize} × ${lev}x = $${posUSD} position`);
    console.log(`     SL: $${stopLoss} (-${scalpSlPct}%) → risk $${riskUSD.toFixed(2)}`);
    console.log(`     TP: $${takeProfit} (+${scalpTpPct}%) → reward $${rewardUSD.toFixed(2)}`);
    console.log(`     Scalps today: ${scalpsToday}/3 | Open margin: $${openMargin}`);

    const logEntry = {
      timestamp:    new Date().toISOString(),
      symbol,
      timeframe:    "5m",
      isScalp:      true,
      price,
      side:         scalpBias,
      tradeSize:    scalpSize,
      leverage:     lev,
      stopLoss,
      takeProfit,
      quantity:     scalpSize / price,
      orderPlaced:  false,
      orderId:      null,
      paperTrading: CONFIG.paperTrading,
      scalpReason:  reason,
      conditions:   [{ label: "Scalp signal", pass: true }],
      allPass:      true,
      bias:         scalpBias,
    };

    if (CONFIG.paperTrading) {
      logEntry.orderPlaced = true;
      logEntry.orderId     = `SCALP-${Date.now()}`;
      console.log(`\n  📋 PAPER SCALP LOGGED ✅`);
    } else {
      try {
        const order = await placeBitGetOrder(symbol, scalpBias, scalpSize, price);
        logEntry.orderPlaced  = true;
        logEntry.orderId      = order.orderId;
        logEntry.stopLoss     = order.stopLoss;
        logEntry.takeProfit   = order.takeProfit;
        console.log(`  ✅ SCALP ORDER PLACED — ${order.orderId}`);
      } catch (err) {
        console.log(`  ❌ SCALP FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }

    return logEntry;
  } catch (err) {
    // Silently skip — scalps are opportunistic, not critical
    return null;
  }
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

  // Load learning system
  const learning = loadLearning();
  console.log(`🧠 Learning: Win rate ${learning.winRate}% over ${learning.totalTrades} trades | RSI threshold: ${learning.rsiEntryThreshold} | VWAP proximity: ${learning.vwapProximityPct}%`);

  // Load log and check daily limits
  const log = loadLog();

  // ── Check outcomes of open paper trades ──
  const currentPrices = {};
  for (const symbol of CONFIG.symbols) {
    try {
      const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
      const data = await res.json();
      currentPrices[symbol] = parseFloat(data.price);
    } catch { /* ignore */ }
  }
  // Check SL/TP hits
  const outcomesUpdated = updateTradeOutcomes(log, learning, currentPrices);

  // Check early exit conditions on all open trades
  const earlyExitUpdated = await checkEarlyExits(log, learning, currentPrices);

  if (outcomesUpdated || earlyExitUpdated) {
    saveLog(log);
    saveLearning(learning);
    if (earlyExitUpdated) adaptThresholds(log, learning);
  }

  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  // Scan every symbol
  for (const symbol of CONFIG.symbols) {
    try {
      const logEntry = await analyseSymbol(symbol, rules, log, learning);
      if (logEntry) {
        log.trades.push(logEntry);
        saveLog(log);
        writeTradeCsv(logEntry);
        if (!checkTradeLimits(log)) {
          console.log("\n⛔ Daily trade limit reached — stopping scan.");
          break;
        }
      }
    } catch (err) {
      console.log(`\n⚠️  Error scanning ${symbol}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 1200));
  }

  // ── Scalp Scanner — runs after main strategy ──────────────────────────────
  console.log(`\n── ⚡ Scalp Scanner (5m) ${"─".repeat(35)}\n`);
  let scalpsFound = 0;
  for (const symbol of CONFIG.symbols) {
    try {
      const scalpEntry = await scanForScalps(symbol, log, learning);
      if (scalpEntry) {
        scalpsFound++;
        log.trades.push(scalpEntry);
        saveLog(log);
        writeTradeCsv(scalpEntry);
      } else {
        console.log(`  ${symbol}: no scalp setup right now`);
      }
    } catch (err) {
      console.log(`  ⚠️  Scalp error ${symbol}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 600));
  }
  if (scalpsFound === 0) console.log(`\n  No scalp opportunities this scan.`);

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
