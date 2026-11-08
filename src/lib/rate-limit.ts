import "server-only";

// ──────────────────────────────────────────────────────────────
// 分散レート制限
//
// 環境変数 UPSTASH_REDIS_REST_URL と UPSTASH_REDIS_REST_TOKEN が
// 設定されている場合は Upstash Redis を使用（Vercel 本番推奨）。
// 未設定の場合はプロセスメモリにフォールバック（ローカル開発用のみ）。
//
// Upstash 無料枠: 10,000 コマンド/日
// セットアップ: https://console.upstash.com/ → Redis → Create Database
// ──────────────────────────────────────────────────────────────

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  /** レート制限リセットまでの秒数（超過時のみ意味を持つ） */
  retryAfterSec: number;
}

const WINDOW_SEC = 60;
const MAX_REQUESTS = 10;    // 10 リクエスト / 60 秒 / IP
const DAILY_MAX = 150;      // デモ全体での日次上限

// ── Upstash 分散レート制限 ────────────────────────────────────

async function tryUpstashLimit(identifier: string): Promise<RateLimitResult | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  try {
    const { Ratelimit } = await import("@upstash/ratelimit");
    const { Redis } = await import("@upstash/redis");

    const ratelimit = new Ratelimit({
      redis: new Redis({ url, token }),
      limiter: Ratelimit.fixedWindow(MAX_REQUESTS, `${WINDOW_SEC} s`),
      analytics: false,
      prefix: "rl:chat",
    });

    const result = await ratelimit.limit(identifier);
    return {
      success: result.success,
      limit: result.limit,
      remaining: result.remaining,
      retryAfterSec: result.success ? 0 : Math.ceil((result.reset - Date.now()) / 1000),
    };
  } catch (err) {
    // Redis 接続失敗時はインメモリ制限にフォールバック（レート制限は継続して有効）
    console.error(
      "[rate-limit] Upstash 接続失敗 → インメモリにフォールバック:",
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

// ── インメモリフォールバック（ローカル開発専用） ──────────────

type MemEntry = { count: number; resetAt: number };
const memStore = new Map<string, MemEntry>();

function memLimit(identifier: string): RateLimitResult {
  const now = Date.now();
  const entry = memStore.get(identifier);

  if (!entry || now >= entry.resetAt) {
    memStore.set(identifier, { count: 1, resetAt: now + WINDOW_SEC * 1000 });
    return { success: true, limit: MAX_REQUESTS, remaining: MAX_REQUESTS - 1, retryAfterSec: 0 };
  }

  if (entry.count >= MAX_REQUESTS) {
    return {
      success: false,
      limit: MAX_REQUESTS,
      remaining: 0,
      retryAfterSec: Math.ceil((entry.resetAt - now) / 1000),
    };
  }

  entry.count++;
  return {
    success: true,
    limit: MAX_REQUESTS,
    remaining: MAX_REQUESTS - entry.count,
    retryAfterSec: 0,
  };
}

function pruneMemStore(): void {
  const now = Date.now();
  for (const [key, entry] of memStore) {
    if (now >= entry.resetAt) memStore.delete(key);
  }
}

// ── 日次グローバル上限（Upstash Redis 使用時のみ有効） ───────────

export interface DailyLimitResult {
  allowed: boolean;
  /** 本日の残りリクエスト数（Redisが使えない場合は null） */
  remaining: number | null;
}

export async function checkDailyLimit(): Promise<DailyLimitResult> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { allowed: true, remaining: null };

  try {
    const { Redis } = await import("@upstash/redis");
    const redis = new Redis({ url, token });

    const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const dateKey = jst.toISOString().slice(0, 10); // "YYYY-MM-DD" JST
    const key = `rl:daily:${dateKey}`;

    const count = await redis.incr(key);
    if (count === 1) {
      // 新しいキーなら 48 時間で自動削除
      await redis.expire(key, 48 * 60 * 60);
    }

    return {
      allowed: count <= DAILY_MAX,
      remaining: Math.max(0, DAILY_MAX - count),
    };
  } catch (err) {
    console.error("[rate-limit] 日次制限チェック失敗 → 許可扱い:", err instanceof Error ? err.message : String(err));
    return { allowed: true, remaining: null };
  }
}

// ── 公開 API ──────────────────────────────────────────────────

/**
 * リクエスト元 IP に対してレート制限を確認する。
 * - Upstash Redis 設定済み → 全インスタンス共有の分散制限（Vercel 本番）
 * - 未設定 → インメモリ制限（ローカル開発のみ、インスタンス間共有なし）
 */
export async function checkRateLimit(ip: string): Promise<RateLimitResult> {
  pruneMemStore();
  return (await tryUpstashLimit(ip)) ?? memLimit(ip);
}
