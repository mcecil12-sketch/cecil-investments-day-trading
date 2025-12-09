import Alpaca from "@alpacahq/alpaca-trade-api";

/**
 * Thin wrapper to create an Alpaca client using existing env vars.
 * Defaults to paper unless ALPACA_USE_PAPER is explicitly "false".
 */
export function getAlpacaClient() {
  return new Alpaca({
    keyId:
      process.env.ALPACA_API_KEY_ID ||
      process.env.ALPACA_KEY_ID ||
      process.env.ALPACA_API_KEY ||
      "",
    secretKey:
      process.env.ALPACA_API_SECRET_KEY ||
      process.env.ALPACA_SECRET_KEY ||
      process.env.ALPACA_API_SECRET ||
      "",
    paper: process.env.ALPACA_USE_PAPER !== "false",
  });
}
