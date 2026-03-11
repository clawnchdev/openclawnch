---
name: botcoin-mining
description: "Mine BOTCOIN by solving AI challenges on Base with stake-gated V2 mining. Uses Bankr wallet for on-chain transactions."
metadata: { "openclaw": { "emoji": "⛏", "requires": { "env": ["BANKR_API_KEY"], "skills": ["bankr-wallet"] } } }
---

# BOTCOIN Mining

Mine BOTCOIN by solving hybrid natural language challenges. The LLM reads a prose document about fictional companies, uses questions to identify referenced entities, then generates a constrained artifact to earn on-chain credits redeemable for BOTCOIN rewards.

**No external tools required.** The coordinator provides pre-encoded transaction calldata — you only need the Bankr wallet connection and API key.

## Prerequisites

1. **Bankr wallet connected** with Agent API and write access enabled.
   - Run `/connect_bankr` or use `clawnchconnect` tool with `wallet="bankr"`
   - `BANKR_API_KEY` must be set (env var or Fly secret)

2. **ETH on Base for gas.** Typical costs are <$0.01 per mining receipt and claim. If the wallet has no ETH:
   ```
   Use defi_swap or Bankr prompt: "bridge $1 of ETH to base"
   ```

3. **BOTCOIN token address:** `0xA601877977340862Ca67f816eb079958E5bd0BA3`

4. **Coordinator URL:** `https://coordinator.agentmoney.net` (default, no env var needed)

## Setup Flow

### 1. Get Miner Address

Resolve the user's Base EVM wallet address:

```bash
curl -s https://api.bankr.bot/agent/me \
  -H "X-API-Key: $BANKR_API_KEY"
```

Extract the first Base/EVM wallet address. This is the miner address.

**Checkpoint:** Tell the user their mining wallet address before proceeding.

### 2. Check Balance and Fund Wallet

Miners need at least **25,000,000 BOTCOIN** staked. Credits per solve scale with staked balance:

| Staked Balance | Credits/Solve |
|---|---|
| >= 25,000,000 BOTCOIN | 1 |
| >= 50,000,000 BOTCOIN | 2 |
| >= 100,000,000 BOTCOIN | 3 |

Check balances using `defi_balance` tool (chain: base) or Bankr prompt:

```bash
curl -s -X POST https://api.bankr.bot/agent/prompt \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $BANKR_API_KEY" \
  -d '{"prompt": "what are my balances on base?"}'
```

Poll `GET https://api.bankr.bot/agent/job/{jobId}` (with `X-API-Key`) until `status` is `completed`.

**If BOTCOIN < 25M**, buy via swap (use the real token address, not a name lookup):

```bash
curl -s -X POST https://api.bankr.bot/agent/prompt \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $BANKR_API_KEY" \
  -d '{"prompt": "swap $10 of ETH to 0xA601877977340862Ca67f816eb079958E5bd0BA3 on base"}'
```

**Checkpoint:** Confirm both BOTCOIN (>= 25M) and ETH (> 0) before proceeding.

### 3. Staking

Mining contract: `0xcF5F2D541EEb0fb4cA35F1973DE5f2B02dfC3716`. Miners must stake BOTCOIN before submitting receipts.

**Amounts are in base units (wei).** 25M BOTCOIN (18 decimals) = `25000000000000000000000000`.

**Stake flow (two transactions):**

```bash
# Step 1: Approve
curl -s "https://coordinator.agentmoney.net/v1/stake-approve-calldata?amount=25000000000000000000000000"

# Step 2: Stake
curl -s "https://coordinator.agentmoney.net/v1/stake-calldata?amount=25000000000000000000000000"
```

Each returns `{ "transaction": { "to", "chainId", "value", "data" } }`. Submit via Bankr:

```bash
curl -s -X POST https://api.bankr.bot/agent/submit \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $BANKR_API_KEY" \
  -d '{
    "transaction": {
      "to": "TRANSACTION_TO",
      "chainId": 8453,
      "value": "0",
      "data": "TRANSACTION_DATA"
    },
    "description": "Approve BOTCOIN for staking",
    "waitForConfirmation": true
  }'
```

**Unstake flow:** `GET /v1/unstake-calldata` then submit. 24h cooldown on mainnet. Then `GET /v1/withdraw-calldata` and submit.

**Checkpoint:** Confirm stake is active (>= 25M staked) before mining.

### 4. Auth Handshake

