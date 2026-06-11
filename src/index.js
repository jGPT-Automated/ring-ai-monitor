import { RingApi } from 'ring-client-api'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import TelegramBot from 'node-telegram-bot-api'
import * as dotenv from 'dotenv'

dotenv.config()

const ring    = new RingApi({ refreshToken: process.env.RING_REFRESH_TOKEN })
const claude  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const sb      = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
const tg      = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: false })
const CHAT_ID = process.env.TELEGRAM_CHAT_ID

// ─── Classifier ──────────────────────────────────────────────────────────────

const CLASSIFY_PROMPT = `You are analyzing a doorbell camera snapshot.
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
    system: CLASSIFY_PROMPT,
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

// ─── Mailman pattern ──────────────────────────────────────────────────────────

function fmt(m) {
  const h = Math.floor(m / 60), min = m % 60
  return `${h > 12 ? h - 12 : h || 12}:${String(min).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
}

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

  const avg = Math.round(mins.reduce((a, b) => a + b) / mins.length)
  return {
    avg:    fmt(avg),
    window: `${fmt(Math.min(...mins))} – ${fmt(Math.max(...mins))}`,
    n:      data.length
  }
}

// ─── Telegram alert ───────────────────────────────────────────────────────────

const ICONS = {
  mailman:         '📬',
  delivery_driver: '📦',
  garbageman:      '🗑️',
  neighbor:        '🚶',
  pedestrian:      '🚶',
  vehicle_only:    '🚗',
  animal:          '🐾',
  unknown:         '❓'
}

async function alert(classification, cameraName, pattern) {
  const { category, confidence, carrier, details } = classification
  const icon = ICONS[category]
  if (!icon) return

  let msg = `${icon} *${category.replace('_', ' ').toUpperCase()}*\n`
  msg    += `📷 ${cameraName} · ${Math.round(confidence * 100)}% confidence\n`
  if (carrier) msg += `🏢 ${carrier}\n`
  msg    += `\n_${details}_`

  if (category === 'mailman' && pattern) {
    msg += `\n\n📊 *Your mailman pattern (7-day)*`
    msg += `\nUsually arrives: ~${pattern.avg}`
    msg += `\nWindow: ${pattern.window}`
    msg += `\nBased on ${pattern.n} observations`
  } else if (category === 'mailman' && !pattern) {
    msg += `\n\n_First mailman observation — pattern builds after 3+_`
  }

  await tg.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' })
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🔔 Ring AI Monitor starting...')
  const locations = await ring.getLocations()

  for (const location of locations) {
    for (const camera of location.cameras) {
      console.log(`👁️  Watching: ${camera.name}`)

      camera.onNewNotification.subscribe(async ({ action }) => {
        if (action !== 'motion') return

        try {
          const snapshot = await camera.getSnapshot()
          const result   = await classify(snapshot)
          console.log(`[${camera.name}] ${result.category} (${Math.round(result.confidence * 100)}%) — ${result.details}`)

          // Skip noise
          if (result.category === 'empty' || result.confidence < 0.35) return

          await sb.from('doorbell_events').insert({
            category:    result.category,
            confidence:  result.confidence,
            carrier:     result.carrier || null,
            details:     result.details,
            camera_name: camera.name,
            detected_at: new Date().toISOString()
          })

          const pattern = result.category === 'mailman' ? await getMailmanPattern() : null
          await alert(result, camera.name, pattern)

        } catch (err) {
          console.error(`Motion processing error: ${err.message}`)
        }
      })
    }
  }

  console.log('✅ Listening...')
  await new Promise(() => {}) // keep alive
}

main().catch(console.error)
