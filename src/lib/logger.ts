// A simple logger . The default is "info" in production and "silent" in test.
type Level = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

// Resolve the configured minimum log level.
function resolveLevel(): Level {
  const configured = process.env.LOG_LEVEL;
  if (configured && configured in LEVEL_ORDER) return configured as Level;
  return process.env.NODE_ENV === "test" ? "silent" : "info";
}

// Check whether a message meets the configured log threshold.
function shouldLog(level: Level): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[resolveLevel()];
}

export const logger = { // A simple logger instance with debug, info, warn, and error methods
  debug: (...args: unknown[]): void => {
    if (shouldLog("debug")) console.log(...args);
  },
  info: (...args: unknown[]): void => {
    if (shouldLog("info")) console.log(...args);
  },
  warn: (...args: unknown[]): void => {
    if (shouldLog("warn")) console.warn(...args);
  },
  error: (...args: unknown[]): void => {
    if (shouldLog("error")) console.error(...args);
  },
};
