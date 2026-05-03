import TelegramBot      from "node-telegram-bot-api"
import axios            from "axios"
import express          from "express"
import dotenv           from "dotenv"
import fs               from "fs"
import path             from "path"
import os               from "os"
import { exec }         from "child_process"
import { promisify }    from "util"
import { createWriteStream } from "fs"

dotenv.config()
const execAsync = promisify(exec)

// ══════════════════════════════════════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════════════════════════════════════
const TOKEN        = process.env.TOKEN
const PORT         = process.env.PORT || 3000
const BOT_USERNAME = "AZASAVED_bot"
const ADMIN_ID     = 5331869155
const CHANNEL      = "https://t.me/AZATECHNOLOGY_FREE"
const CHANNEL_ID   = process.env.CHANNEL_ID || ""  // "@AZATECHNOLOGY_FREE"

const EXPECTED_BOT = "AZASAVED_bot"
const REAL_ADMIN   = 5331869155
const SECRET_KEY   = "aza_secure_2026"

const DB_FILE  = "./db.json"
const CACHE_TTL = 3_600_000  // 1ч

if (!TOKEN) { console.error("❌ TOKEN missing"); process.exit(1) }

// ══════════════════════════════════════════════════════════════════════════════
//  DB
// ══════════════════════════════════════════════════════════════════════════════
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE))
      return JSON.parse(fs.readFileSync(DB_FILE, "utf8"))
  } catch {}
  return { users: {}, ads: [], adIdCounter: 1, bannedUsers: [], scheduledAds: [], dailyStats: {} }
}

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify({
      users:        Object.fromEntries(users),
      ads, adIdCounter,
      bannedUsers:  [...bannedUsers],
      scheduledAds, dailyStats
    }, null, 2))
  } catch (e) { console.error("DB:", e.message) }
}

setInterval(saveDB, 30_000)

const raw         = loadDB()
const users       = new Map(Object.entries(raw.users || {}))
const cache       = new Map()        // url → { type, data, ts }
const cooldown    = new Map()
// loadingMsgs: только индикаторы "загружаю" — удаляем их после получения видео
// Видео и фото — НИКОГДА не удаляем
const loadingMsgs = new Map()        // userId → msgId
const userStates  = new Map()
// videoFileIds: msgId → file_id — для кнопки кружок
const videoFileIds = new Map()

let ads          = raw.ads          || []
let adIdCounter  = raw.adIdCounter  || 1
const bannedUsers  = new Set(raw.bannedUsers || [])
let scheduledAds = raw.scheduledAds || []
let dailyStats   = raw.dailyStats   || {}

// ══════════════════════════════════════════════════════════════════════════════
//  SECURITY
// ══════════════════════════════════════════════════════════════════════════════
async function protectBot(bot) {
  try {
    const me = await bot.getMe()
    if (me.username !== EXPECTED_BOT) { console.error("❌ Cloned"); process.exit(1) }
  } catch { process.exit(1) }
}
function protectAdmin() {
  if (ADMIN_ID !== REAL_ADMIN) { console.error("❌ Fake admin"); process.exit(1) }
}
function hiddenCheck() {
  if (SECRET_KEY !== "aza_secure_2026") process.exit(1)
}

// ══════════════════════════════════════════════════════════════════════════════
//  EXPRESS
// ══════════════════════════════════════════════════════════════════════════════
const app = express()
app.get("/",       (_req, res) => res.send("✅ Bot running"))
app.get("/health", (_req, res) => res.json({ status: "ok", users: users.size, cache: cache.size }))
app.listen(PORT, () => console.log(`🌐 Port ${PORT}`))

// ══════════════════════════════════════════════════════════════════════════════
//  BOT
// ══════════════════════════════════════════════════════════════════════════════
const bot = new TelegramBot(TOKEN, { polling: true })
console.log("🤖 Started");

;(async () => { await protectBot(bot); protectAdmin(); hiddenCheck() })()

setInterval(() => {
  if (!users.has(String(REAL_ADMIN))) { console.error("❌ Admin missing"); process.exit(1) }
}, 60_000)

// ══════════════════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════════════════
const sleep = ms => new Promise(r => setTimeout(r, ms))

function fmt(n) {
  if (!n) return "0"
  if (n >= 1_000_000) return (n/1_000_000).toFixed(1)+"M"
  if (n >= 1_000)     return (n/1_000).toFixed(1)+"K"
  return String(n)
}

function todayKey() { return new Date().toISOString().slice(0, 10) }

function recordDownload() {
  const k = todayKey()
  if (!dailyStats[k]) dailyStats[k] = { downloads: 0, newUsers: 0 }
  dailyStats[k].downloads++
}
function recordNewUser() {
  const k = todayKey()
  if (!dailyStats[k]) dailyStats[k] = { downloads: 0, newUsers: 0 }
  dailyStats[k].newUsers++
}

function antiSpam(id, ms = 1500) {
  const now = Date.now()
  if (cooldown.has(id) && now - cooldown.get(id) < ms) return true
  cooldown.set(id, now)
  return false
}

// Удаляем только индикатор загрузки конкретного юзера
async function deleteLoading(chatId, userId) {
  const mid = loadingMsgs.get(String(userId))
  if (mid) {
    try { await bot.deleteMessage(chatId, mid) } catch {}
    loadingMsgs.delete(String(userId))
  }
}

async function safeDelete(chatId, msgId) {
  try { await bot.deleteMessage(chatId, msgId) } catch {}
}

function extractTikTokLinks(text) {
  return text.match(/https?:\/\/[^\s]*(?:tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)[^\s]*/g) || []
}
function extractInstaLinks(text) {
  return text.match(/https?:\/\/(?:www\.)?instagram\.com\/(?:reel|p|tv)\/[^\s]+/g) || []
}

function isCacheValid(e) { return e && Date.now() - e.ts < CACHE_TTL }

function trackUser(msg) {
  const id  = String(msg.from.id)
  const isNew = !users.has(id)
  if (isNew) {
    users.set(id, {
      id: msg.from.id, name: msg.from.first_name || "User",
      username: msg.from.username || null, lang: msg.from.language_code || "ru",
      joinedAt: Date.now(), downloads: 0, lastAdShown: 0, history: []
    })
    recordNewUser()
    notifyAdmin(`👤 Новый: *${msg.from.first_name}* ${msg.from.username ? "@"+msg.from.username : ""}\nID: \`${msg.from.id}\`\n👥 Всего: *${users.size}*`)
  }
  return users.get(id)
}

