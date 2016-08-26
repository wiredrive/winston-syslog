/*
 * syslog.js: Transport for logging to a remote syslog consumer
 *
 * (C) 2011 Squeeks and Charlie Robbins
 * MIT LICENCE
 *
 */

var dgram = require('dgram'),
    net = require('net'),
    util = require('util'),
    cycle = require('cycle'),
    glossy = require('glossy'),
    winston = require('winston'),
    common = require('winston/lib/winston/common');

var levels = Object.keys({
  debug: 0,
  info: 1,
  notice: 2,
  warning: 3,
  error: 4,
  crit: 5,
  alert: 6,
  emerg: 7
});

//
// ### function Syslog (options)
// #### @options {Object} Options for this instance.
// Constructor function for the Syslog Transport capable of sending
// RFC 3164 and RFC 5424 compliant messages.
//
var Syslog = exports.Syslog = function (options) {
  winston.Transport.call(this, options);
  options = options || {};
  //
  // Setup connection state
  //
  this.connected = false;
  this.congested = false;
  this.retries = 0;
  this.queue = [];
  this.inFlight = 0;

  this.json        = options.json        || false;
  this.colorize    = options.colorize    || false;
  this.prettyPrint = options.prettyPrint || false;
  this.timestamp   = typeof options.timestamp !== 'undefined' ? options.timestamp : false;
  this.showLevel   = options.showLevel === undefined ? true : options.showLevel;
  this.label       = options.label       || null;
  this.logstash    = options.logstash    || false;
  this.depth       = options.depth       || null;

  //
  // Merge the options for the target Syslog server.
  //
  this.host     = options.host     || 'localhost';
  this.port     = options.port     || 514;
  this.path     = options.path     || null;
  this.appId    = options.appId    || options.app_id || null;
  this.protocol = options.protocol || 'udp4';
  this.isDgram  = /^udp|^unix/.test(this.protocol);
  this.endOfLine = options.eol;

  if (!/^udp|unix|unix-connect|tcp/.test(this.protocol)) {
    throw new Error('Invalid syslog protocol: ' + this.protocol);
  }

  if (/^unix/.test(this.protocol) && !this.path) {
    throw new Error('`options.path` is required on unix dgram sockets.');
  }

  //
  // Merge the default message options.
  //
  this.localhost = typeof options.localhost !== 'undefined' ? options.localhost : 'localhost';
  this.type      = options.type      || 'BSD';
  this.facility  = options.facility  || 'local0';
  this.pid       = options.pid       || process.pid;
  this.appName   = options.appName   || options.app_name  || process.title;

  //
  // Setup our Syslog and network members for later use.
  //
  this.socket   = null;
  this.producer = new glossy.Produce({
    type:     this.type,
    // appName:  this.appName,
    // pid:      this.pid,
    facility: this.facility
  });
};

//
// Inherit from `winston.Transport`.
//
util.inherits(Syslog, winston.Transport);

//
// Define a getter so that `winston.transports.Syslog`
// is available and thus backwards compatible.
//
winston.transports.Syslog = Syslog;

//
// Expose the name of this Transport on the prototype
//
Syslog.prototype.name = 'syslog';
//
// ### function log (level, msg, [meta], callback)
// #### @level {string} Target level to log to
// #### @msg {string} Message to log
// #### @meta {Object} **Optional** Additional metadata to log.
// #### @callback {function} Continuation to respond to when complete.
// Core logging method exposed to Winston. Logs the `msg` and optional
// metadata, `meta`, to the specified `level`.
//
Syslog.prototype.log = function (level, msg, meta, callback) {
  var self = this,
      syslogMsg,
      buffer;

  if (!~levels.indexOf(level)) {
    return callback(new Error('Cannot log unknown syslog level: ' + level));
  }

  var output = common.log({
    colorize:    this.colorize,
    json:        this.json,
    level:       level,
    message:     msg,
    meta:        meta,
    stringify:   this.stringify,
    timestamp:   this.timestamp,
    showLevel:   this.showLevel,
    prettyPrint: this.prettyPrint,
    raw:         this.raw,
    label:       this.label,
    logstash:    this.logstash,
    depth:       this.depth,
    formatter:   this.formatter,
    humanReadableUnhandledException: this.humanReadableUnhandledException
  });

  syslogMsg = this.producer.produce({
    severity: level,
    host:     this.localhost,
    // appName:   this.appId || process.title,
    date:     new Date(),
    message:  this.endOfLine ? output + this.endOfLine : output
  });

  //
  // Attempt to connect to the socket
  //
  this.connect(function (err) {
    if (err) {
      //
      // If there was an error enqueue the message
      //
      self.queue.push(syslogMsg);

      return callback(err);
    }

    //
    // On any error writing to the socket, enqueue the message
    //
    function onError(logErr) {
      if (logErr) { self.queue.push(syslogMsg) }
      self.emit('logged');
      self.inFlight--;
    }

    function onCongestion() {
      onError(new Error('Congestion Error'));
    }

    //
    // Write to the `tcp*`, `udp*`, or `unix` socket.
    //
    if (self.isDgram) {
      buffer = new Buffer(syslogMsg);

      if (self.protocol.match(/^udp/)) {
        self.inFlight++;
        self.socket.send(buffer, 0, buffer.length, self.port, self.host, onError);
      }
      else if (self.protocol === 'unix') {
        self.socket.send(buffer, 0, buffer.length, self.path, onError);
      }
      else {
        if (self.congested) {
          self.queue.push(syslogMsg);
        }
        else {
          self.socket.once('congestion', onCongestion);
          self.socket.once('error', onError);
          self.socket.send(buffer, function () {
            self.socket.removeListener('congestion', onCongestion);
            self.socket.removeListener('error', onError);
            onError();
          });
        }
      }
    }
    else {
      self.socket.write(syslogMsg, 'utf8', onError);
    }

    callback(null, true);
  });
};
//
// ### function close ()
// Closes the socket used by this transport freeing the resource.
//
Syslog.prototype.close = function () {
  var self = this,
      max = 6,
      attempt = 0;

  (function _close() {
    if (attempt >= max || (self.queue.length === 0 && self.inFlight <= 0)) {
      if (self.socket) {
        self.socket.close();
      }

      self.emit('closed', self.socket);
    }
    else {
      attempt++;
      setTimeout(_close, 200 * attempt);
    }
  }());
};

