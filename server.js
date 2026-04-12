import TelegramBot from "node-telegram-bot-api"
import axios from "axios"
import express from "express"
import dotenv from "dotenv"

dotenv.config()

const TOKEN = process.env.TOKEN
const PORT = process.env.PORT || 3000
const BOT_USERNAME = "AZASAVED_bot"
const ADMIN_ID = 5331869155
const CHANNEL = "https://t.me/AZATECHNOLOGY_FREE"

if (!TOKEN) {
  console.log("TOKEN missing")
  process.exit(1)
}

// express
const app = express()
app.get("/", (req, res) => res.send("Bot running"))
app.listen(PORT)

// bot
const bot = new TelegramBot(TOKEN, { polling: true })
console.log("Bot started")

// база пользователей
const users = new Set()

// админ режим
let adminBroadcast = false

// кэш
const cache = new Map()

// антиспам
const cooldown = new Map()
function antiSpam(id) {
  const now = Date.now()
  if (cooldown.has(id)) {
    if (now - cooldown.get(id) < 1500) return true
  }
  cooldown.set(id, now)
  return false
}

// антибан очередь
function sleep(ms) {
  return new Promise(res => setTimeout(res, ms))
}

const queue = []
let working = false

function addQueue(task) {
  queue.push(task)
  runQueue()
}

async function runQueue() {
  if (working) return
  working = true

  while (queue.length) {
    const job = queue.shift()
    try {
      await job()
      await sleep(1200)
    } catch (e) {
      console.log(e)
    }
  }

  working = false
}

// 🚀 START
bot.onText(/\/start/, async msg => {
  const chatId = msg.chat.id
  const userId = msg.from.id

  users.add(userId)

  // удаляем /start
  try {
    await bot.deleteMessage(chatId, msg.message_id)
  } catch {}

  const sent = await bot.sendMessage(chatId,
`👋 Добро пожаловать!

🎬 Я скачиваю TikTok видео без водяного знака.

📌 Как пользоваться:
1. Скинь ссылку на видео
2. Я скачаю быстро ⚡
3. Получишь видео или фото

👇 Просто отправь ссылку`,
  {
    reply_markup: {
      inline_keyboard: [
        [{ text: "💖 Поддержка создателя", callback_data: "donate" }],
        [{ text: "📢 Основной канал", url: CHANNEL }],
        userId === ADMIN_ID
          ? [{ text: "⚙️ Админ панель", callback_data: "admin" }]
          : []
      ]
    }
  })

  // убираем старые закрепы
  try {
    await bot.unpinAllChatMessages(chatId)
  } catch {}

  // закрепляем
  try {
    await bot.pinChatMessage(chatId, sent.message_id)
  } catch {}
})

// кнопки
bot.on("callback_query", async q => {
  const chatId = q.message.chat.id
  const userId = q.from.id
  const data = q.data

  if (data === "donate") {
    bot.sendMessage(chatId, "💖 Поддержка: @AZAkzn1")
  }

  if (data === "admin" && userId === ADMIN_ID) {
    bot.sendMessage(chatId,
`⚙️ Админ панель

👤 Пользователей: ${users.size}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "📢 Рассылка", callback_data: "broadcast" }],
            [{ text: "📊 Статистика", callback_data: "stats" }]
          ]
        }
      })
  }

  if (data === "stats" && userId === ADMIN_ID) {
    bot.sendMessage(chatId, `📊 Всего пользователей: ${users.size}`)
  }

  if (data === "broadcast" && userId === ADMIN_ID) {
    bot.sendMessage(chatId, "✉️ Напиши сообщение для всех")
    adminBroadcast = true
  }
})

// сообщения
bot.on("message", async msg => {
  const chatId = msg.chat.id
  const userId = msg.from.id

  if (!msg.text) return

  users.add(userId)

  // 📢 РАССЫЛКА
  if (adminBroadcast && userId === ADMIN_ID) {
    adminBroadcast = false

    bot.sendMessage(chatId, "🚀 Рассылка началась")

    for (const id of users) {
      try {
        await bot.sendMessage(id, msg.text)
        await sleep(50)
      } catch {}
    }

    bot.sendMessage(chatId, "✅ Готово")
    return
  }

  const links = msg.text.match(/https?:\/\/[^\s]*tiktok\.com\/[^\s]+/g)
  if (!links) return

  if (antiSpam(userId)) return

  for (const link of links) {

    addQueue(async () => {

      // 🎬 GIF загрузки
      const waitMsg = await bot.sendAnimation(
        chatId,
        "https://media.giphy.com/media/3oEjI6SIIHBdRxXI40/giphy.gif",
        { caption: "⏳ Загружаю..." }
      )

      try {

        // ⚡ КЭШ
        if (cache.has(link)) {
          const cached = cache.get(link)

          await bot.deleteMessage(chatId, waitMsg.message_id)
          await bot.deleteMessage(chatId, msg.message_id)

          if (cached.type === "video") {
            return bot.sendVideo(chatId, cached.data.file_id, cached.data.options)
          }

          if (cached.type === "photo") {
            return bot.sendMediaGroup(chatId, cached.data)
          }
        }

        const api = `https://www.tikwm.com/api/?url=${encodeURIComponent(link)}`
        const { data } = await axios.get(api)

        const item = data.data

        const views = item.play_count
        const likes = item.digg_count
        const author = item.author.nickname

        await bot.deleteMessage(chatId, waitMsg.message_id)
        await bot.deleteMessage(chatId, msg.message_id)

        // 🖼 ФОТО
        if (item.images && item.images.length) {

          const media = item.images.map((img, i) => ({
            type: "photo",
            media: img,
            caption: i === 0 ?
`📥 @${BOT_USERNAME}

👤 ${author}
👁 ${views}
❤️ ${likes}` : undefined
          }))

          await bot.sendMediaGroup(chatId, media)

          cache.set(link, {
            type: "photo",
            data: media
          })

          return
        }

        // 🎬 ВИДЕО
        const video = item.hdplay || item.play

        const sent = await bot.sendVideo(chatId, video, {
          caption:
`📥 @${BOT_USERNAME}

👤 ${author}
👁 ${views}
❤️ ${likes}`,

          reply_markup: {
            inline_keyboard: [
              [{ text: "💖 Поддержка", callback_data: "donate" }],
              [{ text: "📢 Канал", url: CHANNEL }]
            ]
          }
        })

        cache.set(link, {
          type: "video",
          data: {
            file_id: sent.video.file_id,
            options: {
              caption: sent.caption,
              reply_markup: sent.reply_markup
            }
          }
        })

      } catch (e) {
        await bot.deleteMessage(chatId, waitMsg.message_id)
        bot.sendMessage(chatId, "❌ Ошибка загрузки")
      }

    })
  }
})

process.on("unhandledRejection", console.error)
process.on("uncaughtException", console.error)