function isBanned(userId) { return bannedUsers.has(String(userId)) }

// ══════════════════════════════════════════════════════════════════════════════
//  LANGUAGES
// ══════════════════════════════════════════════════════════════════════════════
const LANGS = {
  ru: {
    welcome: `🎬 *AZASAVED Bot*\n\nСкачиваю видео и фото с TikTok и Instagram без водяного знака.\n\n✅ Поддерживаю:\n• TikTok видео (HD)\n• TikTok слайд-шоу / фото\n• Instagram Reels / посты\n\n👇 *Просто отправь ссылку!*`,
    loading: "⏳ Загружаю...",
    error:   "❌ Не удалось загрузить.\n\n• Видео приватное\n• Ссылка недействительна\n• Сбой API\n\nПопробуй позже.",
    wait:    "⏳ Подожди секунду...",
    cancel:  "❌ Отменено.",
    banned:  "🚫 Ты заблокирован.",
    sub_req: "🔒 Подпишись на канал чтобы использовать бота:",
    sub_btn: "✅ Проверить подписку",
    help: `ℹ️ *Помощь*\n\n1. Скопируй ссылку TikTok или Instagram\n2. Вставь сюда\n3. Получи видео или фото\n\n❓ Проблемы? @AZAkzn1`,
    donate:  "💖 Поддержать: *@AZAkzn1*\nСпасибо!",
    mystats: d => `📊 Твои загрузки: *${d}*`,
    lang_ok: "✅ Язык: 🇷🇺 Русский",
  },
  en: {
    welcome: `🎬 *AZASAVED Bot*\n\nDownload TikTok & Instagram videos without watermark.\n\n✅ Supports:\n• TikTok video (HD)\n• TikTok slideshows\n• Instagram Reels / posts\n\n👇 *Just send a link!*`,
    loading: "⏳ Loading...",
    error:   "❌ Failed to download.\n\n• Private video\n• Invalid link\n• API error\n\nTry again later.",
    wait:    "⏳ Wait a second...",
    cancel:  "❌ Cancelled.",
    banned:  "🚫 You are banned.",
    sub_req: "🔒 Subscribe to use the bot:",
    sub_btn: "✅ Check subscription",
    help: `ℹ️ *Help*\n\n1. Copy TikTok or Instagram link\n2. Paste here\n3. Get video or photo\n\n❓ Issues? @AZAkzn1`,
    donate:  "💖 Support: *@AZAkzn1*\nThank you!",
    mystats: d => `📊 Your downloads: *${d}*`,
    lang_ok: "✅ Language: 🇬🇧 English",
  },
  uz: {
    welcome: `🎬 *AZASAVED Bot*\n\nTikTok va Instagram videolarini suvli belgisiz yuklayman.\n\n✅ Qo'llab-quvvatlanadi:\n• TikTok video (HD)\n• TikTok foto-slaydlar\n• Instagram Reels / postlar\n\n👇 *Havola yuboring!*`,
    loading: "⏳ Yuklanmoqda...",
    error:   "❌ Yuklab bo'lmadi.\n\n• Video maxfiy\n• Havola noto'g'ri\n• API xatosi\n\nKeyinroq urinib ko'ring.",
    wait:    "⏳ Bir soniya...",
    cancel:  "❌ Bekor qilindi.",
    banned:  "🚫 Siz bloklangansiz.",
    sub_req: "🔒 Botdan foydalanish uchun obuna bo'ling:",
    sub_btn: "✅ Obunani tekshirish",
    help: `ℹ️ *Yordam*\n\n1. TikTok yoki Instagram havolasini nusxalang\n2. Shu yerga yuboring\n3. Video yoki foto oling\n\n❓ @AZAkzn1`,
    donate:  "💖 Qo'llab-quvvatlash: *@AZAkzn1*",
    mystats: d => `📊 Yuklamalaringiz: *${d}*`,
    lang_ok: "✅ Til: 🇺🇿 O'zbek",
  }
}

function t(userId, key, ...args) {
  const u   = users.get(String(userId))
  const lng = LANGS[u?.lang] ? u.lang : "ru"
  const val = LANGS[lng][key] ?? LANGS.ru[key] ?? key
  return typeof val === "function" ? val(...args) : val
}

// ══════════════════════════════════════════════════════════════════════════════
//  NOTIFY ADMIN
// ══════════════════════════════════════════════════════════════════════════════
async function notifyAdmin(text) {
  try { await bot.sendMessage(ADMIN_ID, text, { parse_mode: "Markdown" }) } catch {}
}

// ══════════════════════════════════════════════════════════════════════════════
//  SUB CHECK
// ══════════════════════════════════════════════════════════════════════════════
async function isSubscribed(userId) {
  if (!CHANNEL_ID) return true
  try {
    const m = await bot.getChatMember(CHANNEL_ID, userId)
    return ["member","administrator","creator"].includes(m.status)
  } catch { return true }
}

// ══════════════════════════════════════════════════════════════════════════════
//  ADS
// ══════════════════════════════════════════════════════════════════════════════
const getActiveAds = () => ads.filter(a => a.active)

function pickAd() {
  const a = getActiveAds()
  return a.length ? a[Math.floor(Math.random() * a.length)] : null
}

function shouldShowAd(user, every = 3) {
  return (user.downloads - user.lastAdShown) >= every
}

function buildAdKb(buttons) {
  if (!buttons?.length) return undefined
  return { inline_keyboard: [buttons.map(b => ({ text: b.text, url: b.url }))] }
}

async function sendAdToUser(chatId, userId, ad) {
  try {
    const kb   = buildAdKb(ad.buttons)
    const opts = { parse_mode: "Markdown", ...(kb ? { reply_markup: kb } : {}) }
    if (ad.type === "photo" && ad.imageUrl)
      await bot.sendPhoto(chatId, ad.imageUrl, { caption: ad.text, ...opts })
    else if (ad.type === "video" && ad.videoUrl)
      await bot.sendVideo(chatId, ad.videoUrl, { caption: ad.text, ...opts })
    else
      await bot.sendMessage(chatId, ad.text, opts)
    ad.views = (ad.views || 0) + 1
    return true
  } catch { return false }
}

