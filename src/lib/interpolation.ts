export function interPolatePrice(
  currentTime: string,
  beforeTime: string,
  afterTime: string,
  beforePrice: string,
  afterPrice: string
): number {
  const current = Number(currentTime) * 1000;
  const before = Number(beforeTime) * 1000;
  const after = Number(afterTime) * 1000;

  const beforeP = parseFloat(beforePrice);
  const afterP = parseFloat(afterPrice);

  if (after === before) {
    return Number(beforeP.toFixed(10));
  }

  const timeFraction = Math.min(Math.max((current - before) / (after - before), 0), 1);

  const interpolatedValue = beforeP + timeFraction * (afterP - beforeP);

  return Number(interpolatedValue.toFixed(10));
}
