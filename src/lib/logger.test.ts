import { describe, it, expect, afterEach, vi } from "vitest";
import { logger } from "./logger";

describe("logger", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("is silent by default under NODE_ENV=test (vitest's own default)", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("LOG_LEVEL", "");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    logger.debug("x");
    logger.info("x");
    logger.warn("x");
    logger.error("x");

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("LOG_LEVEL explicitly overrides the test-env default", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("LOG_LEVEL", "debug");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    logger.debug("visible");
    expect(logSpy).toHaveBeenCalledWith("visible");
  });

  it("defaults to info level outside of the test environment", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LOG_LEVEL", "");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    logger.debug("hidden");
    logger.info("shown");

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("shown");
  });

  it("respects level ordering - a warn floor suppresses info/debug but not warn/error", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LOG_LEVEL", "warn");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith("c");
    expect(errorSpy).toHaveBeenCalledWith("d");
  });

  it("LOG_LEVEL=silent suppresses even error", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LOG_LEVEL", "silent");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    logger.error("should not print");
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