async function maybeShowAd(chatId, userId, user) {
  const ad = pickAd()
  if (!ad || !shouldShowAd(user, ad.showEvery)) return
  user.lastAdShown = user.downloads
  await sleep(1500)
  await sendAdToUser(chatId, userId, ad)
}

// Scheduled ads
setInterval(async () => {
  const now = Date.now()
  for (const s of scheduledAds) {
    if (s.sent || now < s.sendAt) continue
    s.sent = true
    const ad = ads.find(a => a.id === s.adId)
    if (!ad) continue
    let ok = 0, fail = 0
    for (const [, u] of users) {
      if (bannedUsers.has(String(u.id))) continue
      ;(await sendAdToUser(u.id, String(u.id), ad)) ? ok++ : fail++
      await sleep(60)
    }
    notifyAdmin(`📣 Реклама #${ad.id} разослана ✔️${ok} ❌${fail}`)
    saveDB()
  }
}, 60_000)

// ══════════════════════════════════════════════════════════════════════════════
//  QUEUE
// ══════════════════════════════════════════════════════════════════════════════
const queue = []
let qRunning = false

function addQueue(task) { queue.push(task); runQueue() }

async function runQueue() {
  if (qRunning) return
  qRunning = true
  while (queue.length) {
    const job = queue.shift()
    try { await job() } catch (e) { console.error("Queue:", e.message) }
    await sleep(800)
  }
  qRunning = false
}

// ══════════════════════════════════════════════════════════════════════════════
//  FETCH TIKTOK
// ══════════════════════════════════════════════════════════════════════════════
async function fetchTikTok(url) {
  // Пробуем несколько эндпоинтов
  const endpoints = [
    `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`,
    `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`,
  ]
  for (const ep of endpoints) {
    try {
      const { data } = await axios.get(ep, { timeout: 20_000 })
      if (data?.data) return data.data
    } catch {}
  }
  throw new Error("TikTok API failed")
}

// ══════════════════════════════════════════════════════════════════════════════
//  FETCH INSTAGRAM
// ══════════════════════════════════════════════════════════════════════════════
async function fetchInstagram(url) {
  try {
    const { data } = await axios.get(
      `https://snapinsta.app/api/?url=${encodeURIComponent(url)}`,
      { timeout: 20_000 }
    )
    if (data?.url) return { type: "video", url: data.url }
  } catch {}
  throw new Error("Instagram API failed")
}

// ══════════════════════════════════════════════════════════════════════════════
//  VIDEO NOTE (кружок)
// ══════════════════════════════════════════════════════════════════════════════
async function downloadToFile(url, dest) {
  const res = await axios({ url, method: "GET", responseType: "stream", timeout: 120_000 })
  return new Promise((resolve, reject) => {
    const w = createWriteStream(dest)
    res.data.pipe(w)
    w.on("finish", resolve)
    w.on("error", reject)
  })
}

