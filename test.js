'use strict';

const childprocess = require('child_process');
const chai = require('chai');
const fspromise = require('fs-promise');
const mocha = require('mocha');
const pg = require('pg');
const Postgres = require('./Postgres');
const expect = chai.expect;
const after = mocha.after;
const before = mocha.before;
const describe = mocha.describe;
const it = mocha.it;

/**
 * Get a random port number.
 * @return {Number}
 */
const generateRandomPort = () =>
  Math.floor(Math.random() * 10000) + 9000;

/**
 * Get a random database path.
 * @return {String}
 */
const generateRandomPath = () =>
  `data/db/${generateRandomPort()}`;

/**
 * Get a {@link Promise} that is resolved or rejected when the given
 * {@linkcode delegate} invokes the callback it is provided.
 * @argument {Function} delegate
 * @return {Promise}
 */
const promisify = (delegate) =>
  new Promise((resolve, reject) => {
    delegate((err, value) => {
      if (err == null) {
        resolve(value);
      }
      else {
        reject(err);
      }
    });
  });

/**
 * Create a PostgreSQL database at a given {@linkcode dir} path.
 * @argument {String} dir
 * @return {Promise}
 */
const initdb = (dir) =>
  promisify((done) => childprocess.exec(`initdb ${dir}`, done));

/**
 * Create a PostgreSQL database for a given {@linkcode server}.
 * @see initdb
 * @argument {Postgres} server
 * @return {Promise}
 */
const mkdatadir = (server) =>
  initdb(server.config.datadir);

/**
 * Expect a given {@linkcode server} to not be opening, closing, or running.
 * @argument {Postgres} server
 * @return {undefined}
 */
const expectIdle = (server) => {
  expect(server.isOpening).to.equal(false);
  expect(server.isRunning).to.equal(false);
  expect(server.isClosing).to.equal(false);
};

/**
 * Expect a given {@linkcode server} to be running.
 * @argument {Postgres} server
 * @return {undefined}
 */
const expectRunning = (server) => {
  expect(server.isOpening).to.equal(false);
  expect(server.isRunning).to.equal(true);
  expect(server.isClosing).to.equal(false);
  expect(server.process).to.not.equal(null);
};

/**
 * Attempt to start a given {@linkcode server} and expect it to be opening.
 * Passes {linkcode done} to {@link Postgres#open}.
 * @argument {Postgres} server
 * @argument {Postgres~callback} [done]
 * @return {undefined}
 */
const expectToOpen = (server, done) => {
  const oldPromise = server.openPromise;
  const newPromise = server.open(done);

  expect(newPromise).to.be.a('promise');
  expect(newPromise).to.not.equal(oldPromise);
  expect(server.isOpening).to.equal(true);

  return newPromise;
};

/**
 * Attempt to stop a given {@linkcode server} and expect it be closing.
 * Passes {linkcode done} to {@link Postgres#close}.
 * @argument {Postgres} server
 * @argument {Postgres~callback} [done]
 * @return {undefined}
 */
const expectToClose = (server, done) => {
  const oldPromise = server.openPromise;
  const newPromise = server.close(done);

  expect(newPromise).to.be.a('promise');
  expect(newPromise).to.not.equal(oldPromise);
  expect(server.isClosing).to.equal(true);

  return newPromise;
};

/**
 * Fetch and compare the port number of a given {@linkcode server} to a
 * given {@linkcode port}.
 * @argument {Postgres} server
 * @argument {Number} expectedPort
 * @return {Promise}
 */
const expectPort = (server, expectedPort) => {
  const client = new pg.Client({ port: expectedPort, database: 'postgres' });
  const sql = 'SELECT * FROM pg_settings WHERE name = \'port\'';

  return promisify((done) => client.connect(done))
  .then(() => promisify((done) => client.query(sql, done)))
  .then((result) => {
    const actualPort = Number(result.rows[0].setting);

    expect(actualPort).to.equal(expectedPort);

    return promisify((done) => client.end(done));
  });
};

