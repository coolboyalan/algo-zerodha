import fs from "fs";
import path from "path";
import winston from "winston";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logsDir = path.resolve(process.cwd(), "logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const enumerateErrorFormat = winston.format((info) => {
  if (info instanceof Error) {
    return { ...info, message: info.message, stack: info.stack, name: info.name || "Error" };
  }
  if (info.error instanceof Error) {
    info.error = {
      message: info.error.message,
      stack: info.error.stack,
      name: info.error.name || "Error",
    };
  }
  return info;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    enumerateErrorFormat(),
    winston.format.timestamp({ format: () => new Date().toISOString() }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({
      filename: path.join(logsDir, "error.log"),
      level: "error",
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(logsDir, "app.log"),
      level: "info",
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),
  ],
  exitOnError: false,
});

if (process.env.NODE_ENV !== "production") {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf((info) => {
          const ts = info.timestamp || new Date().toISOString();
          const msg = typeof info.message === "string" ? info.message : JSON.stringify(info.message);
          return `[${ts}] ${info.level}: ${msg}${info.stack ? "\n" + info.stack : ""}`;
        })
      ),
    })
  );
}

// Keep useful Axios details only; avoid full req/resp dumps
export function normalizeAxiosError(err) {
  const base = {
    name: err?.name || "Error",
    message: err?.message || "Unknown error",
    stack: err?.stack,
    code: err?.code,
    cause: err?.cause?.message || undefined,
    isAxiosError: !!err?.isAxiosError,
  };

  if (err?.isAxiosError) {
    const status = err?.response?.status;
    const statusText = err?.response?.statusText;
    const data = err?.response?.data;

    let dataSnippet;
    if (typeof data === "string") dataSnippet = data.slice(0, 1000);
    else if (data && typeof data === "object") {
      try {
        dataSnippet = JSON.stringify(data).slice(0, 1000);
      } catch {
        dataSnippet = "[unserializable]";
      }
    }

    return {
      ...base,
      axios: {
        method: err?.config?.method,
        url: err?.config?.url,
        response: status ? { status, statusText, data: dataSnippet } : undefined,
      },
    };
  }
  return base;
}

function getOrigin(stackDepth = 3) {
  const e = new Error();
  const stack = (e.stack || "").split("\n").slice(stackDepth);
  const frame = stack[0] || "";
  const match =
    frame.match(/\s*at\s+(.*)\s+\((.*):(\d+):(\d+)\)/) ||
    frame.match(/\s*at\s+(.*):(\d+):(\d+)/);
  if (match) {
    if (match.length === 5) {
      const [, fn, file, line, col] = match;
      return { file, fn, line: Number(line), col: Number(col) };
    } else if (match.length === 4) {
      const [, file, line, col] = match;
      return { file, fn: "<anonymous>", line: Number(line), col: Number(col) };
    }
  }
  return { file: "<unknown>", fn: "<unknown>", line: 0, col: 0 };
}

export function logInfo(message, meta) {
  const origin = getOrigin(3);
  logger.info(message, { origin, ...(meta || {}) });
}

export function logWarn(message, meta) {
  const origin = getOrigin(3);
  logger.warn(message, { origin, ...(meta || {}) });
}

export function logError(message, error, meta) {
  const origin = getOrigin(3);
  const normalized =
    error?.isAxiosError || error instanceof Error ? normalizeAxiosError(error) : error;
  logger.error(message, { origin, error: normalized, ...(meta || {}) });
}

export default logger;

