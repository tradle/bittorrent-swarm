// TODO:
// - Support magnet metadata protocol for trackerless torrents
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

/**
 * Peer
 * ====
 * A peer in the swarm. Comprised of a `net.Socket` and a `Wire`.
 *
 * @param {string} addr
 * @param {Socket} conn
 */
function Peer (addr, conn) {
  this.addr = addr
  this.conn = conn

  this.wire = null

  // TODO
  // this.reconnect = false
  // this.retries = 0
  // this.timeout = null
}

/**
 * Called once the peer's `conn` has connected (i.e. fired 'connect')
 */
Peer.prototype.onconnect = function () {
  var conn = this.conn
  var wire = this.wire = new Wire()
  wire.remoteAddress = this.addr

  // Close the wire when the connection is destroyed
  conn.once('end', function () { conn.destroy() })
  conn.once('error', function () { conn.destroy() })
  conn.once('close', function () { wire.end() })

  // Duplex streaming magic!
  conn.pipe(wire).pipe(conn)
}

/**
 * Pool
 * ====
 * A "pool" is a bunch of swarms all listening on the same TCP port for
 * incoming connections from peers who are interested in one of our swarms.
 * There is one Pool for every port that a swarm is listening on, and they are
 * all stored in the `Pool.pools` object. When a connection comes in, the pool
 * does the wire protocol handshake with the peer to determine which swarm they
 * are interested in, and routes the connection to the right swarm.
 *
 * @param {number} port
 */
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

/**
 * In-use Pools (port -> Pool)
 */
Pool.pools = {}

/**
 * STATIC METHOD: Add a swarm to a pool, creating a new pool if necessary.
 * @param {Swarm} swarm
 */
Pool.add = function (swarm) {
  var port = swarm.port
  var pool = Pool.pools[port]

  if (!pool)
    pool = Pool.pools[port] = new Pool(port)

  pool.addSwarm(swarm)
}

/**
 * STATIC METHOD: Remove a swarm from its pool.
 * @param  {Swarm} swarm
 */
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

/**
 * Destroy this pool.
 * @param  {function} cb
 */
Pool.prototype.destroy = function (cb) {
  // Destroy all open connections & wire objects so the server can gracefully
  // close without waiting for timeout or the remote peer to disconnect.
  this.conns.forEach(function (conn) {
    conn.destroy()
  })
  this.server.close(cb)
}

/**
 * Add a swarm to this pool.
 * @param {Swarm} swarm
 */
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

/**
 * Remove a swarm from this pool.
 * @param  {Swarm} swarm
 */
Pool.prototype.removeSwarm = function (swarm) {
  var infoHash = swarm.infoHash.toString('hex')
  delete this.swarms[infoHash]

  if (Object.keys(this.swarms).length === 0)
    this.destroy()
}


inherits(Swarm, EventEmitter)

/**
 * Swarm
 * =====
 * Abstraction of a BitTorrent "swarm", which is handy for managing all peer
 * connections for a given torrent download. This handles connecting to peers,
 * listening for incoming connections, and doing the initial peer wire protocol
 * handshake with peers. It also tracks total data uploaded/downloaded to/from
 * the swarm.
 *
 * Events: wire, download, upload, error, close
 *
 * @param {Buffer|string} infoHash
 * @param {Buffer|string} peerId
 * @param {Object} extensions
 */
function Swarm (infoHash, peerId, extensions) {
  if (!(this instanceof Swarm)) return new Swarm(infoHash, peerId)

  EventEmitter.call(this)

  this.infoHash = typeof infoHash === 'string'
    ? new Buffer(infoHash, 'hex')
    : infoHash

  this.peerId = typeof peerId === 'string'
    ? new Buffer(peerId, 'utf8')
    : peerId

  this.extensions = extensions

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

/**
 * Temporarily stop connecting to new peers. Note that this does not pause new
 * incoming connections, nor does it pause the streams of existing connections
 * or their wires.
 */
Swarm.prototype.pause = function () {
  this._paused = true
}

/**
 * Resume connecting to new peers.
 */
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
 * Destroy the swarm, close all open peer connections, and do cleanup.
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

    peer.wire.handshake(this.infoHash, this.peerId, this.extensions)

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
  peer.wire.handshake(this.infoHash, this.peerId, this.extensions)

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
