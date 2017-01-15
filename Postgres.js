'use strict';

/**
 * Configuration options for {@link Postgres}.
 * @typedef {Object} Postgres~Config
 * @property {String} [bin=postgres]
 * @property {String} [conf]
 * @property {(Number|String)} [port=5432]
 * @property {String} datadir
 * @property {String} shutdown
 */

/**
 * Invoked when an operation (i.e. {@link Postgres#open}) completes.
 * @callback Postgres~callback
 * @argument {Error} err
 */

/**
 * Emitted when a PostgreSQL server prints to stdout.
 * @event Postgres#stdout
 */

/**
 * Emitted when attempting to start a PostgreSQL server.
 * @event Postgres#opening
 */

/**
 * Emitted when a PostgreSQL server becomes ready to service requests.
 * @event Postgres#open
 */

/**
 * Emitted when attempting to stop a PostgreSQL server.
 * @event Postgres#closing
 */

/**
 * Emitted once a PostgreSQL server has stopped.
 * @event Postgres#close
 */

const childprocess = require('child_process');
const events = require('events');
const PromiseQueue = require('promise-queue');
const regExp = {
  terminalMessage: /ready\sto\saccept|already\sin\suse|denied|fatal|postgres/i,
  errorMessage: /^(?:fatal|postgres):\s+(.*)/i,
  singleWhiteSpace: /\s/g,
  multipleWhiteSpace: /\s\s+/g,
  newline: /\r?\n/
};

/**
 * Start and stop a local PostgreSQL server like a boss.
 * @class
 */
class Postgres extends events.EventEmitter {

  /**
   * Get a function that takes chunks of stdin data, aggregates it, and passes
   * it in complete lines, one by one, to a given {@link Postgres~callback}.
   * @argument {Postgres~callback} callback
   * @return {Function}
   */
  static getTextLineAggregator(callback) {
    let buffer = '';

    return (data) => {
      const fragments = data.toString().split(regExp.newline);
      const lines = fragments.slice(0, fragments.length - 1);

      // If there was an unended line in the previous dump, complete it by
      // the first section.
      lines[0] = buffer + lines[0];

      // If there is an unended line in this dump, store it to be completed by
      // the next. This assumes there will be a terminating newline character
      // at some point. Generally, this is a safe assumption.
      buffer = fragments[fragments.length - 1];

      for (let line of lines) {
        callback(line);
      }
    };
  }

  /**
   * Populate a given {@link Postgres~Config} with values from a
   * given {@link Postgres~Config}.
   * @protected
   * @argument {Postgres~Config} source
   * @argument {Postgres~Config} target
   * @return {Postgres~Config}
   */
  static parseConfig(source, target) {
    if (target == null) {
      target = Object.create(null);
    }

    if (typeof source === 'string') {
      target.datadir = source;

      return target;
    }

    if (source == null || typeof source !== 'object') {
      return target;
    }

    if (source.bin != null) {
      target.bin = source.bin;
    }

    if (source.shutdown != null) {
      target.shutdown = source.shutdown;
    }

    if (source.conf != null) {
      target.conf = source.conf;

      return target;
    }

    if (source.datadir != null) {
      target.datadir = source.datadir;
    }

    if (source.port != null) {
      target.port = source.port;
    }

    return target;
  }

  /**
   * Parse process flags for PostgreSQL from a given {@link Postgres~Config}.
   * @protected
   * @argument {Postgres~Config} config
   * @return {Array.<String>}
   */
  static parseFlags(config) {
    if (config.conf != null) {
      return ['-c', `config_file=${config.conf}`];
    }

    const flags = [];

    if (config.datadir != null) {
      flags.push('-D', config.datadir);
    }

    if (config.port != null) {
      flags.push('-p', config.port);
    }

    return flags;
  }

  /**
   * Parse Redis server output for terminal messages.
   * @protected
   * @argument {String} string
   * @return {Object}
   */
  static parseData(string) {
    const matches = regExp.terminalMessage.exec(string);

    if (matches === null) {
      return null;
    }

    const result = {
      err: null,
      key: matches
      .pop()
      .replace(regExp.singleWhiteSpace, '')
      .toLowerCase()
    };

    switch (result.key) {
      case 'readytoaccept':
        break;

      case 'alreadyinuse':
        result.err = new Error('Address already in use');
        result.err.code = -1;

        break;

      case 'denied':
        result.err = new Error('Permission denied');
        result.err.code = -2;

        break;

      case 'postgres':
      case 'fatal': {
        const matches = regExp.errorMessage.exec(string);

        result.err = new Error(
          matches === null ? string : matches.pop()
        );
        result.err.code = -3;

        break;
      }
    }

    return result;
  }

