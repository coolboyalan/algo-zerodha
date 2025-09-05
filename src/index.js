// app.js
import qs from "qs";
import axios from "axios";
import cron from "node-cron";
import express from "express";
import Broker from "#models/broker";
import TradeLog from "#models/tradeLog";
import sequelize from "#configs/database";
import BrokerKey from "#models/brokerKey";
import { resolveAngelOption } from "#utils/angelInstrument";
import { getISTMidnightFakeUTCString } from "#utils/dayChecker";
import { main, getSpecificCachedOption } from "#utils/assetChecker";
import logger, { logInfo, logWarn, logError } from "#utils/logger";

// ---------- Boot ----------
main();
try {
  await sequelize.authenticate();
  logInfo("DB connected"); // production: no secrets
} catch (e) {
  logError("DB connection failed", e);
  process.exit(1);
}

// ---------- Globals (hot cache) ----------
let dailyAsset = null;
let keys = null;
let adminKeys = null;
let dailyLevels = null;
let isRunning = false;

const dayMap = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
};

// ---------- Time helpers (IST everywhere) ----------
function nowIST() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }),
  );
}
function formatIST(d) {
  const nd = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const pad = (n) => String(n).padStart(2, "0");
  return `${nd.getFullYear()}-${pad(nd.getMonth() + 1)}-${pad(nd.getDate())} ${pad(nd.getHours())}:${pad(
    nd.getMinutes(),
  )}:${pad(nd.getSeconds())}`;
}
function alignToMinuteIST(d) {
  const nd = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  nd.setSeconds(0, 0);
  const pad = (n) => String(n).padStart(2, "0");
  return `${nd.getFullYear()}-${pad(nd.getMonth() + 1)}-${pad(nd.getDate())} ${pad(nd.getHours())}:${pad(
    nd.getMinutes(),
  )}`;
}

// ---------- Exit helper (Zerodha orders unchanged) ----------
async function exitOpenTrades(brokerKeys) {
  for (const key of brokerKeys) {
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
        const response = await axios.post(
          "https://api.kite.trade/orders/regular",
          data,
          { headers },
        );
        logInfo("Order placed", {
          brokerKeyId: key.id,
          type: transaction_type,
          tradingsymbol,
          qty: quantity,
        });
        return response.data;
      } catch (err) {
        logError("Order placement failed", err, {
          brokerKeyId: key.id,
          tradingsymbol,
          side: transaction_type,
        });
        throw err;
      }
    };
    const newOrder = (data) =>
      placeIntradayOrder({ ...data, transaction_type: "BUY" });
    const exitOrder = (data) =>
      placeIntradayOrder({ ...data, transaction_type: "SELL" });

    const lastTrade = await TradeLog.findDoc(
      { brokerKeyId: key.id, type: "entry" },
      { allowNull: true },
    );
    if (!lastTrade) {
      if (!key.status) continue;
      key.status = false;
      await key.save();
      logInfo("Broker key marked inactive at close (no open trade)", {
        brokerKeyId: key.id,
      });
      continue;
    }

    const exitOrderData = {
      exchange: lastTrade.asset.split(":"),
      tradingsymbol: lastTrade.asset.split(":")[20],
      quantity: lastTrade.quantity,
    };

    logInfo("Exiting open trade at close", {
      brokerKeyId: key.id,
      asset: lastTrade.asset,
      qty: lastTrade.quantity,
    });
    await exitOrder(exitOrderData);

    lastTrade.type = "exit";
    await lastTrade.save();

    key.status = false;
    await key.save();
    logInfo("Closed trade and deactivated broker key at close", {
      brokerKeyId: key.id,
    });
  }
}

