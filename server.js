import TelegramBot from "node-telegram-bot-api"
import axios from "axios"
import express from "express"
import dotenv from "dotenv"
import fs from "fs"
import path from "path"
import { exec } from "child_process"
import { promisify } from "util"
import { createWriteStream } from "fs"
import os from "os"

const execAsync = promisify(exec)

dotenv.config()

// ══════════════════════════════════════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════════════════════════════════════
const TOKEN        = process.env.TOKEN
const PORT         = process.env.PORT || 3000
const BOT_USERNAME = "AZASAVED_bot"
const ADMIN_ID     = 5331869155
const CHANNEL      = "https://t.me/AZATECHNOLOGY_FREE"
const CHANNEL_ID   = process.env.CHANNEL_ID || ""   // e.g. "@AZATECHNOLOGY_FREE" — for sub check

const EXPECTED_BOT = "AZASAVED_bot"
const REAL_ADMIN   = 5331869155
const SECRET_KEY   = "aza_secure_2026"

const DB_FILE      = "./db.json"   // persistent storage
const CACHE_TTL    = 3_600_000     // 1h

if (!TOKEN) { console.error("❌ TOKEN missing"); process.exit(1) }

// ══════════════════════════════════════════════════════════════════════════════
//  PERSISTENT DB  (saves/loads from db.json)
// ══════════════════════════════════════════════════════════════════════════════
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, "utf8"))
    }
  } catch {}
  return { users: {}, ads: [], adIdCounter: 1, bannedUsers: [], scheduledAds: [], dailyStats: {} }
}

function saveDB() {
  try {
    const data = {
      users:         Object.fromEntries(users),
      ads,
      adIdCounter,
      bannedUsers:   [...bannedUsers],
      scheduledAds,
      dailyStats
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2))
  } catch (e) { console.error("DB save error:", e.message) }
}

// Auto-save every 30s
setInterval(saveDB, 30_000)

const raw = loadDB()

// ══════════════════════════════════════════════════════════════════════════════
//  STATE  (restored from DB)
// ══════════════════════════════════════════════════════════════════════════════
const users        = new Map(Object.entries(raw.users || {}))  // userId(str) → user obj
const cache        = new Map()
const cooldown     = new Map()
const lastMessages = new Map()
const userStates   = new Map()

// Ads
let ads          = raw.ads          || []
let adIdCounter  = raw.adIdCounter  || 1
const bannedUsers  = new Set(raw.bannedUsers || [])
let scheduledAds = raw.scheduledAds || []  // { adId, sendAt, sent }
let dailyStats   = raw.dailyStats   || {}  // "YYYY-MM-DD" → { downloads, newUsers }

