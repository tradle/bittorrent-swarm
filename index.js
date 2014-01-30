// TODO:
// - Support magnet metadata protocol for trackerless torrents
// - Support PORT message to add peer to DHT
// - Need to call setKeepAlive(true) on all wires or else they'll disconnect us
// - Should we call setTimeout() on the wires?
// - What happens when a peer connects and handhsakes for an infoHash that we don't have?

module.exports = Swarm
// module.exports.Peer = Peer
// module.exports.Pool = Pool

var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')
var net = require('net')
var once = require('once')
var Wire = require('bittorrent-protocol')

var MAX_SIZE = 100
var HANDSHAKE_TIMEOUT = 5000
var RECONNECT_WAIT = [1000, 5000, 15000, 30000, 60000, 120000, 300000, 600000]

function Peer (addr, conn) {
  this.addr = addr
  this.conn = conn

  this.wire = null

  // TODO
  // this.reconnect = false
  // this.retries = 0
  // this.timeout = null
}

Peer.prototype.onconnect = function () {
  var conn = this.conn
  var wire = this.wire = new Wire()

  conn.once('end', function () { conn.destroy() })
  conn.once('error', function () { conn.destroy() })
  conn.once('close', function () { wire.end() })

  conn.pipe(wire).pipe(conn)
  wire.remoteAddress = this.addr
}

function Pool (port) {
  this.port = port
  this.swarms = {} // infoHash -> Swarm
  this.listening = false

  // Keep track of incoming connections so we can destroy them if we need to
  // close the server later.
  this.conns = []

  this.server = net.createServer(this._onconn.bind(this))
  this.server.listen(this.port, this._onlistening.bind(this))
  this.server.on('error', this._onerror.bind(this))

  this._retries = 0
}

Pool.pools = {} // open pools (port -> Pool)

Pool.add = function (swarm) {
  var port = swarm.port
  var pool = Pool.pools[port]

  if (!pool)
    pool = Pool.pools[port] = new Pool(port)

  pool.addSwarm(swarm)
}

Pool.remove = function (swarm) {
  var port = swarm.port
  var pool = Pool.pools[port]
  if (!pool) return

  pool.removeSwarm(swarm)

  if (Object.keys(pool.swarms).length === 0)
    delete Pool.pools[port]
}

Pool.prototype._onlistening = function () {
  this.listening = true
  for (var infoHash in this.swarms) {
    var swarm = this.swarms[infoHash]
    swarm.emit('listening')
  }
}

Pool.prototype._onconn = function (conn) {
  // Track all conns in this pool
  this.conns.push(conn)
  conn.on('close', function () {
    this.conns.splice(this.conns.indexOf(conn))
  }.bind(this))

  var addr = conn.remoteAddress + ':' + conn.remotePort

  // On incoming connections, we expect the remote peer to send a handshake
  // first. Based on the infoHash in that handshake, route the peer to the
  // right swarm.
  var peer = new Peer(addr, conn)
  peer.onconnect()

  // TODO: add timeout to wait for handshake for

  peer.wire.on('handshake', function (infoHash, peerId, extensions) {
    var swarm = this.swarms[infoHash.toString('hex')]
    if (!swarm)
      return conn.destroy()

    swarm._onincoming(peer)
  }.bind(this))
}

Pool.prototype._onerror = function (err) {
  if (err.code == 'EADDRINUSE' && this._retries < 5) {
    console.log('Address in use, retrying...')
    setTimeout(function () {
      this._retries += 1
      this.server.close()
      this.server.listen(this.port)
    }.bind(this), 1000)
  } else {
    this.swarms.forEach(function (swarm) {
      swarm.emit('error', 'Swarm listen error: ' + err.message)
    })
  }
}

Pool.prototype.close = function (cb) {
  this.conns.forEach(function (conn) {
    conn.destroy()
  })
  this.server.close(cb)
}

Pool.prototype.addSwarm = function (swarm) {
  var infoHash = swarm.infoHash.toString('hex')

  if (this.listening) {
    process.nextTick(function () {
      swarm.emit('listening')
    })
  }

  if (this.swarms[infoHash]) {
    process.nextTick(function() {
      swarm.emit('error', new Error('Swarm listen error: There is already a ' +
        'swarm with infoHash ' + swarm.infoHash + ' listening on port ' +
        swarm.port))
    })
    return
  }

  this.swarms[infoHash] = swarm
}

Pool.prototype.removeSwarm = function (swarm) {
  var infoHash = swarm.infoHash.toString('hex')
  delete this.swarms[infoHash]

  if (Object.keys(this.swarms).length === 0)
    this.close()
}


inherits(Swarm, EventEmitter)

function Swarm (infoHash, peerId) {
  if (!(this instanceof Swarm)) return new Swarm(infoHash, peerId)

  EventEmitter.call(this)

  this.infoHash = typeof infoHash === 'string'
    ? new Buffer(infoHash, 'hex')
    : infoHash

  this.peerId = typeof peerId === 'string'
    ? new Buffer(peerId, 'utf8')
    : peerId

  this.port = 0
  this.downloaded = 0
  this.uploaded = 0

  this.wires = [] // open wires (added *after* handshake)

  this._queue = [] // queue of peers to connect to
  this._peers = {} // connected peers (addr -> Peer)

  this._paused = false
  this._destroyed = false
}

Object.defineProperty(Swarm.prototype, 'numQueued', {
  get: function () {
    return this._queue.length
  }
})

Object.defineProperty(Swarm.prototype, 'numConns', {
  get: function () {
    return Object.keys(this._peers)
      .map(function (addr) {
        return this._peers[addr].conn ? 1 : 0
      }.bind(this))
      .reduce(function (prev, current) {
        return prev + current
      }, 0)
  }
})

