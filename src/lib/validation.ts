//check for valid token address using regex pattern
const TOKEN_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

export function isValidTokenAddress(address: unknown): address is string {
  return typeof address === "string" && TOKEN_ADDRESS_PATTERN.test(address);
}
