import http from 'node:http'

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('e2e-fixture-ok')
})

server.listen(3000, () => {
  console.log('e2e fixture listening on :3000')
})
