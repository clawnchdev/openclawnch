import { defineConfig } from 'tsdown';

/**
 * Bundle runtime dependencies into the output so the compiled plugin is
 * self-contained and doesn't rely on the host framework hoisting them.
 *
 * Without this, tsdown auto-externalizes every package listed in
 * dependencies/peerDependencies, producing bare `import … from "viem"`
 * statements that break at runtime when the host doesn't provide them.
 *
 * Packages NOT listed here stay external (the default):
 *   - openclaw              — host framework, installed globally in Docker
 *   - @walletconnect/*      — optional peer dep, installed globally
 *   - @clawnch/clawncher-sdk — depends on @uniswap/v4-sdk which has a
 *                              broken `ethers/lib/utils` CJS import that
 *                              rolldown can't resolve.  Installed via
 *                              Dockerfile instead.
 */
export default defineConfig({
  // Regex patterns to match the package AND all subpath imports
  // (e.g. /^viem/ matches both "viem" and "viem/chains").
  // Only packages listed in our own dependencies need overriding —
  // transitive deps not in package.json are bundled automatically.
  noExternal: [
    /^@sinclair\/typebox/,
    /^viem/,
    /^@clawnch\/sdk/,
    /^@clawnch\/clawnx/,
    /^@clawnch\/clawncher-sdk/,
    /^clanker-sdk/,
    /^@uniswap\/sdk-core/,
    /^@noble\/hashes/,
    /^@scure\/bip39/,
  ],
  // @uniswap/v4-sdk stays external — it has a broken `ethers/lib/utils`
  // CJS import that rolldown can't resolve (ethers v5 → v6 mismatch).
  // Installed in Docker via npm pack to avoid the workspace:* problem.
  external: [
    /^@uniswap\/v4-sdk/,
    /^@uniswap\/v3-sdk/,
  ],
});