async function makeVideoNote(fileId) {
  const tmp = os.tmpdir()
  const inp = path.join(tmp, `vn_in_${Date.now()}.mp4`)
  const out = path.join(tmp, `vn_out_${Date.now()}.mp4`)

  try {
    // Скачиваем с Telegram
    const link = await bot.getFileLink(fileId)
    await downloadToFile(link, inp)

    // Конвертируем в квадрат 384x384, макс 59 сек (лимит Telegram)
    await execAsync(
      `ffmpeg -y -i "${inp}" -t 59 ` +
      `-vf "crop=min(iw\\,ih):min(iw\\,ih),scale=384:384:flags=lanczos" ` +
      `-c:v libx264 -preset fast -crf 26 ` +
      `-c:a aac -b:a 64k -ar 44100 ` +
      `-pix_fmt yuv420p -movflags +faststart ` +
      `"${out}"`
    )

    return fs.readFileSync(out)
  } finally {
    try { fs.unlinkSync(inp) } catch {}
    try { fs.unlinkSync(out) } catch {}
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  KEYBOARDS
// ══════════════════════════════════════════════════════════════════════════════
const mainKb = (userId) => ({
  inline_keyboard: [
    [{ text: "📢 Канал", url: CHANNEL }, { text: "💖 Поддержать", callback_data: "donate" }],
    [{ text: "ℹ️ Помощь", callback_data: "help" }, { text: "📊 Мои загрузки", callback_data: "mystats" }],
    [{ text: "🌍 Язык / Language", callback_data: "lang_menu" }],
    ...(userId === ADMIN_ID ? [[{ text: "⚙️ Админ", callback_data: "admin" }]] : [])
  ]
})

// Клавиатура под видео — msgId нужен чтобы кружок знал какое видео конвертировать
const videoKb = (msgId) => ({
  inline_keyboard: [
    [{ text: "⭕ Кружок", callback_data: `circle_${msgId}` }],
    [{ text: "💖 Поддержать", callback_data: "donate" }, { text: "📢 Канал", url: CHANNEL }]
  ]
})

const adminKb = () => ({
  inline_keyboard: [
    [{ text: "📢 Рассылка",  callback_data: "broadcast"  }, { text: "📊 Статистика", callback_data: "adminstats" }],
    [{ text: "📣 Реклама",   callback_data: "ads_menu"   }, { text: "🚫 Баны",       callback_data: "ban_menu"   }],
    [{ text: "📈 Аналитика", callback_data: "analytics"  }, { text: "🗑 Кэш",        callback_data: "clearcache" }],
  ]
})

// ══════════════════════════════════════════════════════════════════════════════
//  /start
// ══════════════════════════════════════════════════════════════════════════════
bot.onText(/\/start/, async msg => {
  const chatId = msg.chat.id
  const userId = msg.from.id
  trackUser(msg)
  safeDelete(chatId, msg.message_id)

  if (CHANNEL_ID && !(await isSubscribed(userId))) {
    await bot.sendMessage(chatId, t(userId, "sub_req"), {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [
        [{ text: "📢 Подписаться", url: CHANNEL }],
        [{ text: t(userId, "sub_btn"), callback_data: "check_sub" }]
      ]}
    })
    return
  }

  await bot.sendMessage(chatId, t(userId, "welcome"), {
    parse_mode: "Markdown",
    reply_markup: mainKb(userId)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
//  /history
// ══════════════════════════════════════════════════════════════════════════════
bot.onText(/\/history/, async msg => {
  const u = users.get(String(msg.from.id))
  safeDelete(msg.chat.id, msg.message_id)
  if (!u?.history?.length) {
    const m = await bot.sendMessage(msg.chat.id, "📋 История пуста.")
    setTimeout(() => safeDelete(msg.chat.id, m.message_id), 8_000)
    return
  }
  const list = u.history.slice(-10).reverse()
    .map((h, i) => `${i+1}. [${h.type}] ${h.url.slice(0, 45)}...`)
    .join("\n")
  const m = await bot.sendMessage(msg.chat.id, `📋 *Последние загрузки:*\n\n${list}`, { parse_mode: "Markdown" })
  setTimeout(() => safeDelete(msg.chat.id, m.message_id), 30_000)
})

// ══════════════════════════════════════════════════════════════════════════════
//  /stats
// ══════════════════════════════════════════════════════════════════════════════
bot.onText(/\/stats/, async msg => {
  if (msg.from.id !== ADMIN_ID) return
  const totalDl  = [...users.values()].reduce((s, u) => s + u.downloads, 0)
  const topUsers = [...users.values()]
    .sort((a, b) => b.downloads - a.downloads).slice(0, 5)
    .map((u, i) => `${i+1}. ${u.name} — ${u.downloads}`)
    .join("\n")
  bot.sendMessage(msg.chat.id,
    `📊 *Статистика*\n\n👥 ${users.size}\n🚫 Банов: ${bannedUsers.size}\n📥 Загрузок: ${totalDl}\n📣 Реклама: ${ads.length}\n\n🏆 Топ:\n${topUsers||"нет"}`,
    { parse_mode: "Markdown" }
  )
})

// ══════════════════════════════════════════════════════════════════════════════
//  CALLBACK QUERIES
// ══════════════════════════════════════════════════════════════════════════════
bot.on("callback_query", async q => {
  const chatId = q.message.chat.id
  const userId = q.from.id
  const data   = q.data

  await bot.answerCallbackQuery(q.id).catch(() => {})

  // ── Кружок ──────────────────────────────────────────────────────────────────
  if (data.startsWith("circle_")) {
    const msgId  = data.replace("circle_", "")
    const fileId = videoFileIds.get(msgId)

    if (!fileId) {
      await bot.answerCallbackQuery(q.id, { text: "❌ Видео устарело, скачай заново", show_alert: true })
      return
    }

    await bot.answerCallbackQuery(q.id, { text: "⏳ Делаю кружок..." })

    const proc = await bot.sendMessage(chatId, "⭕ Конвертирую в кружок...")

    try {
      const buf = await makeVideoNote(fileId)
      // Отправляем как video_note — это и есть кружок в Telegram
      await bot.sendVideoNote(chatId, buf, { length: 384, duration: 59 })
      safeDelete(chatId, proc.message_id)
    } catch (e) {
      console.error("Circle:", e.message)
      safeDelete(chatId, proc.message_id)
      let txt = "❌ Не удалось создать кружок."
      if (e.message.includes("too big") || e.message.includes("Entity Too Large"))
        txt = "❌ Видео слишком тяжёлое для кружка (лимит ~50MB)."
      else if (e.message.includes("ffmpeg") || e.message.includes("ENOENT"))
        txt = "❌ ffmpeg не установлен на сервере.\n\nУстанови: `sudo apt install ffmpeg`"
      const err = await bot.sendMessage(chatId, txt, { parse_mode: "Markdown" })
      setTimeout(() => safeDelete(chatId, err.message_id), 10_000)
    }
    return
  }

  // ── Sub check ────────────────────────────────────────────────────────────────
  if (data === "check_sub") {
    if (await isSubscribed(userId)) {
      await bot.sendMessage(chatId, t(userId, "welcome"), { parse_mode: "Markdown", reply_markup: mainKb(userId) })
    } else {
      await bot.answerCallbackQuery(q.id, { text: "❌ Ты ещё не подписан!", show_alert: true })
    }
    return
  }

  // ── Public ───────────────────────────────────────────────────────────────────
  if (data === "donate") {
    const m = await bot.sendMessage(chatId, t(userId, "donate"), { parse_mode: "Markdown" })
    setTimeout(() => safeDelete(chatId, m.message_id), 10_000)
  }

  if (data === "help") {
    const m = await bot.sendMessage(chatId, t(userId, "help"), { parse_mode: "Markdown" })
    setTimeout(() => safeDelete(chatId, m.message_id), 20_000)
  }

  if (data === "mystats") {
    const u = users.get(String(userId))
    const m = await bot.sendMessage(chatId, u ? t(userId, "mystats", u.downloads) : "Нет загрузок.", { parse_mode: "Markdown" })
    setTimeout(() => safeDelete(chatId, m.message_id), 10_000)
  }

  // ── Lang ─────────────────────────────────────────────────────────────────────
  if (data === "lang_menu") {
    const m = await bot.sendMessage(chatId, "🌍 Выбери язык:", {
      reply_markup: { inline_keyboard: [
        [{ text: "🇷🇺 Русский", callback_data: "lang_ru" }],
        [{ text: "🇬🇧 English", callback_data: "lang_en" }],
        [{ text: "🇺🇿 O'zbek",  callback_data: "lang_uz" }],
      ]}
    })
    setTimeout(() => safeDelete(chatId, m.message_id), 30_000)
  }

  if (data.startsWith("lang_")) {
    const lng = data.replace("lang_", "")
    const u = users.get(String(userId))
    if (u) { u.lang = lng; saveDB() }
    const m = await bot.sendMessage(chatId, t(userId, "lang_ok"), { parse_mode: "Markdown" })
    setTimeout(() => safeDelete(chatId, m.message_id), 4_000)
  }

  // ── Admin ────────────────────────────────────────────────────────────────────
  if (data === "admin" && userId === ADMIN_ID) {
    await bot.sendMessage(chatId,
      `⚙️ *Админ панель*\n\n👥 ${users.size}\n🚫 Банов: ${bannedUsers.size}\n📣 Реклама: ${ads.length} (активных: ${getActiveAds().length})`,
      { parse_mode: "Markdown", reply_markup: adminKb() }
    )
  }

  if (data === "adminstats" && userId === ADMIN_ID) {
    const totalDl = [...users.values()].reduce((s, u) => s + u.downloads, 0)
    await bot.sendMessage(chatId,
      `📊 *Статистика*\n\n👥 ${users.size}\n📥 Загрузок: ${totalDl}\n🗃 Кэш: ${cache.size}\n📋 Очередь: ${queue.length}`,
      { parse_mode: "Markdown" }
    )
  }

  if (data === "analytics" && userId === ADMIN_ID) {
    const days  = Object.entries(dailyStats).sort((a,b) => a[0].localeCompare(b[0])).slice(-7)
    const chart = days.map(([d, s]) => `📅 ${d}\n   📥 ${s.downloads}  👤 +${s.newUsers}`).join("\n\n")
    const today = dailyStats[todayKey()] || { downloads: 0, newUsers: 0 }
    await bot.sendMessage(chatId,
      `📈 *Аналитика 7 дней*\n\nСегодня: 📥${today.downloads} 👤+${today.newUsers}\n\n${chart||"нет данных"}`,
      { parse_mode: "Markdown" }
    )
  }

  if (data === "clearcache" && userId === ADMIN_ID) {
    cache.clear()
    const m = await bot.sendMessage(chatId, "✅ Кэш очищен!")
    setTimeout(() => safeDelete(chatId, m.message_id), 4_000)
  }

  if (data === "broadcast" && userId === ADMIN_ID) {
    userStates.set(userId, { state: "broadcast" })
    await bot.sendMessage(chatId, "📢 Отправь сообщение для рассылки.\n/cancel — отмена")
  }

  // ── Bans ─────────────────────────────────────────────────────────────────────
  if (data === "ban_menu" && userId === ADMIN_ID) { await showBanMenu(chatId, userId) }

  if (data === "ban_add" && userId === ADMIN_ID) {
    userStates.set(userId, { state: "ban_add" })
    await bot.sendMessage(chatId, "🚫 Введи ID для бана:\n/cancel — отмена")
  }

  if (data === "ban_remove" && userId === ADMIN_ID) {
    userStates.set(userId, { state: "ban_remove" })
    await bot.sendMessage(chatId, "✅ Введи ID для разбана:\n/cancel — отмена")
  }

  if (data.startsWith("unban_") && userId === ADMIN_ID) {
    const uid = data.replace("unban_", "")
    bannedUsers.delete(uid)
    const u = users.get(uid); if (u) u.banned = false
    saveDB()
    await bot.answerCallbackQuery(q.id, { text: "✅ Разбанен" })
    await showBanMenu(chatId, userId)
  }

  // ── Ads ───────────────────────────────────────────────────────────────────────
  if (data === "ads_menu"   && userId === ADMIN_ID) { await showAdsMenu(chatId, userId) }
  if (data === "ad_create"  && userId === ADMIN_ID) { await startAdCreate(chatId, userId) }

  if (["ad_type_text","ad_type_photo","ad_type_video"].includes(data) && userId === ADMIN_ID) {
    const type = data.replace("ad_type_","")
    userStates.set(userId, { state: "ad_content", adType: type, adData: {} })
    const prompt = { text:"✏️ Напиши текст:", photo:"🖼 Фото с подписью:", video:"🎬 Видео с подписью:" }[type]
    await bot.sendMessage(chatId, `📣 Шаг 2/3\n\n${prompt}\n\n/cancel — отмена`, { parse_mode: "Markdown" })
  }

  if (data === "ad_add_buttons" && userId === ADMIN_ID) {
    const st = userStates.get(userId); if (!st) return
    userStates.set(userId, { ...st, state: "ad_buttons" })
    await bot.sendMessage(chatId,
      "📣 Кнопки (каждая с новой строки):\n`Текст | https://ссылка`",
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "➡️ Без кнопок", callback_data: "ad_no_buttons" }]] } }
    )
  }

  if (data === "ad_no_buttons" && userId === ADMIN_ID) {
    const st = userStates.get(userId); if (!st) return
    userStates.set(userId, { ...st, state: "ad_frequency" })
    await askAdFrequency(chatId, userId)
  }

  if (data.startsWith("ad_freq_") && userId === ADMIN_ID) {
    const freq = parseInt(data.replace("ad_freq_",""))
    const st   = userStates.get(userId); if (!st) return
    st.adFrequency = freq
    userStates.delete(userId)
    await finalizeAd(chatId, userId, st)
  }

  if (data.startsWith("ad_toggle_") && userId === ADMIN_ID) {
    const ad = ads.find(a => a.id === parseInt(data.replace("ad_toggle_","")))
    if (ad) { ad.active = !ad.active; saveDB() }
    await bot.answerCallbackQuery(q.id, { text: ad?.active ? "✅ Включена" : "⏸ Выключена" })
    await showAdsMenu(chatId, userId)
  }

  if (data.startsWith("ad_delete_") && userId === ADMIN_ID) {
    const idx = ads.findIndex(a => a.id === parseInt(data.replace("ad_delete_","")))
    if (idx !== -1) { ads.splice(idx, 1); saveDB() }
    await bot.answerCallbackQuery(q.id, { text: "🗑 Удалено" })
    await showAdsMenu(chatId, userId)
  }

  if (data.startsWith("ad_preview_") && userId === ADMIN_ID) {
    const ad = ads.find(a => a.id === parseInt(data.replace("ad_preview_","")))
    if (ad) await sendAdToUser(chatId, userId, ad)
  }

  if (data.startsWith("ad_info_") && userId === ADMIN_ID) {
    const ad = ads.find(a => a.id === parseInt(data.replace("ad_info_","")))
    if (!ad) return
    await bot.sendMessage(chatId,
      `📣 *Реклама #${ad.id}*\n\nТип: ${ad.type}\nСтатус: ${ad.active?"✅":"⏸"}\nКаждые: ${ad.showEvery} загрузок\n👁 Показов: ${ad.views||0}\nКнопок: ${ad.buttons?.length||0}`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
        [{ text: ad.active?"⏸ Выкл":"▶️ Вкл", callback_data:`ad_toggle_${ad.id}` }, { text:"👁 Превью", callback_data:`ad_preview_${ad.id}` }],
        [{ text: "⏰ Запланировать", callback_data:`ad_schedule_${ad.id}` }],
        [{ text: "🗑 Удалить", callback_data:`ad_delete_${ad.id}` }],
        [{ text: "◀️ Назад", callback_data:"ads_menu" }]
      ]}}
    )
  }

  if (data.startsWith("ad_schedule_") && userId === ADMIN_ID) {
    const id = parseInt(data.replace("ad_schedule_",""))
    userStates.set(userId, { state: "ad_schedule", adId: id })
    await bot.sendMessage(chatId, "⏰ Дата и время:\n`ДД.ММ.ГГГГ ЧЧ:ММ`\n\nПример: `25.12.2025 18:00`\n\n/cancel", { parse_mode: "Markdown" })
  }

  if (data === "ad_broadcast_choose" && userId === ADMIN_ID) {
    if (!ads.length) { await bot.sendMessage(chatId, "❌ Нет объявлений."); return }
    await bot.sendMessage(chatId, "📣 Выбери объявление:",
      { reply_markup: { inline_keyboard: [
        ...ads.map(a => [{ text:`${a.active?"✅":"⏸"} #${a.id} [${a.type}]`, callback_data:`ad_send_all_${a.id}` }]),
        [{ text:"◀️ Назад", callback_data:"ads_menu" }]
      ]}}
    )
  }

  if (data.startsWith("ad_send_all_") && userId === ADMIN_ID) {
    const ad = ads.find(a => a.id === parseInt(data.replace("ad_send_all_","")))
    if (!ad) return
    let ok = 0, fail = 0
    const prog = await bot.sendMessage(chatId, `📣 Рассылаю #${ad.id}...`)
    for (const [, u] of users) {
      if (bannedUsers.has(String(u.id))) continue
      ;(await sendAdToUser(u.id, String(u.id), ad)) ? ok++ : fail++
      await sleep(60)
    }
    bot.editMessageText(
      `✅ Готово!\n✔️ ${ok}  ❌ ${fail}`,
      { chat_id: chatId, message_id: prog.message_id }
    )
    saveDB()
  }
})

