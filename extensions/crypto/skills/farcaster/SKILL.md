---
name: farcaster
description: Post casts, browse feeds, search users, and engage with content on the Farcaster protocol
---

# Farcaster

Use the `farcaster` tool for social actions on the Farcaster protocol.

## When to Use

- User wants to post a cast (Farcaster's tweet equivalent)
- User wants to browse feeds, channels, or trending content
- User wants to search for casts or users
- User wants to engage with content (like, recast)
- User wants to follow/unfollow users

## Prerequisites

Requires Neynar API key:
```
/flykeys set NEYNAR_API_KEY your_key
```
Get a key at https://neynar.com (free tier available).

For write operations (post, like, recast, follow), also set:
```
/flykeys set NEYNAR_SIGNER_UUID your_signer_uuid
```

## Actions

| Action | Description | Required Params |
|--------|-------------|-----------------|
| post | Publish a cast | text |
| feed | Get user or home feed | (username optional) |
| search | Search casts | query |
| user | Get user profile | username or fid |
| channel | Channel info + casts | channel_id |
| trending | Trending casts | (none) |
| like | Like a cast | cast_hash |
| recast | Recast a cast | cast_hash |
| follow | Follow a user | username or fid |
| unfollow | Unfollow a user | username or fid |

## Common Flows

### Post a cast
```
farcaster action=post text="gm from openclawnch"
```
Max 320 characters. Reply to a cast:
```
farcaster action=post text="great take" parent_hash=0x...
```
Post to a channel:
```
farcaster action=post text="check this out" parent_url=base
```

### Browse feeds
```
farcaster action=feed username=dwr
farcaster action=trending limit=10
farcaster action=channel channel_id=base
```

### Search
```
farcaster action=search query="base ecosystem"
```

### User profile
```
farcaster action=user username=vitalik
```

### Engage
```
farcaster action=like cast_hash=0x...
farcaster action=recast cast_hash=0x...
farcaster action=follow username=jessepollak
```

## Popular Channels

| Channel | ID | Description |
|---------|-----|-------------|
| Base | `base` | Base ecosystem |
| Farcaster | `farcaster` | Meta discussion |
| Memes | `memes` | Meme content |
| Dev | `dev` | Developer discussion |
| DeFi | `defi` | DeFi discussion |

## Important Notes

1. **Cast limit is 320 characters** — tool enforces this before posting
2. **Signer UUID required for writes** — read operations (feed, search, user) only need API key
3. **Similar to ClawnX** — same interaction patterns as the X/Twitter tool but for Farcaster
4. **Verified addresses** — user profiles include Ethereum addresses linked to Farcaster accounts
5. **Power badges** — some users have verified power badges indicating active status