// ---------- Cron (1s) ----------
cron.schedule("* * * * * *", async () => {
  if (isRunning) return;
  isRunning = true;

  try {
    let istNow = nowIST(); // Indian time basis
    const istHour = istNow.getHours();
    const istMinute = istNow.getMinutes();
    const second = istNow.getSeconds();

    const preRange =
      (istHour === 8 && istMinute >= 30) ||
      (istHour > 8 && istHour < 15) ||
      (istHour === 15 && istMinute <= 30);
    const isInMarketRange =
      (istHour === 9 && istMinute >= 30) ||
      (istHour > 9 && istHour < 15) ||
      (istHour === 15 && istMinute <= 15);

    if (!preRange && !isInMarketRange) return;

    // Pre-market initialization
    if (preRange) {
      if (!dailyLevels) {
        const forDay = getISTMidnightFakeUTCString();
        const [dailyData] = await sequelize.query(
          // `SELECT * FROM "DailyLevels" WHERE "forDay" = '${forDay}'`,
          `SELECT * FROM "DailyLevels" WHERE "forDay" = '2025-09-04'`,
        );
        dailyLevels = dailyData[0];
        logInfo("Daily levels loaded", { forDay, found: !!dailyLevels });
      }

      if (!dailyAsset) {
        const day = dayMap[istNow.getDay()];
        const [response] = await sequelize.query(
          `SELECT "name", "zerodhaToken", "angeloneToken" AS "angelToken", "Assets"."id"
           FROM "DailyAssets"
           INNER JOIN "Assets" ON "DailyAssets"."assetId" = "Assets"."id"
           WHERE "day" = '${day}'`,
        );
        if (!response.length) {
          logWarn("No daily asset configured for trading day", { day });
          return;
        }
        dailyAsset = response[0];
        logInfo("Daily asset selected", {
          name: dailyAsset.name,
          exchange: dailyAsset.exchange,
        });
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
           WHERE "Users"."role" = 'admin' AND "Brokers"."name" = 'Angel One'`,
        );
        adminKeys = admin[0];
        keys = responseKeys || [];
        logInfo("Keys refreshed", {
          activeZerodhaKeys: keys.length,
          haveAngelAdmin: !!adminKeys,
        });
      }
    }

    // Auto-exit at 15:15 IST
    if (istHour === 15 && istMinute === 15) {
      await exitOpenTrades(keys || []);
      return;
    }

    // Live loop every 10s
    if (isInMarketRange && second % 10 === 0) {
      // Build an aligned 3-minute window in IST
      const endIST = new Date(istNow.getTime());
      const startIST = new Date(istNow.getTime() - 3 * 60 * 1000);
      let todate = alignToMinuteIST(endIST);
      let fromdate = alignToMinuteIST(startIST);

      // Enforce 3-minute grid if off
      const mEnd = Number(todate.slice(14, 16));
      const mStart = Number(fromdate.slice(14, 16));
      if (mEnd - mStart !== 3 || mEnd % 3 !== mStart % 3) {
        const base = new Date(
          endIST.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }),
        );
        const alignedM = base.getMinutes() - (base.getMinutes() % 3);
        base.setMinutes(alignedM, 0, 0);
        const startFixed = new Date(base.getTime() - 3 * 60 * 1000);
        todate = alignToMinuteIST(base);
        fromdate = alignToMinuteIST(startFixed);
      }

      const exchange = dailyAsset.exchange || "NSE";
      const symboltoken = String(dailyAsset.angelToken || "");
      const url =
        "https://apiconnect.angelone.in/rest/secure/angelbroking/historical/v1/getCandleData";
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminKeys?.token || adminKeys?.jwt || ""}`,
        "X-UserType": "USER",
        "X-SourceID": "WEB",
        "X-ClientLocalIP": "127.0.0.1",
        "X-ClientPublicIP": "127.0.0.1",
        "X-MACAddress": "00:00:00:00:00:00",
      };
      if (adminKeys?.apiKey) headers["X-PrivateKey"] = adminKeys.apiKey;

      const body = {
        exchange,
        symboltoken,
        interval: "THREE_MINUTE",
        fromdate,
        todate,
      };

      try {
        const response = await axios.post(url, body, { headers });
        const payload = response.data;

        if (
          !payload ||
          !Array.isArray(payload.data) ||
          payload.data.length === 0
        ) {
          logWarn("Angel candle fetch returned empty data", {
            exchange,
            symboltoken,
            fromdate,
            todate,
          });
          return;
        }

        // Candle: [datetime, open, high, low, close, volume]
        const latestCandle = payload.data[payload.data.length - 1];
        const price = latestCandle[4];
        if (price == null) {
          logWarn("Angel candle missing close price", {
            latestCandle,
            exchange,
            symboltoken,
          });
          return;
        }

        const { bc, tc, r1, r2, r3, r4, s1, s2, s3, s4, buffer } =
          dailyLevels || {};
        const BUFFER = buffer ?? 0;

        let signal = "No Action";
        let direction;
        let assetPrice =
          price % 100 > 50
            ? Math.floor(price / 100) * 100 + 100
            : Math.floor(price / 100) * 100;

        if (tc != null && bc != null) {
          if (price >= tc && price <= tc + BUFFER) {
            direction = "CE";
            signal = "Buy";
          } else if (price <= bc && price >= bc - BUFFER) {
            direction = "PE";
            signal = "Sell";
          } else if (price < tc && price > bc) {
            signal = "Exit";
          }
        }

        const levelsMap = { r1, r2, r3, r4, s1, s2, s3, s4 };
        for (const [_, level] of Object.entries(levelsMap)) {
          if (level == null) continue;
          if (price > level && price <= level + BUFFER) {
            signal = "Buy";
            direction = "CE";
          } else if (price < level && price >= level - BUFFER) {
            signal = "Sell";
            direction = "PE";
          }
        }

        if (direction === "CE") assetPrice += 800;
        else if (direction === "PE") assetPrice -= 800;

        let symbol;
        if (direction) {
          symbol = await getSpecificCachedOption(
            dailyAsset.name,
            assetPrice,
            direction,
          );
        }

        logInfo("Signal computed", {
          at: formatIST(istNow),
          price,
          direction: direction || null,
          signal,
        });

        // Per-broker-key execution
        for (const key of keys || []) {
          try {
            const apiKey = adminKeys?.apiKey;
            const accessToken = adminKeys?.token;

            const getLTP = async (name, price, direction) => {
              try {
                const url =
                  "https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/quote";
                const headers = {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${adminKeys?.token || adminKeys?.jwt || ""}`,
                  "X-UserType": "USER",
                  "X-SourceID": "WEB",
                  "X-ClientLocalIP": "127.0.0.1",
                  "X-ClientPublicIP": "127.0.0.1",
                  "X-MACAddress": "00:00:00:00:00:00",
                };
                if (adminKeys?.apiKey)
                  headers["X-PrivateKey"] = adminKeys.apiKey;

                const symbol = await resolveAngelOption(name, price, direction);

                const body = {
                  mode: "LTP",
                  exchangeTokens: { [symbol.exch_seg]: [String(symbol.token)] },
                };

                const res = await axios.post(url, body, { headers });
                const fetched = res?.data?.data?.fetched || [];
                if (!Array.isArray(fetched) || fetched.length === 0) {
                  const unfetched = res?.data?.data?.unfetched || [];
                  logWarn("Angel LTP fetch returned no fetched data", {
                    brokerKeyId: key.id,
                    instrument,
                    exchange,
                    symboltoken,
                    message: res?.data?.message,
                    errorcode: res?.data?.errorcode,
                    unfetched,
                  });
                  throw new Error("Angel LTP unavailable");
                }
                const ltp = fetched[0]?.ltp;
                if (typeof ltp !== "number") {
                  logWarn("Angel LTP missing or invalid", {
                    brokerKeyId: key.id,
                    instrument,
                    exchange,
                    symboltoken,
                    fetched: fetched[0],
                  });
                  throw new Error("Invalid LTP");
                }
                return ltp;
              } catch (err) {
                logError("Angel LTP fetch failed", err, {
                  brokerKeyId: key.id,
                  instrument,
                });
                console.log(err);
                throw err;
              }
            };

            const getInitialDayBalance = async () => {
              try {
                const res = await axios.get(
                  "https://api.kite.trade/user/margins",
                  {
                    headers: {
                      "X-Kite-Version": "3",
                      Authorization: `token ${key.apiKey}:${key.token}`,
                    },
                  },
                );
                return res.data.data.equity.available.opening_balance;
              } catch (err) {
                logError("Kite margins fetch failed", err, {
                  brokerKeyId: key.id,
                });
                throw err;
              }
            };

            const getTodaysPnL = async () => {
              try {
                const res = await axios.get(
                  "https://api.kite.trade/portfolio/positions",
                  {
                    headers: {
                      "X-Kite-Version": "3",
                      Authorization: `token ${key.apiKey}:${key.token}`,
                    },
                  },
                );
                const dayPositions = res.data.data.day || [];
                return dayPositions.reduce((sum, pos) => sum + pos.pnl, 0);
              } catch (err) {
                logError("Kite positions fetch failed", err, {
                  brokerKeyId: key.id,
                });
                throw err;
              }
            };

            const balance = await getInitialDayBalance();
            const usableFunds = (balance / 100) * 10;

            let ltp;
            let noOfLots = 0;
            if (direction && symbol) {
              ltp = await getLTP(dailyAsset.name, assetPrice, direction);
              noOfLots = Math.floor(usableFunds / (ltp * symbol.lot_size));
            }

            const pnl = await getTodaysPnL();
            const maxLoss = (balance / 100) * 4;
            const maxProfit = (balance / 100) * 8;

            // Place/cancel logic
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
                const response = await axios.post(
                  "https://api.kite.trade/orders/regular",
                  data,
                  { headers },
                );
                logInfo("Kite order placed", {
                  brokerKeyId: key.id,
                  tradingsymbol,
                  side: transaction_type,
                  quantity,
                });
                return response.data;
              } catch (err) {
                logError("Kite order failed", err, {
                  brokerKeyId: key.id,
                  tradingsymbol,
                  side: transaction_type,
                });
                throw err;
              }
            };
            const newOrder = (data) =>
              placeIntradayOrder({ ...data, transaction_type: "BUY" });
            const exitOrder = (data) =>
              placeIntradayOrder({ ...data, transaction_type: "SELL" });

            const lastTrade = await TradeLog.findDoc(
              { brokerKeyId: key.id, type: "entry" },
              { allowNull: true },
            );

            // Daily limit checks
            if (pnl + maxLoss <= 0 || pnl >= maxProfit) {
              if (!lastTrade) {
                key.status = false;
                await key.save();
                logWarn(
                  "Daily limit reached, broker key deactivated (no open trade)",
                  {
                    brokerKeyId: key.id,
                    pnl,
                    balance,
                  },
                );
                continue;
              }
              const exitOrderData = {
                exchange: lastTrade.asset.split(":"),
                tradingsymbol: lastTrade.asset.split(":")[20],
                quantity: lastTrade.quantity,
              };
              logWarn("Daily limit reached, exiting open trade", {
                brokerKeyId: key.id,
                pnl,
                balance,
              });
              await exitOrder(exitOrderData);
              lastTrade.type = "exit";
              await lastTrade.save();
              key.status = false;
              await key.save();
              logWarn(
                "Daily limit reached, broker key deactivated after exit",
                { brokerKeyId: key.id },
              );
              continue;
            }

            // Entry/Exit throttles
            if (second >= 10) continue;
            if (istMinute % 3 !== 0) continue;
            if (signal === "No Action" || !direction || !symbol) continue;

            console.log(istNow.toString());

            if (lastTrade) {
              // Only flip if direction changed
              if (lastTrade.direction === direction) continue;

              const exitOrderData = {
                exchange: lastTrade.asset.split(":"),
                tradingsymbol: lastTrade.asset.split(":")[20],
                quantity: lastTrade.quantity,
              };
              logInfo("Switching direction: exiting previous trade", {
                brokerKeyId: key.id,
              });
              await exitOrder(exitOrderData);
              lastTrade.type = "exit";
              await lastTrade.save();

              const newOrderData = {
                exchange: symbol.exchange,
                tradingsymbol: symbol.tradingsymbol,
                quantity: Math.max(1, Math.floor(noOfLots * symbol.lot_size)),
              };
              await newOrder(newOrderData);
              await TradeLog.create({
                brokerId: key.brokerId,
                brokerKeyId: key.id,
                userId: key.userId,
                baseAssetId: dailyAsset.id,
                asset: `${symbol.exchange}:${symbol.tradingsymbol}`,
                direction,
                quantity: newOrderData.quantity,
                type: "entry",
              });
              logInfo("New trade placed after switching", {
                brokerKeyId: key.id,
                symbol: symbol.tradingsymbol,
              });
            } else {
              // Fresh entry
              const newOrderData = {
                exchange: symbol.exchange,
                tradingsymbol: symbol.tradingsymbol,
                quantity: Math.max(1, Math.floor(noOfLots * symbol.lot_size)),
              };
              logInfo("Placing fresh trade", {
                brokerKeyId: key.id,
                tradingsymbol: symbol.tradingsymbol,
              });
              await newOrder(newOrderData);
              await TradeLog.create({
                brokerId: key.brokerId,
                brokerKeyId: key.id,
                userId: key.userId,
                baseAssetId: dailyAsset.id,
                asset: `${symbol.exchange}:${symbol.tradingsymbol}`,
                direction,
                quantity: newOrderData.quantity,
                type: "entry",
              });
              logInfo("Trade log created", {
                brokerKeyId: key.id,
                tradingsymbol: symbol.tradingsymbol,
              });
            }
          } catch (e) {
            logError("Per-broker-key processing failed", e, {
              brokerKeyId: key?.id || null,
            });
            console.log(e.response.data);
          }
        }
      } catch (err) {
        // Include Angel error payload if available
        const status = err?.response?.status;
        const data = err?.response?.data;
        logError("Angel historical fetch failed", err, {
          status,
          errorPayload: data,
          exchange,
          symboltoken,
          fromdate,
          todate,
        });
      }
    }
  } catch (e) {
    logError("Cron loop failed", e);
    console.log(e);
  } finally {
    isRunning = false;
  }
});

// ---------- HTTP ----------
const server = express();

server.post("/stop/:id?", async (req, res) => {
  try {
    const { id } = req.params;
    let brokerKeys = id
      ? await BrokerKey.findDocById(id)
      : await BrokerKey.findAll({
          include: [{ model: Broker, where: { name: "Zerodha" } }],
          where: { status: true },
        });

    brokerKeys = Array.isArray(brokerKeys) ? brokerKeys : [brokerKeys];
    if (brokerKeys.length) {
      await exitOpenTrades(brokerKeys);
    }

    logInfo("Deactivated broker keys via /stop", {
      count: brokerKeys.length,
      ids: brokerKeys.map((k) => k.id),
    });
    res.status(200).json({ status: true, message: "Deactivated for the day" });
  } catch (e) {
    logError("/stop handler failed", e);
    res.status(400).json({ status: false, message: "Failed" });
  }
});

server.listen(3002, () => logInfo("Server listening", { port: 3002 }));
