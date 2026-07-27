// Pure, dependency-free analytics over a price series. Kept separate from
// any route/DB code so it's trivially unit-testable and reusable wherever a
// numeric price series shows up (historical-prices route, future features).

export interface AnalyticsSummary {
  /** Overall % change from the first to the last price in the series. */
  percentChange: number;
  /** Sample standard deviation of period-over-period returns, as a percentage. */
  volatility: number;
  min: number;
  max: number;
  /** Simple moving average, one entry per input price; null until the window fills. */
  sma: (number | null)[];
}

export function simpleMovingAverage(prices: number[], windowSize: number): (number | null)[] {
  const window = Math.max(1, Math.floor(windowSize));
  return prices.map((_, i) => {
    if (i < window - 1) return null;
    let sum = 0;
    for (let j = i - window + 1; j <= i; j++) sum += prices[j];
    return sum / window;
  });
}

export function percentChange(prices: number[]): number {
  if (prices.length < 2) return 0;
  const first = prices[0];
  const last = prices[prices.length - 1];
  if (first === 0) return 0;
  return ((last - first) / first) * 100;
}

/** Sample standard deviation of period-over-period returns, as a percentage. */
export function volatility(prices: number[]): number {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1];
    if (prev === 0) continue; // undefined return, skip rather than divide by zero
    returns.push((prices[i] - prev) / prev);
  }
  if (returns.length < 2) return 0;

  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);

  return Math.sqrt(variance) * 100;
}

export function summarize(prices: number[], smaWindow = 5): AnalyticsSummary {
  if (prices.length === 0) {
    return { percentChange: 0, volatility: 0, min: 0, max: 0, sma: [] };
  }
  return {
    percentChange: percentChange(prices),
    volatility: volatility(prices),
    min: Math.min(...prices),
    max: Math.max(...prices),
    sma: simpleMovingAverage(prices, smaWindow),
  };
}
