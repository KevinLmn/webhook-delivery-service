import Fastify from 'fastify'

export async function buildApp() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } })
  app.get('/health', () => ({ ok: true }))
  return app
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await buildApp()
  await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) })
}
