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
- **Mode**: Paper trading (PAPER_TRADING=true) until April 23rd review
- **Target**: $30 → $60 in 3 days (Option A: flat $15 trades, 5 symbols)
- **Leverage**: 10x futures on BitGet
- **Symbols**: BTCUSDT, ETHUSDT, SOLUSDT, XAUTUSDT, BNBUSDT

## 📁 Key Files

| File | Purpose |
|---|---|
| `bot.js` | Main bot — all strategy, indicators, CSV, learning logic |
| `.env` | Local config (gitignored — keep private) |
| `.env.futures` | Futures config ready for April 23rd activation |
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
LEVERAGE=10
PORTFOLIO_VALUE_USD=30
MAX_TRADE_SIZE_USD=15
MAX_TRADES_PER_DAY=10
MAX_CONCURRENT_TRADES=2
SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT,XAUTUSDT,BNBUSDT
TIMEFRAME=4H
PAPER_TRADING=true
STOP_LOSS_PCT=1.5
RR_RATIO=2.0
```

## 📅 April 23rd Activation Checklist (Go Live)
- [ ] Paper win rate ≥ 55%
- [ ] Futures trading enabled on BitGet
- [ ] Futures wallet funded with USDT
- [ ] Set leverage to 10x on all contracts in BitGet
- [ ] Update Railway: PAPER_TRADING=false
