import cron from "node-cron";
import express from "express";
import axios from "axios";
import { getISTMidnightFakeUTCString } from "#utils/dayChecker";
import sequelize from "#configs/database";
import { main, getSpecificCachedOption } from "#utils/assetChecker";
import BrokerKey from "#models/brokerKey";
import Broker from "#models/broker";
import TradeLog from "#models/tradeLog";
import qs from "qs";
import logger, { logInfo, logWarn, logError } from "./utils/logger.js";

// Bootstrap
try {
  await sequelize.authenticate();
  logInfo("Database connected", { dialect: sequelize.getDialect && sequelize.getDialect() });
} catch (e) {
  logError("Database connection failed", e);
  process.exit(1);
}
await main();

const server = express();

let dailyAsset = null;
let keys = null;
let adminKeys = null;
let dailyLevels = null;

const dayMap = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
};

// Helper to format to Kite-compatible IST timestamp: "YYYY-MM-DD HH:mm:00"
function toKiteISTFormat(dateObj) {
  const local = new Date(dateObj.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const yyyy = local.getFullYear();
  const mm = String(local.getMonth() + 1).padStart(2, "0");
  const dd = String(local.getDate()).padStart(2, "0");
  const hh = String(local.getHours()).padStart(2, "0");
  const min = String(local.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:00`;
}

async function exitOpenTrades(targetKeys) {
  for (let key of targetKeys) {
    const placeIntradayOrder = async ({
      exchange = "NSE",
      tradingsymbol,
      transaction_type = "BUY",
      quantity = 1,
      accessToken = key.token,
      apiKey = key.apiKey,
    }) => {
      try {
        const data = qs.stringify({
          tradingsymbol,
          exchange,
          transaction_type,
          order_type: "MARKET",
          quantity,
          product: "MIS",
          validity: "DAY",
        });
        const headers = {
          "X-Kite-Version": "3",
          Authorization: `token ${apiKey}:${accessToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
        };
        const response = await axios.post("https://api.kite.trade/orders/regular", data, { headers });
        logInfo("Order placed (exitOpenTrades)", {
          brokerKeyId: key.id,
          side: transaction_type,
          qty: quantity,
          tradingsymbol,
          order_id: response?.data?.data?.order_id,
        });
        return response.data;
      } catch (err) {
        logError("Order placement failed (exitOpenTrades)", err, {
          brokerKeyId: key.id,
          tradingsymbol,
          side: transaction_type,
          qty: quantity,
        });
        // proceed regardless to deactivate
      }
    };

    const newOrder = async (data) => {
      data.transaction_type = "BUY";
      return await placeIntradayOrder(data);
    };
    const exitOrder = async (data) => {
      data.transaction_type = "SELL";
      return await placeIntradayOrder(data);
    };

    try {
      const lastTrade = await TradeLog.findDoc({ brokerKeyId: key.id, type: "entry" }, { allowNull: true });
      if (!lastTrade) {
        if (!key.status) continue;
        key.status = false;
        await key.save();
        logInfo("Marking key as inactive (no open trade at close)", { brokerKeyId: key.id });
        continue;
      }
      const exitOrderData = {
        exchange: lastTrade.asset.split(":"),
        tradingsymbol: lastTrade.asset.split(":")[11] || lastTrade.asset.split(":")[12],
        quantity: lastTrade.quantity,
        accessToken: key.token,
        apiKey: key.apiKey,
      };
      logInfo("Exiting last trade, closing time", { brokerKeyId: key.id, asset: lastTrade.asset, qty: lastTrade.quantity });
      await exitOrder(exitOrderData);
      lastTrade.type = "exit";
      await lastTrade.save();
      key.status = false;
      await key.save();
      logInfo("Marked key inactive after exiting last trade", { brokerKeyId: key.id });
    } catch (e) {
      logError("exitOpenTrades failed", e, { brokerKeyId: key?.id });
    }
  }
}

// Flags for two lightweight crons
let isRunning3Min = false;
let isRunning5Min = false;

