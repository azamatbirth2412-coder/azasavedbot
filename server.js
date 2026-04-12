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

// 🔐 PRO SECURITY
const EXPECTED_BOT = "AZASAVED_bot"
const REAL_ADMIN = 5331869155
const SECRET_KEY = "aza_secure_2026"

async function protectBot(bot){
  try{
    const me = await bot.getMe()
    if(me.username !== EXPECTED_BOT){
      console.log("❌ cloned bot blocked")
      process.exit(1)
    }
  }catch{
    process.exit(1)
  }
}

function protectAdmin(){
  if(ADMIN_ID !== REAL_ADMIN){
    console.log("❌ fake admin")
    process.exit(1)
  }
}

function hiddenCheck(){
  if(SECRET_KEY !== "aza_secure_2026"){
    process.exit(1)
  }
}

function watchdog(users){
  setInterval(()=>{
    if(!users.has(REAL_ADMIN)){
      console.log("❌ admin missing")
      process.exit(1)
    }
  }, 60000)
}

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

// запуск защиты
;(async ()=>{
  await protectBot(bot)
  protectAdmin()
  hiddenCheck()
})()

// база
const users = new Set()
watchdog(users)

// кэш
const cache = new Map()

// админ
let adminBroadcast = false

// антиспам
const cooldown = new Map()

// очистка
const lastMessages = new Map()

function antiSpam(id) {
  const now = Date.now()
  if (cooldown.has(id)) {
    if (now - cooldown.get(id) < 1500) return true
  }
  cooldown.set(id, now)
  return false
}

function sleep(ms){
  return new Promise(res=>setTimeout(res,ms))
}

function formatNumber(num){
  if(num >= 1_000_000) return (num/1_000_000).toFixed(1)+"M"
  if(num >= 1_000) return (num/1_000).toFixed(1)+"K"
  return num
}

// очередь антибан
const queue = []
let working = false

function addQueue(task){
  queue.push(task)
  runQueue()
}

async function runQueue(){
  if(working) return
  working = true

  while(queue.length){
    const job = queue.shift()
    try{
      await job()
      await sleep(1200)
    }catch{}
  }

  working = false
}

// очистка чата
async function clearChat(chatId,userId){
  if(!lastMessages.has(userId)) return

  const msgs = lastMessages.get(userId)

  for(const m of msgs){
    try{
      await bot.deleteMessage(chatId,m)
    }catch{}
  }

  lastMessages.set(userId,[])
}

function saveMsg(userId,msgId){
  if(!lastMessages.has(userId)){
    lastMessages.set(userId,[])
  }
  lastMessages.get(userId).push(msgId)
}

// 🚀 START
bot.onText(/\/start/, async msg=>{
  const chatId = msg.chat.id
  const userId = msg.from.id

  users.add(userId)

  try{ await bot.deleteMessage(chatId,msg.message_id) }catch{}

  const sent = await bot.sendMessage(chatId,
`👋 Добро пожаловать!

🎬 Я скачиваю TikTok видео без водяного знака.

📌 Как пользоваться:
1. Скинь ссылку на видео
2. Я скачаю быстро ⚡
3. Получишь видео или фото

👇 Просто отправь ссылку`,
  {
    reply_markup:{
      inline_keyboard:[
        [{text:"📢 Основной канал",url:CHANNEL}],
        userId===ADMIN_ID
          ? [{text:"⚙️ Админ панель",callback_data:"admin"}]
          : []
      ]
    }
  })

  saveMsg(userId,sent.message_id)

  setTimeout(()=>{
    bot.deleteMessage(chatId,sent.message_id).catch(()=>{})
  },60000)
})

