'use strict'

const Scheduler = require('qos_scheduler')
const Performance = require('qos_performance')
const Process = require('qos_process')

global.BUCKET_EMERGENCY = 1000
global.BUCKET_FLOOR = 2000
global.BUCKET_CEILING = 9500
const CPU_BUFFER = 130
const CPU_MINIMUM = 0.50
const CPU_ADJUST = 0.05
const CPU_GLOBAL_BOOST = 60
const MINIMUM_PROGRAMS = 0.3
const PROGRAM_NORMALIZING_BURST = 2
const GLOBAL_LAST_RESET = Game.time

class QosKernel {
  constructor () {
    global.kernel = this

    if (!Memory.qos) {
      Memory.qos = {}
    }
    this.newglobal = GLOBAL_LAST_RESET === Game.time
    this.simulation = !!Game.rooms['sim']
    this.scheduler = new Scheduler()
    this.performance = new Performance()
    this.process = Process
  }

  start () {
    // Announce new uploads
    Logger.log(`Initializing Kernel for tick ${Game.time}`, LOG_TRACE, 'kernel')
    if (!Memory.qos.script_version || Memory.qos.script_version !== SCRIPT_VERSION) {
      Logger.log(`New script upload detected: ${SCRIPT_VERSION}`, LOG_WARN)
      Memory.qos.script_version = SCRIPT_VERSION
      Memory.qos.script_upload = Game.time
    }

    sos.lib.segments.moveToGlobalCache()
    sos.lib.stormtracker.track()

    if (Game.time % 7 === 0) {
      this.cleanMemory()
    }

    this.scheduler.shift()

    if (this.scheduler.getProcessCount() <= 0) {
      this.scheduler.launchProcess('player')
    }
  }

  cleanMemory () {
    Logger.log('Cleaning memory', LOG_TRACE, 'kernel')
    let i
    for (i in Memory.creeps) { // jshint ignore:line
      if (!Game.creeps[i]) {
        delete Memory.creeps[i]
      }
    }

    sos.lib.cache.clean()
    qlib.notify.clean()
  }

  run () {
    while (this.shouldContinue()) {
      const runningProcess = this.scheduler.getNextProcess()
      if (!runningProcess) {
        return
      }
      Logger.defaultLogGroup = runningProcess.name
      try {
        let processName = runningProcess.name
        const descriptor = runningProcess.getDescriptor()
        if (descriptor) {
          processName += ' ' + descriptor
        }

        Logger.log(`Running ${processName} (pid ${runningProcess.pid})`, LOG_TRACE, 'kernel')
        const startCpu = Game.cpu.getUsed()
        runningProcess.run()
        let performanceName = runningProcess.name
        const performanceDescriptor = runningProcess.getPerformanceDescriptor()
        if (performanceDescriptor) {
          performanceName += ' ' + performanceDescriptor
        }
        this.performance.addProgramStats(performanceName, Game.cpu.getUsed() - startCpu)
      } catch (err) {
        let message = 'program error occurred\n'
        message += `process ${runningProcess.pid}: ${runningProcess.name}\n`
        message += !!err && !!err.stack ? err.stack : err.toString()
        Logger.log(message, LOG_ERROR)
      }
      Logger.defaultLogGroup = 'default'
    }
  }

  sigmoid (x) {
    return 1.0 / (1.0 + Math.exp(-x))
  }

  sigmoidSkewed (x) {
    return this.sigmoid((x * 12.0) - 6.0)
  }

  shouldContinue () {
    if (this.simulation) {
      return true
    }

    // Make sure to stop if cpuUsed has hit the maximum allowed cpu.
    const cpuUsed = Game.cpu.getUsed()
    if (cpuUsed >= Game.cpu.tickLimit - CPU_BUFFER) {
      return false
    }

    // Allow if the cpu used is less than this tick's limit.
    const cpuLimit = this.getCpuLimit()
    if (cpuUsed < cpuLimit) {
      return true
    }

    // Ensure that a minumum number of processes runs each tick.
    // This is primarily useful for garbage collection cycles.
    if (Game.cpu.bucket > BUCKET_FLOOR) {
      const total = this.scheduler.getProcessCount()
      const completed = this.scheduler.getCompletedProcessCount()
      if (completed / total < MINIMUM_PROGRAMS) {
        if (cpuUsed < cpuLimit * PROGRAM_NORMALIZING_BURST) {
          return true
        }
      }
    }

    return false
  }

  getCpuLimit () {
    if (Game.cpu.bucket > BUCKET_CEILING) {
      return Game.cpu.tickLimit - CPU_BUFFER
    }

    if (Game.cpu.bucket < BUCKET_EMERGENCY) {
      return 0
    }

    if (Game.cpu.bucket < BUCKET_FLOOR) {
      return Game.cpu.limit * CPU_MINIMUM
    }

    if (!this._cpuLimit) {
      const bucketRange = BUCKET_CEILING - BUCKET_FLOOR
      const depthInRange = (Game.cpu.bucket - BUCKET_FLOOR) / bucketRange
      const minToAllocate = Game.cpu.limit * CPU_MINIMUM
      const maxToAllocate = Game.cpu.limit
      this._cpuLimit = (minToAllocate + this.sigmoidSkewed(depthInRange) * (maxToAllocate - minToAllocate)) * (1 - CPU_ADJUST)
      if (this.newglobal) {
        this._cpuLimit += CPU_GLOBAL_BOOST
      }
    }

    return this._cpuLimit
  }

  shutdown () {
    sos.lib.vram.saveDirty()
    sos.lib.segments.process()

    const processCount = this.scheduler.getProcessCount()
    const completedCount = this.scheduler.memory.processes.completed.length

    Logger.log(`Processes Run: ${completedCount}/${processCount}`, LOG_INFO, 'kernel')
    Logger.log(`Tick Limit: ${Game.cpu.tickLimit}`, LOG_INFO, 'kernel')
    Logger.log(`Kernel Limit: ${this.getCpuLimit()}`, LOG_INFO, 'kernel')
    Logger.log(`CPU Used: ${Game.cpu.getUsed()}`, LOG_INFO, 'kernel')
    Logger.log(`Bucket: ${Game.cpu.bucket}`, LOG_INFO, 'kernel')

    if (Game.time % 50 === 0) {
      this.performance.reportHtml()
    }
    if (Game.time % 3000 === 0) {
      this.performance.clear()
    }
  }
}

module.exports = QosKernel