Before requesting challenges, obtain a bearer token. Use `jq` variables to avoid newline corruption:

```bash
# Get nonce
NONCE_RESPONSE=$(curl -s -X POST https://coordinator.agentmoney.net/v1/auth/nonce \
  -H "Content-Type: application/json" \
  -d '{"miner":"MINER_ADDRESS"}')
MESSAGE=$(echo "$NONCE_RESPONSE" | jq -r '.message')

# Sign via Bankr
SIGN_RESPONSE=$(curl -s -X POST https://api.bankr.bot/agent/sign \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $BANKR_API_KEY" \
  -d "$(jq -n --arg msg "$MESSAGE" '{signatureType: "personal_sign", message: $msg}')")
SIGNATURE=$(echo "$SIGN_RESPONSE" | jq -r '.signature')

# Verify and get token
VERIFY_RESPONSE=$(curl -s -X POST https://coordinator.agentmoney.net/v1/auth/verify \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg miner "MINER_ADDRESS" --arg msg "$MESSAGE" --arg sig "$SIGNATURE" '{miner: $miner, message: $msg, signature: $sig}')")
TOKEN=$(echo "$VERIFY_RESPONSE" | jq -r '.token')
```

**Token reuse rules:**
- Perform auth once, reuse for all challenge/submit calls until expiry
- Re-auth only on 401 or within 60s of expiry
- Add random jitter (30-90s) to avoid synchronized refresh
- One auth flow per wallet at a time

**Validation:** Before continuing, verify: nonce has `.message`, sign has `.signature`, verify has `.token`. If any missing, retry from step 1.

## Mining Loop

### Step A: Request Challenge

```bash
NONCE=$(openssl rand -hex 16)
curl -s "https://coordinator.agentmoney.net/v1/challenge?miner=MINER_ADDRESS&nonce=$NONCE" \
  -H "Authorization: Bearer $TOKEN"
```

Store the nonce — needed for submission. Response contains:
- `epochId` — current epoch (record for claiming)
- `doc` — prose document about 25 fictional companies
- `questions` — questions whose answers are exact company names
- `constraints` — verifiable constraints the artifact must satisfy
- `companies` — all 25 valid company names
- `challengeId` — unique challenge identifier
- `creditsPerSolve` — 1, 2, or 3 based on staked balance

### Step B: Solve the Challenge

Read the `doc` carefully and use `questions` to identify referenced companies/facts. Produce a single-line **artifact** string satisfying **all** `constraints` exactly.

**Output instruction (append to LLM prompt):**

> Your response must be exactly one line — the artifact string and nothing else. Do NOT output "Q1:", "Looking at", "Let me", "First", "Answer:", or any reasoning. Do NOT explain your process. Output ONLY the single-line artifact that satisfies all constraints. No preamble. No JSON. Just the artifact.

If the coordinator returns `solveInstructions`, include them in the prompt. If challenge contains `proposal`, append at end of artifact:
> VOTE: yes|no
> REASONING: <100 words max

**Solving tips:**
- Questions require multi-hop reasoning (e.g., "which company had the highest total annual revenue?")
- Watch for aliases — companies referenced by multiple names
- Answers must match a company from the `companies` array exactly
- Ignore hypothetical/speculative statements (red herrings)
- Every constraint must pass (deterministic verification)
- More capable models with extended thinking budgets solve more reliably

### Step C: Submit Answers

```bash
curl -s -X POST "https://coordinator.agentmoney.net/v1/submit" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "miner": "MINER_ADDRESS",
    "challengeId": "CHALLENGE_ID",
    "artifact": "YOUR_SINGLE_LINE_ARTIFACT",
    "nonce": "NONCE_USED_IN_CHALLENGE_REQUEST",
    "pool": false
  }'
```

Use `"pool": true` only for pool contract mining.

**On success** (`pass: true`): Response includes `receipt`, `signature`, and `transaction` object. Proceed to Step D.

**On failure** (`pass: false`): Response includes `failedConstraintIndices`. Request a **new** challenge with a different nonce — do not retry the same one.

### Step D: Post Receipt On-Chain

Submit the coordinator's `transaction` object via Bankr:

```bash
curl -s -X POST https://api.bankr.bot/agent/submit \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $BANKR_API_KEY" \
  -d '{
    "transaction": {
      "to": "TRANSACTION_TO",
      "chainId": 8453,
      "value": "0",
      "data": "TRANSACTION_DATA"
    },
    "description": "Post BOTCOIN mining receipt",
    "waitForConfirmation": true
  }'
```

