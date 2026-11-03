import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, type Db } from 'mongodb'

export interface TestMongo {
  uri: string
  client: MongoClient
  db: (name?: string) => Db
  stop: () => Promise<void>
}

let counter = 0

/** In-memory MongoDB (binary version pinned in package.json config.mongodbMemoryServer). */
export async function startMongo(): Promise<TestMongo> {
  const server = await MongoMemoryServer.create()
  const uri = server.getUri()
  const client = await MongoClient.connect(uri, { retryWrites: false })
  return {
    uri,
    client,
    db: (name) => client.db(name ?? `cs_test_${process.pid}_${++counter}`),
    stop: async () => {
      await client.close()
      await server.stop()
    },
  }
}

export const VALID_SHA = '0123456789abcdef0123456789abcdef01234567'

export function baseEnv(uri = 'mongodb://127.0.0.1:27017'): Record<string, string> {
  return { GIT_SHA: VALID_SHA, MONGODB_URI: uri, MONGODB_DB: 'chorescout', NODE_ENV: 'test', LOG_LEVEL: 'silent' }
}