// Shared trading logic (small cron pattern)
async function runTradingLogic({ intervalMinutes, intervalString }) {
  const istNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const istHour = istNow.getHours();
  const istMinute = istNow.getMinutes();
  const second = istNow.getSeconds();

  const preRange =
    (istHour === 8 && istMinute >= 30) || (istHour > 8 && istHour < 15) || (istHour === 15 && istMinute <= 30);
  const isInMarketRange =
    (istHour === 9 && istMinute >= 30) || (istHour > 9 && istHour < 15) || (istHour === 15 && istMinute <= 15);

  if (!preRange && !isInMarketRange) return;

  // Preload shared state
  if (preRange) {
    if (!dailyLevels) {
      const [dailyData] = await sequelize.query(
        `SELECT * FROM "DailyLevels" WHERE "forDay" = '${getISTMidnightFakeUTCString()}'`
      );
      dailyLevels = Array.isArray(dailyData) ? dailyData : dailyData;
      logInfo("Loaded dailyLevels", { present: !!dailyLevels });
    }
    if (!dailyAsset) {
      const day = dayMap[istNow.getDay()];
      const [response] = await sequelize.query(
        `SELECT "name", "zerodhaToken","Assets"."id" FROM "DailyAssets"
         INNER JOIN "Assets" ON "DailyAssets"."assetId" = "Assets"."id"
         WHERE "day" = '${day}'`
      );
      if (!response.length) {
        logWarn("❌ No asset available for today", { day });
        return;
      }
      dailyAsset = response;
      logInfo("Loaded dailyAsset", { name: dailyAsset?.name, token: dailyAsset?.zerodhaToken });
    }
    if (!keys || !adminKeys || (istMinute % 1 === 0 && second % 40 === 0)) {
      const responseKeys = await BrokerKey.findAll({
        include: [{ model: Broker, where: { name: "Zerodha" } }],
        where: { status: true },
      });
      const [admin] = await sequelize.query(
        `SELECT * FROM "BrokerKeys"
       INNER JOIN "Users" ON "BrokerKeys"."userId" = "Users"."id"
       INNER JOIN "Brokers" ON "BrokerKeys"."brokerId" = "Brokers"."id"
       WHERE "Users"."role" = 'admin' AND "Brokers"."name" = 'Zerodha'`
      );
      adminKeys = Array.isArray(admin) ? admin : admin;
      keys = responseKeys;
      logInfo("Refreshed keys/adminKeys", { keysCount: Array.isArray(keys) ? keys.length : 0, hasAdmin: !!adminKeys });
    }
  }

  // Hard exit time
  if (istHour === 15 && istMinute === 15) {
    logInfo("Hard exit time — exiting open trades");
    return await exitOpenTrades(keys || []);
  }

  // Low cadence fetch; minute/second guards applied later
  if (isInMarketRange && second % 10 === 0) {
    const toTime = toKiteISTFormat(istNow);
    const fromTime = toKiteISTFormat(new Date(istNow.getTime() - intervalMinutes * 60 * 1000));
    const instrumentToken = dailyAsset.zerodhaToken;
    const interval = intervalString;
    const apiKey = adminKeys.apiKey;
    const accessToken = adminKeys.token;

    const url = `https://api.kite.trade/instruments/historical/${instrumentToken}/${interval}?from=${encodeURIComponent(
      fromTime
    )}&to=${encodeURIComponent(toTime)}&continuous=false`;

    let dataObj;
    try {
      const response = await axios.get(url, {
        headers: {
          "X-Kite-Version": "3",
          Authorization: `token ${apiKey}:${accessToken}`,
        },
      });
      dataObj = response?.data?.data;
    } catch (e) {
      logError("Historical data fetch failed", e, { instrumentToken, interval, fromTime, toTime });
      return;
    }

    if (!dataObj || !Array.isArray(dataObj.candles) || dataObj.candles.length === 0) {
      logWarn("⚠️ No candle data available", { instrumentToken, interval, fromTime, toTime });
      return;
    }

    const latestCandle = dataObj.candles[dataObj.candles.length - 1];
    // Kite candles: [time, open, high, low, close, volume]
    const price = latestCandle?.[13];
    if (price === null || price === undefined) {
      logWarn("⚠️ Invalid Price", { latestCandle });
      return;
    }

    const { bc, tc, r1, r2, r3, r4, s1, s2, s3, s4 } = dailyLevels;
    const BUFFER = dailyLevels.buffer;

    let signal = "No Action";
    let reason = "Neutral zone";
    let direction;
    let assetPrice;

    if (price % 100 > 50) {
      assetPrice = parseInt(price / 100) * 100 + 100;
    } else {
      assetPrice = parseInt(price / 100) * 100;
    }

    if (price >= tc && price <= tc + BUFFER) {
      direction = "CE";
      signal = "Buy";
      reason = "Above TC within buffer";
    } else if (price <= bc && price >= bc - BUFFER) {
      direction = "PE";
      signal = "Sell";
      reason = "Below BC within buffer";
    } else if (price < tc && price > bc) {
      signal = "Exit";
      reason = "Inside CPR";
    }

    const levelsMap = { r1, r2, r3, r4, s1, s2, s3, s4 };
    Object.entries(levelsMap).forEach(([levelName, level]) => {
      if (price > level && price <= level + BUFFER) {
        signal = "Buy";
        reason = `Above ${levelName} within buffer`;
        direction = "CE";
      } else if (price < level && price >= level - BUFFER) {
        signal = "Sell";
        reason = `Below ${levelName} within buffer`;
        direction = "PE";
      }
    });

    const innerLevelMap = { r1, r2, r3, r4, s1, s2, s3, s4, tc, bc };
    const open = latestCandle?.[11];
    const close = latestCandle?.[13];
    Object.entries(innerLevelMap).find(([levelName, level]) => {
      if (signal === "No Action") {
        if (close > level && open < level) {
          signal = "PE Exit";
          reason = `Crossed ${levelName}`;
          return true;
        }
        if (close < level && open > level) {
          signal = "CE Exit";
          reason = `Crossed ${levelName}`;
          return true;
        }
      }
      return false;
    });

    if (direction === "CE") assetPrice += intervalMinutes === 3 ? 600 : 400;
    else if (direction === "PE") assetPrice -= intervalMinutes === 3 ? 600 : 400;

    let symbol;
    if (direction) {
      try {
        symbol = await getSpecificCachedOption(dailyAsset.name, assetPrice, direction);
      } catch (e) {
        logError("getSpecificCachedOption failed", e, {
          base: dailyAsset?.name,
          assetPrice,
          direction,
          intervalMinutes,
        });
      }
    }

    logInfo("Signal snapshot", {
      t: istNow.toISOString(),
      price,
      direction,
      signal,
      reason,
      tf: intervalString,
    });

    // Trade loop
    for (const key of keys || []) {
      try {
        // Strict minute/second guards
        if (intervalMinutes === 3) {
          if (second >= 10) continue;
          if (istMinute % 3 !== 0) continue;
        } else if (intervalMinutes === 5) {
          if (second !== 0) continue;
          if (istMinute % 5 !== 0) continue;
        }

        const getLTP = async (instrument) => {
          try {
            const res = await axios.get("https://api.kite.trade/quote/ltp", {
              headers: {
                "X-Kite-Version": "3",
                Authorization: `token ${adminKeys.apiKey}:${adminKeys.token}`,
              },
              params: { i: instrument },
            });
            return res?.data?.data?.[instrument]?.last_price;
          } catch (err) {
            logError("LTP fetch failed", err, { instrument });
            throw err;
          }
        };

        const getInitialDayBalance = async () => {
          try {
            const res = await axios.get("https://api.kite.trade/user/margins", {
              headers: {
                "X-Kite-Version": "3",
                Authorization: `token ${key.apiKey}:${key.token}`,
              },
            });
            return res?.data?.data?.equity?.available?.opening_balance;
          } catch (err) {
            logError("Initial day balance fetch failed", err, { brokerKeyId: key.id });
            throw err;
          }
        };

        const getTodaysPnL = async () => {
          try {
            const res = await axios.get("https://api.kite.trade/portfolio/positions", {
              headers: {
                "X-Kite-Version": "3",
                Authorization: `token ${key.apiKey}:${key.token}`,
              },
            });
            const dayPositions = res?.data?.data?.day || [];
            return dayPositions.reduce((sum, pos) => sum + (pos?.pnl || 0), 0);
          } catch (err) {
            logError("Today's PnL fetch failed", err, { brokerKeyId: key.id });
            throw err;
          }
        };

        const balance = await getInitialDayBalance();
        const usableFunds = (balance / 100) * 10;

        let ltp;
        let noOfLots;
        if (direction && symbol) {
          const instrument = `${symbol.exchange}:${symbol.tradingsymbol}`;
          ltp = await getLTP(instrument);
          noOfLots = Math.floor(usableFunds / (ltp * symbol.lot_size));
        }

        const pnl = await getTodaysPnL();
        const maxLoss = (balance / 100) * 4;
        const maxProfit = (balance / 100) * 8;

        const placeIntradayOrder = async ({
          exchange = "NSE",
          tradingsymbol,
          transaction_type = "BUY",
          quantity = 1,
        }) => {
          try {
            const data = qs.stringify({
              tradingsymbol,
              exchange,
              transaction_type,
              order_type: "MARKET",
              quantity,
              product: "MIS",
              validity: "DAY",
            });
            const headers = {
              "X-Kite-Version": "3",
              Authorization: `token ${key.apiKey}:${key.token}`,
              "Content-Type": "application/x-www-form-urlencoded",
            };
            const response = await axios.post("https://api.kite.trade/orders/regular", data, { headers });
            logInfo("Order placed", {
              tf: intervalString,
              brokerKeyId: key.id,
              tradingsymbol,
              side: transaction_type,
              qty: quantity,
              order_id: response?.data?.data?.order_id,
            });
            return response.data;
          } catch (err) {
            logError("Order placement failed", err, {
              tf: intervalString,
              brokerKeyId: key.id,
              tradingsymbol,
              side: transaction_type,
              qty: quantity,
            });
            throw err;
          }
        };

        const newOrder = async (data) => {
          data.transaction_type = "BUY";
          return await placeIntradayOrder(data);
        };
        const exitOrder = async (data) => {
          data.transaction_type = "SELL";
          return await placeIntradayOrder(data);
        };

        const lastTrade = await TradeLog.findDoc({ brokerKeyId: key.id, type: "entry" }, { allowNull: true });

        // Daily limits
        if (pnl + maxLoss <= 0 || pnl >= maxProfit) {
          if (!lastTrade) {
            key.status = false;
            await key.save();
            logInfo("Deactivated key due to daily limit (no open trade)", {
              tf: intervalString,
              brokerKeyId: key.id,
              pnl,
              balance,
            });
            continue;
          }
          const exitOrderData = {
            exchange: lastTrade.asset.split(":"),
            tradingsymbol: lastTrade.asset.split(":")[11] || lastTrade.asset.split(":")[12],
            quantity: lastTrade.quantity,
          };
          logInfo("Exiting last trade, daily limit reached", { tf: intervalString, brokerKeyId: key.id, pnl, balance });
          await exitOrder(exitOrderData);
          lastTrade.type = "exit";
          await lastTrade.save();
          key.status = false;
          await key.save();
          logInfo("Deactivated key after exit (daily limit)", { tf: intervalString, brokerKeyId: key.id });
          continue;
        }

        if (signal === "No Action") continue;

        // Exit logic
        if (signal === "Exit" || signal === "PE Exit" || signal === "CE Exit") {
          if (!lastTrade) continue;
          const exitOrderData = {
            exchange: lastTrade.asset.split(":"),
            tradingsymbol: lastTrade.asset.split(":")[11] || lastTrade.asset.split(":")[12],
            quantity: lastTrade.quantity,
          };
          if (signal === "PE Exit" && lastTrade.direction === "PE") {
            logInfo("PE Exit matched, exiting", { tf: intervalString, brokerKeyId: key.id });
            await exitOrder(exitOrderData);
            lastTrade.type = "exit";
            await lastTrade.save();
            continue;
          } else if (signal === "CE Exit" && lastTrade.direction === "CE") {
            logInfo("CE Exit matched, exiting", { tf: intervalString, brokerKeyId: key.id });
            await exitOrder(exitOrderData);
            lastTrade.type = "exit";
            await lastTrade.save();
            continue;
          }
          if (signal === "Exit") {
            logInfo("Generic Exit, closing last trade", { tf: intervalString, brokerKeyId: key.id });
            await exitOrder(exitOrderData);
            lastTrade.type = "exit";
            await lastTrade.save();
            continue;
          }
        }

        // Entry or reversal
        if (!symbol) continue;
        if (!noOfLots || noOfLots <= 0) continue;

        const newOrderData = {
          exchange: symbol.exchange,
          tradingsymbol: symbol.tradingsymbol,
          quantity: noOfLots * symbol.lot_size,
        };

        if (lastTrade) {
          if (lastTrade.direction === direction) continue;

          const exitOrderData = {
            exchange: lastTrade.asset.split(":"),
            tradingsymbol: lastTrade.asset.split(":")[11] || lastTrade.asset.split(":")[12],
            quantity: lastTrade.quantity,
          };

          logInfo("Direction changed, exiting last trade", {
            tf: intervalString,
            brokerKeyId: key.id,
            from: lastTrade.direction,
            to: direction,
          });
          await exitOrder(exitOrderData);
          lastTrade.type = "exit";
          await lastTrade.save();

          const newTradeLog = {
            brokerId: key.brokerId,
            brokerKeyId: key.id,
            userId: key.userId,
            baseAssetId: dailyAsset.id,
            asset: `${symbol.exchange}:${symbol.tradingsymbol}`,
            direction,
            quantity: newOrderData.quantity,
            type: "entry",
          };

          logInfo("Placing new trade after exit", { tf: intervalString, brokerKeyId: key.id, symbol: newTradeLog.asset });
          await newOrder(newOrderData);
          await TradeLog.create(newTradeLog);
        } else {
          const newTradeLog = {
            brokerId: key.brokerId,
            brokerKeyId: key.id,
            userId: key.userId,
            baseAssetId: dailyAsset.id,
            asset: `${symbol.exchange}:${symbol.tradingsymbol}`,
            direction,
            quantity: newOrderData.quantity,
            type: "entry",
          };
          logInfo("Placing fresh trade", { tf: intervalString, brokerKeyId: key.id, symbol: newTradeLog.asset });
          await newOrder(newOrderData);
          await TradeLog.create(newTradeLog);
        }
      } catch (e) {
        logError("Per-key execution failed", e, { tf: intervalString, brokerKeyId: key?.id });
      }
    }
  }
}