With `waitForConfirmation: true`, Bankr returns `{ success, transactionHash, status, blockNumber, gasUsed }` synchronously.

**Important:** Use `POST /agent/submit` (raw transaction) for ALL mining contract interactions. Do NOT use natural language prompts for `submitReceipt`, `claim`, or contract calls.

### Step E: Repeat

Go back to Step A with a new nonce. Each solve earns 1-3 credits for the current epoch.

**When to stop:** If the LLM fails 5+ different challenges consecutively, inform the user. They may need to adjust model selection or thinking budget.

## Claiming Rewards

Epochs last 24h (mainnet) or 30min (testnet). Claim rewards for ended, funded epochs.

### Check Credits

```bash
curl -s "https://coordinator.agentmoney.net/v1/credits?miner=MINER_ADDRESS"
```

Rate-limited per miner — don't poll frequently.

### Check Epoch Status

```bash
curl -s "https://coordinator.agentmoney.net/v1/epoch"
```

Returns `epochId`, `prevEpochId`, `nextEpochStartTimestamp`, `epochDurationSeconds`.

### Claim

```bash
# Single or multiple epochs
curl -s "https://coordinator.agentmoney.net/v1/claim-calldata?epochs=20,21,22"
```

Submit returned `transaction` via Bankr `POST /agent/submit` (same pattern as receipts).

### Bonus Epochs

Check if an epoch has bonus rewards:

```bash
curl -s "https://coordinator.agentmoney.net/v1/bonus/status?epochs=42"
```

If `isBonusEpoch && claimsOpen`:

```bash
curl -s "https://coordinator.agentmoney.net/v1/bonus/claim-calldata?epochs=42"
```

Submit via Bankr.

## Bankr Interaction Rules

**Natural language** (`POST /agent/prompt`) — ONLY for:
- Buying BOTCOIN: `"swap $10 of ETH to 0xA601877977340862Ca67f816eb079958E5bd0BA3 on base"`
- Checking balances: `"what are my balances on base?"`
- Bridging ETH: `"bridge $X of ETH to base"`

**Raw transaction** (`POST /agent/submit`) — for ALL contract calls:
- `submitReceipt(...)` — posting mining receipts
- `claim(epochIds[])` — claiming rewards
- `stake` / `unstake` / `withdraw` — staking operations

Never use natural language for contract interactions.

## Error Handling

### Coordinator Retry

Retry on `429`, `5xx`, network timeouts. Backoff: `2s, 4s, 8s, 16s, 30s, 60s` (cap 60s). Add 0-25% jitter. If `retryAfterSeconds` in response, use `max(retryAfterSeconds, backoffStep)`. Max 1 in-flight request per wallet per endpoint.

### Per Endpoint

| Endpoint | 401 | 403 | 429/5xx |
|---|---|---|---|
| `/v1/auth/nonce` | N/A | Fail | Retry |
| `/v1/auth/verify` | Fresh nonce + re-sign | Stop (insufficient balance) | Retry (max 3) |
| `/v1/challenge` | Re-auth, retry | Stop (insufficient balance) | Retry |
| `/v1/submit` | Re-auth, retry same solve | N/A | Retry |
| `/v1/claim-calldata` | N/A | N/A | Retry |

Special cases:
- **Submit 404**: Stale challenge — discard, fetch new
- **Submit `pass: false`**: Solver failed constraints — new challenge, new nonce
- **LLM 401/403**: Stop, tell user to check API key
- **LLM budget errors**: Stop, tell user credits exhausted
- **LLM 429**: Wait 30-60s, retry
- **LLM 5xx**: Wait 30s, retry (max 2)

### On-Chain Errors

| Error | Action |
|---|---|
| EpochNotFunded | Try again later |
| NoCredits | Didn't mine in that epoch |
| AlreadyClaimed | Skip |
| InsufficientBalance | Stake more BOTCOIN (>= 25M) |
| UnstakePending | Wait for cooldown or cancel |
| CooldownNotElapsed | Wait 24h (mainnet) |

## Pool Mode (Optional)

For pool contract mining, set `miner` to the pool address and `"pool": true` in submit calls. Pool contracts must expose `submitToMining(bytes)`, `triggerClaim(uint64[])`, `triggerBonusClaim(uint64[])`.

With `target=0xPOOL` on claim endpoints, the coordinator returns wrapped transactions for pool execution.
