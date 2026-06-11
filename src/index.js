import { RingApi } from 'ring-client-api'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import TelegramBot from 'node-telegram-bot-api'
import * as dotenv from 'dotenv'

dotenv.config()

const ring   = new RingApi({ refreshToken: process.env.RING_REFRESH_TOKEN })
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const sb     = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
const tg     = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: false })
const CHAT   = process.env.TELEGRAM_CHAT_ID

// ─── Classifier ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are analyzing a doorbell camera snapshot.
Return ONLY valid JSON, no markdown:
{
  "category": "mailman" | "delivery_driver" | "garbageman" | "neighbor" | "pedestrian" | "vehicle_only" | "animal" | "empty" | "unknown",
  "confidence": 0.0-1.0,
  "carrier": "USPS" | "FedEx" | "UPS" | "Amazon" | "DHL" | null,
  "details": "one sentence"
}
Rules: mailman = USPS only (blue/grey uniform, satchel, mail truck). delivery_driver = all other carriers. confidence < 0.4 → unknown. dark/empty frame → empty.`

async function classify(imageBuffer) {
  const res = await claude.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 200,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: imageBuffer.toString('base64')
          }
        },
        { type: 'text', text: 'Classify.' }
      ]
    }]
  })
  return JSON.parse(res.content[0].text.trim())
}

// ─── Pattern analysis ─────────────────────────────────────────────────────────

async function getMailmanPattern() {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { data } = await sb
    .from('doorbell_events')
    .select('detected_at')
    .eq('category', 'mailman')
    .gte('detected_at', since)

  if (!data || data.length < 3) return null

  const mins = data.map(r => {
    const d = new Date(r.detected_at)
    return d.getHours() * 60 + d.getMinutes()
  })

  const fmt = m => {
    const h = Math.floor(m / 60), min = m % 60
    return `${h > 12 ? h - 12 : h || 12}:${String(min).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
  }

  const avg = Math.round(mins.reduce((a, b) => a + b, 0) / mins.length)
  const mn  = Math.min(...mins)
  const mx  = Math.max(...mins)

  return `📬 Mail pattern (last 7d, ${data.length} visits): usually ${fmt(avg)} ± ${Math.round((mx - mn) / 2)} min`
}

// ─── Telegram alert ───────────────────────────────────────────────────────────

const EMOJI = {
  mailman:         '📬',
  delivery_driver: '📦',
  garbageman:      '🗑️',
  neighbor:        '👋',
  pedestrian:      '🚶',
  vehicle_only:    '🚗',
  animal:          '🐾',
  empty:           '👻',
  unknown:         '❓'
}

async function sendAlert(result, cameraName) {
  const em      = EMOJI[result.category] || '❓'
  const carrier = result.carrier ? ` (${result.carrier})` : ''
  const conf    = Math.round(result.confidence * 100)
  let msg = `${em} <b>${result.category.replace('_', ' ')}${carrier}</b> — ${cameraName}\n`
  msg    += `<i>${result.details}</i>\n`
  msg    += `Confidence: ${conf}%`

  if (result.category === 'mailman') {
    const pattern = await getMailmanPattern()
    if (pattern) msg += `\n${pattern}`
  }

  await tg.sendMessage(CHAT, msg, { parse_mode: 'HTML' })
}

// ─── Store event ──────────────────────────────────────────────────────────────

async function storeEvent(result, cameraName) {
  await sb.from('doorbell_events').insert({
    category:    result.category,
    confidence:  result.confidence,
    carrier:     result.carrier,
    details:     result.details,
    camera_name: cameraName
  })
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main() {
  console.log('🔔 Ring AI Monitor starting...')

  const cameras = await ring.getCameras()
  console.log(`Found ${cameras.length} camera(s): ${cameras.map(c => c.name).join(', ')}`)

  for (const cam of cameras) {
    cam.onMotionDetected.subscribe(async () => {
      try {
        console.log(`Motion: ${cam.name}`)
        const snapshot = await cam.getSnapshot()
        if (!snapshot) return

        const result = await classify(snapshot)
        console.log(`Classified: ${result.category} (${Math.round(result.confidence * 100)}%)`)

        // Skip noise
        if (result.category === 'empty') return

        await Promise.all([
          storeEvent(result, cam.name),
          sendAlert(result, cam.name)
        ])
      } catch (err) {
        console.error('Error processing motion event:', err.message)
      }
    })

    cam.onDoorbellPressed.subscribe(async () => {
      try {
        console.log(`Doorbell: ${cam.name}`)
        const snapshot = await cam.getSnapshot()
        if (!snapshot) return

        const result = await classify(snapshot)
        const em = EMOJI[result.category] || '❓'
        const carrier = result.carrier ? ` (${result.carrier})` : ''

        let msg = `🔔 <b>DOORBELL</b> — ${cam.name}\n`
        msg    += `${em} ${result.category.replace('_', ' ')}${carrier}\n`
        msg    += `<i>${result.details}</i>`

        await Promise.all([
          storeEvent(result, cam.name),
          tg.sendMessage(CHAT, msg, { parse_mode: 'HTML' })
        ])
      } catch (err) {
        console.error('Error processing doorbell event:', err.message)
      }
    })
  }

  console.log('✅ Watching for events...')
}

main().catch(console.error)
