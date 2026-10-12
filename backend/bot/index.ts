import 'dotenv/config';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PrismaClient } = require('@prisma/client');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PrismaPg } = require('@prisma/adapter-pg');
import * as bcrypt from 'bcryptjs';
import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma   = new PrismaClient({ adapter });

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

const ADMIN_ID = parseInt(process.env.TELEGRAM_ADMIN_ID!);

// ── Conversation state ───────────────────────────────────────────────────────
type Step = 'idle' | 'adduser:email' | 'adduser:password' | 'deluser:email';
const sessions = new Map<number, { step: Step; email?: string }>();

function getSession(id: number) {
  if (!sessions.has(id)) sessions.set(id, { step: 'idle' });
  return sessions.get(id)!;
}

// ── Auth guard ───────────────────────────────────────────────────────────────
function isAdmin(ctx: any): boolean {
  return ctx.from?.id === ADMIN_ID;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmtDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

async function getUserList() {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    include: { credentials: { select: { exchange: true } } },
  });
  return users;
}

// ── Commands ─────────────────────────────────────────────────────────────────

bot.command('start', (ctx) => {
  if (!isAdmin(ctx)) return;
  ctx.reply(
    '👋 *ZigX Admin Bot*\n\n' +
    '`/adduser` — create a new user\n' +
    '`/users`   — list all users\n' +
    '`/deluser` — delete a user\n' +
    '`/stats`   — platform stats',
    { parse_mode: 'Markdown' },
  );
});

bot.command('adduser', (ctx) => {
  if (!isAdmin(ctx)) return;
  const session = getSession(ctx.from!.id);
  session.step = 'adduser:email';
  ctx.reply('📧 Enter email:');
});

bot.command('deluser', (ctx) => {
  if (!isAdmin(ctx)) return;
  const session = getSession(ctx.from!.id);
  session.step = 'deluser:email';
  ctx.reply('❌ Enter email of user to delete:');
});

bot.command('users', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const users = await getUserList();
  if (users.length === 0) {
    return ctx.reply('No users found.');
  }
  const lines = users.map((u: any) => {
    const exchanges = u.credentials.map((e: any) => e.exchange.toUpperCase()).join(', ') || 'none';
    return `👤 *${u.email}*\n   Joined: ${fmtDate(u.createdAt)}\n   Exchanges: ${exchanges}`;
  });
  ctx.reply(lines.join('\n\n'), { parse_mode: 'Markdown' });
});

bot.command('stats', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const [userCount, credCount] = await Promise.all([
    prisma.user.count(),
    prisma.exchangeCredential.count(),
  ]);
  const users = await getUserList();
  const exchangeCounts: Record<string, number> = {};
  for (const u of users) {
    for (const e of u.credentials) {
      exchangeCounts[e.exchange] = (exchangeCounts[e.exchange] ?? 0) + 1;
    }
  }
  const breakdown = Object.entries(exchangeCounts)
    .map(([ex, n]) => `   ${ex.toUpperCase()}: ${n} user${n > 1 ? 's' : ''}`)
    .join('\n') || '   none';

  ctx.reply(
    `📊 *Platform Stats*\n\n` +
    `👥 Total users: *${userCount}*\n` +
    `🔑 API keys stored: *${credCount}*\n\n` +
    `*Exchange connections:*\n${breakdown}`,
    { parse_mode: 'Markdown' },
  );
});

// ── Conversation handler ─────────────────────────────────────────────────────

bot.on(message('text'), async (ctx) => {
  if (!isAdmin(ctx)) return;

  const session = getSession(ctx.from!.id);
  const text = ctx.message.text.trim();

  // ── adduser: email step ──────────────────────────────────────────────────
  if (session.step === 'adduser:email') {
    if (!text.includes('@') || !text.includes('.')) {
      return ctx.reply('⚠️ That doesn\'t look like a valid email. Try again:');
    }
    try {
      const existing = await prisma.user.findUnique({ where: { email: text } });
      if (existing) {
        session.step = 'idle';
        return ctx.reply(`⚠️ User *${text}* already exists.`, { parse_mode: 'Markdown' });
      }
      session.email = text;
      session.step  = 'adduser:password';
      return ctx.reply('🔒 Enter password:');
    } catch {
      session.step = 'idle';
      return ctx.reply('❌ Database error. Try again with /adduser');
    }
  }

  // ── adduser: password step ───────────────────────────────────────────────
  if (session.step === 'adduser:password') {
    if (text.length < 6) {
      return ctx.reply('⚠️ Password must be at least 6 characters. Try again:');
    }
    const email = session.email!;
    try {
      const passwordHash = await bcrypt.hash(text, 12);
      await prisma.user.create({ data: { email, passwordHash } });
      session.step  = 'idle';
      session.email = undefined;
      return ctx.reply(`✅ User *${email}* created successfully!`, { parse_mode: 'Markdown' });
    } catch (err: any) {
      session.step  = 'idle';
      session.email = undefined;
      const msg = err?.code === 'P2002'
        ? `⚠️ User *${email}* already exists.`
        : '❌ Failed to create user. Try again with /adduser';
      return ctx.reply(msg, { parse_mode: 'Markdown' });
    }
  }

  // ── deluser: email step ──────────────────────────────────────────────────
  if (session.step === 'deluser:email') {
    try {
      const user = await prisma.user.findUnique({ where: { email: text } });
      if (!user) {
        session.step = 'idle';
        return ctx.reply(`⚠️ No user found with email *${text}*.`, { parse_mode: 'Markdown' });
      }
      await prisma.user.delete({ where: { email: text } });
      session.step = 'idle';
      return ctx.reply(`🗑️ User *${text}* deleted.`, { parse_mode: 'Markdown' });
    } catch {
      session.step = 'idle';
      return ctx.reply('❌ Failed to delete user. Try again with /deluser');
    }
  }
});

// ── Global error handler ─────────────────────────────────────────────────────
bot.catch((err: any, ctx: any) => {
  console.error('[bot] Error:', err);
  ctx.reply('❌ Something went wrong. Please try again.').catch(() => {});
});

// ── Start ─────────────────────────────────────────────────────────────────────

async function main() {
  await prisma.$connect();
  console.log('[bot] Connected to database');
  console.log('[bot] Starting polling…');
  bot.launch();
  process.once('SIGINT',  () => { bot.stop('SIGINT');  prisma.$disconnect(); });
  process.once('SIGTERM', () => { bot.stop('SIGTERM'); prisma.$disconnect(); });
}

main().catch((e) => { console.error(e); process.exit(1); });
