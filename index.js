var EventEmitter = require('events').EventEmitter
var fifo = require('fifo')
var inherits = require('inherits')
var net = require('net')
var once = require('once')
var peerWireProtocol = require('bittorrent-protocol')

var HANDSHAKE_TIMEOUT = 5000
var RECONNECT_WAIT = [1000, 5000, 15000, 30000, 60000, 120000, 300000, 600000]
var DEFAULT_SIZE = 100

var toAddress = function (wire) {
  if (typeof wire === 'string') return wire
  return wire.remoteAddress
}

var onwire = function(connection, onhandshake) {
  var wire = peerWireProtocol()

  connection.on('end', function() {
    connection.destroy()
  })
  connection.on('error', function() {
    connection.destroy()
  })
  connection.on('close', function() {
    wire.end()
  })

  var destroy = function() {
    connection.destroy()
  }
  var timeout = setTimeout(destroy, HANDSHAKE_TIMEOUT)

  wire.once('handshake', function(infoHash, peerId, extensions) {
    console.log('HANDSHAKE SUCCESS, extensions:')
    console.log(extensions)
    clearTimeout(timeout)
    onhandshake(infoHash, peerId, extensions)
  })

  connection.pipe(wire).pipe(connection)
  return wire
}

var pools = {}

var leave = function(port, swarm) {
  if (!pools[port]) return
  delete pools[port].swarms[swarm.infoHash.toString('hex')]

  if (Object.keys(pools[port].swarms).length) return
  pools[port].server.close()
  delete pools[port]
}

var join = function(port, swarm) {
  var pool = pools[port]

  if (!pool) {
    var swarms = {}
    var server = net.createServer(function(connection) {
      var wire = onwire(connection, function(infoHash, peerId, extensions) {
        console.log(extensions)
        var swarm = swarms[infoHash.toString('hex')]
        if (!swarm) return connection.destroy()
        swarm._onincoming(connection, wire)
      })
    })

    server.listen(port, function() {
      pool.listening = true
      Object.keys(swarms).forEach(function(infoHash) {
        swarms[infoHash].emit('listening')
      })
    })

    pool = pools[port] = {
      server: server,
      swarms: swarms,
      listening: false
    }
  }

  var infoHash = swarm.infoHash.toString('hex')

  if (pool.listening) {
    process.nextTick(function() {
      swarm.emit('listening')
    })
  }
  if (pool.swarms[infoHash]) {
    process.nextTick(function() {
      swarm.emit('error', new Error('port and info hash already in use'))
    })
    return
  }

  pool.swarms[infoHash] = swarm
}

inherits(Swarm, EventEmitter)

function Swarm (infoHash, peerId, options) {
  var self = this
  if (!(self instanceof Swarm)) return new Swarm(infoHash, peerId, options)
  EventEmitter.call(self)

  if (!options) options = {}

  self.port = 0
  self.size = options.size || DEFAULT_SIZE

  self.infoHash = new Buffer(infoHash, 'hex')
  self.peerId = new Buffer(peerId, 'utf8')

  self.downloaded = 0
  self.uploaded = 0
  self.connections = []
  self.wires = []
  self.paused = false

  self._destroyed = false
  self._queues = [fifo()]
  self._peers = {}
}


Swarm.prototype.__defineGetter__('queued', function() {
  return this._queues.reduce(function(prev, queue) {
    return prev + queue.length
  }, 0)
})

Swarm.prototype.pause = function () {
  this.paused = true
}

Swarm.prototype.resume = function () {
  this.paused = false
  this._drain()
}

Swarm.prototype.priority = function(addr, level) {
  addr = toAddress(addr)
  var peer = this._peers[addr]

  if (!peer) return 0
  if (typeof level !== 'number' || peer.priority === level) return level

  if (!this._queues[level]) this._queues[level] = fifo()

  if (peer.node) {
    this._queues[peer.priority].remove(peer.node)
    peer.node = this._queues[level].push(addr)
  }

  peer.priority = level
  return level
}

/**
 * Add a peer to the swarm.
 * @param {string} addr  ip address and port (ex: 12.34.56.78:12345)
 */
