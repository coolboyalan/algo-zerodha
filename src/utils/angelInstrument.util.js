// angelInstruments.util.js
import axios from "axios";
import cron from "node-cron";

// Angel scrip master JSON endpoint
const SCRIP_MASTER_URL =
  "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";

let SCRIP_CACHE = []; // Raw array of Angel rows

export async function loadAngelScripMaster(force = false) {
  try {
    if (!force && Array.isArray(SCRIP_CACHE) && SCRIP_CACHE.length) {
      return true; // already cached in memory
    }

    const res = await axios.get(SCRIP_MASTER_URL, { timeout: 30000 });
    if (!Array.isArray(res.data))
      throw new Error("Unexpected scrip master format");

    SCRIP_CACHE = res.data;
    console.log(
      `✅ Loaded Angel scrip master: ${SCRIP_CACHE.length} instruments`,
    );

    // 👇 Demo log for NIFTY 24000 CE
    const testOption = resolveAngelOption("NIFTY", 24000, "CE");
    if (testOption) {
      console.log("🟢 Resolved NIFTY 24000 CE:", testOption);
    } else {
      console.log("🔴 Could not resolve NIFTY 24000 CE");
    }

    return true;
  } catch (e) {
    console.error("❌ Failed to load Angel scrip master:", e.message);
    return false;
  }
}

// Refresh daily at 7:05 IST
cron.schedule(
  "5 7 * * *",
  async () => {
    console.log("🔄 Refreshing Angel scrip master...");
    await loadAngelScripMaster(true);
  },
  { timezone: "Asia/Kolkata" },
);

loadAngelScripMaster();

// Helpers
function normalizeIndexBaseName(name) {
  return String(name || "").toUpperCase();
}

export function resolveAngelOption(baseName, strike, direction) {
  const base = normalizeIndexBaseName(baseName); // e.g. NIFTY, BANKNIFTY, FINNIFTY
  const typ = String(direction || "").toUpperCase(); // CE / PE
  if (!SCRIP_CACHE.length) return null;

  const strikeScaled = Math.round(Number(strike) * 100);

  const fnoRows = SCRIP_CACHE.filter((r) => {
    const seg = String(r.exch_seg || "").toUpperCase();
    const inst = String(r.instrumenttype || "").toUpperCase();
    const sym = String(r.symbol || "").toUpperCase();
    const nm = String(r.name || "").toUpperCase();

    if (seg !== "NFO") return false;
    if (inst !== "OPTIDX") return false;
    if (!sym.endsWith(typ)) return false; // CE / PE suffix
    if (nm !== base) return false; // ✅ exact base match

    return Math.round(Number(r.strike)) === strikeScaled;
  });

  if (!fnoRows.length) return null;

  // Pick nearest expiry
  const withExpiry = fnoRows
    .map((r) => {
      const expStr = String(r.expiry || "").trim();
      const expDate = expStr
        ? new Date(
            expStr.replace(
              /^(\d{2})([A-Z]{3})(\d{4})$/,
              (_, d, m, y) => `${d}-${m}-${y}`,
            ),
          )
        : null;
      const ts =
        expDate && !isNaN(expDate.getTime())
          ? expDate.getTime()
          : Number.MAX_SAFE_INTEGER;
      return { row: r, ts };
    })
    .sort((a, b) => a.ts - b.ts);

  const chosen = withExpiry[0].row;

  return {
    token: String(chosen.token),
    symbol: chosen.symbol,
    name: chosen.name,
    expiry: (() => {
      const expStr = String(chosen.expiry || "").trim();
      const expDate = expStr
        ? new Date(
            expStr.replace(
              /^(\d{2})([A-Z]{3})(\d{4})$/,
              (_, d, m, y) => `${d}-${m}-${y}`,
            ),
          )
        : null;
      return expDate && !isNaN(expDate.getTime()) ? expDate : expStr || null;
    })(),
    strike: Number(chosen.strike) / 100, // ✅ convert back from ×100
    lotsize: Number(chosen.lotsize) || null,
    instrumenttype: chosen.instrumenttype,
    exch_seg: chosen.exch_seg,
    tick_size: Number(chosen.tick_size) || null,
  };
}

export function angelQuotePayloadFromResolved(resolved) {
  return {
    exchange: resolved.exchange === "NFO" ? "NFO" : "NSE",
    tradingsymbol: resolved.tradingsymbol,
    symboltoken: resolved.symboltoken,
  };
}