// ══════════════════════════════════════════════════════════════════════════════
//  AD HELPERS
// ══════════════════════════════════════════════════════════════════════════════
async function showAdsMenu(chatId, userId) {
  const active = getActiveAds()
  await bot.sendMessage(chatId,
    `📣 *Реклама*\n\nАктивных: *${active.length}* / Всего: *${ads.length}*`,
    { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
      [{ text: "➕ Создать", callback_data: "ad_create" }],
      [{ text: "📢 Разослать всем", callback_data: "ad_broadcast_choose" }],
      ...ads.map(a => [{ text:`${a.active?"✅":"⏸"} #${a.id} ${a.type}`, callback_data:`ad_info_${a.id}` }]),
      [{ text: "◀️ Назад", callback_data: "admin" }]
    ]}}
  )
}

async function startAdCreate(chatId, userId) {
  userStates.set(userId, { state: "ad_create" })
  await bot.sendMessage(chatId, "📣 *Создание рекламы — Шаг 1/3*\n\nВыбери тип:", {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [
      [{ text: "✏️ Текст",         callback_data: "ad_type_text"  }],
      [{ text: "🖼 Фото + текст",  callback_data: "ad_type_photo" }],
      [{ text: "🎬 Видео + текст", callback_data: "ad_type_video" }],
      [{ text: "❌ Отмена",         callback_data: "ads_menu"      }]
    ]}
  })
}