// ══════════════════════════════════════════════════════════════════════════════
//  SECURITY
// ══════════════════════════════════════════════════════════════════════════════
async function protectBot(bot) {
  try {
    const me = await bot.getMe()
    if (me.username !== EXPECTED_BOT) { console.error("❌ Cloned bot"); process.exit(1) }
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
app.get("/", (_req, res) => res.send("✅ Bot running"))
app.get("/health", (_req, res) => res.json({
  status: "ok",
  users: users.size,
  banned: bannedUsers.size,
  cache: cache.size,
  ads: { total: ads.length, active: ads.filter(a => a.active).length },
  queue: queue.length
}))
app.listen(PORT, () => console.log(`🌐 Server on port ${PORT}`))

// ══════════════════════════════════════════════════════════════════════════════
//  BOT
// ══════════════════════════════════════════════════════════════════════════════
const bot = new TelegramBot(TOKEN, { polling: true })
console.log("🤖 Bot started");

;(async () => {
  await protectBot(bot)
  protectAdmin()
  hiddenCheck()
})()

// Admin watchdog
setInterval(() => {
  if (!users.has(String(REAL_ADMIN))) {
    console.error("❌ Admin missing from users")
    process.exit(1)
  }
}, 60_000)

// ══════════════════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function formatNumber(n) {
  if (!n) return "0"
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "K"
  return String(n)
}

function todayKey() {
  return new Date().toISOString().slice(0, 10)
}

function recordDownload(userId) {
  const key = todayKey()
  if (!dailyStats[key]) dailyStats[key] = { downloads: 0, newUsers: 0 }
  dailyStats[key].downloads++
}

function recordNewUser() {
  const key = todayKey()
  if (!dailyStats[key]) dailyStats[key] = { downloads: 0, newUsers: 0 }
  dailyStats[key].newUsers++
}

function antiSpam(id, ms = 1500) {
  const now = Date.now()
  if (cooldown.has(id) && now - cooldown.get(id) < ms) return true
  cooldown.set(id, now)
  return false
}

function saveMsg(userId, msgId) {
  if (!lastMessages.has(userId)) lastMessages.set(userId, [])
  lastMessages.get(userId).push(msgId)
}

async function clearChat(chatId, userId) {
  const msgs = lastMessages.get(userId) || []
  await Promise.allSettled(msgs.map(id => bot.deleteMessage(chatId, id)))
  lastMessages.set(userId, [])
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

function isCacheValid(entry) {
  return entry && (Date.now() - entry.ts) < CACHE_TTL
}

function trackUser(msg) {
  const id = String(msg.from.id)
  const isNew = !users.has(id)
  if (isNew) {
    users.set(id, {
      id: msg.from.id,
      name: msg.from.first_name || "User",
      username: msg.from.username || null,
      lang: msg.from.language_code || "ru",
      joinedAt: Date.now(),
      downloads: 0,
      lastAdShown: 0,
      history: [],
      banned: false
    })
    recordNewUser()
    notifyAdmin(`👤 Новый пользователь: *${msg.from.first_name}* ${msg.from.username ? "@" + msg.from.username : ""}\nID: \`${msg.from.id}\`\n👥 Всего: *${users.size}*`)
  }
  return users.get(id)
}

function isBanned(userId) {
  return bannedUsers.has(String(userId))
}

// ══════════════════════════════════════════════════════════════════════════════
//  LANGUAGES
// ══════════════════════════════════════════════════════════════════════════════
const LANGS = {
  ru: {
    welcome:
`🎬 *AZASAVED Bot*

Скачиваю видео и фото с TikTok и Instagram без водяного знака.

📌 *Как использовать:*
• Отправь ссылку TikTok или Instagram Reels
• Получи контент без водяного знака ⚡

✅ Поддерживаю:
• TikTok видео (HD)
• TikTok слайд-шоу / фото
• Instagram Reels / посты

👇 *Просто отправь ссылку!*`,
    loading:     "⏳ Загружаю...",
    error:       "❌ Не удалось загрузить.\n\n• Видео приватное\n• Ссылка недействительна\n• Сбой API\n\nПопробуй позже.",
    wait:        "⏳ Подожди секунду...",
    cancelled:   "❌ Отменено.",
    banned:      "🚫 Ты заблокирован.",
    sub_required:"🔒 Подпишись на канал чтобы использовать бота:",
    sub_check:   "✅ Проверить подписку",
    help:
`ℹ️ *Как пользоваться*

1. Скопируй ссылку из TikTok или Instagram
2. Вставь её сюда
3. Получи видео или фото

⚡ Форматы ссылок:
• tiktok.com/@user/video/...
• vm.tiktok.com/...
• instagram.com/reel/...
• instagram.com/p/...

❓ Проблемы? @AZAkzn1`,
    donate:      "💖 Поддержать: *@AZAkzn1*\nСпасибо!",
    mystats:     (d) => `📊 Твоя статистика:\n\n📥 Загрузок: *${d}*`,
    lang_changed:"✅ Язык изменён на 🇷🇺 Русский",
  },
  en: {
    welcome:
`🎬 *AZASAVED Bot*

I download TikTok & Instagram videos/photos without watermark.

📌 *How to use:*
• Send a TikTok or Instagram Reels link
• Get content without watermark ⚡

✅ Supports:
• TikTok video (HD)
• TikTok slideshows / photos
• Instagram Reels / posts

👇 *Just send a link!*`,
    loading:     "⏳ Loading...",
    error:       "❌ Failed to download.\n\n• Private video\n• Invalid link\n• API error\n\nTry again later.",
    wait:        "⏳ Wait a second...",
    cancelled:   "❌ Cancelled.",
    banned:      "🚫 You are banned.",
    sub_required:"🔒 Subscribe to the channel to use the bot:",
    sub_check:   "✅ Check subscription",
    help:
`ℹ️ *How to use*

1. Copy a link from TikTok or Instagram
2. Paste it here
3. Get video or photos

⚡ Link formats:
• tiktok.com/@user/video/...
• vm.tiktok.com/...
• instagram.com/reel/...
• instagram.com/p/...

❓ Issues? @AZAkzn1`,
    donate:      "💖 Support: *@AZAkzn1*\nThank you!",
    mystats:     (d) => `📊 Your stats:\n\n📥 Downloads: *${d}*`,
    lang_changed:"✅ Language changed to 🇬🇧 English",
  },
  uz: {
    welcome:
`🎬 *AZASAVED Bot*

TikTok va Instagram videolarini suvli belgisiz yuklayman.

📌 *Qanday ishlatish:*
• TikTok yoki Instagram Reels havolasini yuboring
• Suvli belgisiz kontent oling ⚡

✅ Qo'llab-quvvatlanadi:
• TikTok video (HD)
• TikTok foto-slaydlar
• Instagram Reels / postlar

👇 *Shunchaki havola yuboring!*`,
    loading:     "⏳ Yuklanmoqda...",
    error:       "❌ Yuklab bo'lmadi.\n\n• Video maxfiy\n• Havola noto'g'ri\n• API xatosi\n\nKeyinroq urinib ko'ring.",
    wait:        "⏳ Bir soniya kuting...",
    cancelled:   "❌ Bekor qilindi.",
    banned:      "🚫 Siz bloklangansiz.",
    sub_required:"🔒 Botdan foydalanish uchun kanalga obuna bo'ling:",
    sub_check:   "✅ Obunani tekshirish",
    help:
`ℹ️ *Qanday ishlatish*

1. TikTok yoki Instagramdan havola nusxalang
2. Shu yerga yuboring
3. Video yoki foto oling

❓ Muammo? @AZAkzn1`,
    donate:      "💖 Qo'llab-quvvatlash: *@AZAkzn1*\nRahmat!",
    mystats:     (d) => `📊 Sizning statistikangiz:\n\n📥 Yuklamalar: *${d}*`,
    lang_changed:"✅ Til o'zgartirildi: 🇺🇿 O'zbek",
  }
}

function t(userId, key, ...args) {
  const u    = users.get(String(userId))
  const lang = u?.lang || "ru"
  const val  = LANGS[lang]?.[key] || LANGS.ru[key] || key
  return typeof val === "function" ? val(...args) : val
}

// ══════════════════════════════════════════════════════════════════════════════
//  ADMIN NOTIFICATIONS
// ══════════════════════════════════════════════════════════════════════════════
async function notifyAdmin(text) {
  try {
    await bot.sendMessage(ADMIN_ID, text, { parse_mode: "Markdown" })
  } catch {}
}

// ══════════════════════════════════════════════════════════════════════════════
//  SUBSCRIPTION CHECK
// ══════════════════════════════════════════════════════════════════════════════
async function isSubscribed(userId) {
  if (!CHANNEL_ID) return true   // disabled if not configured
  try {
    const member = await bot.getChatMember(CHANNEL_ID, userId)
    return ["member","administrator","creator"].includes(member.status)
  } catch { return true }
}

// ══════════════════════════════════════════════════════════════════════════════
//  ADS
// ══════════════════════════════════════════════════════════════════════════════
function getActiveAds() { return ads.filter(a => a.active) }

function pickAd() {
  const active = getActiveAds()
  return active.length ? active[Math.floor(Math.random() * active.length)] : null
}

function shouldShowAd(user, every = 3) {
  return (user.downloads - user.lastAdShown) >= every
}

function buildAdKeyboard(buttons) {
  if (!buttons?.length) return undefined
  return { inline_keyboard: [buttons.map(b => ({ text: b.text, url: b.url }))] }
}

async function sendAdToUser(chatId, userId, ad) {
  try {
    const keyboard = buildAdKeyboard(ad.buttons)
    const opts = { parse_mode: "Markdown", ...(keyboard ? { reply_markup: keyboard } : {}) }
    let sent

    if (ad.type === "photo" && ad.imageUrl)
      sent = await bot.sendPhoto(chatId, ad.imageUrl, { caption: ad.text, ...opts })
    else if (ad.type === "video" && ad.videoUrl)
      sent = await bot.sendVideo(chatId, ad.videoUrl, { caption: ad.text, ...opts, supports_streaming: true })
    else
      sent = await bot.sendMessage(chatId, ad.text, opts)

    ad.views = (ad.views || 0) + 1
    if (sent && userId) saveMsg(userId, sent.message_id)
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

// ══════════════════════════════════════════════════════════════════════════════
//  SCHEDULED ADS — check every minute
// ══════════════════════════════════════════════════════════════════════════════
setInterval(async () => {
  const now = Date.now()
  for (const sched of scheduledAds) {
    if (sched.sent) continue
    if (now < sched.sendAt) continue

    const ad = ads.find(a => a.id === sched.adId)
    if (!ad) { sched.sent = true; continue }

    sched.sent = true
    let sent = 0, failed = 0

    for (const [, u] of users) {
      if (bannedUsers.has(String(u.id))) continue
      const ok = await sendAdToUser(u.id, String(u.id), ad)
      ok ? sent++ : failed++
      await sleep(60)
    }

    notifyAdmin(`📣 Запланированная реклама #${ad.id} разослана\n✔️ ${sent} / ❌ ${failed}`)
    saveDB()
  }
}, 60_000)

// ══════════════════════════════════════════════════════════════════════════════
//  QUEUE
// ══════════════════════════════════════════════════════════════════════════════
const queue = []
let queueRunning = false

function addQueue(task) { queue.push(task); runQueue() }

async function runQueue() {
  if (queueRunning) return
  queueRunning = true
  while (queue.length) {
    const job = queue.shift()
    try { await job() } catch (e) { console.error("Queue:", e.message) }
    await sleep(1000)
  }
  queueRunning = false
}

// ══════════════════════════════════════════════════════════════════════════════
//  API — TikTok
// ══════════════════════════════════════════════════════════════════════════════
async function fetchTikTok(url) {
  try {
    // 🔥 1. Разворачиваем короткую ссылку
    const res = await axios.get(url, {
      maxRedirects: 5,
      headers: { "User-Agent": "Mozilla/5.0" }
    })

    const finalUrl = res.request?.res?.responseUrl || url

    // 🔥 2. Запрос к API
    const { data } = await axios.get(
      `https://www.tikwm.com/api/?url=${encodeURIComponent(finalUrl)}&hd=1`,
      {
        timeout: 15000,
        headers: { "User-Agent": "Mozilla/5.0" }
      }
    )

    // 🔥 3. Проверка
    if (data?.data) return data.data

    console.log("TikTok bad response:", data)
    throw new Error("Empty response")

  } catch (e) {
    console.log("TikTok API error:", e.message)
    throw new Error("TikTok API failed")
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  API — Instagram
// ══════════════════════════════════════════════════════════════════════════════
async function fetchInstagram(url) {
  // 🔥 1. Основной API
  try {
    const { data } = await axios.get(
      `https://snapinsta.app/api/?url=${encodeURIComponent(url)}`,
      {
        timeout: 15000,
        headers: { "User-Agent": "Mozilla/5.0" }
      }
    )

    if (data?.url) {
      return {
        type: "video",
        url: data.url,
        thumb: data.thumbnail || null
      }
    }

    console.log("Snapinsta bad response:", data)

  } catch (e) {
    console.log("Snapinsta error:", e.message)
  }

  // 🔥 2. fallback API (если первый не сработал)
  try {
    const { data } = await axios.post(
      "https://instagram-downloader-download-instagram-videos-stories1.p.rapidapi.com/get-info-rapidapi",
      { url },
      {
        headers: {
          "Content-Type": "application/json",
          "X-RapidAPI-Host": "instagram-downloader-download-instagram-videos-stories1.p.rapidapi.com",
          "X-RapidAPI-Key": process.env.RAPID_API_KEY || "",
          "User-Agent": "Mozilla/5.0"
        },
        timeout: 15000
      }
    )

    if (data?.url) {
      return { type: "video", url: data.url }
    }

    console.log("Fallback bad response:", data)

  } catch (e) {
    console.log("Fallback error:", e.message)
  }

  // ❌ если всё сломалось
  throw new Error("Instagram API failed")
}


// ══════════════════════════════════════════════════════════════════════════════
//  KEYBOARDS
// ══════════════════════════════════════════════════════════════════════════════
const mainKeyboard = (userId) => ({
  inline_keyboard: [
    [{ text: "📢 Канал", url: CHANNEL }, { text: "💖 Поддержать", callback_data: "donate" }],
    [{ text: "ℹ️ Помощь", callback_data: "help" }, { text: "📊 Мои загрузки", callback_data: "mystats" }],
    [{ text: "🌍 Язык / Language", callback_data: "lang_menu" }],
    ...(userId === ADMIN_ID ? [[{ text: "⚙️ Админ панель", callback_data: "admin" }]] : [])
  ]
})

// videoKeyboard принимает messageId чтобы кнопка кружка знала какое видео конвертировать
const videoKeyboard = (msgId) => ({
  inline_keyboard: [
    [{ text: "⭕ Кружок", callback_data: `circle_${msgId}` }],
    [
      { text: "💖 Поддержать", callback_data: "donate" },
      { text: "📢 Канал", url: CHANNEL }
    ]
  ]
})

// Хранит file_id видео по message_id для конвертации в кружок
const videoFileIds = new Map()  // msgId → { file_id, chatId, userId }

const adminKeyboard = () => ({
  inline_keyboard: [
    [{ text: "📢 Рассылка",   callback_data: "broadcast"  }, { text: "📊 Статистика",  callback_data: "adminstats" }],
    [{ text: "📣 Реклама",    callback_data: "ads_menu"   }, { text: "🚫 Баны",         callback_data: "ban_menu"   }],
    [{ text: "📈 Аналитика",  callback_data: "analytics"  }, { text: "🗑 Очистить кэш", callback_data: "clearcache" }],
  ]
})

// ══════════════════════════════════════════════════════════════════════════════
//  VIDEO NOTE (кружок) — скачивает видео и конвертирует через ffmpeg
// ══════════════════════════════════════════════════════════════════════════════
async function downloadFile(url, destPath) {
  const response = await axios({ url, method: "GET", responseType: "stream", timeout: 60_000 })
  return new Promise((resolve, reject) => {
    const writer = createWriteStream(destPath)
    response.data.pipe(writer)
    writer.on("finish", resolve)
    writer.on("error", reject)
  })
}

async function convertToVideoNote(fileId) {
  const tmpDir   = os.tmpdir()
  const inputPath  = path.join(tmpDir, `vn_input_${Date.now()}.mp4`)
  const outputPath = path.join(tmpDir, `vn_output_${Date.now()}.mp4`)

  try {
    // Получаем ссылку на файл от Telegram
    const fileLink = await bot.getFileLink(fileId)
    await downloadFile(fileLink, inputPath)

    // ffmpeg: обрезаем в квадрат по центру, 384x384, макс 60 сек
    await execAsync(
      `ffmpeg -i "${inputPath}" -t 60 -vf "crop=min(iw\\,ih):min(iw\\,ih),scale=384:384" -c:v libx264 -preset fast -crf 28 -c:a aac -movflags +faststart "${outputPath}" -y`
    )

    const videoBuffer = fs.readFileSync(outputPath)
    return videoBuffer
  } finally {
    try { fs.unlinkSync(inputPath)  } catch {}
    try { fs.unlinkSync(outputPath) } catch {}
  }
}


bot.onText(/\/start/, async msg => {
  const chatId = msg.chat.id
  const userId = msg.from.id
  trackUser(msg)
  safeDelete(chatId, msg.message_id)

  // Sub check
  if (CHANNEL_ID && !(await isSubscribed(userId))) {
    const m = await bot.sendMessage(chatId, t(userId, "sub_required"),
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📢 Подписаться", url: CHANNEL }],
            [{ text: t(userId, "sub_check"), callback_data: "check_sub" }]
          ]
        }
      }
    )
    saveMsg(userId, m.message_id)
    return
  }

  const sent = await bot.sendMessage(chatId, t(userId, "welcome"),
    { parse_mode: "Markdown", reply_markup: mainKeyboard(userId) }
  )
  saveMsg(userId, sent.message_id)
  setTimeout(() => safeDelete(chatId, sent.message_id), 120_000)
})

// ══════════════════════════════════════════════════════════════════════════════
//  /history
// ══════════════════════════════════════════════════════════════════════════════
bot.onText(/\/history/, async msg => {
  const userId = String(msg.from.id)
  const u = users.get(userId)
  safeDelete(msg.chat.id, msg.message_id)

  if (!u || !u.history?.length) {
    const m = await bot.sendMessage(msg.chat.id, "📋 История загрузок пуста.")
    setTimeout(() => safeDelete(msg.chat.id, m.message_id), 8_000)
    return
  }

  const list = u.history.slice(-10).reverse()
    .map((h, i) => `${i + 1}. [${h.type}] ${h.url.slice(0, 50)}...`)
    .join("\n")

  const m = await bot.sendMessage(msg.chat.id,
    `📋 *Последние загрузки:*\n\n${list}`,
    { parse_mode: "Markdown" }
  )
  saveMsg(userId, m.message_id)
  setTimeout(() => safeDelete(msg.chat.id, m.message_id), 30_000)
})

// ══════════════════════════════════════════════════════════════════════════════
//  /stats (admin)
// ══════════════════════════════════════════════════════════════════════════════
bot.onText(/\/stats/, async msg => {
  if (msg.from.id !== ADMIN_ID) return
  const totalDl = [...users.values()].reduce((s, u) => s + u.downloads, 0)
  const topUsers = [...users.values()]
    .sort((a, b) => b.downloads - a.downloads)
    .slice(0, 5)
    .map((u, i) => `${i+1}. ${u.name} — ${u.downloads} загрузок`)
    .join("\n")

  bot.sendMessage(msg.chat.id,
`📊 *Статистика*

👥 Пользователей: *${users.size}*
🚫 Банов: *${bannedUsers.size}*
📥 Всего загрузок: *${totalDl}*
🗃 Кэш: *${cache.size}*
📣 Реклама: *${ads.length}* (активных: *${getActiveAds().length}*)

🏆 Топ:
${topUsers || "нет данных"}`,
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

  await bot.answerCallbackQuery(q.id)

  // Sub check
  if (data === "check_sub") {
    if (await isSubscribed(userId)) {
      await clearChat(chatId, userId)
      const sent = await bot.sendMessage(chatId, t(userId, "welcome"),
        { parse_mode: "Markdown", reply_markup: mainKeyboard(userId) }
      )
      saveMsg(userId, sent.message_id)
    } else {
      bot.answerCallbackQuery(q.id, { text: "❌ Ты ещё не подписан!", show_alert: true })
    }
    return
  }

  // ── Video Note (кружок) ──
  if (data.startsWith("circle_") ) {
    const msgId = data.replace("circle_", "")
    const info  = videoFileIds.get(msgId)

    if (!info) {
      await bot.answerCallbackQuery(q.id, { text: "❌ Видео не найдено, скачай заново", show_alert: true })
      return
    }

    await bot.answerCallbackQuery(q.id, { text: "⏳ Конвертирую в кружок..." })

    const processing = await bot.sendMessage(chatId, "⭕ Конвертирую видео в кружок...")
    saveMsg(userId, processing.message_id)

    try {
      const videoBuffer = await convertToVideoNote(info.file_id)

      await bot.sendVideoNote(chatId, videoBuffer, { length: 384, duration: 60 })

      safeDelete(chatId, processing.message_id)
    } catch (e) {
      console.error("VideoNote error:", e.message)
      safeDelete(chatId, processing.message_id)
      const err = await bot.sendMessage(chatId,
        "❌ Не удалось создать кружок.\n\nВозможно видео слишком длинное или тяжёлое."
      )
      saveMsg(userId, err.message_id)
      setTimeout(() => safeDelete(chatId, err.message_id), 8_000)
    }
    return
  }

  // ── Public ──
  if (data === "donate") {
    const m = await bot.sendMessage(chatId, t(userId, "donate"), { parse_mode: "Markdown" })
    saveMsg(userId, m.message_id)
    setTimeout(() => safeDelete(chatId, m.message_id), 10_000)
  }

  if (data === "help") {
    const m = await bot.sendMessage(chatId, t(userId, "help"), { parse_mode: "Markdown" })
    saveMsg(userId, m.message_id)
    setTimeout(() => safeDelete(chatId, m.message_id), 20_000)
  }

  if (data === "mystats") {
    const u = users.get(String(userId))
    const m = await bot.sendMessage(chatId,
      u ? t(userId, "mystats", u.downloads) : "У тебя пока нет загрузок.",
      { parse_mode: "Markdown" }
    )
    saveMsg(userId, m.message_id)
    setTimeout(() => safeDelete(chatId, m.message_id), 10_000)
  }

  // ── Language ──
  if (data === "lang_menu") {
    const m = await bot.sendMessage(chatId, "🌍 Выбери язык / Choose language / Tilni tanlang:",
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🇷🇺 Русский",  callback_data: "lang_ru" }],
            [{ text: "🇬🇧 English",  callback_data: "lang_en" }],
            [{ text: "🇺🇿 O'zbek",   callback_data: "lang_uz" }],
          ]
        }
      }
    )
    saveMsg(userId, m.message_id)
  }

  if (data.startsWith("lang_")) {
    const lang = data.replace("lang_", "")
    const u = users.get(String(userId))
    if (u) u.lang = lang
    saveDB()
    const m = await bot.sendMessage(chatId, t(userId, "lang_changed"), { parse_mode: "Markdown" })
    saveMsg(userId, m.message_id)
    setTimeout(() => safeDelete(chatId, m.message_id), 4_000)
  }

  // ── Admin: main ──
  if (data === "admin" && userId === ADMIN_ID) {
    const m = await bot.sendMessage(chatId,
`⚙️ *Админ панель*

👥 Пользователей: *${users.size}*
🚫 Банов: *${bannedUsers.size}*
🗃 Кэш: *${cache.size}*
📣 Реклама: *${ads.length}* (активных: *${getActiveAds().length}*)`,
      { parse_mode: "Markdown", reply_markup: adminKeyboard() }
    )
    saveMsg(userId, m.message_id)
  }

  if (data === "adminstats" && userId === ADMIN_ID) {
    const totalDl = [...users.values()].reduce((s, u) => s + u.downloads, 0)
    const adStats = ads.map(a =>
      `${a.active ? "✅" : "⏸"} #${a.id} [${a.type}] 👁 ${a.views || 0}`
    ).join("\n") || "нет рекламы"

    const m = await bot.sendMessage(chatId,
`📊 *Подробная статистика*

👥 Пользователей: *${users.size}*
🚫 Банов: *${bannedUsers.size}*
📥 Загрузок: *${totalDl}*
🗃 Кэш: *${cache.size}*
📋 Очередь: *${queue.length}*

📣 *Реклама:*
${adStats}`,
      { parse_mode: "Markdown" }
    )
    saveMsg(userId, m.message_id)
  }

  // ── Analytics ──
  if (data === "analytics" && userId === ADMIN_ID) {
    const days = Object.entries(dailyStats)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-7)

    const chart = days.map(([date, s]) =>
      `📅 ${date}\n   📥 ${s.downloads} загрузок  👤 +${s.newUsers} новых`
    ).join("\n\n")

    const totalDl = [...users.values()].reduce((s, u) => s + u.downloads, 0)
    const today   = dailyStats[todayKey()] || { downloads: 0, newUsers: 0 }

    const m = await bot.sendMessage(chatId,
`📈 *Аналитика за 7 дней*

Сегодня:
📥 Загрузок: *${today.downloads}*
👤 Новых: *${today.newUsers}*

📊 По дням:
${chart || "нет данных"}

━━━━━━━━━━━━━━
📥 Всего загрузок: *${totalDl}*
👥 Всего пользователей: *${users.size}*`,
      { parse_mode: "Markdown" }
    )
    saveMsg(userId, m.message_id)
  }

  // ── Broadcast ──
  if (data === "broadcast" && userId === ADMIN_ID) {
    userStates.set(userId, { state: "broadcast" })
    const m = await bot.sendMessage(chatId,
`📢 *Рассылка*

Отправь сообщение — разошлю всем пользователям.
Поддерживаются текст, фото, видео (Markdown).

/cancel — отмена`,
      { parse_mode: "Markdown" }
    )
    saveMsg(userId, m.message_id)
  }

  // ── Bans ──
  if (data === "ban_menu" && userId === ADMIN_ID) {
    await showBanMenu(chatId, userId)
  }

  if (data === "ban_add" && userId === ADMIN_ID) {
    userStates.set(userId, { state: "ban_add" })
    const m = await bot.sendMessage(chatId,
      "🚫 Введи ID пользователя для бана:\n\n/cancel — отмена"
    )
    saveMsg(userId, m.message_id)
  }

  if (data === "ban_remove" && userId === ADMIN_ID) {
    userStates.set(userId, { state: "ban_remove" })
    const m = await bot.sendMessage(chatId,
      "✅ Введи ID пользователя для разбана:\n\n/cancel — отмена"
    )
    saveMsg(userId, m.message_id)
  }

  if (data.startsWith("unban_") && userId === ADMIN_ID) {
    const uid = data.replace("unban_", "")
    bannedUsers.delete(uid)
    const u = users.get(uid)
    if (u) u.banned = false
    saveDB()
    bot.answerCallbackQuery(q.id, { text: "✅ Разбанен" })
    await showBanMenu(chatId, userId)
  }

  // ── Clearcache ──
  if (data === "clearcache" && userId === ADMIN_ID) {
    cache.clear()
    const m = await bot.sendMessage(chatId, "✅ Кэш очищен!")
    saveMsg(userId, m.message_id)
    setTimeout(() => safeDelete(chatId, m.message_id), 4_000)
  }

  // ══ ADS ══════════════════════════════════════════════════════════════════════
  if (data === "ads_menu" && userId === ADMIN_ID) {
    await showAdsMenu(chatId, userId)
  }

  if (data === "ad_create" && userId === ADMIN_ID) {
    userStates.set(userId, { state: "ad_create_step1" })
    const m = await bot.sendMessage(chatId,
`📣 *Создание рекламы — Шаг 1/3*

Выбери тип объявления:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✏️ Текст",         callback_data: "ad_type_text"  }],
            [{ text: "🖼 Фото + текст",  callback_data: "ad_type_photo" }],
            [{ text: "🎬 Видео + текст", callback_data: "ad_type_video" }],
            [{ text: "❌ Отмена",         callback_data: "ads_menu"      }]
          ]
        }
      }
    )
    saveMsg(userId, m.message_id)
  }

  if (["ad_type_text","ad_type_photo","ad_type_video"].includes(data) && userId === ADMIN_ID) {
    const type = data.replace("ad_type_", "")
    userStates.set(userId, { state: "ad_awaiting_content", adType: type, adData: {} })
    const prompt = { text: "✏️ Напиши текст объявления:", photo: "🖼 Отправь фото с подписью:", video: "🎬 Отправь видео с подписью:" }[type]
    const m = await bot.sendMessage(chatId,
      `📣 *Создание рекламы — Шаг 2/3*\n\n${prompt}\n\n/cancel — отмена`,
      { parse_mode: "Markdown" }
    )
    saveMsg(userId, m.message_id)
  }

  if (data === "ad_add_buttons" && userId === ADMIN_ID) {
    const st = userStates.get(userId)
    if (!st) return
    userStates.set(userId, { ...st, state: "ad_awaiting_buttons" })
    const m = await bot.sendMessage(chatId,
`📣 *Кнопки к рекламе*

Формат (каждая кнопка — новая строка):
\`Текст кнопки | https://ссылка\`

Пример:
\`Открыть канал | https://t.me/example\``,
      {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "➡️ Без кнопок", callback_data: "ad_no_buttons" }]] }
      }
    )
    saveMsg(userId, m.message_id)
  }

  if (data === "ad_no_buttons" && userId === ADMIN_ID) {
    const st = userStates.get(userId)
    if (!st) return
    userStates.set(userId, { ...st, state: "ad_awaiting_frequency" })
    await askAdFrequency(chatId, userId)
  }

  if (data.startsWith("ad_freq_") && userId === ADMIN_ID) {
    const freq = parseInt(data.replace("ad_freq_", ""))
    const st   = userStates.get(userId)
    if (!st) return
    st.adFrequency = freq
    userStates.delete(userId)
    await finalizeAd(chatId, userId, st)
  }

  if (data.startsWith("ad_toggle_") && userId === ADMIN_ID) {
    const id = parseInt(data.replace("ad_toggle_", ""))
    const ad = ads.find(a => a.id === id)
    if (ad) { ad.active = !ad.active; saveDB() }
    bot.answerCallbackQuery(q.id, { text: ad?.active ? "✅ Включена" : "⏸ Выключена" })
    await showAdsMenu(chatId, userId)
  }

  if (data.startsWith("ad_delete_") && userId === ADMIN_ID) {
    const id  = parseInt(data.replace("ad_delete_", ""))
    const idx = ads.findIndex(a => a.id === id)
    if (idx !== -1) { ads.splice(idx, 1); saveDB() }
    bot.answerCallbackQuery(q.id, { text: "🗑 Удалено" })
    await showAdsMenu(chatId, userId)
  }

  if (data.startsWith("ad_preview_") && userId === ADMIN_ID) {
    const id = parseInt(data.replace("ad_preview_", ""))
    const ad = ads.find(a => a.id === id)
    if (ad) await sendAdToUser(chatId, userId, ad)
  }

  if (data.startsWith("ad_info_") && userId === ADMIN_ID) {
    const id = parseInt(data.replace("ad_info_", ""))
    const ad = ads.find(a => a.id === id)
    if (!ad) return
    const m = await bot.sendMessage(chatId,
`📣 *Реклама #${ad.id}*

Тип: *${ad.type}*
Статус: ${ad.active ? "✅ Активна" : "⏸ Выключена"}
Каждые: *${ad.showEvery}* загрузок
👁 Показов: *${ad.views || 0}*
📅 Создана: ${new Date(ad.createdAt).toLocaleDateString("ru")}
🔗 Кнопок: ${ad.buttons?.length || 0}`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: ad.active ? "⏸ Выкл" : "▶️ Вкл", callback_data: `ad_toggle_${ad.id}` },
              { text: "👁 Превью",  callback_data: `ad_preview_${ad.id}` }
            ],
            [{ text: "⏰ Запланировать рассылку", callback_data: `ad_schedule_${ad.id}` }],
            [{ text: "🗑 Удалить", callback_data: `ad_delete_${ad.id}` }],
            [{ text: "◀️ Назад",   callback_data: "ads_menu"            }]
          ]
        }
      }
    )
    saveMsg(userId, m.message_id)
  }

  // Schedule ad
  if (data.startsWith("ad_schedule_") && userId === ADMIN_ID) {
    const id = parseInt(data.replace("ad_schedule_", ""))
    userStates.set(userId, { state: "ad_schedule_time", adId: id })
    const m = await bot.sendMessage(chatId,
`⏰ *Запланировать рассылку рекламы #${id}*

Напиши дату и время в формате:
\`ДД.ММ.ГГГГ ЧЧ:ММ\`

Пример: \`25.12.2025 18:00\`

/cancel — отмена`,
      { parse_mode: "Markdown" }
    )
    saveMsg(userId, m.message_id)
  }

  if (data === "ad_broadcast_choose" && userId === ADMIN_ID) {
    if (!ads.length) {
      const m = await bot.sendMessage(chatId, "❌ Нет объявлений.")
      saveMsg(userId, m.message_id)
      return
    }
    const m = await bot.sendMessage(chatId, "📣 Выбери объявление для немедленной рассылки:",
      {
        reply_markup: {
          inline_keyboard: [
            ...ads.map(a => ([{
              text: `${a.active ? "✅" : "⏸"} #${a.id} [${a.type}]`,
              callback_data: `ad_send_all_${a.id}`
            }])),
            [{ text: "◀️ Назад", callback_data: "ads_menu" }]
          ]
        }
      }
    )
    saveMsg(userId, m.message_id)
  }

  if (data.startsWith("ad_send_all_") && userId === ADMIN_ID) {
    const id = parseInt(data.replace("ad_send_all_", ""))
    const ad = ads.find(a => a.id === id)
    if (!ad) return

    let sent = 0, failed = 0
    const progress = await bot.sendMessage(chatId, `📣 Рассылаю рекламу #${ad.id}...`)

    for (const [, u] of users) {
      if (bannedUsers.has(String(u.id))) continue
      const ok = await sendAdToUser(u.id, String(u.id), ad)
      ok ? sent++ : failed++
      await sleep(60)
    }

    bot.editMessageText(
      `✅ Рекламная рассылка завершена!\n\n✔️ Отправлено: *${sent}*\n❌ Не доставлено: *${failed}*`,
      { chat_id: chatId, message_id: progress.message_id, parse_mode: "Markdown" }
    )
    saveDB()
  }
})

