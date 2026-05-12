import test from "node:test";
import assert from "node:assert/strict";
import { requireEnv } from "../lib/env.js";

test("requireEnv returns the value when set", () => {
  const key = "__TEST_REQUIRE_ENV_OK__";
  process.env[key] = "hello";
  try {
    assert.equal(requireEnv(key), "hello");
  } finally {
    delete process.env[key];
  }
});

test("requireEnv throws with a clear message when missing", () => {
  const key = "__TEST_REQUIRE_ENV_MISSING__";
  delete process.env[key];
  assert.throws(() => requireEnv(key), /Missing required environment variable: __TEST_REQUIRE_ENV_MISSING__/);
});

test("requireEnv throws when empty string", () => {
  const key = "__TEST_REQUIRE_ENV_EMPTY__";
  process.env[key] = "";
  try {
    assert.throws(() => requireEnv(key), /Missing required environment variable: __TEST_REQUIRE_ENV_EMPTY__/);
  } finally {
    delete process.env[key];
  }
});
