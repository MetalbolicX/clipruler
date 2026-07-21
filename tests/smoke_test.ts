import { assertEquals } from "@std/assert";
import { VERSION } from "../src/version.ts";

Deno.test({
  name: "version is a non-empty semver string",
  fn() {
    assertEquals(/^\d+\.\d+\.\d+$/.test(VERSION), true);
  },
});
