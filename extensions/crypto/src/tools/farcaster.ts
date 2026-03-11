/**
 * Farcaster Tool — social actions on the Farcaster protocol via Neynar API.
 *
 * Actions:
 *   post        — Publish a cast
 *   feed        — Get a user's casts or home feed
 *   search      — Search casts by keyword
 *   user        — Get user profile info
 *   channel     — Get channel info and casts
 *   trending    — Get trending casts
 *   like        — Like a cast
 *   recast      — Recast (retweet equivalent)
 *   follow      — Follow a user
 *   unfollow    — Unfollow a user
 *
 * Uses Neynar API (api.neynar.com). Requires NEYNAR_API_KEY env var.
 * Mirrors the structure of the ClawnX (X/Twitter) tool.
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam, readNumberParam } from '../lib/tool-helpers.js';
import { guardedFetch } from '../services/endpoint-allowlist.js';
import { checkToolConfig } from '../services/tool-config-service.js';

const ACTIONS = [
  'post', 'feed', 'search', 'user', 'channel',
  'trending', 'like', 'recast', 'follow', 'unfollow',
] as const;

const FarcasterSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'post: publish a cast. feed: get user/home feed. search: search casts. ' +
      'user: get profile. channel: channel info + casts. trending: trending casts. ' +
      'like/recast: engage with cast. follow/unfollow: manage follows.',
  }),
  text: Type.Optional(Type.String({
    description: 'Cast text content. Required for post. Max 320 characters.',
  })),
  username: Type.Optional(Type.String({
    description: 'Farcaster username (without @). Used for feed/user/follow/unfollow.',
  })),
  fid: Type.Optional(Type.Number({
    description: 'Farcaster ID (numeric). Alternative to username.',
  })),
  query: Type.Optional(Type.String({
    description: 'Search query. Required for search action.',
  })),
  channel_id: Type.Optional(Type.String({
    description: 'Channel ID (e.g. "base", "farcaster", "memes"). Required for channel action.',
  })),
  cast_hash: Type.Optional(Type.String({
    description: 'Cast hash for like/recast actions.',
  })),
  parent_hash: Type.Optional(Type.String({
    description: 'Parent cast hash for replying. Optional for post.',
  })),
  parent_url: Type.Optional(Type.String({
    description: 'Channel URL for posting to a channel. Optional for post.',
  })),
  limit: Type.Optional(Type.Number({
    description: 'Max results. Default: 20.',
  })),
  cursor: Type.Optional(Type.String({
    description: 'Pagination cursor for next page of results.',
  })),
});

export function createFarcasterTool() {
  return {
    name: 'farcaster',
    label: 'Farcaster',
    ownerOnly: true,
    description:
      'Social actions on Farcaster: post casts, browse feeds, search, follow users, ' +
      'engage with content (like/recast), and explore channels and trending casts. ' +
      'Requires NEYNAR_API_KEY.',
    parameters: FarcasterSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const configCheck = checkToolConfig('farcaster');
      if (configCheck) return configCheck;

      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      try {
        switch (action) {
          case 'post':
            return handlePost(params);
          case 'feed':
            return handleFeed(params);
          case 'search':
            return handleSearch(params);
          case 'user':
            return handleUser(params);
          case 'channel':
            return handleChannel(params);
          case 'trending':
            return handleTrending(params);
          case 'like':
            return handleLike(params);
          case 'recast':
            return handleRecast(params);
          case 'follow':
            return handleFollow(params);
          case 'unfollow':
            return handleUnfollow(params);
          default:
            return errorResult(`Unknown action: ${action}.`);
        }
      } catch (err) {
        return errorResult(`Farcaster error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

// ── API Helpers ──────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.NEYNAR_API_KEY;
  if (!key) throw new Error('NEYNAR_API_KEY not set.');
  return key;
}

function getSignerUuid(): string {
  const uuid = process.env.NEYNAR_SIGNER_UUID;
  if (!uuid) throw new Error('NEYNAR_SIGNER_UUID not set. Required for write operations.');
  return uuid;
}

async function neynarGet(path: string, params?: Record<string, string>): Promise<any> {
  const url = new URL(`https://api.neynar.com/v2/farcaster/${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v) url.searchParams.set(k, v);
    }
  }

  const response = await guardedFetch(url.toString(), {
    headers: {
      accept: 'application/json',
      api_key: getApiKey(),
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Neynar API ${response.status}: ${text.slice(0, 200)}`);
  }

  return response.json();
}

async function neynarPost(path: string, body: Record<string, unknown>): Promise<any> {
  const response = await guardedFetch(`https://api.neynar.com/v2/farcaster/${path}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      api_key: getApiKey(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Neynar API ${response.status}: ${text.slice(0, 200)}`);
  }

  return response.json();
}

// ── Resolve FID from username ────────────────────────────────────────────

async function resolveFid(params: Record<string, unknown>): Promise<number> {
  const fid = readNumberParam(params, 'fid');
  if (fid) return fid;

  const username = readStringParam(params, 'username');
  if (!username) throw new Error('Either username or fid is required.');

  const data = await neynarGet('user/by_username', { username });
  const user = data?.user;
  if (!user?.fid) throw new Error(`User "${username}" not found.`);
  return user.fid;
}

// ── Action Handlers ─────────────────────────────────────────────────────

async function handlePost(params: Record<string, unknown>) {
  const text = readStringParam(params, 'text');
  if (!text) return errorResult('text is required for post (max 320 characters).');
  if (text.length > 320) return errorResult(`Cast too long (${text.length}/320). Shorten your text.`);

  const body: Record<string, unknown> = {
    signer_uuid: getSignerUuid(),
    text,
  };

  const parentHash = readStringParam(params, 'parent_hash');
  const parentUrl = readStringParam(params, 'parent_url');
  if (parentHash) body.parent = parentHash;
  if (parentUrl) body.channel_id = parentUrl;

  const data = await neynarPost('cast', body);
  const cast = data?.cast;

  return jsonResult({
    status: 'success',
    action: 'post',
    hash: cast?.hash,
    text: cast?.text ?? text,
    author: cast?.author?.username,
    parentHash: parentHash ?? undefined,
    channel: parentUrl ?? undefined,
  });
}

async function handleFeed(params: Record<string, unknown>) {
  const limit = readNumberParam(params, 'limit') ?? 20;
  const cursor = readStringParam(params, 'cursor');

  const username = readStringParam(params, 'username');
  const fid = readNumberParam(params, 'fid');

  let data: any;
  if (username || fid) {
    const resolvedFid = fid ?? await resolveFid(params);
    data = await neynarGet('feed/user/casts', {
      fid: String(resolvedFid),
      limit: String(limit),
      ...(cursor ? { cursor } : {}),
    });
  } else {
    // Home feed requires signer
    data = await neynarGet('feed', {
      feed_type: 'following',
      fid: String(process.env.NEYNAR_FID ?? '0'),
      limit: String(limit),
      ...(cursor ? { cursor } : {}),
    });
  }

  const casts: any[] = data?.casts ?? [];

  return jsonResult({
    count: casts.length,
    casts: casts.map(formatCast),
    nextCursor: data?.next?.cursor ?? null,
  });
}

async function handleSearch(params: Record<string, unknown>) {
  const query = readStringParam(params, 'query');
  if (!query) return errorResult('query is required for search.');

  const limit = readNumberParam(params, 'limit') ?? 20;

  const data = await neynarGet('cast/search', {
    q: query,
    limit: String(limit),
  });

  const casts: any[] = data?.result?.casts ?? [];

  return jsonResult({
    query,
    count: casts.length,
    casts: casts.map(formatCast),
  });
}

async function handleUser(params: Record<string, unknown>) {
  const username = readStringParam(params, 'username');
  const fid = readNumberParam(params, 'fid');

  if (!username && !fid) return errorResult('username or fid is required for user lookup.');

  let data: any;
  if (username) {
    data = await neynarGet('user/by_username', { username });
  } else {
    data = await neynarGet('user/bulk', { fids: String(fid) });
    data = { user: data?.users?.[0] };
  }

  const user = data?.user;
  if (!user) return errorResult(`User not found.`);

  return jsonResult({
    fid: user.fid,
    username: user.username,
    displayName: user.display_name,
    bio: user.profile?.bio?.text,
    pfpUrl: user.pfp_url,
    followerCount: user.follower_count,
    followingCount: user.following_count,
    verifiedAddresses: user.verified_addresses?.eth_addresses ?? [],
    activeStatus: user.active_status,
    powerBadge: user.power_badge,
  });
}

async function handleChannel(params: Record<string, unknown>) {
  const channelId = readStringParam(params, 'channel_id');
  if (!channelId) return errorResult('channel_id is required (e.g. "base", "farcaster", "memes").');

  const limit = readNumberParam(params, 'limit') ?? 20;

  // Get channel info + recent casts
  const [channelData, castsData] = await Promise.all([
    neynarGet('channel', { id: channelId }),
    neynarGet('feed/channels', {
      channel_ids: channelId,
      limit: String(limit),
    }),
  ]);

  const channel = channelData?.channel;
  const casts: any[] = castsData?.casts ?? [];

  return jsonResult({
    channel: channel ? {
      id: channel.id,
      name: channel.name,
      description: channel.description,
      imageUrl: channel.image_url,
      followerCount: channel.follower_count,
      leadFid: channel.lead?.fid,
    } : { id: channelId },
    casts: casts.map(formatCast),
    count: casts.length,
  });
}

async function handleTrending(params: Record<string, unknown>) {
  const limit = readNumberParam(params, 'limit') ?? 20;

  const data = await neynarGet('feed/trending', {
    limit: String(limit),
  });

  const casts: any[] = data?.casts ?? [];

  return jsonResult({
    trending: true,
    count: casts.length,
    casts: casts.map(formatCast),
  });
}

async function handleLike(params: Record<string, unknown>) {
  const castHash = readStringParam(params, 'cast_hash');
  if (!castHash) return errorResult('cast_hash is required for like.');

  await neynarPost('reaction', {
    signer_uuid: getSignerUuid(),
    reaction_type: 'like',
    target: castHash,
  });

  return jsonResult({ status: 'success', action: 'like', castHash });
}

async function handleRecast(params: Record<string, unknown>) {
  const castHash = readStringParam(params, 'cast_hash');
  if (!castHash) return errorResult('cast_hash is required for recast.');

  await neynarPost('reaction', {
    signer_uuid: getSignerUuid(),
    reaction_type: 'recast',
    target: castHash,
  });

  return jsonResult({ status: 'success', action: 'recast', castHash });
}

async function handleFollow(params: Record<string, unknown>) {
  const targetFid = await resolveFid(params);

  await neynarPost('user/follow', {
    signer_uuid: getSignerUuid(),
    target_fids: [targetFid],
  });

  return jsonResult({ status: 'success', action: 'follow', targetFid });
}

async function handleUnfollow(params: Record<string, unknown>) {
  const targetFid = await resolveFid(params);

  await neynarPost('user/unfollow', {
    signer_uuid: getSignerUuid(),
    target_fids: [targetFid],
  });

  return jsonResult({ status: 'success', action: 'unfollow', targetFid });
}

// ── Formatting ──────────────────────────────────────────────────────────

function formatCast(cast: any) {
  return {
    hash: cast.hash,
    text: cast.text,
    author: cast.author?.username ?? cast.author?.display_name ?? 'unknown',
    authorFid: cast.author?.fid,
    timestamp: cast.timestamp,
    likes: cast.reactions?.likes_count ?? 0,
    recasts: cast.reactions?.recasts_count ?? 0,
    replies: cast.replies?.count ?? 0,
    channel: cast.channel?.id ?? null,
    embeds: cast.embeds?.length > 0
      ? cast.embeds.map((e: any) => e.url ?? e.cast_id?.hash).filter(Boolean)
      : undefined,
  };
}