/**
 * Add a peer to the swarm.
 * @param {string} addr  ip address and port (ex: 12.34.56.78:12345)
 */
Swarm.prototype.add = function (addr) {
  if (this._destroyed || this._peers[addr]) return

  var peer = new Peer(addr)
  this._peers[addr] = peer
  this._queue.push(peer)

  this._drain()
}

Swarm.prototype.pause = function () {
  this._paused = true
}

Swarm.prototype.resume = function () {
  this._paused = false
  this._drain()
}

/**
 * Remove a peer from the swarm.
 * @param  {string} addr  ip address and port (ex: 12.34.56.78:12345)
 */
Swarm.prototype.remove = function (addr) {
  this._remove(addr)
  this._drain()
}

/**
 * Private method to remove a peer from the swarm without calling _drain().
 * @param  {string} addr  ip address and port (ex: 12.34.56.78:12345)
 */
Swarm.prototype._remove = function (addr) {
  var peer = this._peers[addr]
  if (!peer) return
  delete this._peers[addr]
  if (peer.node)
    this._queue.splice(this._queue.indexOf(peer), 1)
  if (peer.timeout)
    clearTimeout(peer.timeout)
  if (peer.wire)
    peer.wire.destroy()
}

/**
 * Listen on the given port for peer connections.
 * @param  {number} port
 * @param  {function} onlistening
 */
Swarm.prototype.listen = function (port, onlistening) {
  this.port = port
  if (onlistening)
    this.once('listening', onlistening)

  Pool.add(this)
}

/**
 * Destroy the swarm, close all open peer connections, and cleanup.
 */
Swarm.prototype.destroy = function() {
  this._destroyed = true

  for (var addr in this._peers) {
    this._remove(addr)
  }

  Pool.remove(this)

  process.nextTick(function() {
    this.emit('close')
  }.bind(this))
}



/**
 * Pop a peer off the FIFO queue and connect to it. When _drain() gets called,
 * the queue will usually have only one peer in it, except when there are too
 * many peers (over `this.maxSize`) in which case they will just sit in the queue
 * until another connection closes.
 */
Swarm.prototype._drain = function () {
  if (this.numConns >= MAX_SIZE || this._paused) return

  var peer = this._queue.shift()
  if (!peer) return

  // if (peer.timeout) {
  //   clearTimeout(peer.timeout)
  //   peer.timeout = null
  // }

  var parts = peer.addr.split(':')
  var conn = peer.conn = net.connect(parts[1], parts[0])

  conn.on('connect', function () {
    peer.onconnect()
    this._onconn(peer)

    peer.wire.handshake(this.infoHash, this.peerId)

    peer.wire.on('handshake', function (infoHash) {
      if (infoHash.toString('hex') !== this.infoHash.toString('hex'))
        return peer.conn.destroy()
      this._onwire(peer)
    }.bind(this))

  }.bind(this))

  // TODO
  // wire.on('handshake', function (infoHash) {
  //   this.reconnect = true
  //   this.retries = 0
  // }.bind(this))

  // Handshake
  // var timeout = setTimeout(function () {
  //   conn.destroy()
  // }, HANDSHAKE_TIMEOUT)

  // wire.once('handshake', function (infoHash, peerId, extensions) {
  //   console.log('HANDSHAKE SUCCESS, extensions:')
  //   console.log(extensions)
  //   clearTimeout(timeout)

  //   if (extensions.extended) {
  //     wire.extended(0, {
  //       m: {
  //         ut_metadata: 1
  //       }
  //       // TODO - this should be set once we have metadata
  //       // metadata_size: xx
  //     })
  //   }

  // var repush = function () {
  //   peer.node = this._queue.push(peer)
  //   this._drain()
  // }.bind(this)

  // wire.on('end', function () {
  //   peer.wire = null
  //   if (!peer.reconnect || this._destroyed || peer.retries >= RECONNECT_WAIT.length) return this._remove(peer.addr)
  //   peer.timeout = setTimeout(repush, RECONNECT_WAIT[peer.retries++])
  // }.bind(this))

}

/**
 * Called whenever a new peer wants to connects to this swarm. Called with a
 * peer that has already sent us a handshake.
 * @param  {Peer} peer
 */
Swarm.prototype._onincoming = function (peer) {
  this._peers[peer.wire.remoteAddress] = peer
  peer.wire.handshake(this.infoHash, this.peerId)

  this._onconn(peer)
  this._onwire(peer)
}

//
// HELPER METHODS
//

/**
 * Called whenever a new connection is connected.
 * @param  {Socket} conn
 */
Swarm.prototype._onconn = function (peer) {
  peer.conn.once('close', function () {
    this._drain() // allow another connection to be opened
  }.bind(this))
}

/**
 * Called whenever we've handshaken with a new wire.
 * @param  {Peer} peer
 */
Swarm.prototype._onwire = function (peer) {
  var conn = peer.conn
  var wire = peer.wire

  wire.on('download', function (downloaded) {
    this.downloaded += downloaded
    this.emit('download', downloaded)
  }.bind(this))

  wire.on('upload', function (uploaded) {
    this.uploaded += uploaded
    this.emit('upload', uploaded)
  }.bind(this))

  var cleanup = once(function () {
    this.wires.splice(this.wires.indexOf(wire), 1)
    conn.destroy()
  }.bind(this))

  wire.on('end', cleanup)
  wire.on('close', cleanup)
  wire.on('error', cleanup)
  wire.on('finish', cleanup)

  this.wires.push(wire)
  this.emit('wire', wire)
}