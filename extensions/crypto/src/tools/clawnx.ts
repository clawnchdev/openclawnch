/**
 * ClawnX Tool — X/Twitter integration via @clawnch/clawnx
 *
 * 45+ actions covering content posting, engagement, social graph,
 * timelines, DMs, lists, streaming, and action chaining.
 *
 * Env vars: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN,
 *           X_ACCESS_TOKEN_SECRET, X_BEARER_TOKEN
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam, readNumberParam } from '../lib/tool-helpers.js';
import { checkToolConfig } from '../services/tool-config-service.js';

const ACTIONS = [
  // Content
  'post_tweet', 'post_thread', 'post_with_media', 'upload_media',
  'delete_tweet', 'get_tweet', 'search',
  // Engagement
  'like', 'unlike', 'retweet', 'unretweet',
  'bookmark', 'unbookmark', 'list_bookmarks', 'list_likes',
  'liking_users', 'retweeted_by', 'quote_tweets',
  // Social
  'follow', 'unfollow', 'list_followers', 'list_following',
  'block', 'unblock', 'mute', 'unmute',
  'list_blocked', 'list_muted',
  'get_user', 'search_users', 'lookup_users',
  // Timelines
  'get_timeline', 'home_timeline', 'get_mentions',
  'get_my_profile', 'get_tweet_metrics',
  // DMs
  'send_dm', 'send_dm_to_conversation', 'list_dms', 'get_dm_conversation',
  // Threads
  'get_conversation',
  // Lists
  'create_list', 'delete_list', 'get_list', 'get_user_lists',
  'add_list_member', 'remove_list_member', 'list_members', 'list_tweets',
  // Streaming
  'stream_start', 'stream_stop', 'stream_rules_set', 'stream_rules_get',
  // Orchestration
  'action_chain',
] as const;

const ClawnXSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'Content: post_tweet, post_thread, search, get_tweet. ' +
      'Engagement: like, retweet, bookmark. Social: follow, block, get_user. ' +
      'Timelines: get_timeline, home_timeline, get_mentions. ' +
      'DMs: send_dm, list_dms. Lists: create_list, list_tweets. ' +
      'Streaming: stream_start/stop/rules. Orchestration: action_chain.',
  }),
  text: Type.Optional(Type.String({ description: 'Tweet text or DM message' })),
  thread: Type.Optional(Type.String({ description: 'JSON array of tweet objects for post_thread' })),
  query: Type.Optional(Type.String({ description: 'Search query' })),
  tweet_id: Type.Optional(Type.String({ description: 'Tweet ID' })),
  username: Type.Optional(Type.String({ description: 'X username (without @)' })),
  usernames: Type.Optional(Type.String({ description: 'Comma-separated usernames for lookup' })),
  reply_to: Type.Optional(Type.String({ description: 'Tweet ID to reply to' })),
  quote: Type.Optional(Type.String({ description: 'Tweet ID to quote' })),
  media_url: Type.Optional(Type.String({ description: 'URL of media to upload' })),
  media_type: Type.Optional(Type.String({ description: 'MIME type override for media' })),
  count: Type.Optional(Type.Number({ description: 'Number of results (max 100, default 20)' })),
  list_id: Type.Optional(Type.String({ description: 'List ID' })),
  list_name: Type.Optional(Type.String({ description: 'Name for new list' })),
  list_description: Type.Optional(Type.String({ description: 'Description for new list' })),
  list_private: Type.Optional(Type.Boolean({ description: 'Make list private' })),
  conversation_id: Type.Optional(Type.String({ description: 'DM conversation ID' })),
  stream_rules: Type.Optional(Type.String({ description: 'JSON array of stream rules [{value, tag?}]' })),
  stream_duration: Type.Optional(Type.Number({ description: 'Stream duration in seconds (max 300)' })),
  chain_steps: Type.Optional(Type.String({ description: 'JSON array of action objects for action_chain' })),
});

// Lazy singleton
let _client: any = null;

async function getClawnX(): Promise<any> {
  if (_client) return _client;

  // Check required env vars
  const required = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing X/Twitter credentials: ${missing.join(', ')}. Set these environment variables.`);
  }

  const mod = await import('@clawnch/clawnx');
  _client = new mod.ClawnX();
  return _client;
}

export function createClawnXTool() {
  return {
    name: 'clawnx',
    label: 'ClawnX (X/Twitter)',
    ownerOnly: false,
    description:
      'X/Twitter integration: post tweets, threads, media. Engage with likes, retweets, bookmarks. ' +
      'Manage followers, lists, DMs. Monitor with streaming. Chain multiple actions together. ' +
      'Requires X API credentials (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET).',
    parameters: ClawnXSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      // Early check: is the tool configured?
      const notReady = checkToolConfig('clawnx');
      if (notReady) return notReady;

      const p = args as Record<string, unknown>;
      const action = readStringParam(p, 'action', { required: true })!;

      try {
        const x = await getClawnX();
        const count = Math.min(readNumberParam(p, 'count') ?? 20, 100);

        switch (action) {
          // ── Content ─────────────────────────────────────────────────
          case 'post_tweet': {
            const text = readStringParam(p, 'text', { required: true })!;
            const result = await x.postTweet({
              text,
              replyTo: readStringParam(p, 'reply_to'),
              quoteTweetId: readStringParam(p, 'quote'),
            });
            return jsonResult({ status: 'posted', tweet: result, tweet_id: result?.data?.id });
          }

          case 'post_thread': {
            const threadStr = readStringParam(p, 'thread', { required: true })!;
            const tweets = JSON.parse(threadStr);
            if (!Array.isArray(tweets) || tweets.length < 2) {
              return errorResult('Thread must be a JSON array with at least 2 tweet objects [{text: "..."}]');
            }
            const result = await x.postThread(tweets);
            return jsonResult({ status: 'posted', thread: result });
          }

          case 'post_with_media': {
            const text = readStringParam(p, 'text', { required: true })!;
            const mediaUrl = readStringParam(p, 'media_url', { required: true })!;
            const media = await x.uploadMediaFromUrl({
              url: mediaUrl,
              mimeType: readStringParam(p, 'media_type'),
            });
            const result = await x.postTweet({
              text,
              mediaIds: [media.media_id_string],
              replyTo: readStringParam(p, 'reply_to'),
              quoteTweetId: readStringParam(p, 'quote'),
            });
            return jsonResult({ status: 'posted', tweet: result, media_id: media.media_id_string });
          }

          case 'upload_media': {
            const mediaUrl = readStringParam(p, 'media_url', { required: true })!;
            const result = await x.uploadMediaFromUrl({
              url: mediaUrl,
              mimeType: readStringParam(p, 'media_type'),
            });
            return jsonResult({ status: 'uploaded', media_id: result.media_id_string });
          }

          case 'delete_tweet': {
            const tweetId = readStringParam(p, 'tweet_id', { required: true })!;
            await x.deleteTweet(tweetId);
            return jsonResult({ status: 'deleted', tweet_id: tweetId });
          }

          case 'get_tweet': {
            const tweetId = readStringParam(p, 'tweet_id', { required: true })!;
            const result = await x.getTweet(tweetId);
            return jsonResult(result);
          }

          case 'search': {
            const query = readStringParam(p, 'query', { required: true })!;
            const result = await x.searchTweets({ query, maxResults: Math.min(count, 10) });
            return jsonResult(result);
          }

          // ── Engagement ──────────────────────────────────────────────
          case 'like': {
            const tweetId = readStringParam(p, 'tweet_id', { required: true })!;
            await x.likeTweet(tweetId);
            return jsonResult({ status: 'liked', tweet_id: tweetId });
          }

          case 'unlike': {
            const tweetId = readStringParam(p, 'tweet_id', { required: true })!;
            await x.unlikeTweet(tweetId);
            return jsonResult({ status: 'unliked', tweet_id: tweetId });
          }

          case 'retweet': {
            const tweetId = readStringParam(p, 'tweet_id', { required: true })!;
            await x.retweet(tweetId);
            return jsonResult({ status: 'retweeted', tweet_id: tweetId });
          }

          case 'unretweet': {
            const tweetId = readStringParam(p, 'tweet_id', { required: true })!;
            await x.unretweet(tweetId);
            return jsonResult({ status: 'unretweeted', tweet_id: tweetId });
          }

          case 'bookmark': {
            const tweetId = readStringParam(p, 'tweet_id', { required: true })!;
            await x.bookmarkTweet(tweetId);
            return jsonResult({ status: 'bookmarked', tweet_id: tweetId });
          }

          case 'unbookmark': {
            const tweetId = readStringParam(p, 'tweet_id', { required: true })!;
            await x.unbookmarkTweet(tweetId);
            return jsonResult({ status: 'unbookmarked', tweet_id: tweetId });
          }

          case 'list_bookmarks': {
            const result = await x.getBookmarks({ maxResults: count });
            return jsonResult(result);
          }

          case 'list_likes': {
            const username = readStringParam(p, 'username', { required: true })!;
            const result = await x.getLikedTweets(username, { maxResults: count });
            return jsonResult(result);
          }

          case 'liking_users': {
            const tweetId = readStringParam(p, 'tweet_id', { required: true })!;
            const result = await x.getLikingUsers(tweetId, { maxResults: count });
            return jsonResult(result);
          }

          case 'retweeted_by': {
            const tweetId = readStringParam(p, 'tweet_id', { required: true })!;
            const result = await x.getRetweetedBy(tweetId, { maxResults: count });
            return jsonResult(result);
          }

          case 'quote_tweets': {
            const tweetId = readStringParam(p, 'tweet_id', { required: true })!;
            const result = await x.getQuoteTweets(tweetId, { maxResults: count });
            return jsonResult(result);
          }

          // ── Social Graph ────────────────────────────────────────────
          case 'follow': {
            const username = readStringParam(p, 'username', { required: true })!;
            await x.followUser(username);
            return jsonResult({ status: 'followed', username });
          }

          case 'unfollow': {
            const username = readStringParam(p, 'username', { required: true })!;
            await x.unfollowUser(username);
            return jsonResult({ status: 'unfollowed', username });
          }

          case 'list_followers': {
            const username = readStringParam(p, 'username', { required: true })!;
            const result = await x.getFollowers(username, { maxResults: count });
            return jsonResult(result);
          }

          case 'list_following': {
            const username = readStringParam(p, 'username', { required: true })!;
            const result = await x.getFollowing(username, { maxResults: count });
            return jsonResult(result);
          }

          case 'block': {
            const username = readStringParam(p, 'username', { required: true })!;
            await x.blockUser(username);
            return jsonResult({ status: 'blocked', username });
          }

          case 'unblock': {
            const username = readStringParam(p, 'username', { required: true })!;
            await x.unblockUser(username);
            return jsonResult({ status: 'unblocked', username });
          }

          case 'mute': {
            const username = readStringParam(p, 'username', { required: true })!;
            await x.muteUser(username);
            return jsonResult({ status: 'muted', username });
          }

          case 'unmute': {
            const username = readStringParam(p, 'username', { required: true })!;
            await x.unmuteUser(username);
            return jsonResult({ status: 'unmuted', username });
          }

          case 'list_blocked': {
            const result = await x.getBlockedUsers({ maxResults: count });
            return jsonResult(result);
          }

          case 'list_muted': {
            const result = await x.getMutedUsers({ maxResults: count });
            return jsonResult(result);
          }

          case 'get_user': {
            const username = readStringParam(p, 'username', { required: true })!;
            const result = await x.getUser(username);
            return jsonResult(result);
          }

          case 'search_users': {
            const query = readStringParam(p, 'query', { required: true })!;
            const result = await x.searchUsers(query, { maxResults: count });
            return jsonResult(result);
          }

          case 'lookup_users': {
            const usernamesStr = readStringParam(p, 'usernames', { required: true })!;
            const usernames = usernamesStr.split(',').map(u => u.trim());
            const result = await x.getUsersByUsernames(usernames);
            return jsonResult(result);
          }

          // ── Timelines ───────────────────────────────────────────────
          case 'get_timeline': {
            const username = readStringParam(p, 'username', { required: true })!;
            const result = await x.getUserTimeline(username, { maxResults: Math.min(count, 10) });
            return jsonResult(result);
          }

          case 'home_timeline': {
            const result = await x.getHomeTimeline({ maxResults: count });
            return jsonResult(result);
          }

          case 'get_mentions': {
            const result = await x.getMentions({ maxResults: Math.min(count, 10) });
            return jsonResult(result);
          }

          case 'get_my_profile': {
            const result = await x.getMyProfile();
            return jsonResult(result);
          }

          case 'get_tweet_metrics': {
            const tweetId = readStringParam(p, 'tweet_id', { required: true })!;
            const result = await x.getTweetMetrics(tweetId);
            return jsonResult(result);
          }

          // ── DMs ─────────────────────────────────────────────────────
          case 'send_dm': {
            const username = readStringParam(p, 'username', { required: true })!;
            const text = readStringParam(p, 'text', { required: true })!;
            const result = await x.sendDM(username, { text });
            return jsonResult({ status: 'sent', result });
          }

          case 'send_dm_to_conversation': {
            const convId = readStringParam(p, 'conversation_id', { required: true })!;
            const text = readStringParam(p, 'text', { required: true })!;
            const result = await x.sendDMToConversation(convId, { text });
            return jsonResult({ status: 'sent', result });
          }

          case 'list_dms': {
            const result = await x.getDMEvents({ maxResults: count });
            return jsonResult(result);
          }

          case 'get_dm_conversation': {
            const convId = readStringParam(p, 'conversation_id', { required: true })!;
            const result = await x.getDMConversation(convId, { maxResults: count });
            return jsonResult(result);
          }

          // ── Threads / Conversations ─────────────────────────────────
          case 'get_conversation': {
            const tweetId = readStringParam(p, 'tweet_id', { required: true })!;
            const result = await x.getConversation(tweetId, { maxResults: count });
            return jsonResult(result);
          }

          // ── Lists ───────────────────────────────────────────────────
          case 'create_list': {
            const name = readStringParam(p, 'list_name', { required: true })!;
            const result = await x.createList({
              name,
              description: readStringParam(p, 'list_description'),
              private: p.list_private as boolean | undefined,
            });
            return jsonResult({ status: 'created', list: result });
          }

          case 'delete_list': {
            const listId = readStringParam(p, 'list_id', { required: true })!;
            await x.deleteList(listId);
            return jsonResult({ status: 'deleted', list_id: listId });
          }

          case 'get_list': {
            const listId = readStringParam(p, 'list_id', { required: true })!;
            const result = await x.getList(listId);
            return jsonResult(result);
          }

          case 'get_user_lists': {
            const username = readStringParam(p, 'username', { required: true })!;
            const result = await x.getUserLists(username, { maxResults: count });
            return jsonResult(result);
          }

          case 'add_list_member': {
            const listId = readStringParam(p, 'list_id', { required: true })!;
            const username = readStringParam(p, 'username', { required: true })!;
            await x.addListMember(listId, username);
            return jsonResult({ status: 'added', list_id: listId, username });
          }

          case 'remove_list_member': {
            const listId = readStringParam(p, 'list_id', { required: true })!;
            const username = readStringParam(p, 'username', { required: true })!;
            await x.removeListMember(listId, username);
            return jsonResult({ status: 'removed', list_id: listId, username });
          }

          case 'list_members': {
            const listId = readStringParam(p, 'list_id', { required: true })!;
            const result = await x.getListMembers(listId, { maxResults: count });
            return jsonResult(result);
          }

          case 'list_tweets': {
            const listId = readStringParam(p, 'list_id', { required: true })!;
            const result = await x.getListTweets(listId, { maxResults: count });
            return jsonResult(result);
          }

          // ── Streaming ───────────────────────────────────────────────
          case 'stream_start': {
            const duration = Math.min(readNumberParam(p, 'stream_duration') ?? 30, 300);
            await x.stopStream(); // Stop any existing stream
            const result = await x.streamFiltered({
              durationMs: duration * 1000,
              maxTweets: 50,
            });
            return jsonResult({ status: 'stream_complete', tweets: result });
          }

          case 'stream_stop': {
            await x.stopStream();
            return jsonResult({ status: 'stream_stopped' });
          }

          case 'stream_rules_set': {
            const rulesStr = readStringParam(p, 'stream_rules', { required: true })!;
            const rules = JSON.parse(rulesStr);
            const result = await x.setStreamRules(rules);
            return jsonResult({ status: 'rules_set', result });
          }

          case 'stream_rules_get': {
            const result = await x.getStreamRules();
            return jsonResult(result);
          }

          // ── Orchestration ───────────────────────────────────────────
          case 'action_chain': {
            const stepsStr = readStringParam(p, 'chain_steps', { required: true })!;
            const steps = JSON.parse(stepsStr);
            if (!Array.isArray(steps) || steps.length === 0) {
              return errorResult('chain_steps must be a non-empty JSON array of action objects');
            }

            const results: any[] = [];
            let prevMetadata: any = {};

            for (let i = 0; i < steps.length; i++) {
              const step = steps[i] as Record<string, unknown>;

              // Substitute PREV_TWEET_ID placeholder
              for (const [key, val] of Object.entries(step)) {
                if (typeof val === 'string' && val.includes('PREV_TWEET_ID')) {
                  step[key] = val.replace(
                    'PREV_TWEET_ID',
                    prevMetadata.tweet_id || prevMetadata.first_tweet_id || '',
                  );
                }
              }

              // Recursive call: extract action and pass full step as args
              const stepAction = step.action as string;
              if (!stepAction) {
                results.push({ step: i, error: 'Missing action in chain step' });
                break;
              }

              // Re-invoke this tool's execute with the step params
              const stepResult = await createClawnXTool().execute(_toolCallId, step) as any;
              const parsed = JSON.parse(stepResult.content[0]!.text);

              if (stepResult.isError) {
                results.push({ step: i, action: stepAction, error: parsed });
                break;
              }

              results.push({ step: i, action: stepAction, result: parsed });
              prevMetadata = parsed;
            }

            return jsonResult({ status: 'chain_complete', steps: results });
          }

          default:
            return errorResult(`Unknown clawnx action: ${action}`);
        }
      } catch (err) {
        return errorResult(`ClawnX error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