// кнопки
bot.on("callback_query", async q=>{
  const chatId = q.message.chat.id
  const userId = q.from.id
  const data = q.data

  if(data==="donate"){
    const m = await bot.sendMessage(chatId,"💖 Поддержка: @AZAkzn1")
    saveMsg(userId,m.message_id)
  }

  if(data==="admin" && userId===ADMIN_ID){
    const m = await bot.sendMessage(chatId,
`⚙️ Админ панель

👤 Пользователей: ${users.size}`,
    {
      reply_markup:{
        inline_keyboard:[
          [{text:"📢 Рассылка",callback_data:"broadcast"}],
          [{text:"📊 Статистика",callback_data:"stats"}]
        ]
      }
    })
    saveMsg(userId,m.message_id)
  }

  if(data==="stats" && userId===ADMIN_ID){
    const m = await bot.sendMessage(chatId,`📊 Всего пользователей: ${users.size}`)
    saveMsg(userId,m.message_id)
  }

  if(data==="broadcast" && userId===ADMIN_ID){
    const m = await bot.sendMessage(chatId,"✉️ Напиши сообщение для всех")
    saveMsg(userId,m.message_id)
    adminBroadcast = true
  }
})

// сообщения
bot.on("message", async msg=>{
  const chatId = msg.chat.id
  const userId = msg.from.id

  if(!msg.text) return

  users.add(userId)

  await clearChat(chatId,userId)

  // рассылка
  if(adminBroadcast && userId===ADMIN_ID){
    adminBroadcast = false

    bot.sendMessage(chatId,"🚀 Рассылка началась")

    for(const id of users){
      try{
        await bot.sendMessage(id,msg.text)
        await sleep(50)
      }catch{}
    }

    bot.sendMessage(chatId,"✅ Готово")
    return
  }

  const links = msg.text.match(/https?:\/\/[^\s]*tiktok\.com\/[^\s]+/g)
  if(!links) return

  if(antiSpam(userId)) return

  for(const link of links){

    addQueue(async ()=>{

      const waitMsg = await bot.sendAnimation(
        chatId,
        "https://media.giphy.com/media/3oEjI6SIIHBdRxXI40/giphy.gif",
        {caption:"⏳ Загружаю..."}
      )

      saveMsg(userId,waitMsg.message_id)

      try{

        // кэш
        if(cache.has(link)){
          const cached = cache.get(link)

          await clearChat(chatId,userId)

          if(cached.type==="video"){
            const sent = await bot.sendVideo(chatId,cached.data.file_id,cached.data.options)
            saveMsg(userId,sent.message_id)
            return
          }

          if(cached.type==="photo"){
            const sentMedia = await bot.sendMediaGroup(chatId,cached.data)
            sentMedia.forEach(m=>saveMsg(userId,m.message_id))
            return
          }
        }

        const api = `https://www.tikwm.com/api/?url=${encodeURIComponent(link)}`
        const {data} = await axios.get(api)

        const item = data.data

        const views = formatNumber(item.play_count)
        const likes = formatNumber(item.digg_count)
        const author = item.author.nickname

        await clearChat(chatId,userId)

        // фото
        if(item.images && item.images.length){

          const media = item.images.map((img,i)=>({
            type:"photo",
            media:img,
            caption:i===0?
`📥 @${BOT_USERNAME}

👤 ${author}
👁 ${views}
❤️ ${likes}`:undefined
          }))

          const sentMedia = await bot.sendMediaGroup(chatId,media)
          sentMedia.forEach(m=>saveMsg(userId,m.message_id))

          cache.set(link,{type:"photo",data:media})
          return
        }

        // видео
        const video = item.hdplay || item.play

        const sent = await bot.sendVideo(chatId,video,{
          caption:
`📥 @${BOT_USERNAME}

👤 ${author}
👁 ${views}
❤️ ${likes}`,
          reply_markup:{
            inline_keyboard:[
              [{text:"💖 Поддержка",callback_data:"donate"}],
              [{text:"📢 Канал",url:CHANNEL}]
            ]
          }
        })

        saveMsg(userId,sent.message_id)

        cache.set(link,{
          type:"video",
          data:{
            file_id:sent.video.file_id,
            options:{
              caption:sent.caption,
              reply_markup:sent.reply_markup
            }
          }
        })

      }catch(e){
        await clearChat(chatId,userId)
        const err = await bot.sendMessage(chatId,"❌ Ошибка загрузки")
        saveMsg(userId,err.message_id)
      }

    })
  }
})

process.on("unhandledRejection",console.error)
process.on("uncaughtException",console.error)
