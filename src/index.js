import cron from "node-cron";
import { main, getSpecificCachedOption } from "#utils/assetChecker";
import env from "#configs/env";
import { getISTMidnightFakeUTCString } from "#utils/dayChecker";
import sequelize from "#configs/database";

main();

await sequelize.authenticate();

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
  const istNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }),
  );

  const istHour = istNow.getHours();
  const istMinute = istNow.getMinutes();
  const second = istNow.getSeconds();

  const preRange =
    (istHour === 7 && istMinute >= 30) ||
    (istHour > 7 && istHour < 15) ||
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
          `SELECT "name", "zerodhaToken" FROM "DailyAssets"
           INNER JOIN "Assets" ON "DailyAssets"."assetId" = "Assets"."id"
           WHERE "day" = '${day}'`,
        );

        if (!response.length) {
          return console.log("❌ No asset available for today");
        }

        dailyAsset = response[0];
      }

      if (!keys || !adminKeys || (istMinute % 1 === 0 && second % 40 === 0)) {
        const [responseKeys] = await sequelize.query(
          `SELECT * FROM "BrokerKeys"
         INNER JOIN "Brokers" ON "BrokerKeys"."brokerId" = "Brokers"."id"
         WHERE "Brokers"."name" = 'Zerodha' AND "BrokerKeys"."status" = true`,
        );

        const [admin] = await sequelize.query(
          `SELECT * FROM "BrokerKeys"
         INNER JOIN "Users" ON "BrokerKeys"."userId" = "Users"."id"
         INNER JOIN "Brokers" ON "BrokerKeys"."brokerId" = "Brokers"."id"
         WHERE "Users"."role" = 'admin' AND "Brokers"."name" = 'Zerodha'
         AND "BrokerKeys"."status" = true`,
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

      if (!data || !Array.isArray(data.candles) || data.candles.length === 0) {
        console.log("⚠️ No candle data available");
        return;
      }

      const latestCandle = data.candles[data.candles.length - 1];
      const price = latestCandle[4]; // close price

      if (price === null || price === undefined) {
        return console.log("⚠️ Invalid Price");
      }
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
});
