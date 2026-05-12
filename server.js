import TelegramBot from "node-telegram-bot-api"
import axios from "axios"
import express from "express"
import dotenv from "dotenv"
import ffmpeg from "fluent-ffmpeg"
import ffmpegPath from "ffmpeg-static"
dotenv.config()

const TOKEN = process.env.TOKEN
const PORT = process.env.PORT || 3000
const BOT_USERNAME = "AZASAVED_bot"
const ADMIN_ID = 5331869155
ffmpeg.setFfmpegPath(ffmpegPath)
if(!TOKEN){
  console.log("TOKEN missing")
  process.exit(1)
}

// express (для Railway)
const app = express()
app.get("/", (req,res)=>res.send("Bot running"))
app.listen(PORT)

// bot
const bot = new TelegramBot(TOKEN,{ polling:true })
console.log("Bot started")

// база
const users = {}

// админ состояние
const adminState = {}

// cache
const cache = new Map()

// очередь
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
    try{ await job() }catch(e){ console.log(e) }
  }

  working = false
}

// антиспам
const cooldown = new Map()

function antiSpam(id){
  const now = Date.now()
  if(cooldown.has(id)){
    if(now - cooldown.get(id) < 1500) return true
  }
  cooldown.set(id,now)
  return false
}

// меню
function menu(chatId,userId){
  const buttons = [
    [{text:"💖 Поддержать",callback_data:"donate"}],
    [{text:"👥 Пригласить",callback_data:"invite"}]
  ]

  if(userId === ADMIN_ID){
    buttons.push([{text:"⚙️ Админ панель",callback_data:"admin"}])
  }

  bot.sendMessage(chatId,"🎬 TikTok Downloader",{
    reply_markup:{inline_keyboard:buttons}
  })
}

// start
bot.onText(/\/start/, msg=>{
  menu(msg.chat.id,msg.from.id)
})

// кнопки
bot.on("callback_query", async q=>{
  const chatId = q.message.chat.id
  const userId = q.from.id
  const data = q.data

  if(data==="invite"){
    bot.sendMessage(chatId,
`👥 Приглашай:
https://t.me/${BOT_USERNAME}?start=${userId}`)
  }

  if(data==="donate"){
    bot.sendMessage(chatId,
`💖 Поддержать создателя

🎁 Отправь подарок:
👉 @AZAkzn1

Спасибо ❤️`)
  }

  // админка
  if(data==="admin" && userId===ADMIN_ID){
    bot.sendMessage(chatId,"⚙️ Админ панель",{
      reply_markup:{
        inline_keyboard:[
          [{text:"📢 Рассылка",callback_data:"admin_broadcast"}]
        ]
      }
    })
  }

  if(data==="admin_broadcast" && userId===ADMIN_ID){
    adminState[userId] = "broadcast"
    bot.sendMessage(chatId,"📢 Отправь сообщение / фото / видео")
  }

  // музыка
  if(data.startsWith("music_")){
    const link = decodeURIComponent(data.replace("music_",""))

    const api = `https://www.tikwm.com/api/?url=${encodeURIComponent(link)}`
    const {data:res} = await axios.get(api)

    await bot.sendAudio(chatId,res.data.music,{title:"TikTok Sound"})
  }
})

// сообщения
bot.on("message", async msg=>{
  const chatId = msg.chat.id
  const userId = msg.from.id

  // игнор не текста (важно для гифтов)
  if(!msg.text) return

  const text = msg.text

  // регистрация
  if(!users[userId]){
    users[userId] = true
  }

  // рассылка
  if(userId===ADMIN_ID && adminState[userId]==="broadcast"){
    adminState[userId] = null

    let sent = 0

    for(const id of Object.keys(users)){
      try{
        if(msg.text){
          await bot.sendMessage(id,msg.text)
        }
        else if(msg.photo){
          const photo = msg.photo[msg.photo.length-1].file_id
          await bot.sendPhoto(id,photo,{caption:msg.caption||""})
        }
        else if(msg.video){
          await bot.sendVideo(id,msg.video.file_id,{caption:msg.caption||""})
        }
        sent++
      }catch{}
    }

    bot.sendMessage(chatId,`✅ Отправлено: ${sent}`)
    return
  }

  // ищем tiktok ссылки
  const links = text.match(/https?:\/\/[^\s]*tiktok\.com\/[^\s]+/g)
  if(!links) return

  // антиспам только тут
  if(antiSpam(userId)) return

  for(const link of links){
    addQueue(async ()=>{
      const userMessageId = msg.message_id

      // 🎬 GIF загрузка
      const loading = await bot.sendAnimation(
        chatId,
        "https://media.giphy.com/media/3oEjI6SIIHBdRxXI40/giphy.gif"
      )

      try{
        // cache
        if(cache.has(link)){
          await bot.deleteMessage(chatId,loading.message_id)
          await bot.deleteMessage(chatId,userMessageId)

          await bot.sendVideo(chatId,cache.get(link),{
            caption:`📥 Скачано через @${BOT_USERNAME}`,
            reply_markup:{
              inline_keyboard:[
                [{text:"💾 Сохранить", url: cache.get(link)}],
                [{text:"🎵 Скачать музыку", callback_data:`music_${encodeURIComponent(link)}`}],
                [{text:"➕ Добавить в группу", url:`https://t.me/${BOT_USERNAME}?startgroup=true`}]
              ]
            }
          })
          return
        }

        const api = `https://www.tikwm.com/api/?url=${encodeURIComponent(link)}`
        const {data} = await axios.get(api)

        const video = data.data.hdplay || data.data.play

        // удаляем гифку и сообщение
        await bot.deleteMessage(chatId,loading.message_id)
        await bot.deleteMessage(chatId,userMessageId)

const sent = await bot.sendVideo(chatId, video,{
  caption:`📥 Скачано через @${BOT_USERNAME}`,
  reply_markup:{
    inline_keyboard:[
      [{text:"💾 Сохранить", url: video}],
      [{text:"🎵 Скачать музыку", callback_data:`music_${encodeURIComponent(link)}`}],
      [{text:"➕ Добавить в группу", url:`https://t.me/${BOT_USERNAME}?startgroup=true`}]
    ]
  }
})

cache.set(link, sent.video.file_id)

      }catch{
        bot.sendMessage(chatId,"❌ Ошибка")
      }
    })
  }
})

process.on("unhandledRejection",console.error)
process.on("uncaughtException",console.error)   
