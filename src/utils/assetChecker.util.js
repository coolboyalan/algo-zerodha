import path from "path";
import axios from "axios";
import cron from "node-cron";
import { parse } from "csv-parse";
import { fileURLToPath } from "url";
import moment from "moment-timezone";
import { createWriteStream } from "fs";
import { readFile, writeFile, unlink } from "fs/promises";

// Helper to get __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INSTRUMENTS_URL = "https://api.kite.trade/instruments";
const CSV_FILE_PATH = path.join(__dirname, "instruments_downloaded.csv");
const OUTPUT_JSON_PATH = path.join(__dirname, "immediate_expiry_options.json");

const appCache = {
  NIFTY: [],
  SENSEX: [],
};

const INDEX_CONFIGS = {
  NIFTY: {
    displayName: "NIFTY50",
    csvName: "NIFTY",
    csvExchange: "NFO",
    csvSymbolPrefix: "NIFTY",
    excludeSymbolPrefixes: ["NIFTYNXT", "NIFTYMID", "NIFTYFIN", "NIFTYBANK"],
  },
  SENSEX: {
    displayName: "SENSEX",
    csvName: "SENSEX",
    csvExchange: "BFO",
    csvSymbolPrefix: "SENSEX",
    excludeSymbolPrefixes: [],
  },
};

async function downloadInstrumentsFile() {
  console.log(`Starting download from ${INSTRUMENTS_URL}...`);
  try {
    const response = await axios({
      method: "get",
      url: INSTRUMENTS_URL,
      responseType: "stream",
    });

    if (response.status !== 200) {
      console.error(`Failed to download file. Status Code: ${response.status}`);
      return false;
    }

    const writer = createWriteStream(CSV_FILE_PATH);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on("finish", () => {
        console.log(
          `File downloaded successfully and saved to ${CSV_FILE_PATH}`,
        );
        resolve(true);
      });
      writer.on("error", async (err) => {
        console.error("Error writing downloaded file:", err.message);
        await unlink(CSV_FILE_PATH).catch(() => {});
        reject(false);
      });
    });
  } catch (error) {
    console.error("Error during download request:", error.message);
    return false;
  }
}

function processAndCacheImmediateOptions(indexKey, allRecords) {
  const config = INDEX_CONFIGS[indexKey];
  if (!config) {
    console.error(`No configuration found for index key: ${indexKey}`);
    return;
  }
  console.log(`\nProcessing options for ${config.displayName}...`);

  const indexOptions = allRecords.filter((instrument) => {
    const name = instrument.name?.toUpperCase() || "";
    const exchange = instrument.exchange?.toUpperCase() || "";
    const instrumentType = instrument.instrument_type?.toUpperCase() || "";
    const tradingsymbol = instrument.tradingsymbol?.toUpperCase() || "";

    if (
      config.excludeSymbolPrefixes?.some((prefix) =>
        tradingsymbol.startsWith(prefix),
      )
    ) {
      return false;
    }

    return (
      name === config.csvName &&
      exchange === config.csvExchange &&
      (instrumentType === "CE" || instrumentType === "PE") &&
      tradingsymbol.startsWith(config.csvSymbolPrefix)
    );
  });

  if (indexOptions.length === 0) {
    console.log(`No ${config.displayName} options found.`);
    appCache[indexKey] = [];
    return;
  }

  console.log(`Found ${indexOptions.length} ${config.displayName} options.`);

  let minExpiryDate = null;
  let validOptionsWithDate = [];

  indexOptions.forEach((opt) => {
    if (opt.expiry?.trim()) {
      try {
        const expiryDate = new Date(opt.expiry);
        if (!isNaN(expiryDate.getTime())) {
          validOptionsWithDate.push({ ...opt, expiryDateObj: expiryDate });
          if (!minExpiryDate || expiryDate < minExpiryDate) {
            minExpiryDate = expiryDate;
          }
        }
      } catch {
        /* ignore */
      }
    }
  });

  if (!minExpiryDate) {
    console.log(
      `Could not determine the most immediate expiry date for ${config.displayName}.`,
    );
    appCache[indexKey] = [];
    return;
  }

  const minExpiryDateString = minExpiryDate.toISOString().split("T")[0];
  const immediateExpiryOptions = validOptionsWithDate
    .filter(
      (opt) =>
        opt.expiryDateObj.toISOString().split("T")[0] === minExpiryDateString,
    )
    .map((opt) => {
      const { expiryDateObj, ...rest } = opt;
      rest.strike = parseFloat(rest.strike);
      return rest;
    });

  appCache[indexKey] = immediateExpiryOptions;

  console.log(
    `Found ${immediateExpiryOptions.length} options for immediate expiry (${minExpiryDateString}).`,
  );
  if (immediateExpiryOptions.length) {
    const sample = immediateExpiryOptions[0];
    console.log(
      `Sample: ${sample.tradingsymbol} @ ${sample.strike} (${sample.instrument_type})`,
    );
  }
}

export function getSpecificCachedOption(indexKey, strikePrice, direction) {
  const cachedOptions = appCache[indexKey];
  if (!cachedOptions?.length) {
    console.warn(`Cache for ${indexKey} is empty.`);
    return null;
  }

  const targetDirection = direction.toUpperCase();
  return (
    cachedOptions.find(
      (opt) =>
        opt.strike === strikePrice &&
        opt.instrument_type.toUpperCase() === targetDirection,
    ) || null
  );
}

export async function main() {
  const downloadSuccess = await downloadInstrumentsFile();
  if (!downloadSuccess) {
    console.log("Skipping processing due to download failure.");
    return;
  }

  console.log(`\nReading and parsing CSV...`);
  let allRecords;
  try {
    const fileContent = await readFile(CSV_FILE_PATH, "utf8");
    allRecords = await new Promise((resolve, reject) => {
      parse(
        fileContent,
        {
          columns: true,
          skip_empty_lines: true,
          trim: true,
        },
        (err, records) => (err ? reject(err) : resolve(records)),
      );
    });
  } catch (error) {
    console.error("Failed to read/parse CSV:", error.message);
    return;
  }

  processAndCacheImmediateOptions("NIFTY", allRecords);
  processAndCacheImmediateOptions("SENSEX", allRecords);

  await writeFile(OUTPUT_JSON_PATH, JSON.stringify(appCache, null, 2));
  console.log(`\nCached options written to ${OUTPUT_JSON_PATH}`);
}

const getCurrentISTTime = () =>
  moment().tz("Asia/Kolkata").format("YYYY-MM-DD HH:mm:ss [IST]");

cron.schedule(
  "0 7 * * *",
  async () => {
    console.log(`Cron job triggered at ${getCurrentISTTime()}`);
    await main();
    console.log("Daily task executed successfully!");
  },
  {
    scheduled: true,
    timezone: "Asia/Kolkata",
  },
);
