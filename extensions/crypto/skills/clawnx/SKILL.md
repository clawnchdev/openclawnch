---
name: clawnx
description: X/Twitter integration — post tweets, threads, media. Engage with likes, retweets, bookmarks. Manage followers, lists, DMs. Monitor with streaming. Chain multiple actions.
metadata: { "openclaw": { "emoji": "𝕏", "requires": { "env": ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"] } } }
---

# ClawnX — X/Twitter Integration

## When to Use

- User wants to post a tweet or thread (e.g., announce a token launch)
- User wants to engage with content (like, retweet, bookmark)
- User wants to manage their X social graph (follow, block, mute)
- User wants to check their timeline, mentions, or DMs
- User wants to manage X lists
- User wants to monitor a topic via streaming
- User wants to chain multiple X actions together

## When NOT to Use

- Non-social media tasks
- Content that violates X's ToS

## Tool: `clawnx`

### Content Actions

| Action | Params | Description |
|--------|--------|-------------|
| `post_tweet` | text, reply_to?, quote? | Post a tweet. Optional reply or quote. |
| `post_thread` | thread (JSON array) | Post a multi-tweet thread. Min 2 tweets. |
| `post_with_media` | text, media_url | Upload media from URL and post with tweet text |
| `upload_media` | media_url | Upload media only (returns media_id for later use) |
| `delete_tweet` | tweet_id | Delete a tweet |
| `get_tweet` | tweet_id | Get tweet details |
| `search` | query, count | Search tweets (max 10 results) |

### Engagement Actions

| Action | Params | Description |
|--------|--------|-------------|
| `like` / `unlike` | tweet_id | Like or unlike a tweet |
| `retweet` / `unretweet` | tweet_id | Retweet or undo retweet |
| `bookmark` / `unbookmark` | tweet_id | Bookmark or remove bookmark |
| `list_bookmarks` | count | List your bookmarks |
| `list_likes` | username, count | List a user's likes |
| `liking_users` | tweet_id, count | Who liked a tweet |
| `retweeted_by` | tweet_id, count | Who retweeted a tweet |
| `quote_tweets` | tweet_id, count | Quote tweets of a tweet |

### Social Graph Actions

| Action | Params | Description |
|--------|--------|-------------|
| `follow` / `unfollow` | username | Follow or unfollow a user |
| `block` / `unblock` | username | Block or unblock |
| `mute` / `unmute` | username | Mute or unmute |
| `list_followers` | username, count | List followers |
| `list_following` | username, count | List following |
| `list_blocked` | count | List blocked users |
| `list_muted` | count | List muted users |
| `get_user` | username | Get user profile |
| `search_users` | query, count | Search users |
| `lookup_users` | usernames (comma-separated) | Bulk user lookup |

### Timeline Actions

| Action | Params | Description |
|--------|--------|-------------|
| `get_timeline` | username, count | User's timeline (max 10) |
| `home_timeline` | count | Your home timeline |
| `get_mentions` | count | Your mentions (max 10) |
| `get_my_profile` | — | Your own profile |
| `get_tweet_metrics` | tweet_id | Impressions, engagements, etc. |

### DM Actions

| Action | Params | Description |
|--------|--------|-------------|
| `send_dm` | username, text | Send a DM to a user |
| `send_dm_to_conversation` | conversation_id, text | Send to an existing DM conversation |
| `list_dms` | count | List recent DM events |
| `get_dm_conversation` | conversation_id, count | Messages in a conversation |

### List Actions

| Action | Params | Description |
|--------|--------|-------------|
| `create_list` | list_name, list_description?, list_private? | Create a new list |
| `delete_list` | list_id | Delete a list |
| `get_list` | list_id | Get list details |
| `get_user_lists` | username, count | User's lists |
| `add_list_member` / `remove_list_member` | list_id, username | Manage list members |
| `list_members` | list_id, count | List members |
| `list_tweets` | list_id, count | Tweets from a list |

### Streaming

| Action | Params | Description |
|--------|--------|-------------|
| `stream_start` | stream_duration (max 300s) | Start filtered stream (uses existing rules) |
| `stream_stop` | — | Stop active stream |
| `stream_rules_set` | stream_rules (JSON array) | Set stream filter rules |
| `stream_rules_get` | — | View current rules |

### Action Chaining

Chain multiple X actions sequentially. Use `PREV_TWEET_ID` to reference the previous step's tweet ID:

```json
[
  {"action": "post_tweet", "text": "Just launched $TOKEN!"},
  {"action": "like", "tweet_id": "PREV_TWEET_ID"},
  {"action": "retweet", "tweet_id": "PREV_TWEET_ID"}
]
```

Pass as: `action: action_chain, chain_steps: [...]`

### Token Launch Promotion Pattern

After a successful `clawnch_launch`, post an announcement:

```
action: post_tweet
text: "Just launched $SYMBOL (Name) on @clawnch!\n\nTrade on Base via Uniswap V4.\n1% LP fees, MEV protection.\n\nhttps://clawn.ch/token/ADDRESS"
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `X_API_KEY` | Yes | X API key |
| `X_API_SECRET` | Yes | X API secret |
| `X_ACCESS_TOKEN` | Yes | OAuth access token |
| `X_ACCESS_TOKEN_SECRET` | Yes | OAuth access token secret |
| `X_BEARER_TOKEN` | No | Bearer token (for app-only auth) |

### Important Notes

- All write actions (post, like, follow, etc.) are rate-limited by X
- Streaming is capped at 300 seconds per invocation
- Thread posts require at least 2 tweet objects in the array
- Count is capped at 100 per request; timeline/search capped at 10
- Action chains stop on first error
