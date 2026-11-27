// LaunchGuard RPC configuration.
//
// Resolution order for an RPC endpoint (first match wins):
//   1. Global override:  globalThis.LAUNCHGUARD_CONFIG?.rpcEndpoints?.[cluster]
//      In the browser this is set with a small inline <script> in index.html
//      BEFORE the module script runs, e.g.:
//
//        <script>
//          window.LAUNCHGUARD_CONFIG = {
//            rpcEndpoints: {
//              // ⬇⬇⬇  PASTE YOUR HELIUS URL HERE  ⬇⬇⬇
//              // Get it from https://dashboard.helius.dev (free tier) —
//              // the endpoint looks like:
//              //   https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
//              // Replace YOUR_KEY with your own key. Never commit a real key.
//              "mainnet-beta": "https://mainnet.helius-rpc.com/?api-key=YOUR_KEY",
//              // Optional devnet Helius URL (same shape, devnet host):
//              // devnet: "https://devnet.helius-rpc.com/?api-key=YOUR_KEY",
//            },
//          };
//        </script>
//
//   2. Node environment variables (when process.env exists):
//        LAUNCHGUARD_RPC_MAINNET  -> cluster "mainnet-beta"
//        LAUNCHGUARD_RPC_DEVNET   -> cluster "devnet"
//      e.g.  LAUNCHGUARD_RPC_MAINNET="https://mainnet.helius-rpc.com/?api-key=YOUR_KEY" npm test
//
//   3. The public endpoints below (rate-limited; fine for a quick look,
//      not recommended for a live demo — the hackathon organizers' own tip
//      is "never demo on a public RPC endpoint").

/**
 * Per-call RPC timeout in milliseconds (LG-B3). 10 s is demo-friendly:
 * public Solana RPC calls normally answer in well under a second, so
 * 10 s is generous headroom for a slow endpoint, while still bounding a
 * hung connection to a wait a demo audience will tolerate before the UI
 * reports a typed timeout instead of spinning forever. Injectable in
 * tests via the `timeoutMs` option on the data-layer calls.
 */
export const RPC_TIMEOUT_MS = 10_000;

/** Public fallback endpoints. No API key required, but aggressively rate-limited. */
export const PUBLIC_RPC_ENDPOINTS = {
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
};

// Maps a cluster name to its Node environment variable name.
const ENV_VAR_BY_CLUSTER = {
  "mainnet-beta": "LAUNCHGUARD_RPC_MAINNET",
  devnet: "LAUNCHGUARD_RPC_DEVNET",
};

/**
 * Resolve the RPC endpoint URL for a cluster.
 * @param {string} cluster  "mainnet-beta" or "devnet"
 * @returns {string} endpoint URL
 * @throws {Error} on unknown cluster
 */
export function getRpcEndpoint(cluster) {
  if (!Object.prototype.hasOwnProperty.call(PUBLIC_RPC_ENDPOINTS, cluster)) {
    throw new Error(`Unknown cluster: ${cluster}`);
  }

  let endpoint = null;

  // (a) Global override — browser config snippet or tests.
  const globalOverride = globalThis.LAUNCHGUARD_CONFIG?.rpcEndpoints?.[cluster];
  if (typeof globalOverride === "string" && globalOverride.length > 0) {
    endpoint = globalOverride;
  } else if (typeof process !== "undefined" && process.env) {
    // (b) Node environment variable.
    const envValue = process.env[ENV_VAR_BY_CLUSTER[cluster]];
    if (typeof envValue === "string" && envValue.length > 0) {
      endpoint = envValue;
    }
  }

  // (c) Public fallback.
  if (endpoint === null) endpoint = PUBLIC_RPC_ENDPOINTS[cluster];

  // FIX 3: validate the resolved endpoint. Only https, or http on a
  // local host (e.g. a local validator at http://localhost:8899), is allowed.
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`Invalid RPC endpoint for ${cluster}: must be an https URL`);
  }
  const isLocalHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1");
  if (url.protocol !== "https:" && !isLocalHttp) {
    throw new Error(`Invalid RPC endpoint for ${cluster}: must be an https URL`);
  }
  return endpoint;
}

/**
 * Host name of the resolved endpoint — safe to display in the UI.
 * Never returns the path/query, so an API key in the URL is never shown.
 */
export function getRpcEndpointHost(cluster) {
  try {
    return new URL(getRpcEndpoint(cluster)).host;
  } catch {
    // FIX 2: never leak the raw endpoint (it may contain an API key or be a
    // malformed string supplied as an override); return a constant instead.
    return "(invalid RPC URL)";
  }
}