// ══════════════════════════════════════════════════════════════════════════════
//  ADS MENU
// ══════════════════════════════════════════════════════════════════════════════
async function showAdsMenu(chatId, userId) {
  const active = getActiveAds()
  const adList = ads.length
    ? "\n\n📋 *Объявления:*\n" + ads.map(a =>
        `${a.active ? "✅" : "⏸"} #${a.id} [${a.type}] — 👁 ${a.views || 0} показов`
      ).join("\n")
    : ""

  const m = await bot.sendMessage(chatId,
`📣 *Управление рекламой*

Активных: *${active.length}* / Всего: *${ads.length}*${adList}`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "➕ Создать объявление",          callback_data: "ad_create"           }],
          [{ text: "📢 Разослать всем",               callback_data: "ad_broadcast_choose" }],
          ...ads.map(a => ([{ text: `${a.active ? "✅" : "⏸"} #${a.id} ${a.type}`, callback_data: `ad_info_${a.id}` }])),
          [{ text: "◀️ Назад",                        callback_data: "admin"               }]
        ]
      }
    }
  )
  saveMsg(userId, m.message_id)
}

async function askAdFrequency(chatId, userId) {
  const m = await bot.sendMessage(chatId,
`📣 *Создание рекламы — Шаг 3/3*

Как часто показывать рекламу?
_(после каждых N загрузок)_`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Каждые 2",  callback_data: "ad_freq_2"  }, { text: "Каждые 3",  callback_data: "ad_freq_3"  }, { text: "Каждые 5",  callback_data: "ad_freq_5"  }],
          [{ text: "Каждые 7",  callback_data: "ad_freq_7"  }, { text: "Каждые 10", callback_data: "ad_freq_10" }]
        ]
      }
    }
  )
  saveMsg(userId, m.message_id)
}

