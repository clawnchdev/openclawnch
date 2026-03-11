# NFTs

Use the `nft` tool to view, transfer, buy, list, and manage NFTs across multiple chains.

## When to Use

- User wants to view NFT metadata, image, or attributes
- User wants to transfer an NFT to someone
- User wants to buy or list an NFT on marketplaces
- User asks about collection floor prices or stats
- User wants to see their NFT portfolio

## Supported Chains

| Chain | ID | Default |
|-------|----|---------|
| Base | 8453 | Yes |
| Ethereum | 1 | |
| Arbitrum | 42161 | |
| Optimism | 10 | |
| Polygon | 137 | |

## Actions

| Action | Description | Required Params |
|--------|-------------|-----------------|
| view | NFT metadata, image, attributes | contract, token_id |
| transfer | Send NFT to address/ENS | contract, token_id, to |
| buy | Buy a listed NFT | contract, token_id |
| list | List NFT for sale | contract, token_id, price |
| collection_floor | Floor price and collection stats | collection |
| portfolio | All owned NFTs | (address optional) |

## Common Flows

### View an NFT
```
nft action=view contract=0x... token_id=123 chain=ethereum
```

### Transfer an NFT
```
nft action=transfer contract=0x... token_id=123 to=vitalik.eth
```
Supports ENS names for the recipient.

### Check collection floor
```
nft action=collection_floor collection=0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D chain=ethereum
```

### Buy a listed NFT
```
nft action=buy contract=0x... token_id=42 chain=base
```

### List an NFT for sale
```
nft action=list contract=0x... token_id=42 price=0.5 chain=base
```
Price is in ETH. Listing goes through Reservoir to OpenSea/Blur.

### View NFT portfolio
```
nft action=portfolio
nft action=portfolio address=0x... chain=ethereum limit=100
```
Groups NFTs by collection. Defaults to connected wallet and Base chain.

## API

Uses the Reservoir API which aggregates data from OpenSea, Blur, and LooksRare. Requires `RESERVOIR_API_KEY` environment variable (stored in credential vault).

## Important Notes

1. **Default chain is Base** — specify `chain=ethereum` etc. for other networks
2. **ENS resolution** — `to` field accepts ENS names (resolved on Ethereum mainnet)
3. **Transfers use ERC-721 safeTransferFrom** — only standard ERC-721 tokens supported
4. **Buy/list go through Reservoir** — marketplace fees may apply
5. **Metadata is cached** — repeat views are fast; cache expires after 5 minutes
6. **Wallet required** — transfer, buy, and list require a connected wallet