describe('Postgres', function () {
  let bin = null;
  const conf = `${new Date().toISOString()}.conf`;
  const port = generateRandomPort();
  const datadir = generateRandomPath();

  this.timeout(5000);
  before((done) => {
    childprocess.exec('pkill postgres', () => done());
  });
  before((done) => {
    childprocess.exec('which postgres', (err, stdout) => {
      bin = stdout.trim();

      done(err);
    });
  });
  before(() => fspromise.emptyDir('data/db/'));
  before(() => {
    const file = `data_directory='${datadir}'
                  hba_file='${datadir}/pg_hba.conf'
                  ident_file='${datadir}/pg_ident.conf'
                  port=${port}`;

    return fspromise.writeFile(conf, file);
  });
  before(() => initdb(datadir));
  after(() => fspromise.remove(conf));
  describe('.parseConfig()', () => {
    it('parses valid properties only', () => {
      const expectedObject = { bin, port, datadir };
      const actualObject = Postgres.parseConfig(
        Object.assign({ fu: 'bar' }, expectedObject)
      );

      expect(actualObject).to.eql(expectedObject);
    });
    it('works without arguments', () => {
      expect(Postgres.parseConfig()).to.be.an('object');
      expect(Postgres.parseConfig(null)).to.be.an('object');
      expect(Postgres.parseConfig({ port: null })).to.be.an('object');
    });
    it('accepts a path', () => {
      const config = Postgres.parseConfig(datadir);

      expect(config).to.be.an('object').and.have.property('datadir').equal(datadir);
    });
    it('accepts a configuration object', () => {
      const expectedObject = { bin, port, datadir };
      const actualObject = Postgres.parseConfig(expectedObject);

      expect(actualObject).to.eql(expectedObject);
    });
  });
  describe('.parseFlags()', () => {
    it('returns an empty array when given an empty object', () => {
      expect(Postgres.parseFlags({})).to.have.length(0);
    });
    it('parses all flags', () => {
      const actualFlags = Postgres.parseFlags({ bin, port, datadir });
      const expectedFlags = [
        '-D',
        datadir,
        '-p',
        port
      ];

      expect(actualFlags).to.eql(expectedFlags);
    });
    it('returns only conf when present', () => {
      const config = { bin, conf, port, datadir };
      const flags = Postgres.parseFlags(config);

      expect(flags).to.eql(['-c', `config_file=${config.conf}`]);
    });
  });
  describe('.parseData()', () => {
    it('parses a "ready to accept connections" message', () => {
      const result = Postgres.parseData(
        'LOG:  database system is ready to accept connections'
      );

      expect(result).to.be.an('object').and.have.property('err');
      expect(result.err).to.equal(null);
    });
    it('parses a "Address already in use" error', () => {
      const result = Postgres.parseData(
        'LOG:  could not bind IPv6 socket: Address already in use'
      );

      expect(result).to.be.an('object').and.have.property('err');
      expect(result.err).be.an('error').with.property('code').equal(-1);
    });
    it('parses a "Permission denied" error', () => {
      const result = Postgres.parseData(
        'LOG:  could not bind IPv6 socket: Permission denied'
      );

      expect(result).to.be.an('object').and.have.property('err');
      expect(result.err).be.an('error').with.property('code').equal(-2);
    });
    it('parses a "FATAL" error', () => {
      const result = Postgres.parseData(
        'FATAL:  invalid value for parameter "port": "fubar"'
      );

      expect(result).to.be.an('object').and.have.property('err');
      expect(result.err).be.an('error').with.property('code').equal(-3);
    });
    it('parses a "postgres" error', () => {
      const result = Postgres.parseData(
        'postgres: could not access directory "/data/db/5432": No such file or \
        directory\nRun initdb or pg_basebackup to initialize a PostgreSQL data \
        directory.'
      );

      expect(result).to.be.an('object').and.have.property('err');
      expect(result.err).be.an('error').with.property('code').equal(-3);
    });
    it('returns `null` when given an unrecognized value', () => {
      const values = ['invalid', '', null, undefined, {}, 1234];

      for (let value of values) {
        expect(Postgres.parseData(value)).to.equal(null);
      }
    });
  });
  describe('#constructor()', () => {
    it('constructs a new instance', () => {
      const server = new Postgres();

      expectIdle(server);
      expect(server.process).to.equal(null);
    });
    it('throws when invoked without the `new` keyword', () => {
      expect(Postgres).to.throw();
    });
    it('calls .parseConfig', () => {
      const parseConfig = Postgres.parseConfig;
      let expectedObject = { port };
      let actualObject = null;

      Postgres.parseConfig = (source, target) => {
        actualObject = source;

        return parseConfig(source, target);
      };

      const server = new Postgres(expectedObject);

      Postgres.parseConfig = parseConfig;

      expect(actualObject).to.equal(expectedObject);
      expect(server.config.port).to.equal(expectedObject.port);
    });
  });
  describe('#open()', () => {
    it('starts a server and executes a callback', () => {
      const server = new Postgres({ datadir, port: generateRandomPort() });

      return expectToOpen(server, (err, res) => {
        expect(err).to.equal(null);
        expect(res).to.equal(null);
        expectRunning(server);

        return server.close();
      });
    });
    it('passes proper arguments to a callback on failure', () => {
      const server = new Postgres('baddatadir');

      return server.open((err, res) => {
        expect(err).to.be.an('error');
        expect(res).to.equal(null);
      });
    });
    it('starts a server and resolves a promise', () => {
      const server = new Postgres({ datadir, port: generateRandomPort() });

      return expectToOpen(server).then((res) => {
        expectRunning(server);
        expect(res).to.equal(null);

        return server.close();
      });
    });
    it('does nothing when a server is already started', () => {
      const server = new Postgres({ datadir, port: generateRandomPort() });
      let openingCount = 0;
      let openCount = 0;

      server.on('opening', () => ++openingCount);
      server.on('open', () => ++openCount);

      const expectedPromise = server.open();
      const actualPromise = server.open();

      return Promise.all([
        expectedPromise,
        actualPromise
      ])
      .then(() => {
        expect(actualPromise).to.equal(expectedPromise);
        expect(openingCount).to.equal(1);
        expect(openCount).to.equal(1);

        return server.close();
      });
    });
    it('does nothing when a server is already started', () => {
      const server = new Postgres({ datadir, port: generateRandomPort() });
      let openingCount = 0;
      let openCount = 0;

      server.on('opening', () => ++openingCount);
      server.on('open', () => ++openCount);

      return server.open()
      .then(() => server.open())
      .then(() => {
        expectRunning(server);
        expect(openingCount).to.equal(1);
        expect(openCount).to.equal(1);

        return server.close();
      });
    });
    it('fails to start a server with a bad datadir', () => {
      const server = new Postgres({ datadir: 'fubar' });

      return server.open((err) => {
        expect(err).to.be.an('error').to.have.property('code').equal(-3);
      });
    });
    it('fails to start a server with a bad port', () => {
      const server = new Postgres({
        datadir: generateRandomPath(),
        port: 'fubar'
      });

      return mkdatadir(server).then(() => server.open((err) => {
        expect(err).to.be.an('error').to.have.property('code').equal(-3);
      }));
    });
    it('fails to start a server with a privileged port', () => {
      const server = new Postgres({
        datadir: generateRandomPath(),
        port: 1
      });

      return mkdatadir(server).then(() => server.open((err) => {
        expect(err).to.be.an('error').to.have.property('code').equal(-2);
      }));
    });
    it('fails to start a server on an in-use port', () => {
      const port = generateRandomPort();
      const server1 = new Postgres({ datadir: generateRandomPath(), port });
      const server2 = new Postgres({ datadir: generateRandomPath(), port });

      return Promise.all([
        mkdatadir(server1),
        mkdatadir(server2)
      ])
      .then(() => server1.open())
      .then(() => server2.open((err) => {
        expect(err).to.be.an('error').and.have.property('code').equal(-1);

        return server1.close();
      }));
    });
    it('starts a server with a given port', () => {
      const server = new Postgres({
        datadir: generateRandomPath(),
        port: generateRandomPort()
      });

      return mkdatadir(server)
      .then(() => expectToOpen(server))
      .then(() => expectPort(server, server.config.port))
      .then(() => server.close());
    });
    it('starts a server with a given PostgreSQL conf', () => {
      const server = new Postgres({ conf });

      return expectToOpen(server)
      .then(() => expectPort(server, port))
      .then(() => server.close());
    });
    it('starts a server with a given PostgreSQL binary', () => {
      const server = new Postgres({
        bin,
        datadir: generateRandomPath(),
        port: generateRandomPort()
      });

      return mkdatadir(server)
      .then(() => expectToOpen(server))
      .then(() => server.close());
    });
    it('starts a server after #close() finishes', () => {
      const server = new Postgres({
        datadir: generateRandomPath(),
        port: generateRandomPort()
      });

      return mkdatadir(server)
      .then(() => Promise.all([
        server.open(),
        promisify((done) => setTimeout(() => server.close(done), 10)),
        promisify((done) => setTimeout(() => server.open(done), 15)),
        promisify((done) => setTimeout(() => server.close(done), 20)),
        promisify((done) => setTimeout(() => server.open(done), 25))
      ]))
      .then(() => {
        expectRunning(server);

        return server.close();
      });
    });
    it('starts a server while others run on different ports', () => {
      const server1 = new Postgres({
        datadir: generateRandomPath(),
        port: generateRandomPort()
      });
      const server2 = new Postgres({
        datadir: generateRandomPath(),
        port: generateRandomPort()
      });
      const server3 = new Postgres({
        datadir: generateRandomPath(),
        port: generateRandomPort()
      });

      return Promise.all([
        mkdatadir(server1),
        mkdatadir(server2),
        mkdatadir(server3)
      ])
      .then(() => Promise.all([
        server1.open(),
        server2.open(),
        server3.open()
      ]))
      .then(() => {
        expectRunning(server1);
        expectRunning(server2);
        expectRunning(server3);
      })
      .then(() => Promise.all([
        server1.close(),
        server2.close(),
        server3.close()
      ]));
    });
    it('emits "opening" and "open" when starting a server', () => {
      const server = new Postgres({
        datadir: generateRandomPath(),
        port: generateRandomPort()
      });
      let openingCount = 0;
      let openCount = 0;

      server.on('opening', () => ++openingCount);
      server.on('open', () => ++openCount);

      return mkdatadir(server)
      .then(() => server.open())
      .then(() => server.close())
      .then(() => server.open())
      .then(() => server.open())
      .then(() => server.close())
      .then(() => {
        expect(openingCount).to.equal(2);
        expect(openCount).to.equal(2);
      });
    });
    it('emits "closing" and "close" when failing to start a server', () => {
      const server = new Postgres({
        datadir: generateRandomPath(),
        port: 'fubar'
      });
      let closingCount = 0;
      let closeCount = 0;

      server.on('closing', () => ++closingCount);
      server.on('close', () => ++closeCount);

      return mkdatadir(server)
      .then(() => server.open((err) => {
        expect(err).to.be.an('error').and.have.property('code').equal(-3);
      }))
      .then(() => server.open((err) => {
        expect(err).to.be.an('error').and.have.property('code').equal(-3);
      }))
      .then(() => {
        expect(closingCount).to.equal(2);
        expect(closeCount).to.equal(2);

        return server.close();
      });
    });
  });
  describe('#close()', () => {
    it('closes a server and execute a callback', () => {
      const server = new Postgres({
        datadir: generateRandomPath(),
        port: generateRandomPort()
      });

      return mkdatadir(server)
      .then(() => server.open())
      .then(() => promisify((done) => expectToClose(server, done)));
    });
    it('closes a server and resolve a promise', () => {
      const server = new Postgres({
        datadir: generateRandomPath(),
        port: generateRandomPort()
      });

      return mkdatadir(server)
      .then(() => server.open())
      .then(() => expectToClose(server));
    });
    it('reports any error when applicable', () => {
      const server = new Postgres({
        datadir: generateRandomPath(),
        port: generateRandomPort()
      });
      const close = Postgres.close;

      Postgres.close = () =>
        Promise.reject(new Error());

      return mkdatadir(server)
      .then(() => server.open())
      .then(() => server.close((err, res) => {
        Postgres.close = close;

        expect(err).to.be.an('error');
        expect(res).to.equal(null);

        return server.close();
      }));
    });
    it('does nothing when a server is already stopping', () => {
      const server = new Postgres({
        datadir: generateRandomPath(),
        port: generateRandomPort()
      });

      return mkdatadir(server)
      .then(() => server.open())
      .then(() => {
        expect(server.close()).to.equal(server.close());

        return server.close();
      });
    });
    it('does nothing when a server is already stopped', () => {
      const server = new Postgres({
        datadir: generateRandomPath(),
        port: generateRandomPort()
      });

      return mkdatadir(server)
      .then(() => server.open())
      .then(() => server.close())
      .then(() => {
        server.close();
        expect(server.isClosing).to.equal(false);
        expectIdle(server);
      });
    });
    it('does nothing when a server was never started', () => {
      const server = new Postgres();

      server.close();
      expect(server.isClosing).to.equal(false);
      expectIdle(server);
    });
    it('stops a server after #open() finishes', () => {
      const server = new Postgres({
        datadir: generateRandomPath(),
        port: generateRandomPort()
      });

      return mkdatadir(server)
      .then(() => Promise.all([
        server.open(),
        promisify((done) => setTimeout(() => server.close(done), 10)),
        promisify((done) => setTimeout(() => server.open(done), 15)),
        promisify((done) => setTimeout(() => server.close(done), 20))
      ]))
      .then(() => {
        expectIdle(server);
      });
    });
    it('emits "closing" and "close" when stopping a server', () => {
      const server = new Postgres({
        datadir: generateRandomPath(),
        port: generateRandomPort()
      });
      let closingCount = 0;
      let closeCount = 0;

      server.on('closing', () => ++closingCount);
      server.on('close', () => ++closeCount);

      return mkdatadir(server)
      .then(() => server.open())
      .then(() => server.close())
      .then(() => server.open())
      .then(() => server.close())
      .then(() => server.close())
      .then(() => {
        expect(closingCount).to.equal(2);
        expect(closeCount).to.equal(2);
      });
    });
  });
  describe('#isClosing', () => {
    it('is `true` while a server is stopping', () => {
      const server = new Postgres({
        datadir: generateRandomPath(),
        port: generateRandomPort()
      });

      return mkdatadir(server)
      .then(() => {
        expect(server.isClosing).to.equal(false);
        server.open();
        expect(server.isClosing).to.equal(false);

        return server.open();
      })
      .then(() => {
        expect(server.isClosing).to.equal(false);
        server.close();
        expect(server.isClosing).to.equal(true);

        return server.close();
      })
      .then(() => {
        expect(server.isClosing).to.equal(false);
      });
    });
    it('is `true` when a server fails to start', () => {
      const server = new Postgres({
        datadir: generateRandomPath(),
        port: 'fubar'
      });
      let isClosing = false;

      return mkdatadir(server)
      .then(() => {
        server.on('closing', () => isClosing = server.isClosing);
        expect(server.isClosing).to.equal(false);
        server.open();
        expect(server.isClosing).to.equal(false);
      })
      .then(() => server.open((err) => {
        expect(err).to.be.an('error').and.have.property('code').equal(-3);
        expect(server.isClosing).to.equal(false);
        expect(isClosing).to.equal(true);
        server.close();
        expect(server.isClosing).to.equal(false);

        return server.close();
      }))
      .then(() => {
        expect(server.isClosing).to.equal(false);
      });
    });
  });
  describe('#isRunning', () => {
    it('is `true` while a server accepts connections', () => {
      const server = new Postgres({
        datadir: generateRandomPath(),
        port: generateRandomPort()
      });

      return mkdatadir(server)
      .then(() => {
        expect(server.isRunning).to.equal(false);
        server.open();
        expect(server.isRunning).to.equal(false);

        return server.open();
      })
      .then(() => {
        expect(server.isRunning).to.equal(true);
        server.close();
        expect(server.isRunning).to.equal(true);

        return server.close();
      })
      .then(() => {
        expect(server.isRunning).to.equal(false);
      });
    });
    it('is `false` after a misconfigured server starts', () => {
      const server = new Postgres({
        datadir: generateRandomPath(),
        port: 'fubar'
      });

      return mkdatadir(server)
      .then(() => {
        expect(server.isRunning).to.equal(false);
        server.open();
        expect(server.isRunning).to.equal(false);
      })
      .then(() => server.open((err) => {
        expect(err).to.be.an('error').and.have.property('code').equal(-3);
        expect(server.isRunning).to.equal(false);
        server.close();
        expect(server.isRunning).to.equal(false);

        return server.close();
      }))
      .then(() => {
        expect(server.isRunning).to.equal(false);
      });
    });
  });
});
