# Browser Automation (PinchTab)

Use the `browser` tool for web page interaction via PinchTab.

## When to Use

- User wants to claim an airdrop from a dApp UI
- User wants to interact with a DeFi protocol that has no API
- User needs to read content from a web dashboard
- User wants to fill out a form or connect a wallet on a website
- User needs to scrape on-chain dashboards or protocol docs

## Prerequisites

PinchTab must be installed and running:
```bash
# Install (12MB Go binary)
curl -sSL https://pinchtab.com/install.sh | sh

# Start server
pinchtab serve
```

Default URL: `http://localhost:9222`. Override with `PINCHTAB_URL` env var.

## Actions

| Action | Description | Required Params |
|--------|-------------|-----------------|
| navigate | Go to URL, extract page content | url |
| click | Click element by CSS selector | selector |
| type | Type text into input field | selector, text |
| extract | Extract structured data from page | (selector optional) |
| screenshot | Take page screenshot | (selector optional) |
| status | Check if PinchTab is running | (none) |

## Common Flows

### Check airdrop eligibility
```
browser action=navigate url=https://claim.example.com wait_for=".claim-button"
```
Then extract the eligibility status:
```
browser action=extract selector=".eligibility-status"
```

### Claim an airdrop
```
browser action=navigate url=https://claim.example.com
browser action=click selector="button.connect-wallet"
browser action=click selector="button.claim"
```

### Read protocol dashboard
```
browser action=navigate url=https://app.aave.com
browser action=extract selector=".markets-table" format=table
```

### Fill and submit a form
```
browser action=navigate url=https://example.com/form
browser action=type selector="#email" text="user@example.com"
browser action=type selector="#amount" text="100"
browser action=click selector="button[type=submit]"
```

### Check PinchTab status
```
browser action=status
```

## Token Efficiency

PinchTab extracts structured text content (~800 tokens/page) instead of sending screenshots (~10K+ tokens). This makes it practical for LLM-driven web automation. Use `extract` for data retrieval and `screenshot` only when visual inspection is necessary.

## Important Notes

1. **Stealth mode is on by default** — bypasses common bot detection
2. **Requires PinchTab binary** — tool reports clear error if not running
3. **CSS selectors** — click/type/extract use standard CSS selectors (e.g. `"#id"`, `".class"`, `"button.submit"`)
4. **Content truncation** — navigate limits content to ~4000 chars; use extract with a selector for specific content
5. **Not for bulk scraping** — designed for interactive single-page operations. Use CF /crawl for batch research.
6. **No wallet connection** — PinchTab browses the web but doesn't sign transactions. For dApp wallet interaction, the dApp needs WalletConnect or manual steps.
