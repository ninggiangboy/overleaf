import Queue from 'bull'
import logger from '@overleaf/logger'
import config from 'config'
import metrics from '@overleaf/metrics'
import {
  backupProject,
  initializeProjects,
  configureBackup,
} from './backup.mjs'

const CONCURRENCY = 15
const redisOptions = config.get('redis.queue')
const TIME_BUCKETS = [10, 100, 500, 1000, 5000, 10000, 30000, 60000]

// Configure backup settings to match worker concurrency
configureBackup({ concurrency: 50, useSecondary: true })

// Create a Bull queue named 'backup'
const backupQueue = new Queue('backup', {
  redis: redisOptions,
  settings: {
    lockDuration: 15 * 60 * 1000, // 15 minutes
    lockRenewTime: 60 * 1000, // 1 minute
    maxStalledCount: 0, // mark stalled jobs as failed
  },
})

// Log queue events
backupQueue.on('active', job => {
  logger.info({ job }, 'job  is now active')
})

backupQueue.on('completed', (job, result) => {
  metrics.inc('backup_worker_job', 1, { status: 'completed' })
  logger.info({ job, result }, 'job completed')
})

backupQueue.on('failed', (job, err) => {
  metrics.inc('backup_worker_job', 1, { status: 'failed' })
  logger.error({ job, err }, 'job failed')
})

backupQueue.on('waiting', jobId => {
  logger.info({ jobId }, 'job is waiting')
})

backupQueue.on('error', error => {
  logger.error({ error }, 'queue error')
})

backupQueue.on('stalled', job => {
  logger.error({ job }, 'job has stalled')
})

backupQueue.on('lock-extension-failed', (job, err) => {
  logger.error({ job, err }, 'lock extension failed')
})

backupQueue.on('paused', () => {
  logger.info('queue paused')
})

backupQueue.on('resumed', () => {
  logger.info('queue resumed')
})

// Process jobs
backupQueue.process(CONCURRENCY, async job => {
  const { projectId, startDate, endDate } = job.data

  if (projectId) {
    return await runBackup(projectId)
  } else if (startDate && endDate) {
    return await runInit(startDate, endDate)
  } else {
    throw new Error('invalid job data')
  }
})

async function runBackup(projectId) {
  const timer = new metrics.Timer(
    'backup_worker_job_duration',
    1,
    {},
    TIME_BUCKETS
  )
  try {
    logger.info({ projectId }, 'processing backup for project')
    const { errors, completed } = await backupProject(projectId, {})
    metrics.inc('backup_worker_project', completed - errors, {
      status: 'success',
    })
    metrics.inc('backup_worker_project', errors, { status: 'failed' })
    timer.done()
    return `backup completed ${projectId} (${errors} failed in ${completed} projects)`
  } catch (err) {
    logger.error({ projectId, err }, 'backup failed')
    throw err // Re-throw to mark job as failed
  }
}

async function runInit(startDate, endDate) {
  try {
    logger.info({ startDate, endDate }, 'initializing projects')
    await initializeProjects({ 'start-date': startDate, 'end-date': endDate })
    return `initialization completed ${startDate} - ${endDate}`
  } catch (err) {
    logger.error({ startDate, endDate, err }, 'initialization failed')
    throw err
  }
}

export async function drainQueue() {
  logger.info({ queue: backupQueue.name }, 'pausing queue')
  await backupQueue.pause(true) // pause this worker and wait for jobs to finish
  logger.info({ queue: backupQueue.name }, 'closing queue')
  await backupQueue.close()
}

export async function healthCheck() {
  const count = await backupQueue.count()
  metrics.gauge('backup_worker_queue_length', count)
}
