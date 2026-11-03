/**
 * Database client (CS-3941). DocumentDB 5.0-compatible MongoDB driver usage.
 *
 * - Pool settings are passed explicitly from config.
 * - retryWrites is false: DocumentDB does not support retryable writes.
 * - No collation, change streams, transactions or $jsonSchema validators are used
 *   by the scaffold, keeping to what DocumentDB 5.0 supports.
 */
import { MongoClient, type MongoClientOptions } from 'mongodb'
import type { BaseConfig } from './config.js'

export function mongoClientOptions(config: BaseConfig): MongoClientOptions {
  const options: MongoClientOptions = {
    appName: 'chore-scout-server',
    maxPoolSize: config.MONGO_MAX_POOL_SIZE,
    minPoolSize: config.MONGO_MIN_POOL_SIZE,
    maxIdleTimeMS: config.MONGO_MAX_IDLE_TIME_MS,
    waitQueueTimeoutMS: config.MONGO_WAIT_QUEUE_TIMEOUT_MS,
    serverSelectionTimeoutMS: config.MONGO_SERVER_SELECTION_TIMEOUT_MS,
    connectTimeoutMS: config.MONGO_CONNECT_TIMEOUT_MS,
    socketTimeoutMS: config.MONGO_SOCKET_TIMEOUT_MS,
    retryWrites: false,
  }
  if (config.MONGODB_TLS_CA_FILE) {
    options.tls = true
    options.tlsCAFile = config.MONGODB_TLS_CA_FILE
  }
  return options
}

export async function connectMongo(config: BaseConfig): Promise<MongoClient> {
  const client = new MongoClient(config.MONGODB_URI, mongoClientOptions(config))
  await client.connect()
  return client
}
