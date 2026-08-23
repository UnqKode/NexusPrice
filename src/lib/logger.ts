// Level-gated logger for API routes - replaces raw console.* calls, which
// were drowning the vitest reporter's already-useful failure output in
// request-by-request "Cache HIT"/"Sending request to Alchemy" noise on
// every test run, passing or not.
type Level = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

// Read live (not cached at module load) so tests can flip LOG_LEVEL/NODE_ENV
// between cases without needing to re-import the module.
function resolveLevel(): Level {
  const configured = process.env.LOG_LEVEL;
  if (configured && configured in LEVEL_ORDER) return configured as Level;
  // Vitest sets NODE_ENV=test automatically - default to silent there so a
  // normal test run stays readable; LOG_LEVEL still overrides this when a
  // test is specifically debugging logging behavior.
  return process.env.NODE_ENV === "test" ? "silent" : "info";
}

function shouldLog(level: Level): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[resolveLevel()];
}

export const logger = {
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