//
// ### function connect (callback)
// #### @callback {function} Continuation to respond to when complete.
// Connects to the remote syslog server using `dgram` or `net` depending
// on the `protocol` for this instance.
//
Syslog.prototype.connect = function (callback) {
  var self = this, readyEvent;

  //
  // If the socket already exists then respond
  //
  if (this.socket) {
    return (!this.socket.readyState) || (this.socket.readyState === 'open')
      ? callback(null)
      : callback(true);
  }

  //
  // Create the appropriate socket type.
  //
  if (this.isDgram) {
    if (self.protocol.match(/^udp/)) {
      this.socket = new dgram.Socket(this.protocol);
    }
    else if (self.protocol === 'unix') {
      this.socket = require('unix-dgram').createSocket('unix_dgram');
    }
    else {
      return this._unixDgramConnect(callback);
    }

    return callback(null);
  }
  else {
    this.socket = new net.Socket({ type: this.protocol });
    this.socket.setKeepAlive(true);
    this.socket.setNoDelay();
    readyEvent = 'connect';
  }

  //
  // On any error writing to the socket, emit the `logged` event
  // and the `error` event.
  //
  function onError(logErr) {
    if (logErr) { self.emit('error', logErr) }
    self.emit('logged');
    self.inFlight--;
  }

  //
  // Indicate to the callee that the socket is not ready. This
  // will enqueue the current message for later.
  //
  callback(true);

  //
  // Listen to the appropriate events on the socket that
  // was just created.
  //
  this.socket.on(readyEvent, function () {
    //
    // When the socket is ready, write the current queue
    // to it.
    //
    self.socket.write(self.queue.join(''), 'utf8', onError);

    self.emit('logged');
    self.queue = [];
    self.retries = 0;
    self.connected = true;
  }).on('error', function (ex) {
    //
    // TODO: Pass this error back up
    //
  }).on('end', function (ex) {
    //
    // Nothing needs to be done here.
    //
  }).on('close', function (ex) {
    //
    // Attempt to reconnect on lost connection(s), progressively
    // increasing the amount of time between each try.
    //
    var interval = Math.pow(2, self.retries);
    self.connected = false;

    setTimeout(function () {
      self.retries++;
      self.socket.connect(self.port, self.host);
    }, interval * 1000);
  }).on('timeout', function () {
    if (self.socket.readyState !== 'open') {
      self.socket.destroy();
    }
  });

  this.socket.connect(this.port, this.host);
};

Syslog.prototype._unixDgramConnect = function (cb) {
  var self = this;

  function flushQueue() {
    var sentMsgs = 0;
    self.queue.forEach(function (msg) {
      var buffer = new Buffer(msg);

      if (!self.congested) {
        self.socket.send(buffer, function () {
          ++sentMsgs;
        });
      }
    });

    self.queue.splice(0, sentMsgs);
  }

  this.socket = require('unix-dgram').createSocket('unix_dgram');
  this.socket.on('error', function (err) {
    if (err.syscall === 'connect') {
      self.socket.close();
      self.socket = null;
      cb(err);
    }
    if (err.syscall === 'send') {
      self.socket.close();
      self.socket = null;
    }

    self.emit('error', err);
  });

  this.socket.on('connect', function () {
    this.on('congestion', function () {
      self.congested = true;
    });

    this.on('writable', function () {
      self.congested = false;
      flushQueue();
    });

    flushQueue();
    cb();
  });

  this.socket.connect(this.path);
};
