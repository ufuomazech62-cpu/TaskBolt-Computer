// Wrapper to start Vite without TTY requirement
process.env.FORCE_COLOR = '1'
const { createServer } = require('vite')

async function main() {
  const server = await createServer({
    server: {
      port: 1420,
      host: '127.0.0.1',
    },
    clearScreen: false,
  })
  await server.listen()
  server.printUrls()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
