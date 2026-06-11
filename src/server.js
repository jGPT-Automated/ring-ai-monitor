/**
 * ring-monitor — Express dashboard server
 * Serves the GUI at :3000 and exposes /api/* for live data
 */

import express from 'express'
import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

dotenv.config()

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const sb  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
const PORT = process.env.PORT || 3000

app.use(express.static(join(__dirname, '../public')))

// ─── API ──────────────────────────────────────────────────────────────────────

// Recent events
app.get('/api/events', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50
  const { data, error } = await sb
    .from('doorbell_events')
    .select('*')
    .order('detected_at', { ascending: false })
    .limit(limit)

  if (error) return res.status(500).json({ error })
  res.json(data)
})

// Category breakdown (last 7 days)
app.get('/api/stats', async (req, res) => {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await sb
    .from('doorbell_events')
    .select('category, carrier, confidence, detected_at')
    .gte('detected_at', since)

  if (error) return res.status(500).json({ error })

  const counts = {}
  const carriers = {}
  const hourly = Array(24).fill(0)

  for (const row of data) {
    counts[row.category] = (counts[row.category] || 0) + 1
    if (row.carrier) carriers[row.carrier] = (carriers[row.carrier] || 0) + 1
    const h = new Date(row.detected_at).getHours()
    hourly[h]++
  }

  res.json({ total: data.length, counts, carriers, hourly, since })
})

// Mailman pattern
app.get('/api/mailman', async (req, res) => {
  const { data } = await sb
    .from('doorbell_events')
    .select('detected_at')
    .eq('category', 'mailman')
    .gte('detected_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
    .order('detected_at', { ascending: false })

  if (!data || data.length === 0) return res.json({ visits: 0 })

  const mins = data.map(r => {
    const d = new Date(r.detected_at)
    return d.getHours() * 60 + d.getMinutes()
  })

  const avg = Math.round(mins.reduce((a, b) => a + b, 0) / mins.length)
  const mn  = Math.min(...mins)
  const mx  = Math.max(...mins)
  const fmt = m => {
    const h = Math.floor(m / 60), min = m % 60
    return `${h > 12 ? h - 12 : h || 12}:${String(min).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
  }

  res.json({
    visits: data.length,
    avg_time: fmt(avg),
    earliest: fmt(mn),
    latest: fmt(mx),
    spread_min: mx - mn
  })
})

app.listen(PORT, () => {
  console.log(`📺 Dashboard: http://localhost:${PORT}`)
})
