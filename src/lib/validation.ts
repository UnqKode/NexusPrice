// Token address is used unvalidated as both an upstream Alchemy parameter
// and a Redis/Mongo key component in every route that takes one - an
// arbitrary string creates an unbounded cache key and gets forwarded
// straight to Alchemy. This is the one shape a valid ERC-20/EVM address
// can take; anything else is rejected before it reaches any of that.
const TOKEN_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

export function isValidTokenAddress(address: unknown): address is string {
  return typeof address === "string" && TOKEN_ADDRESS_PATTERN.test(address);
}
