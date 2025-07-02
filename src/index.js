import cron from "node-cron";
import { main, getSpecificCachedOption } from "#utils/assetChecker";
import env from "#configs/env";
import Trade from "#models/trade";
import qs from "qs";
import axios from "axios";
import { getISTMidnightFakeUTCString } from "#utils/dayChecker";
import sequelize from "#configs/database";
import BrokerKey from "#models/brokerKey";
import Broker from "#models/broker";
import express from "express";
import TradeLog from "#models/tradeLog";

main();

try {
  await sequelize.authenticate();
  console.log("connected");
} catch (e) {
  console.log("Cannot connect");
  process.exit();
}

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
  const local = new Date(
    dateObj.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }),
  );

  const yyyy = local.getFullYear();
  const mm = String(local.getMonth() + 1).padStart(2, "0");
  const dd = String(local.getDate()).padStart(2, "0");
  const hh = String(local.getHours()).padStart(2, "0");
  const min = String(local.getMinutes()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd} ${hh}:${min}:00`;
}

cron.schedule("* * * * * *", async () => {
  try {
    const istNow = new Date(
      new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }),
    );

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
      (istHour === 15 && istMinute <= 12);

    try {
      if (!preRange && !isInMarketRange) return;

      if (preRange) {
        if (!dailyLevels) {
          const [dailyData] = await sequelize.query(`
			  SELECT * FROM "DailyLevels" WHERE "forDay" = '${getISTMidnightFakeUTCString()}'
			  `);

          dailyLevels = dailyData[0];
        }

        if (!dailyAsset) {
          const day = dayMap[istNow.getDay()];
          const [response] = await sequelize.query(
            `SELECT "name", "zerodhaToken", "Assets"."id" FROM "DailyAssets"
           INNER JOIN "Assets" ON "DailyAssets"."assetId" = "Assets"."id"
           WHERE "day" = '${day}'`,
          );

          if (!response.length) {
            return console.log("❌ No asset available for today");
          }

          dailyAsset = response[0];
        }

        if (!keys || !adminKeys || (istMinute % 1 === 0 && second % 40 === 0)) {
          const responseKeys = await BrokerKey.findAll({
            include: [
              {
                model: Broker,
                where: {
                  name: "Zerodha",
                },
              },
            ],
            where: {
              status: true,
            },
          });
          const [admin] = await sequelize.query(
            `SELECT * FROM "BrokerKeys"
         INNER JOIN "Users" ON "BrokerKeys"."userId" = "Users"."id"
         INNER JOIN "Brokers" ON "BrokerKeys"."brokerId" = "Brokers"."id"
         WHERE "Users"."role" = 'admin' AND "Brokers"."name" = 'Zerodha'
         `,
          );

          adminKeys = admin[0];
          keys = responseKeys;
        }
      }

      if (isInMarketRange && istMinute % 3 === 0 && second === 0) {
        const toTime = toKiteISTFormat(istNow);
        const fromTime = toKiteISTFormat(
          new Date(istNow.getTime() - 3 * 60 * 1000),
        );

        const instrumentToken = dailyAsset.zerodhaToken;
        const interval = "3minute";
        const apiKey = adminKeys.apiKey;
        const accessToken = adminKeys.token;

        const url = `https://api.kite.trade/instruments/historical/${instrumentToken}/${interval}?from=${encodeURIComponent(
          fromTime,
        )}&to=${encodeURIComponent(toTime)}&continuous=false`;

        const response = await axios.get(url, {
          headers: {
            "X-Kite-Version": "3",
            Authorization: `token ${apiKey}:${accessToken}`,
          },
        });

        const { data } = response.data;

        if (
          !data ||
          !Array.isArray(data.candles) ||
          data.candles.length === 0
        ) {
          console.log("⚠️ No candle data available");
          return;
        }

        const latestCandle = data.candles[data.candles.length - 1];
        const price = latestCandle[4]; // close price

        if (price === null || price === undefined) {
          return console.log("⚠️ Invalid Price");
        }

        const { bc, tc, r1, r2, r3, r4, s1, s2, s3, s4 } = dailyLevels;

        const BUFFER = dailyLevels.buffer;
        let signal = "No Action";
        let reason = "Price is in a neutral zone.";
        let direction;
        let assetPrice;
        let lastTrade;

        if (price % 100 > 50) {
          assetPrice = parseInt(price / 100) * 100 + 100;
        } else {
          assetPrice = parseInt(price / 100) * 100;
        }

        // If price is above TC and within TC + BUFFER, Buy
        if (price >= tc && price <= tc + BUFFER) {
          direction = "CE";
          signal = "Buy";
          reason = "Price is above TC within buffer.";
        }
        // If price is below BC and within BC - BUFFER, Sell
        else if (price <= bc && price >= bc - BUFFER) {
          direction = "PE";
          signal = "Sell";
          reason = "Price is below BC within buffer.";
        }
        // If price is between TC and BC, No Action
        else if (price < tc && price > bc) {
          signal = "Exit";
          reason = "Price is within CPR range.";
        }

        const levelsMap = { r1, r2, r3, r4, s1, s2, s3, s4 };

        Object.entries(levelsMap).forEach(([levelName, level]) => {
          if (price > level && price <= level + BUFFER) {
            signal = "Buy";
            reason = `Price is above ${levelName} (${level}) within buffer.`;
            direction = "CE";
          } else if (price < level && price >= level - BUFFER) {
            signal = "Sell";
            reason = `Price is below ${levelName} (${level}) within buffer.`;
            direction = "PE";
          }
        });

        const innerLevelMap = { r1, r2, r3, r4, s1, s2, s3, s4, tc, bc };

        Object.entries(innerLevelMap).find(([levelName, level]) => {
          if (signal === "No Action") {
            if (data.close > level && data.open < level) {
              signal = "PE Exit";
              reason = `Price crossed the level ${levelName}`;
              return true;
            }
            if (data.close < level && data.open > level) {
              signal = "CE Exit";
              reason = `Price crossed the level ${levelName}`;
              return true;
            }
          }
        });

        let symbol;
        if (direction) {
          symbol = await getSpecificCachedOption(
            dailyAsset.name,
            assetPrice,
            direction,
          );
        }

        for (const key of keys) {
          const getLTP = async (instrument) => {
            try {
              const res = await axios.get("https://api.kite.trade/quote/ltp", {
                headers: {
                  "X-Kite-Version": "3",
                  Authorization: `token ${key.apiKey}:${key.token}`,
                },
                params: {
                  i: instrument, // e.g., 'NSE:RELIANCE'
                },
              });

              const ltp = res.data.data[instrument].last_price;
              return ltp;
            } catch (err) {
              console.error(
                "❌ Error fetching LTP:",
                err.response?.data || err.message,
              );
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

              const openingBalance =
                res.data.data.equity.available.opening_balance;
              return openingBalance;
            } catch (err) {
              console.error(
                "❌ Error fetching initial day balance:",
                err.response?.data || err.message,
              );
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
              const totalPnL = dayPositions.reduce(
                (sum, pos) => sum + pos.pnl,
                0,
              );
              return totalPnL;
            } catch (err) {
              console.error(
                "❌ Error fetching today's P&L:",
                err.response?.data || err.message,
              );
              throw err;
            }
          };

          const balance = await getInitialDayBalance();
          const usableFunds = (balance / 100) * 25;
          let ltp;
          let noOfLots;

          if (direction) {
            ltp = await getLTP(`${symbol.exchange}:${symbol.tradingsymbol}`);
            noOfLots = Math.floor(usableFunds / (ltp * symbol.lot_size));
          }
          const pnl = await getTodaysPnL();

          const maxLoss = balance / 10;
          const maxProfit = (balance / 10) * 1.5;

          const placeIntradayOrder = async ({
            exchange = "NSE",
            tradingsymbol,
            transaction_type = "BUY", // or "SELL"
            quantity = 1,
          }) => {
            try {
              const data = qs.stringify({
                tradingsymbol,
                exchange,
                transaction_type,
                order_type: "MARKET",
                quantity,
                product: "MIS", // Intraday
                validity: "DAY",
              });

              const headers = {
                "X-Kite-Version": "3",
                Authorization: `token ${key.apiKey}:${key.apiSecret}`,
                "Content-Type": "application/x-www-form-urlencoded",
              };

              const response = await axios.post(
                "https://api.kite.trade/orders/regular",
                data,
                { headers },
              );

              console.log("✅ Order placed:", response.data);
              return response.data;
            } catch (err) {
              console.error(
                "❌ Order error:",
                err.response?.data || err.message,
              );
              throw err;
            }
          };

          async function newOrder(data) {
            data.transaction_type = "BUY";
            return await placeIntradayOrder(data);
          }

          async function exitOrder(data) {
            data.transaction_type = "SELL";
            return await placeIntradayOrder(data);
          }

          const lastTrade = await TradeLog.findDoc(
            { brokerKeyId: key.id, type: "entry" },
            { allowNull: true },
          );

          if (pnl + maxLoss <= 0 || pnl >= maxProfit) {
            if (!lastTrade) {
              key.status = false;
              await key.save();
              continue;
            }
            const exitOrderData = {
              exchange: lastTrade.asset.split(":")[0],
              tradingsymbol: lastTrade.asset.split(":")[1],
              quantity: lastTrade.quantity,
            };

            await exitOrder(exitOrderData);
            lastTrade.type = "exit";
            await lastTrade.save();
            key.status = false;
            await key.save();
            continue;
          }
          if (signal === "No Action") continue;

          if (
            signal === "Exit" ||
            signal === "PE Exit" ||
            signal === "CE Exit"
          ) {
            if (!lastTrade) continue;

            const exitOrderData = {
              exchange: lastTrade.asset.split(":")[0],
              tradingsymbol: lastTrade.asset.split(":")[1],
              quantity: lastTrade.quantity,
            };

            if (signal === "PE Exit") {
              if (lastTrade.direction === "PE") {
                await exitOrder(exitOrderData);
                lastTrade.type = "exit";
                await lastTrade.save();
                continue;
              }
              continue;
            } else if (signal === "CE Exit") {
              if (lastTrade.direction === "CE") {
                await exitOrder(exitOrderData);
                lastTrade.type = "exit";
                await lastTrade.save();
                continue;
              }
              continue;
            }

            if (signal === "Exit") {
              await exitOrder(exitOrderData);
              lastTrade.type = "exit";
              await lastTrade.save();
              continue;
            }
          }

          const newOrderData = {};
          const exitOrderData = {};

          newOrderData.exchange = symbol.exchange;
          newOrderData.tradingsymbol = symbol.tradingsymbol;
          newOrderData.quantity = noOfLots * symbol.lot_size;

          if (lastTrade) {
            exitOrderData.exchange = lastTrade.asset.split(":")[0];
            exitOrderData.tradingsymbol = lastTrade.asset.split(":")[1];
            exitOrderData.quantity = lastTrade.quantity;
          }

          if (lastTrade) {
            if (lastTrade.direction === direction) continue;
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
            await newOrder(newOrderData);
            await TradeLog.create(newTradeLog);
          }
        }

        // Example usage
      }
    } catch (e) {
      if (axios.isAxiosError(e)) {
        console.error("❌ Cron Error:", e.message);
        if (e.response) {
          console.error("📉 Response Data:", e.response.data);
          console.error("📊 Status Code:", e.response.status);
        }
      } else {
        console.error("❌ Unknown Error:", e.message);
      }
    }
  } catch (e) {
    console.log(e);
  }
});

const server = express();

server.listen(3001);
