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

main();
try {
  await sequelize.authenticate();
  logInfo("DB connected");
} catch (e) {
  logError("DB connection failed", e);
  process.exit(1);
}

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

cron.schedule("* * * * * *", async () => {
  if (isRunning) return;
  isRunning = true;
  try {
    let istNow = nowIST();
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

    if (istHour === 15 && istMinute === 15) {
      await exitOpenTrades(keys || []);
      return;
    }

    if (isInMarketRange && second % 10 === 0) {
      const endIST = new Date(istNow.getTime());
      const startIST = new Date(istNow.getTime() - 3 * 60 * 1000);
      let todate = alignToMinuteIST(endIST);
      let fromdate = alignToMinuteIST(startIST);

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
        } else {
          const latestCandle = payload.data[payload.data.length - 1];
          const price = latestCandle[4];
          if (price == null) {
            logWarn("Angel candle missing close price", {
              latestCandle,
              exchange,
              symboltoken,
            });
          } else {
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

            for (const key of keys || []) {
              if (key.timeFrame !== 3) continue;
              try {
                const getLTP = async (name, price, direction) => {
                  const urlQ =
                    "https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/quote";
                  const headersQ = {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${adminKeys?.token || adminKeys?.jwt || ""}`,
                    "X-UserType": "USER",
                    "X-SourceID": "WEB",
                    "X-ClientLocalIP": "127.0.0.1",
                    "X-ClientPublicIP": "127.0.0.1",
                    "X-MACAddress": "00:00:00:00:00:00",
                  };
                  if (adminKeys?.apiKey)
                    headersQ["X-PrivateKey"] = adminKeys.apiKey;
                  const sym = await resolveAngelOption(name, price, direction);
                  const bodyQ = {
                    mode: "LTP",
                    exchangeTokens: { [sym.exch_seg]: [String(sym.token)] },
                  };
                  const res = await axios.post(urlQ, bodyQ, {
                    headers: headersQ,
                  });
                  const fetched = res?.data?.data?.fetched || [];
                  if (!Array.isArray(fetched) || fetched.length === 0)
                    throw new Error("Angel LTP unavailable");
                  const ltp = fetched[0]?.ltp;
                  if (typeof ltp !== "number") throw new Error("Invalid LTP");
                  return { ltp, sym };
                };

                const getInitialDayBalance = async () => {
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
                };

                const getTodaysPnL = async () => {
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
                };

                const balance = await getInitialDayBalance();
                const usableFunds = (balance / 100) * 10;

                let ltp,
                  sym,
                  noOfLots = 0;
                if (direction && symbol) {
                  const resLTP = await getLTP(
                    dailyAsset.name,
                    assetPrice,
                    direction,
                  );
                  ltp = resLTP.ltp;
                  sym = resLTP.sym;
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
                  const data = qs.stringify({
                    tradingsymbol,
                    exchange,
                    transaction_type,
                    order_type: "MARKET",
                    quantity,
                    product: "MIS",
                    validity: "DAY",
                  });
                  const headersO = {
                    "X-Kite-Version": "3",
                    Authorization: `token ${key.apiKey}:${key.token}`,
                    "Content-Type": "application/x-www-form-urlencoded",
                  };
                  const responseO = await axios.post(
                    "https://api.kite.trade/orders/regular",
                    data,
                    { headers: headersO },
                  );
                  logInfo("Kite order placed", {
                    brokerKeyId: key.id,
                    tradingsymbol,
                    side: transaction_type,
                    quantity,
                  });
                  return responseO.data;
                };
                const newOrder = (data) =>
                  placeIntradayOrder({ ...data, transaction_type: "BUY" });
                const exitOrder = (data) =>
                  placeIntradayOrder({ ...data, transaction_type: "SELL" });

                const lastTrade = await TradeLog.findDoc(
                  { brokerKeyId: key.id, type: "entry" },
                  { allowNull: true },
                );

                if (pnl + maxLoss <= 0 || pnl >= maxProfit) {
                  if (!lastTrade) {
                    key.status = false;
                    await key.save();
                    logWarn(
                      "Daily limit reached, broker key deactivated (no open trade)",
                      { brokerKeyId: key.id, pnl, balance },
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

                if (second >= 10) continue;
                if (istMinute % 3 !== 0) continue;
                if (signal === "No Action" || !direction || !symbol) continue;

                if (lastTrade) {
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
                    quantity: Math.max(
                      1,
                      Math.floor(noOfLots * symbol.lot_size),
                    ),
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
                  const newOrderData = {
                    exchange: symbol.exchange,
                    tradingsymbol: symbol.tradingsymbol,
                    quantity: Math.max(
                      1,
                      Math.floor(noOfLots * symbol.lot_size),
                    ),
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
                console.log(e.response?.data);
              }
            }
          }
        }
      } catch (err) {
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

    // 5-minute replica
    if (isInMarketRange && second % 10 === 0) {
      const endIST5 = new Date(istNow.getTime());
      const startIST5 = new Date(istNow.getTime() - 5 * 60 * 1000);
      let todate5 = alignToMinuteIST(endIST5);
      let fromdate5 = alignToMinuteIST(startIST5);

      const mEnd5 = Number(todate5.slice(14, 16));
      const mStart5 = Number(fromdate5.slice(14, 16));
      if (mEnd5 - mStart5 !== 5 || mEnd5 % 5 !== mStart5 % 5) {
        const base5 = new Date(
          endIST5.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }),
        );
        const alignedM5 = base5.getMinutes() - (base5.getMinutes() % 5);
        base5.setMinutes(alignedM5, 0, 0);
        const startFixed5 = new Date(base5.getTime() - 5 * 60 * 1000);
        todate5 = alignToMinuteIST(base5);
        fromdate5 = alignToMinuteIST(startFixed5);
      }

      const exchange5 = dailyAsset.exchange || "NSE";
      const symboltoken5 = String(dailyAsset.angelToken || "");
      const url5 =
        "https://apiconnect.angelone.in/rest/secure/angelbroking/historical/v1/getCandleData";
      const headers5 = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminKeys?.token || adminKeys?.jwt || ""}`,
        "X-UserType": "USER",
        "X-SourceID": "WEB",
        "X-ClientLocalIP": "127.0.0.1",
        "X-ClientPublicIP": "127.0.0.1",
        "X-MACAddress": "00:00:00:00:00:00",
      };
      if (adminKeys?.apiKey) headers5["X-PrivateKey"] = adminKeys.apiKey;

      const body5 = {
        exchange: exchange5,
        symboltoken: symboltoken5,
        interval: "FIVE_MINUTE",
        fromdate: fromdate5,
        todate: todate5,
      };

      try {
        const response5 = await axios.post(url5, body5, { headers: headers5 });
        const payload5 = response5.data;
        if (
          !payload5 ||
          !Array.isArray(payload5.data) ||
          payload5.data.length === 0
        ) {
          logWarn("Angel candle fetch (5m) returned empty data", {
            exchange: exchange5,
            symboltoken: symboltoken5,
            fromdate: fromdate5,
            todate: todate5,
          });
        } else {
          const latestCandle5 = payload5.data[payload5.data.length - 1];
          const price5 = latestCandle5[4];
          if (price5 == null) {
            logWarn("Angel candle (5m) missing close price", {
              latestCandle5,
              exchange: exchange5,
              symboltoken: symboltoken5,
            });
          } else {
            const { bc, tc, r1, r2, r3, r4, s1, s2, s3, s4, buffer } =
              dailyLevels || {};
            const BUFFER5 = buffer ?? 0;

            let signal5 = "No Action";
            let direction5;
            let assetPrice5 =
              price5 % 100 > 50
                ? Math.floor(price5 / 100) * 100 + 100
                : Math.floor(price5 / 100) * 100;

            if (tc != null && bc != null) {
              if (price5 >= tc && price5 <= tc + BUFFER5) {
                direction5 = "CE";
                signal5 = "Buy";
              } else if (price5 <= bc && price5 >= bc - BUFFER5) {
                direction5 = "PE";
                signal5 = "Sell";
              } else if (price5 < tc && price5 > bc) {
                signal5 = "Exit";
              }
            }
            const levelsMap5 = { r1, r2, r3, r4, s1, s2, s3, s4 };
            for (const [_, level] of Object.entries(levelsMap5)) {
              if (level == null) continue;
              if (price5 > level && price5 <= level + BUFFER5) {
                signal5 = "Buy";
                direction5 = "CE";
              } else if (price5 < level && price5 >= level - BUFFER5) {
                signal5 = "Sell";
                direction5 = "PE";
              }
            }

            if (direction5 === "CE") assetPrice5 += 800;
            else if (direction5 === "PE") assetPrice5 -= 800;

            let symbol5;
            if (direction5) {
              symbol5 = await getSpecificCachedOption(
                dailyAsset.name,
                assetPrice5,
                direction5,
              );
            }

            logInfo("Signal computed (5m)", {
              at: formatIST(istNow),
              price: price5,
              direction: direction5 || null,
              signal: signal5,
            });

            for (const key of keys || []) {
              if (key.timeFrame !== 5) continue;
              try {
                const getLTP5 = async (name, price, direction) => {
                  const urlQ5 =
                    "https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/quote";
                  const headersQ5 = {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${adminKeys?.token || adminKeys?.jwt || ""}`,
                    "X-UserType": "USER",
                    "X-SourceID": "WEB",
                    "X-ClientLocalIP": "127.0.0.1",
                    "X-ClientPublicIP": "127.0.0.1",
                    "X-MACAddress": "00:00:00:00:00:00",
                  };
                  if (adminKeys?.apiKey)
                    headersQ5["X-PrivateKey"] = adminKeys.apiKey;
                  const sym = await resolveAngelOption(name, price, direction);
                  const bodyQ5 = {
                    mode: "LTP",
                    exchangeTokens: { [sym.exch_seg]: [String(sym.token)] },
                  };
                  const res = await axios.post(urlQ5, bodyQ5, {
                    headers: headersQ5,
                  });
                  const fetched = res?.data?.data?.fetched || [];
                  if (!Array.isArray(fetched) || fetched.length === 0)
                    throw new Error("Angel LTP unavailable");
                  const ltp = fetched[0]?.ltp;
                  if (typeof ltp !== "number") throw new Error("Invalid LTP");
                  return { ltp, sym };
                };

                const getInitialDayBalance5 = async () => {
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
                };

                const getTodaysPnL5 = async () => {
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
                };

                const balance5 = await getInitialDayBalance5();
                const usableFunds5 = (balance5 / 100) * 10;

                let ltp5,
                  sym5,
                  noOfLots5 = 0;
                if (direction5 && symbol5) {
                  const resLTP5 = await getLTP5(
                    dailyAsset.name,
                    assetPrice5,
                    direction5,
                  );
                  ltp5 = resLTP5.ltp;
                  sym5 = resLTP5.sym;
                  noOfLots5 = Math.floor(
                    usableFunds5 / (ltp5 * symbol5.lot_size),
                  );
                }

                const pnl5 = await getTodaysPnL5();
                const maxLoss5 = (balance5 / 100) * 4;
                const maxProfit5 = (balance5 / 100) * 8;

                const placeIntradayOrder5 = async ({
                  exchange = "NSE",
                  tradingsymbol,
                  transaction_type = "BUY",
                  quantity = 1,
                }) => {
                  const data5 = qs.stringify({
                    tradingsymbol,
                    exchange,
                    transaction_type,
                    order_type: "MARKET",
                    quantity,
                    product: "MIS",
                    validity: "DAY",
                  });
                  const headersO5 = {
                    "X-Kite-Version": "3",
                    Authorization: `token ${key.apiKey}:${key.token}`,
                    "Content-Type": "application/x-www-form-urlencoded",
                  };
                  const responseO5 = await axios.post(
                    "https://api.kite.trade/orders/regular",
                    data5,
                    { headers: headersO5 },
                  );
                  logInfo("Kite order placed (5m)", {
                    brokerKeyId: key.id,
                    tradingsymbol,
                    side: transaction_type,
                    quantity,
                  });
                  return responseO5.data;
                };
                const newOrder5 = (data) =>
                  placeIntradayOrder5({ ...data, transaction_type: "BUY" });
                const exitOrder5 = (data) =>
                  placeIntradayOrder5({ ...data, transaction_type: "SELL" });

                const lastTrade5 = await TradeLog.findDoc(
                  { brokerKeyId: key.id, type: "entry" },
                  { allowNull: true },
                );

                if (pnl5 + maxLoss5 <= 0 || pnl5 >= maxProfit5) {
                  if (!lastTrade5) {
                    key.status = false;
                    await key.save();
                    logWarn(
                      "Daily limit reached, broker key deactivated (no open trade) (5m)",
                      { brokerKeyId: key.id, pnl: pnl5, balance: balance5 },
                    );
                    continue;
                  }
                  const exitOrderData5 = {
                    exchange: lastTrade5.asset.split(":")[0],
                    tradingsymbol: lastTrade5.asset.split(":")[1],
                    quantity: lastTrade5.quantity,
                  };
                  logWarn("Daily limit reached, exiting open trade (5m)", {
                    brokerKeyId: key.id,
                    pnl: pnl5,
                    balance: balance5,
                  });
                  await exitOrder5(exitOrderData5);
                  lastTrade5.type = "exit";
                  await lastTrade5.save();
                  key.status = false;
                  await key.save();
                  logWarn(
                    "Daily limit reached, broker key deactivated after exit (5m)",
                    { brokerKeyId: key.id },
                  );
                  continue;
                }

                if (second >= 10) continue;
                if (istMinute % 5 !== 0) continue;
                if (signal5 === "No Action" || !direction5 || !symbol5)
                  continue;

                if (lastTrade5) {
                  if (lastTrade5.direction === direction5) continue;
                  const exitOrderData5 = {
                    exchange: lastTrade5.asset.split(":")[0],
                    tradingsymbol: lastTrade5.asset.split(":")[1],
                    quantity: lastTrade5.quantity,
                  };
                  logInfo("Switching direction: exiting previous trade (5m)", {
                    brokerKeyId: key.id,
                  });
                  await exitOrder5(exitOrderData5);
                  lastTrade5.type = "exit";
                  await lastTrade5.save();
                  const newOrderData5 = {
                    exchange: symbol5.exchange,
                    tradingsymbol: symbol5.tradingsymbol,
                    quantity: Math.max(
                      1,
                      Math.floor(noOfLots5 * symbol5.lot_size),
                    ),
                  };
                  await newOrder5(newOrderData5);
                  await TradeLog.create({
                    brokerId: key.brokerId,
                    brokerKeyId: key.id,
                    userId: key.userId,
                    baseAssetId: dailyAsset.id,
                    asset: `${symbol5.exchange}:${symbol5.tradingsymbol}`,
                    direction: direction5,
                    quantity: newOrderData5.quantity,
                    type: "entry",
                  });
                  logInfo("New trade placed after switching (5m)", {
                    brokerKeyId: key.id,
                    symbol: symbol5.tradingsymbol,
                  });
                } else {
                  const newOrderData5 = {
                    exchange: symbol5.exchange,
                    tradingsymbol: symbol5.tradingsymbol,
                    quantity: Math.max(
                      1,
                      Math.floor(noOfLots5 * symbol5.lot_size),
                    ),
                  };
                  logInfo("Placing fresh trade (5m)", {
                    brokerKeyId: key.id,
                    tradingsymbol: symbol5.tradingsymbol,
                  });
                  await newOrder5(newOrderData5);
                  await TradeLog.create({
                    brokerId: key.brokerId,
                    brokerKeyId: key.id,
                    userId: key.userId,
                    baseAssetId: dailyAsset.id,
                    asset: `${symbol5.exchange}:${symbol5.tradingsymbol}`,
                    direction: direction5,
                    quantity: newOrderData5.quantity,
                    type: "entry",
                  });
                  logInfo("Trade log created (5m)", {
                    brokerKeyId: key.id,
                    tradingsymbol: symbol5.tradingsymbol,
                  });
                }
              } catch (e) {
                logError("Per-broker-key processing failed (5m)", e, {
                  brokerKeyId: key?.id || null,
                });
              }
            }
          }
        }
      } catch (err) {
        const status5 = err?.response?.status;
        const data5 = err?.response?.data;
        logError("Angel historical fetch failed (5m)", err, {
          status: status5,
          errorPayload: data5,
          exchange: exchange5,
          symboltoken: symboltoken5,
          fromdate: fromdate5,
          todate: todate5,
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
