import express from 'express'
import register from './routes/register.js'
import certs from './routes/certs.js'
import status from './routes/status.js'
import updateIp from './routes/ip.js'
import { oauthRegister } from './routes/oauth.js'
import renewCertsJob from './routes/renew-certs-job.js'

const app = express()
const port = process.env.PORT || 3000

app.use(express.json())

// Request logging
app.use((req, res, next) => {
  if (req.method !== 'GET') {
    console.log(`${req.method} ${req.path}`, JSON.stringify(req.body))
  }
  next()
})

app.get('/api/health', (req, res) => {
  res.json({ ok: true })
})

app.post('/api/register', register)
app.get('/api/certs', certs)
app.get('/api/status', status)
app.post('/api/ip', updateIp)
app.post('/api/oauth/register', oauthRegister)
app.post('/api/jobs/renew-certs', renewCertsJob)

app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).json({ error: 'Internal server error' })
})

app.listen(port, () => {
  console.log(`jump.sh API listening on port ${port}`)
})