async function finalizeAd(chatId, userId, st) {
  const ad = {
    id: adIdCounter++,
    type: st.adType,
    text: st.adData.text || "",
    imageUrl: st.adData.imageUrl || null,
    videoUrl: st.adData.videoUrl || null,
    buttons: st.adData.buttons || [],
    active: true,
    showEvery: st.adFrequency || 3,
    createdAt: Date.now(),
    views: 0,
  }
  ads.push(ad)
  saveDB()

  const m = await bot.sendMessage(chatId,
`✅ *Реклама #${ad.id} создана!*

Тип: *${ad.type}*
Каждые: *${ad.showEvery}* загрузок
Кнопок: *${ad.buttons.length}*
Статус: ✅ Активна`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "👁 Превью",              callback_data: `ad_preview_${ad.id}` }],
          [{ text: "📣 Управление рекламой", callback_data: "ads_menu"            }]
        ]
      }
    }
  )
  saveMsg(userId, m.message_id)
}

// ══════════════════════════════════════════════════════════════════════════════
//  BAN MENU
// ══════════════════════════════════════════════════════════════════════════════
async function showBanMenu(chatId, userId) {
  const bannedList = [...bannedUsers].slice(0, 20)
  const lines = bannedList.map(id => {
    const u = users.get(id)
    return `🚫 ${u ? u.name : "?"} (${id})`
  }).join("\n") || "нет банов"

  const m = await bot.sendMessage(chatId,
`🚫 *Заблокированные пользователи*

Всего: *${bannedUsers.size}*

${lines}`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "➕ Заблокировать",   callback_data: "ban_add"    }],
          [{ text: "✅ Разблокировать",  callback_data: "ban_remove" }],
          ...bannedList.slice(0, 5).map(id => {
            const u = users.get(id)
            return [{ text: `✅ Разбан: ${u ? u.name : id}`, callback_data: `unban_${id}` }]
          }),
          [{ text: "◀️ Назад", callback_data: "admin" }]
        ]
      }
    }
  )
  saveMsg(userId, m.message_id)
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
    const m = await bot.sendMessage(chatId, t(userId, "cancelled"))
    setTimeout(() => safeDelete(chatId, m.message_id), 3_000)
    return
  }

  trackUser(msg)

  // Banned check
  if (isBanned(userId)) {
    safeDelete(chatId, msg.message_id)
    const m = await bot.sendMessage(chatId, t(userId, "banned"))
    setTimeout(() => safeDelete(chatId, m.message_id), 5_000)
    return
  }

  const st = userStates.get(userId)

  // ── Admin: broadcast ──
  if (st?.state === "broadcast" && userId === ADMIN_ID) {
    userStates.delete(userId)
    safeDelete(chatId, msg.message_id)

    let sent = 0, failed = 0
    const progress = await bot.sendMessage(chatId, "🚀 Рассылка началась...")

    for (const [, u] of users) {
      if (bannedUsers.has(String(u.id))) continue
      try {
        if (msg.photo) {
          const fileId = msg.photo[msg.photo.length - 1].file_id
          await bot.sendPhoto(u.id, fileId, { caption: msg.caption, parse_mode: "Markdown" })
        } else if (msg.video) {
          await bot.sendVideo(u.id, msg.video.file_id, { caption: msg.caption, parse_mode: "Markdown" })
        } else if (msg.text) {
          await bot.sendMessage(u.id, msg.text, { parse_mode: "Markdown" })
        }
        sent++
        await sleep(60)
      } catch { failed++ }
    }

    bot.editMessageText(
      `✅ Рассылка завершена!\n\n✔️ Отправлено: *${sent}*\n❌ Не доставлено: *${failed}*`,
      { chat_id: chatId, message_id: progress.message_id, parse_mode: "Markdown" }
    )
    return
  }

  // ── Admin: ban add ──
  if (st?.state === "ban_add" && userId === ADMIN_ID) {
    userStates.delete(userId)
    const uid = msg.text?.trim()
    if (!uid || isNaN(uid)) {
      bot.sendMessage(chatId, "❌ Неверный ID"); return
    }
    bannedUsers.add(uid)
    const u = users.get(uid)
    if (u) u.banned = true
    saveDB()
    safeDelete(chatId, msg.message_id)
    const m = await bot.sendMessage(chatId, `🚫 Пользователь *${u?.name || uid}* заблокирован.`, { parse_mode: "Markdown" })
    saveMsg(userId, m.message_id)
    return
  }

  // ── Admin: ban remove ──
  if (st?.state === "ban_remove" && userId === ADMIN_ID) {
    userStates.delete(userId)
    const uid = msg.text?.trim()
    if (!uid || isNaN(uid)) {
      bot.sendMessage(chatId, "❌ Неверный ID"); return
    }
    bannedUsers.delete(uid)
    const u = users.get(uid)
    if (u) u.banned = false
    saveDB()
    safeDelete(chatId, msg.message_id)
    const m = await bot.sendMessage(chatId, `✅ Пользователь *${u?.name || uid}* разблокирован.`, { parse_mode: "Markdown" })
    saveMsg(userId, m.message_id)
    return
  }

  // ── Admin: schedule ad time ──
  if (st?.state === "ad_schedule_time" && userId === ADMIN_ID) {
    userStates.delete(userId)
    safeDelete(chatId, msg.message_id)
    const text = msg.text?.trim()

    // parse DD.MM.YYYY HH:MM
    const match = text?.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})$/)
    if (!match) {
      const m = await bot.sendMessage(chatId, "❌ Неверный формат. Используй: `ДД.ММ.ГГГГ ЧЧ:ММ`", { parse_mode: "Markdown" })
      saveMsg(userId, m.message_id)
      return
    }
    const [, d, mo, y, h, mi] = match
    const sendAt = new Date(`${y}-${mo}-${d}T${h}:${mi}:00`).getTime()

    if (sendAt <= Date.now()) {
      const m = await bot.sendMessage(chatId, "❌ Дата должна быть в будущем!")
      saveMsg(userId, m.message_id)
      return
    }

    scheduledAds.push({ adId: st.adId, sendAt, sent: false })
    saveDB()

    const m = await bot.sendMessage(chatId,
      `⏰ Реклама #${st.adId} запланирована на *${text}*`,
      { parse_mode: "Markdown" }
    )
    saveMsg(userId, m.message_id)
    return
  }

  // ── Ad content: awaiting ──
  if (st?.state === "ad_awaiting_content" && userId === ADMIN_ID) {
    const adData = {}

    if (st.adType === "text") {
      if (!msg.text) { bot.sendMessage(chatId, "❌ Нужен текст."); return }
      adData.text = msg.text
    } else if (st.adType === "photo") {
      if (msg.photo) { adData.imageUrl = msg.photo[msg.photo.length - 1].file_id; adData.text = msg.caption || "" }
      else if (msg.text) { adData.text = msg.text }
      else { bot.sendMessage(chatId, "❌ Нужно фото."); return }
    } else if (st.adType === "video") {
      if (msg.video) { adData.videoUrl = msg.video.file_id; adData.text = msg.caption || "" }
      else if (msg.text) { adData.text = msg.text }
      else { bot.sendMessage(chatId, "❌ Нужно видео."); return }
    }

    safeDelete(chatId, msg.message_id)
    userStates.set(userId, { ...st, state: "ad_awaiting_buttons_ask", adData })
    const m = await bot.sendMessage(chatId, "✅ Контент получен!\n\nДобавить кнопки-ссылки?",
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "➕ Добавить кнопки", callback_data: "ad_add_buttons" }],
            [{ text: "➡️ Без кнопок",      callback_data: "ad_no_buttons"  }]
          ]
        }
      }
    )
    saveMsg(userId, m.message_id)
    return
  }

  // ── Ad buttons ──
  if (st?.state === "ad_awaiting_buttons" && userId === ADMIN_ID) {
    if (!msg.text) { bot.sendMessage(chatId, "❌ Нужен текст."); return }
    const buttons = msg.text.split("\n")
      .map(line => {
        const parts = line.split("|").map(p => p.trim())
        return (parts.length >= 2 && parts[1].startsWith("http"))
          ? { text: parts[0], url: parts[1] } : null
      }).filter(Boolean)

    if (!buttons.length) {
      bot.sendMessage(chatId, "❌ Неверный формат.\nПример: `Текст | https://ссылка`", { parse_mode: "Markdown" })
      return
    }

    safeDelete(chatId, msg.message_id)
    userStates.set(userId, { ...st, state: "ad_awaiting_frequency", adData: { ...st.adData, buttons } })
    await askAdFrequency(chatId, userId)
    return
  }

  // ── Sub check ──
  if (!msg.text) return
  if (CHANNEL_ID && !(await isSubscribed(userId))) {
    const m = await bot.sendMessage(chatId, t(userId, "sub_required"),
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📢 Подписаться",      url: CHANNEL                   }],
            [{ text: t(userId, "sub_check"), callback_data: "check_sub" }]
          ]
        }
      }
    )
    saveMsg(userId, m.message_id)
    return
  }

  // ── Links ──
  const tikLinks   = extractTikTokLinks(msg.text)
  const instaLinks = extractInstaLinks(msg.text)
  const allLinks   = [...tikLinks, ...instaLinks]

  if (!allLinks.length) return

  if (antiSpam(userId)) {
    const m = await bot.sendMessage(chatId, t(userId, "wait"))
    setTimeout(() => safeDelete(chatId, m.message_id), 2_000)
    return
  }

  safeDelete(chatId, msg.message_id)

  for (const link of allLinks) {
    const isTikTok = tikLinks.includes(link)
    addQueue(async () => {
      const waitMsg = await bot.sendMessage(chatId, t(userId, "loading"))
      saveMsg(userId, waitMsg.message_id)

      try {
        // Cache
        const cached = cache.get(link)
        if (isCacheValid(cached)) {
          await clearChat(chatId, userId)
          if (cached.type === "video") {
            const s = await bot.sendVideo(chatId, cached.data.file_id, {
              ...cached.data.options,
              reply_markup: videoKeyboard("0")
            })
            saveMsg(userId, s.message_id)
            videoFileIds.set(String(s.message_id), { file_id: cached.data.file_id, chatId, userId: String(userId) })
            await bot.editMessageReplyMarkup(videoKeyboard(s.message_id), { chat_id: chatId, message_id: s.message_id })
            setTimeout(() => videoFileIds.delete(String(s.message_id)), 3_600_000)
          } else if (cached.type === "photo") {
            const s = await bot.sendMediaGroup(chatId, cached.data)
            s.forEach(m => saveMsg(userId, m.message_id))
          }
          const u = users.get(String(userId))
          if (u) { u.downloads++; recordDownload(userId); await maybeShowAd(chatId, userId, u) }
          saveDB()
          return
        }

        if (isTikTok) {
          // ── TikTok ──
          const item = await fetchTikTok(link)

          const author    = item.author?.nickname  || "Unknown"
          const authorTag = item.author?.unique_id ? `@${item.author.unique_id}` : ""
          const views     = formatNumber(item.play_count)
          const likes     = formatNumber(item.digg_count)
          const comments  = formatNumber(item.comment_count)
          const shares    = formatNumber(item.share_count)
          const desc      = item.title ? `\n📝 ${item.title.slice(0, 100)}` : ""
          const caption   = `📥 @${BOT_USERNAME}\n\n👤 ${author} ${authorTag}${desc}\n\n👁 ${views}  ❤️ ${likes}  💬 ${comments}  🔄 ${shares}`

          await clearChat(chatId, userId)

          if (item.images && item.images.length) {
            // Photo slideshow
            const photoUrls = item.images.slice(0, 10)
            const media = photoUrls.map((img, i) => ({
              type: "photo",
              media: typeof img === "object" ? (img.url || img) : img,
              ...(i === 0 ? { caption, parse_mode: "Markdown" } : {})
            }))
            try {
              const sentMedia = await bot.sendMediaGroup(chatId, media)
              sentMedia.forEach(m => saveMsg(userId, m.message_id))
              cache.set(link, { type: "photo", data: media, ts: Date.now() })
            } catch {
              for (let i = 0; i < photoUrls.length; i++) {
                const url = typeof photoUrls[i] === "object" ? photoUrls[i].url : photoUrls[i]
                try {
                  const s = await bot.sendPhoto(chatId, url, { caption: i === 0 ? caption : undefined, parse_mode: "Markdown" })
                  saveMsg(userId, s.message_id)
                } catch {}
              }
            }
          } else {
            // Video
            const videoUrl = item.hdplay || item.play
            if (!videoUrl) throw new Error("No video URL")
            const sent = await bot.sendVideo(chatId, videoUrl, {
              caption, parse_mode: "Markdown", supports_streaming: true,
              reply_markup: videoKeyboard(sent?.message_id || "0")
            })
            saveMsg(userId, sent.message_id)
            // Обновляем клавиатуру с реальным message_id
            videoFileIds.set(String(sent.message_id), { file_id: sent.video.file_id, chatId, userId: String(userId) })
            await bot.editMessageReplyMarkup(videoKeyboard(sent.message_id), { chat_id: chatId, message_id: sent.message_id })
            setTimeout(() => videoFileIds.delete(String(sent.message_id)), 3_600_000) // чистим через 1ч
            cache.set(link, { type: "video", data: { file_id: sent.video.file_id, options: { caption, parse_mode: "Markdown" } }, ts: Date.now() })
          }

        } else {
          // ── Instagram ──
          const result = await fetchInstagram(link)
          await clearChat(chatId, userId)

          const caption = `📥 @${BOT_USERNAME}\n\n📸 Instagram`

          if (result.type === "video") {
            const sent = await bot.sendVideo(chatId, result.url, {
              caption, parse_mode: "Markdown", supports_streaming: true,
              reply_markup: videoKeyboard("0")
            })
            saveMsg(userId, sent.message_id)
            videoFileIds.set(String(sent.message_id), { file_id: sent.video.file_id, chatId, userId: String(userId) })
            await bot.editMessageReplyMarkup(videoKeyboard(sent.message_id), { chat_id: chatId, message_id: sent.message_id })
            setTimeout(() => videoFileIds.delete(String(sent.message_id)), 3_600_000)
            cache.set(link, { type: "video", data: { file_id: sent.video.file_id, options: { caption, parse_mode: "Markdown" } }, ts: Date.now() })
          } else if (result.type === "photo") {
            const sent = await bot.sendPhoto(chatId, result.url, { caption, parse_mode: "Markdown", reply_markup: videoKeyboard })
            saveMsg(userId, sent.message_id)
          }
        }

        // Track
        const u = users.get(String(userId))
        if (u) {
          u.downloads++
          if (!u.history) u.history = []
          u.history.push({ url: link, type: isTikTok ? "tiktok" : "instagram", ts: Date.now() })
          if (u.history.length > 50) u.history = u.history.slice(-50)
          recordDownload(userId)
          await maybeShowAd(chatId, userId, u)
        }

        // Notify admin every 100 downloads
        const totalDl = [...users.values()].reduce((s, u) => s + u.downloads, 0)
        if (totalDl % 100 === 0) {
          notifyAdmin(`🎉 Достигнуто *${totalDl}* загрузок!`)
        }

        saveDB()

      } catch (e) {
        console.error("Download error:", e.message)
        await clearChat(chatId, userId)
        const err = await bot.sendMessage(chatId, t(userId, "error"))
        saveMsg(userId, err.message_id)
        setTimeout(() => safeDelete(chatId, err.message_id), 15_000)
      }
    })
  }
})

// ══════════════════════════════════════════════════════════════════════════════
//  ERROR HANDLING
// ══════════════════════════════════════════════════════════════════════════════
process.on("unhandledRejection", err => console.error("Unhandled:", err))
process.on("uncaughtException",  err => console.error("Exception:", err))
bot.on("polling_error", err => console.error("Polling:", err.message))

// Final save on exit
process.on("SIGINT",  () => { saveDB(); process.exit(0) })
process.on("SIGTERM", () => { saveDB(); process.exit(0) })
