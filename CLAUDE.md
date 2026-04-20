# Claude Trading Bot — Project Notes

## 🔑 Special Keywords

### "Project Lelouch"
When the user says **"Project Lelouch"**, immediately prepare a laptop migration backup package:

1. Copy these 3 files into a new folder called `bot-backup/`:
   - `trades.csv` — full trade history & P&L log
   - `learning.json` — bot's brain (win rates, lessons, cooldowns, thresholds)
   - `.env` — API keys and local settings (remind user to keep this private)

2. Zip the folder if possible, or list exact paths so user can copy manually

3. Provide the full new-laptop setup guide:
   - Install Git, Node.js (LTS), Claude Code
   - `git clone https://github.com/LelouchViZer/claude-tradingview-mcp-trading.git`
   - `npm install`
   - Paste the 3 backed-up files into the folder
   - Railway keeps running — just log in at railway.app
   - Re-open project in Claude Code

---

## 🤖 Bot Overview

- **Runs on**: Railway (cloud, 24/7) — cron every 15 min
- **GitHub**: `LelouchViZer/claude-tradingview-mcp-trading`
- **Mode**: Paper trading (PAPER_TRADING=true) — 2-3 day stress test ending ~April 22-23
- **Portfolio**: $1,500 paper capital
- **Risk per trade**: 5% = $75 max loss per trade
- **Leverage**: 5x–25x dynamic (confidence-based)
- **Symbols**: BTCUSDT, ETHUSDT, SOLUSDT, XAUTUSDT, BNBUSDT
- **Daily report**: Telegram every morning with P&L summary

## 📁 Key Files

| File | Purpose |
|---|---|
| `bot.js` | Main bot — all strategy, indicators, CSV, learning logic |
| `.env` | Local config (gitignored — keep private) |
| `trades.csv` | Trade log — open in Excel anytime |
| `learning.json` | Adaptive brain — lessons, cooldowns, thresholds |
| `railway.json` | Railway deploy config (15-min cron) |

## ⚙️ Railway Environment Variables

```
BITGET_API_KEY=bg_136c27ec4130f7d734758650938a2b0f
BITGET_SECRET_KEY=200adf861e3231704e0110ddcc4dc75591297bca68f83aba15f6e3531022a939
BITGET_PASSPHRASE=Sihak112299
BITGET_BASE_URL=https://api.bitget.com
TRADE_MODE=futures
LEVERAGE=25
MIN_LEVERAGE=5
PORTFOLIO_VALUE_USD=1500
RISK_PER_TRADE_PCT=5.0
MAX_TRADES_PER_DAY=15
MAX_CONCURRENT_TRADES=5
SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT,XAUTUSDT,BNBUSDT
TIMEFRAME=4H
PAPER_TRADING=true
STOP_LOSS_PCT=1.5
RR_RATIO=2.0
TELEGRAM_BOT_TOKEN=8796892938:AAHH61KCp6VkJ0OxAXSjtdcLA3chs2kqq6A
TELEGRAM_CHAT_ID=2115369211
```

---

## 🏁 Go-Live Checklist (April 22–23 Review)

The bot has 2-3 days to prove itself on paper. Review these metrics before switching to real money:

### ✅ Green Light — Go Live
- [ ] Win rate ≥ 55% over at least 10 trades
- [ ] Profit factor ≥ 1.5 (total $ won ÷ total $ lost)
- [ ] No single day lost more than 10% of portfolio (max drawdown)
- [ ] Bot is actively finding entries (not too conservative/blocked)
- [ ] Futures trading enabled on BitGet
- [ ] Futures wallet funded with USDT
- [ ] Set leverage to 25x on all contracts in BitGet app

### ⚠️ Keep Paper Trading If:
- Win rate < 50% after 15+ trades
- Strategy is only entering 1-2 trades per day (too conservative)
- Any bug or unexpected behaviour observed

### 🔴 Scale Back Leverage If:
- Win rate < 45% — drop back to 10x max, 3% risk
- 3+ consecutive losses — bot auto-cooldowns symbols, but reduce risk manually too

### 🚀 To Go Live:
Update ONE variable on Railway:
```
PAPER_TRADING=false
```

---

## 📊 Current Strategy Settings

| Parameter | Value | Notes |
|---|---|---|
| Risk/trade | 5% = $75 | Max loss per trade |
| Leverage | 5x–25x | Scales with confidence |
| Win = | +$150 | At 2:1 RR, 25x |
| Extreme win = | +$300 | At 4:1 RR (deep bounce) |
| Stop loss | 1.5% price move | Fixed |
| Concurrent trades | Up to 5 | Capital: ~$1,000–1,500 deployed |
| Daily Telegram | Every morning | P&L + win rate |