async function askAdFrequency(chatId, userId) {
  await bot.sendMessage(chatId, "📣 *Шаг 3/3* — Как часто показывать?", {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [
      [{ text:"Каждые 2", callback_data:"ad_freq_2" }, { text:"Каждые 3", callback_data:"ad_freq_3" }, { text:"Каждые 5", callback_data:"ad_freq_5" }],
      [{ text:"Каждые 7", callback_data:"ad_freq_7" }, { text:"Каждые 10", callback_data:"ad_freq_10" }]
    ]}
  })
}

async function finalizeAd(chatId, userId, st) {
  const ad = {
    id: adIdCounter++, type: st.adType,
    text: st.adData.text || "", imageUrl: st.adData.imageUrl || null,
    videoUrl: st.adData.videoUrl || null, buttons: st.adData.buttons || [],
    active: true, showEvery: st.adFrequency || 3,
    createdAt: Date.now(), views: 0
  }
  ads.push(ad)
  saveDB()
  await bot.sendMessage(chatId,
    `✅ *Реклама #${ad.id} создана!*\n\nТип: ${ad.type}\nКаждые: ${ad.showEvery} загрузок\nКнопок: ${ad.buttons.length}`,
    { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
      [{ text: "👁 Превью", callback_data:`ad_preview_${ad.id}` }],
      [{ text: "📣 К рекламе", callback_data:"ads_menu" }]
    ]}}
  )
}

async function showBanMenu(chatId, userId) {
  const list = [...bannedUsers].slice(0, 10)
  const lines = list.map(id => { const u = users.get(id); return `🚫 ${u?.name||"?"} (${id})` }).join("\n") || "нет"
  await bot.sendMessage(chatId,
    `🚫 *Баны*\n\nВсего: *${bannedUsers.size}*\n\n${lines}`,
    { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
      [{ text: "➕ Забанить",     callback_data: "ban_add"    }],
      [{ text: "✅ Разбанить",    callback_data: "ban_remove" }],
      ...list.slice(0,5).map(id => { const u = users.get(id); return [{ text:`✅ Разбан: ${u?.name||id}`, callback_data:`unban_${id}` }] }),
      [{ text: "◀️ Назад", callback_data: "admin" }]
    ]}}
  )
}

