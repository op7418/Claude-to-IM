/**
 * WeChat ilink Bot HTTP protocol helpers.
 *
 * Pure protocol layer — no business logic, no adapter state.
 * Covers QR login, long-poll message fetching, and message sending
 * via the official WeChat ClawBot ilink API.
 *
 * Based on reverse-engineering from:
 *   https://github.com/Johnixr/claude-code-wechat-channel
 */

import crypto from 'crypto';
import type { SendResult } from '../types.js';

// ── ilink API endpoints ────────────────────────────────────────

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const BOT_TYPE = '3';
const CHANNEL_VERSION = '0.1.0';

// ── Message type constants ─────────────────────────────────────

export const MSG_TYPE_USER = 1;
export const MSG_TYPE_BOT = 2;
export const MSG_ITEM_TEXT = 1;
export const MSG_ITEM_VOICE = 3;
export const MSG_STATE_FINISH = 2;

// ── Types ──────────────────────────────────────────────────────

export interface WeixinMessage {
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  session_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  create_time_ms?: number;
}

interface MessageItem {
  type?: number;
  text_item?: { text?: string };
  voice_item?: { text?: string };
  ref_msg?: { title?: string; message_item?: MessageItem };
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface QRStatusResponse {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired';
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

// ── HTTP helpers ───────────────────────────────────────────────

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function buildHeaders(token?: string, body?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
  };
  if (body) {
    headers['Content-Length'] = String(Buffer.byteLength(body, 'utf-8'));
  }
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
}): Promise<string> {
  const base = params.baseUrl.endsWith('/') ? params.baseUrl : `${params.baseUrl}/`;
  const url = new URL(params.endpoint, base).toString();
  const headers = buildHeaders(params.token, params.body);
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: params.body,
    signal: AbortSignal.timeout(params.timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return text;
}

// ── Context Token Cache ────────────────────────────────────────

const contextTokenCache = new Map<string, string>();

export function cacheContextToken(userId: string, token: string): void {
  contextTokenCache.set(userId, token);
}

export function getCachedContextToken(userId: string): string | undefined {
  return contextTokenCache.get(userId);
}

export function clearContextTokenCache(): void {
  contextTokenCache.clear();
}

// ── Message text extraction ────────────────────────────────────

export function extractTextFromMessage(msg: WeixinMessage): string {
  if (!msg.item_list?.length) return '';
  for (const item of msg.item_list) {
    if (item.type === MSG_ITEM_TEXT && item.text_item?.text) {
      const text = item.text_item.text;
      const ref = item.ref_msg;
      if (!ref) return text;
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      if (!parts.length) return text;
      return `[引用: ${parts.join(' | ')}]\n${text}`;
    }
    if (item.type === MSG_ITEM_VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return '';
}

// ── getUpdates (long-poll) ─────────────────────────────────────

const LONG_POLL_TIMEOUT_MS = 35_000;

export async function getUpdates(
  baseUrl: string,
  token: string,
  getUpdatesBuf: string,
): Promise<GetUpdatesResp> {
  try {
    const raw = await apiFetch({
      baseUrl,
      endpoint: 'ilink/bot/getupdates',
      body: JSON.stringify({
        get_updates_buf: getUpdatesBuf,
        base_info: { channel_version: CHANNEL_VERSION },
      }),
      token,
      timeoutMs: LONG_POLL_TIMEOUT_MS,
    });
    return JSON.parse(raw) as GetUpdatesResp;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}

// ── sendMessage ────────────────────────────────────────────────

function generateClientId(): string {
  return `claude-bridge:${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

export async function sendTextMessage(
  baseUrl: string,
  token: string,
  to: string,
  text: string,
  contextToken: string,
): Promise<SendResult> {
  const clientId = generateClientId();
  try {
    await apiFetch({
      baseUrl,
      endpoint: 'ilink/bot/sendmessage',
      body: JSON.stringify({
        msg: {
          from_user_id: '',
          to_user_id: to,
          client_id: clientId,
          message_type: MSG_TYPE_BOT,
          message_state: MSG_STATE_FINISH,
          item_list: [{ type: MSG_ITEM_TEXT, text_item: { text } }],
          context_token: contextToken,
        },
        base_info: { channel_version: CHANNEL_VERSION },
      }),
      token,
      timeoutMs: 15_000,
    });
    return { ok: true, messageId: clientId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── QR Login ───────────────────────────────────────────────────

export async function fetchQRCode(baseUrl: string = DEFAULT_BASE_URL): Promise<QRCodeResponse> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`, base);
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`QR fetch failed: ${res.status}`);
  return (await res.json()) as QRCodeResponse;
}

export async function pollQRStatus(
  baseUrl: string,
  qrcode: string,
): Promise<QRStatusResponse> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base);
  try {
    const res = await fetch(url.toString(), {
      headers: { 'iLink-App-ClientVersion': '1' },
      signal: AbortSignal.timeout(35_000),
    });
    if (!res.ok) throw new Error(`QR status failed: ${res.status}`);
    return (await res.json()) as QRStatusResponse;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 'wait' };
    }
    throw err;
  }
}

export { DEFAULT_BASE_URL };