Swarm.prototype.add = function (addr) {
  var self = this
  if (self._destroyed || self._peers[addr]) return

  self._peers[addr] = {
    node: self._queues[0].push(addr),
    priority: 0,
    reconnect: false,
    retries: 0,
    timeout: null,
    wire: null
  }

  self._drain()
}

Swarm.prototype.remove = function(addr) {
  this._remove(toAddress(addr))
  this._drain()
}

Swarm.prototype.listen = function(port, onlistening) {
  if (onlistening) this.once('listening', onlistening)
  this.port = port
  join(this.port, this)
}

Swarm.prototype.destroy = function() {
  this._destroyed = true

  var self = this
  Object.keys(this._peers).forEach(function(addr) {
    self._remove(addr)
  })

  leave(this.port, this)
  process.nextTick(function() {
    self.emit('close')
  })
}

Swarm.prototype._remove = function(addr) {
  var peer = this._peers[addr]
  if (!peer) return
  delete this._peers[addr]
  if (peer.node) this._queues[peer.priority].remove(peer.node)
  if (peer.timeout) clearTimeout(peer.timeout)
  if (peer.wire) peer.wire.destroy()
}

Swarm.prototype._drain = function () {
  var self = this
  if (self.connections.length >= self.size || self.paused) return

  var addr = self._shift()
  if (!addr) return

  var peer = self._peers[addr]
  if (!peer) return

  var parts = addr.split(':')
  var connection = net.connect(parts[1], parts[0])
  if (peer.timeout) clearTimeout(peer.timeout)

  peer.node = null
  peer.timeout = null

  var wire = onwire(connection, function(infoHash) {
    if (infoHash.toString('hex') !== self.infoHash.toString('hex')) return connection.destroy()
    peer.reconnect = true
    peer.retries = 0
    self._onwire(connection, wire)
  })

  var repush = function() {
    peer.node = self._queues[peer.priority].push(addr)
    self._drain()
  }

  wire.on('end', function() {
    peer.wire = null
    if (!peer.reconnect || self._destroyed || peer.retries >= RECONNECT_WAIT.length) return self._remove(addr)
    peer.timeout = setTimeout(repush, RECONNECT_WAIT[peer.retries++])
  })

  peer.wire = wire
  self._onconnection(connection)

  wire.remoteAddress = addr
  wire.handshake(self.infoHash, self.peerId)
}

/**
 * Return a peer from the queues. Prefer higher priority peers, followed by
 * older peers.
 * @return {Object} peer
 */
Swarm.prototype._shift = function() {
  var self = this
  for (var i = self._queues.length - 1; i >= 0; i--) {
    var queue = self._queues[i]
    if (queue && queue.length) return queue.shift()
  }
  return null
}

Swarm.prototype._onincoming = function(connection, wire) {
  wire.remoteAddress = connection.address().address + ':' + connection.address().port
  wire.handshake(this.infoHash, this.peerId)

  this._onconnection(connection)
  this._onwire(connection, wire)
}

Swarm.prototype._onconnection = function(connection) {
  var self = this

  connection.once('close', function() {
    self.connections.splice(self.connections.indexOf(connection), 1)
    self._drain()
  })

  this.connections.push(connection)
}

Swarm.prototype._onwire = function(connection, wire) {
  var self = this

  wire.on('download', function (downloaded) {
    self.downloaded += downloaded
    self.emit('download', downloaded)
  })

  wire.on('upload', function(uploaded) {
    self.uploaded += uploaded
    self.emit('upload', uploaded)
  })

  var cleanup = once(function() {
    self.wires.splice(self.wires.indexOf(wire), 1)
    connection.destroy()
  })

  connection.on('close', cleanup)
  connection.on('error', cleanup)
  connection.on('end', cleanup)
  wire.on('end', cleanup)
  wire.on('close', cleanup)
  wire.on('error', cleanup)
  wire.on('finish', cleanup)

  this.wires.push(wire)
  this.emit('wire', wire, connection)
}

module.exports = Swarm;