// ══════════════════════════════════════════════════════════════════════════════
//  MESSAGES
// ══════════════════════════════════════════════════════════════════════════════
bot.on("message", async msg => {
  const chatId = msg.chat.id
  const userId = msg.from.id

  // /cancel
  if (msg.text === "/cancel") {
    userStates.delete(userId)
    safeDelete(chatId, msg.message_id)
    const m = await bot.sendMessage(chatId, t(userId, "cancel"))
    setTimeout(() => safeDelete(chatId, m.message_id), 3_000)
    return
  }

  trackUser(msg)

  // Бан
  if (isBanned(userId)) {
    safeDelete(chatId, msg.message_id)
    const m = await bot.sendMessage(chatId, t(userId, "banned"))
    setTimeout(() => safeDelete(chatId, m.message_id), 5_000)
    return
  }

  const st = userStates.get(userId)

  // ── Broadcast ──────────────────────────────────────────────────────────────
  if (st?.state === "broadcast" && userId === ADMIN_ID) {
    userStates.delete(userId)
    safeDelete(chatId, msg.message_id)
    let ok = 0, fail = 0
    const prog = await bot.sendMessage(chatId, "🚀 Рассылка...")
    for (const [, u] of users) {
      if (bannedUsers.has(String(u.id))) continue
      try {
        if (msg.photo)
          await bot.sendPhoto(u.id, msg.photo[msg.photo.length-1].file_id, { caption: msg.caption, parse_mode: "Markdown" })
        else if (msg.video)
          await bot.sendVideo(u.id, msg.video.file_id, { caption: msg.caption, parse_mode: "Markdown" })
        else if (msg.text)
          await bot.sendMessage(u.id, msg.text, { parse_mode: "Markdown" })
        ok++; await sleep(60)
      } catch { fail++ }
    }
    bot.editMessageText(`✅ Готово!\n✔️ ${ok}  ❌ ${fail}`, { chat_id: chatId, message_id: prog.message_id })
    return
  }

  // ── Ban add/remove ─────────────────────────────────────────────────────────
  if (st?.state === "ban_add" && userId === ADMIN_ID) {
    userStates.delete(userId)
    const uid = msg.text?.trim()
    if (!uid || isNaN(uid)) { await bot.sendMessage(chatId, "❌ Неверный ID"); return }
    bannedUsers.add(uid)
    const u = users.get(uid); if (u) u.banned = true
    saveDB()
    safeDelete(chatId, msg.message_id)
    await bot.sendMessage(chatId, `🚫 ${u?.name||uid} заблокирован.`)
    return
  }

  if (st?.state === "ban_remove" && userId === ADMIN_ID) {
    userStates.delete(userId)
    const uid = msg.text?.trim()
    if (!uid || isNaN(uid)) { await bot.sendMessage(chatId, "❌ Неверный ID"); return }
    bannedUsers.delete(uid)
    const u = users.get(uid); if (u) u.banned = false
    saveDB()
    safeDelete(chatId, msg.message_id)
    await bot.sendMessage(chatId, `✅ ${u?.name||uid} разбанен.`)
    return
  }

  // ── Ad schedule time ───────────────────────────────────────────────────────
  if (st?.state === "ad_schedule" && userId === ADMIN_ID) {
    userStates.delete(userId)
    safeDelete(chatId, msg.message_id)
    const match = msg.text?.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})$/)
    if (!match) { await bot.sendMessage(chatId, "❌ Неверный формат. Пример: `25.12.2025 18:00`", { parse_mode:"Markdown" }); return }
    const [, d, mo, y, h, mi] = match
    const sendAt = new Date(`${y}-${mo}-${d}T${h}:${mi}:00`).getTime()
    if (sendAt <= Date.now()) { await bot.sendMessage(chatId, "❌ Дата в прошлом!"); return }
    scheduledAds.push({ adId: st.adId, sendAt, sent: false })
    saveDB()
    await bot.sendMessage(chatId, `⏰ Запланировано на *${msg.text.trim()}*`, { parse_mode: "Markdown" })
    return
  }

  // ── Ad content ─────────────────────────────────────────────────────────────
  if (st?.state === "ad_content" && userId === ADMIN_ID) {
    const adData = {}
    if (st.adType === "text") {
      if (!msg.text) { await bot.sendMessage(chatId, "❌ Нужен текст."); return }
      adData.text = msg.text
    } else if (st.adType === "photo") {
      if (msg.photo) { adData.imageUrl = msg.photo[msg.photo.length-1].file_id; adData.text = msg.caption||"" }
      else if (msg.text) { adData.text = msg.text }
      else { await bot.sendMessage(chatId, "❌ Нужно фото."); return }
    } else if (st.adType === "video") {
      if (msg.video) { adData.videoUrl = msg.video.file_id; adData.text = msg.caption||"" }
      else if (msg.text) { adData.text = msg.text }
      else { await bot.sendMessage(chatId, "❌ Нужно видео."); return }
    }
    safeDelete(chatId, msg.message_id)
    userStates.set(userId, { ...st, state: "ad_buttons_ask", adData })
    await bot.sendMessage(chatId, "✅ Контент получен! Добавить кнопки?", {
      reply_markup: { inline_keyboard: [
        [{ text:"➕ Добавить кнопки", callback_data:"ad_add_buttons" }],
        [{ text:"➡️ Без кнопок",     callback_data:"ad_no_buttons"  }]
      ]}
    })
    return
  }

  // ── Ad buttons ─────────────────────────────────────────────────────────────
  if (st?.state === "ad_buttons" && userId === ADMIN_ID) {
    if (!msg.text) { await bot.sendMessage(chatId, "❌ Нужен текст."); return }
    const buttons = msg.text.split("\n").map(line => {
      const [txt, url] = line.split("|").map(s => s.trim())
      return txt && url?.startsWith("http") ? { text: txt, url } : null
    }).filter(Boolean)
    if (!buttons.length) { await bot.sendMessage(chatId, "❌ Неверный формат.\n`Текст | https://...`", { parse_mode:"Markdown" }); return }
    safeDelete(chatId, msg.message_id)
    userStates.set(userId, { ...st, state: "ad_frequency", adData: { ...st.adData, buttons } })
    await askAdFrequency(chatId, userId)
    return
  }

  // ── Ссылки ─────────────────────────────────────────────────────────────────
  if (!msg.text) return

  const tikLinks   = extractTikTokLinks(msg.text)
  const instaLinks = extractInstaLinks(msg.text)
  const allLinks   = [...tikLinks, ...instaLinks]
  if (!allLinks.length) return

  if (antiSpam(userId)) {
    const m = await bot.sendMessage(chatId, t(userId, "wait"))
    setTimeout(() => safeDelete(chatId, m.message_id), 2_000)
    return
  }

  // Проверка подписки
  if (CHANNEL_ID && !(await isSubscribed(userId))) {
    await bot.sendMessage(chatId, t(userId, "sub_req"), {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [
        [{ text: "📢 Подписаться", url: CHANNEL }],
        [{ text: t(userId, "sub_btn"), callback_data: "check_sub" }]
      ]}
    })
    return
  }

  safeDelete(chatId, msg.message_id)

  for (const link of allLinks) {
    const isTikTok = tikLinks.includes(link)

    addQueue(async () => {
      // Показываем индикатор загрузки
      const waitMsg = await bot.sendMessage(chatId, t(userId, "loading"))

      try {
        // ── Cache hit ──────────────────────────────────────────────────────
        const cached = cache.get(link)
        if (isCacheValid(cached)) {
          safeDelete(chatId, waitMsg.message_id)

          if (cached.type === "video") {
            // Отправляем видео с временной клавиатурой, потом обновляем на правильный msgId
            const sent = await bot.sendVideo(chatId, cached.fileId, {
              caption:      cached.caption,
              parse_mode:   "Markdown",
              reply_markup: videoKb("tmp")
            })
            // Сохраняем file_id и обновляем кнопку с реальным message_id
            const mid = String(sent.message_id)
            videoFileIds.set(mid, cached.fileId)
            setTimeout(() => videoFileIds.delete(mid), 3_600_000)
            await bot.editMessageReplyMarkup(videoKb(sent.message_id), { chat_id: chatId, message_id: sent.message_id }).catch(() => {})

          } else if (cached.type === "photo") {
            await bot.sendMediaGroup(chatId, cached.media)
          }

          const u = users.get(String(userId))
          if (u) { u.downloads++; recordDownload(); await maybeShowAd(chatId, userId, u) }
          saveDB()
          return
        }

        // ── TikTok ────────────────────────────────────────────────────────
        if (isTikTok) {
          const item = await fetchTikTok(link)

          const author    = item.author?.nickname  || "Unknown"
          const authorTag = item.author?.unique_id ? `@${item.author.unique_id}` : ""
          const views     = fmt(item.play_count)
          const likes     = fmt(item.digg_count)
          const comments  = fmt(item.comment_count)
          const shares    = fmt(item.share_count)
          const desc      = item.title ? `\n📝 ${item.title.slice(0,100)}` : ""
          const caption   = `📥 @${BOT_USERNAME}\n\n👤 ${author} ${authorTag}${desc}\n\n👁 ${views}  ❤️ ${likes}  💬 ${comments}  🔄 ${shares}`

          // Удаляем только индикатор загрузки
          safeDelete(chatId, waitMsg.message_id)

          if (item.images && item.images.length) {
            // Фото / слайд-шоу
            const photoUrls = item.images.slice(0, 10)
            const media = photoUrls.map((img, i) => ({
              type:  "photo",
              media: typeof img === "object" ? (img.url || img) : img,
              ...(i === 0 ? { caption, parse_mode: "Markdown" } : {})
            }))
            try {
              await bot.sendMediaGroup(chatId, media)
              cache.set(link, { type: "photo", media, ts: Date.now() })
            } catch {
              // Fallback — по одному
              for (let i = 0; i < photoUrls.length; i++) {
                const u = typeof photoUrls[i] === "object" ? photoUrls[i].url : photoUrls[i]
                try {
                  await bot.sendPhoto(chatId, u, { caption: i===0?caption:undefined, parse_mode:"Markdown" })
                } catch {}
              }
            }

          } else {
            // Видео
            const videoUrl = item.hdplay || item.play
            if (!videoUrl) throw new Error("No video URL")

            const sent = await bot.sendVideo(chatId, videoUrl, {
              caption,
              parse_mode:        "Markdown",
              supports_streaming: true,
              reply_markup:       videoKb("tmp")   // временный, сразу обновим
            })

            const mid = String(sent.message_id)
            videoFileIds.set(mid, sent.video.file_id)
            setTimeout(() => videoFileIds.delete(mid), 3_600_000)

            // Обновляем клавиатуру — теперь кнопка circle_<реальный_msgId>
            await bot.editMessageReplyMarkup(videoKb(sent.message_id), { chat_id: chatId, message_id: sent.message_id }).catch(() => {})

            cache.set(link, { type: "video", fileId: sent.video.file_id, caption, ts: Date.now() })
          }

        // ── Instagram ──────────────────────────────────────────────────────
        } else {
          const result  = await fetchInstagram(link)
          const caption = `📥 @${BOT_USERNAME}\n\n📸 Instagram`

          safeDelete(chatId, waitMsg.message_id)

          if (result.type === "video") {
            const sent = await bot.sendVideo(chatId, result.url, {
              caption,
              parse_mode:        "Markdown",
              supports_streaming: true,
              reply_markup:       videoKb("tmp")
            })
            const mid = String(sent.message_id)
            videoFileIds.set(mid, sent.video.file_id)
            setTimeout(() => videoFileIds.delete(mid), 3_600_000)
            await bot.editMessageReplyMarkup(videoKb(sent.message_id), { chat_id: chatId, message_id: sent.message_id }).catch(() => {})
            cache.set(link, { type: "video", fileId: sent.video.file_id, caption, ts: Date.now() })

          } else if (result.type === "photo") {
            await bot.sendPhoto(chatId, result.url, { caption, parse_mode: "Markdown" })
          }
        }

        // Трекинг
        const u = users.get(String(userId))
        if (u) {
          u.downloads++
          if (!u.history) u.history = []
          u.history.push({ url: link, type: isTikTok?"tiktok":"instagram", ts: Date.now() })
          if (u.history.length > 50) u.history = u.history.slice(-50)
          recordDownload()
          await maybeShowAd(chatId, userId, u)
        }

        const totalDl = [...users.values()].reduce((s, u) => s + u.downloads, 0)
        if (totalDl % 100 === 0) notifyAdmin(`🎉 *${totalDl}* загрузок!`)

        saveDB()

      } catch (e) {
        console.error("Download error:", e.message)
        safeDelete(chatId, waitMsg.message_id)
        const err = await bot.sendMessage(chatId, t(userId, "error"))
        setTimeout(() => safeDelete(chatId, err.message_id), 15_000)
      }
    })
  }
})

// ══════════════════════════════════════════════════════════════════════════════
//  ERRORS
// ══════════════════════════════════════════════════════════════════════════════
process.on("unhandledRejection", e => console.error("Rejection:", e))
process.on("uncaughtException",  e => console.error("Exception:", e))
bot.on("polling_error", e => console.error("Polling:", e.message))
process.on("SIGINT",  () => { saveDB(); process.exit(0) })
process.on("SIGTERM", () => { saveDB(); process.exit(0) })