  /**
   * Start a given {@linkcode server}.
   * @protected
   * @fires Postgres#stdout
   * @fires Postgres#opening
   * @fires Postgres#open
   * @fires Postgres#closing
   * @fires Postgres#close
   * @argument {Postgres} server
   * @return {Promise}
   */
  static open(server) {
    if (server.isOpening) {
      return server.openPromise;
    }

    server.isOpening = true;
    server.isClosing = false;
    server.openPromise = server.promiseQueue.add(() => {
      if (server.isClosing || server.isRunning) {
        server.isOpening = false;

        return Promise.resolve(null);
      }

      return new Promise((resolve, reject) => {
        /**
         * A listener for the current server process' stdout that resolves or
         * rejects the current {@link Promise} when done.
         * @see Postgres.getTextLineAggregator
         * @see Postgres.parseData
         * @argument {Buffer} buffer
         * @return {undefined}
         */
        const dataListener = Postgres.getTextLineAggregator((string) => {
          const result = Postgres.parseData(string);

          if (result === null) {
            return;
          }

          server.process.stdout.removeListener('data', dataListener);
          server.process.stderr.removeListener('data', dataListener);

          server.isOpening = false;

          if (result.err === null) {
            server.isRunning = true;

            server.emit('open');
            resolve(null);
          }
          else {
            server.isClosing = true;

            server.emit('closing');
            server.process.once('close', () => reject(result.err));
          }
        });

        /**
         * A listener to close the server when the current process exits.
         * @return {undefined}
         */
        const exitListener = () => {
          // istanbul ignore next
          server.close();
        };

        /**
         * Get a text line aggregator that emits a given {@linkcode event}
         * for the current server.
         * @see Postgres.getTextLineAggregator
         * @argument {String} event
         * @return {Function}
         */
        const getDataPropagator = (event) =>
          Postgres.getTextLineAggregator((line) => server.emit(event, line));

        server.emit('opening');

        const flags = Postgres.parseFlags(server.config);

        flags.push('-c', `unix_socket_directories=${__dirname}`);

        server.process = childprocess.spawn(server.config.bin, flags);

        server.process.stderr.on('data', dataListener);
        server.process.stderr.on('data', getDataPropagator('stdout'));
        server.process.stdout.on('data', dataListener);
        server.process.stdout.on('data', getDataPropagator('stdout'));
        server.process.on('close', () => {
          server.process = null;
          server.isRunning = false;
          server.isClosing = false;

          process.removeListener('exit', exitListener);
          server.emit('close');
        });
        process.on('exit', exitListener);
      });
    });

    return server.openPromise;
  }

  /**
   * Stop a given {@linkcode server}.
   * @protected
   * @fires Postgres#closing
   * @argument {Postgres} server
   * @return {Promise}
   */
  static close(server) {
    if (server.isClosing) {
      return server.closePromise;
    }

    server.isClosing = true;
    server.isOpening = false;
    server.closePromise = server.promiseQueue.add(() => {
      if (server.isOpening || !server.isRunning) {
        server.isClosing = false;

        return Promise.resolve(null);
      }

      return new Promise((resolve) => {
        server.emit('closing');
        server.process.once('close', () => resolve(null));

        let signal = server.config.shutdown;

        switch (server.config.shutdown) {
          case 'smart':
            signal = 'SIGTERM';

            break;

          case 'fast':
            signal = 'SIGINT';

            break;

          case 'immediate':
            signal = 'SIGQUIT';

            break;
        }

        server.process.kill(signal);
      });
    });

    return server.closePromise;
  }

  /**
   * Construct a new {@link Postgres}.
   * @argument {(Number|String|Postgres~Config)} [configOrDataDir]
   * A number or string that is a port or an object for configuration.
   */
  constructor(configOrDataDir) {
    super();

    /**
     * Configuration options.
     * @protected
     * @type {Postgres~Config}
     */
    this.config = Postgres.parseConfig(configOrDataDir, {
      bin: 'postgres',
      conf: null,
      port: 5432,
      datadir: null,
      shutdown: 'fast'
    });

    /**
     * The current process.
     * @protected
     * @type {ChildProcess}
     */
    this.process = null;

    /**
     * The last {@link Promise} returned by {@link Postgres#open}.
     * @protected
     * @type {Promise}
     */
    this.openPromise = Promise.resolve(null);

    /**
     * The last {@link Promise} returned by {@link Postgres#close}.
     * @protected
     * @type {Promise}
     */
    this.closePromise = Promise.resolve(null);

    /**
     * A serial queue of open and close promises.
     * @protected
     * @type {PromiseQueue}
     */
    this.promiseQueue = new PromiseQueue(1);

    /**
     * Determine if the instance is closing a PostgreSQL server; {@linkcode true}
     * while a process is being, or about to be, killed until the
     * contained PostgreSQL server either closes or errs.
     * @readonly
     * @type {Boolean}
     */
    this.isClosing = false;

    /**
     * Determine if the instance is starting a PostgreSQL server; {@linkcode true}
     * while a process is spawning, or about tobe spawned, until the
     * contained PostgreSQL server either starts or errs.
     * @readonly
     * @type {Boolean}
     */
    this.isRunning = false;

    /**
     * Determine if the instance is running a PostgreSQL server; {@linkcode true}
     * once a process has spawned and the contained PostgreSQL server is ready
     * to service requests.
     * @readonly
     * @type {Boolean}
     */
    this.isOpening = false;
  }

  /**
   * Open the server.
   * @argument {Postgres~callback} [callback]
   * @return {Promise}
   */
  open(callback) {
    const promise = Postgres.open(this);

    return typeof callback === 'function'
    ? promise
      .then((v) => callback(null, v))
      .catch((e) => callback(e, null))
    : promise;
  }

  /**
   * Close the server.
   * @argument {Postgres~callback} [callback]
   * @return {Promise}
   */
  close(callback) {
    const promise = Postgres.close(this);

    return typeof callback === 'function'
    ? promise
      .then((v) => callback(null, v))
      .catch((e) => callback(e, null))
    : promise;
  }
}

module.exports = exports = Postgres;