// 3-minute schedule (small cron)
cron.schedule("* * * * * *", async () => {
  if (isRunning3Min) return;
  isRunning3Min = true;
  try {
    await runTradingLogic({ intervalMinutes: 3, intervalString: "3minute" });
  } catch (e) {
    logError("3m cron failure", e);
  } finally {
    isRunning3Min = false;
  }
});

// 5-minute schedule (small cron)
cron.schedule("* * * * * *", async () => {
  if (isRunning5Min) return;
  isRunning5Min = true;
  try {
    await runTradingLogic({ intervalMinutes: 5, intervalString: "5minute" });
  } catch (e) {
    logError("5m cron failure", e);
  } finally {
    isRunning5Min = false;
  }
});

// stop endpoint
server.post("/stop/:id?", async (req, res) => {
  try {
    const { id } = req.params;
    let targetKeys;
    targetKeys = id
      ? await BrokerKey.findDocById(id)
      : await BrokerKey.findAll({
          include: [{ model: Broker, where: { name: "Zerodha" } }],
          where: { status: true },
        });

    const arr = Array.isArray(targetKeys) ? targetKeys : [targetKeys].filter(Boolean);
    if (arr.length) {
      await exitOpenTrades(arr);
      logInfo("Deactivated keys for the day via /stop", { count: arr.length, ids: arr.map((k) => k.id) });
    }
    res.status(200).json({ status: true, message: "Deactivated for the day" });
  } catch (e) {
    logError("Stop endpoint failed", e);
    res.status(500).json({ status: false, message: "Internal Server error" });
  }
});

server.listen(3002, () => {
  logInfo("Zerodha runner listening", { port: 3002 });
});

