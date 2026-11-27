import { test } from "node:test";
import assert from "node:assert/strict";
import { getRpcEndpoint, getRpcEndpointHost, PUBLIC_RPC_ENDPOINTS } from "../src/lib/config.js";

// Save/restore global + env state around every test so order never matters.
function withOverrides({ globalConfig, env }, fn) {
  const savedGlobal = globalThis.LAUNCHGUARD_CONFIG;
  const savedEnv = {};
  for (const key of ["LAUNCHGUARD_RPC_MAINNET", "LAUNCHGUARD_RPC_DEVNET"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  if (env) for (const [k, v] of Object.entries(env)) process.env[k] = v;
  if (globalConfig === undefined) delete globalThis.LAUNCHGUARD_CONFIG;
  else globalThis.LAUNCHGUARD_CONFIG = globalConfig;
  try {
    return fn();
  } finally {
    if (savedGlobal === undefined) delete globalThis.LAUNCHGUARD_CONFIG;
    else globalThis.LAUNCHGUARD_CONFIG = savedGlobal;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("public endpoints are the documented fallbacks", () => {
  assert.equal(PUBLIC_RPC_ENDPOINTS["mainnet-beta"], "https://api.mainnet-beta.solana.com");
  assert.equal(PUBLIC_RPC_ENDPOINTS.devnet, "https://api.devnet.solana.com");
});

test("default resolution returns the public endpoint", () => {
  withOverrides({}, () => {
    assert.equal(getRpcEndpoint("mainnet-beta"), "https://api.mainnet-beta.solana.com");
    assert.equal(getRpcEndpoint("devnet"), "https://api.devnet.solana.com");
  });
});

test("env override wins over the public fallback (Node)", () => {
  withOverrides(
    { env: { LAUNCHGUARD_RPC_MAINNET: "https://mainnet.helius-rpc.com/?api-key=TESTKEY", LAUNCHGUARD_RPC_DEVNET: "https://devnet.example.invalid/rpc" } },
    () => {
      assert.equal(getRpcEndpoint("mainnet-beta"), "https://mainnet.helius-rpc.com/?api-key=TESTKEY");
      assert.equal(getRpcEndpoint("devnet"), "https://devnet.example.invalid/rpc");
    },
  );
});

test("globalThis override wins over env and public fallback", () => {
  withOverrides(
    {
      globalConfig: { rpcEndpoints: { "mainnet-beta": "https://global.example.invalid/mainnet" } },
      env: { LAUNCHGUARD_RPC_MAINNET: "https://env.example.invalid/mainnet", LAUNCHGUARD_RPC_DEVNET: "https://env.example.invalid/devnet" },
    },
    () => {
      assert.equal(getRpcEndpoint("mainnet-beta"), "https://global.example.invalid/mainnet");
      // A global override for one cluster does not shadow the other cluster.
      assert.equal(getRpcEndpoint("devnet"), "https://env.example.invalid/devnet");
    },
  );
});

test("empty-string overrides are ignored", () => {
  withOverrides(
    { globalConfig: { rpcEndpoints: { devnet: "" } }, env: { LAUNCHGUARD_RPC_DEVNET: "" } },
    () => {
      assert.equal(getRpcEndpoint("devnet"), "https://api.devnet.solana.com");
    },
  );
});

test("unknown cluster throws", () => {
  withOverrides({}, () => {
    assert.throws(() => getRpcEndpoint("testnet"), /Unknown cluster: testnet/);
    assert.throws(() => getRpcEndpoint(""), /Unknown cluster/);
  });
});

test("malformed override host is a constant and never leaks the raw string (FIX 2)", () => {
  withOverrides(
    { globalConfig: { rpcEndpoints: { "mainnet-beta": "not a url" } } },
    () => {
      const host = getRpcEndpointHost("mainnet-beta");
      assert.equal(host, "(invalid RPC URL)");
      assert.ok(!host.includes("not a url"));
    },
  );
});

test("endpoint validation rejects non-https and non-local http (FIX 3)", () => {
  withOverrides(
    { globalConfig: { rpcEndpoints: { "mainnet-beta": "javascript:alert(1)" } } },
    () => {
      assert.throws(() => getRpcEndpoint("mainnet-beta"), /Invalid RPC endpoint for mainnet-beta: must be an https URL/);
    },
  );
  withOverrides(
    { globalConfig: { rpcEndpoints: { "mainnet-beta": "http://evil.example.com" } } },
    () => {
      assert.throws(() => getRpcEndpoint("mainnet-beta"), /Invalid RPC endpoint for mainnet-beta: must be an https URL/);
    },
  );
  withOverrides(
    { globalConfig: { rpcEndpoints: { devnet: "http://localhost:8899" } } },
    () => {
      assert.equal(getRpcEndpoint("devnet"), "http://localhost:8899");
    },
  );
});

test("endpoint host hides the API key in the URL", () => {
  withOverrides(
    { env: { LAUNCHGUARD_RPC_MAINNET: "https://mainnet.helius-rpc.com/?api-key=TESTKEY" } },
    () => {
      assert.equal(getRpcEndpointHost("mainnet-beta"), "mainnet.helius-rpc.com");
    },
  );
});
