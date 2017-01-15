# postgres

[![Build Status](https://img.shields.io/travis/BrandonZacharie/node-postgres/master.svg)](https://travis-ci.org/BrandonZacharie/node-postgres)
[![Coverage Status](https://img.shields.io/coveralls/BrandonZacharie/node-postgres/master.svg)](https://coveralls.io/github/BrandonZacharie/node-postgres?branch=master)
[![License](https://img.shields.io/npm/l/redis-server.svg)](https://github.com/BrandonZacharie/node-postgres/blob/master/LICENSE.md)

Start and stop a local PostgreSQL server in Node.js like a boss.

## Usage

The constructor exported by this module accepts a single argument; a string
that is a path to PostgreSQL database files or an object for configuration.

### Basic Example

```JavaScript

const Postgres = require('postgres');

// Simply pass the path to database files you want a PostgreSQL server to use.
const server = new Postgres('path/to/datadir');

server.open((err) => {
  if (err === null) {
    // You may now connect a client to the PostgreSQL server.
  }
});

```

### Configuration

| Property | Type   | Default  | Description
|:---------|:-------|:---------|:-----------
| bin      | String | postgres | A path to a PostgreSQL server binary.
| conf     | String |          | A path to a PostgreSQL configuration file.
| datadir  | String |          | A path to PostgreSQL server files.
| port     | Number | 5432     | A port to bind a PostgreSQL server to.
| shutdown | String | fast     | A PostgreSQL shutdown mode or process signal.

A PostgreSQL server binary must be available. If you do not have one in $PATH,
provide a path in configuration.

```JavaScript

const server = new Postgres({
  port: 5432,
  bin: '/opt/local/bin/postgres'
});

```

You may use a PostgreSQL configuration file instead of configuration object
properties that are flags (i.e. `port` and `datadir`). If `conf` is
provided, no other flags will be passed to the binary.

```JavaScript

const server = new Postgres({
  conf: '/path/to/postgresql.conf'
});

```

### Methods

For methods that accept `callback`, `callback` will receive an `Error`
as the first argument if a problem is detected; `null`, if not.

#### Postgres#open()

Attempt to open a PostgreSQL server. Returns a `Promise`.

##### Promise style `open()`

``` JavaScript

server.open().then(() => {
  // You may now connect a client to the PostgreSQL server bound to `server.port`.
});

```

##### Callback style `open()`

``` JavaScript

server.open((err) => {
  if (err === null) {
    // You may now connect a client to the PostgreSQL server bound to `server.port`.
  }
});

```

#### Postgres#close()

Close the associated PostgreSQL server. Returns a `Promise`. NOTE: Disconnect
clients prior to calling this method to avoid receiving connection
errors from clients.

##### Promise style `close()`

``` JavaScript

server.close().then(() => {
  // The associated PostgreSQL server is now closed.
});

```

##### Callback style `close()`

``` JavaScript

server.close((err) => {
  // The associated PostgreSQL server is now closed.
});

```

### Properties

#### Postgres#isOpening

Determine if the instance is starting a PostgreSQL server; `true` while a
process is spawning, and/or about to be spawned, until the contained PostgreSQL
server either starts or errs.

#### Postgres#isRunning

Determine if the instance is running a PostgreSQL server; `true` once a process
has spawned and the contained PostgreSQL server is ready to service requests.

#### Postgres#isClosing

Determine if the instance is closing a PostgreSQL server; `true` while a
process is being, or about to be, killed until the contained PostgreSQL server
either closes or errs.

### Events

#### stdout

Emitted when a PostgreSQL server prints to stdout or stderr.

#### opening

Emitted when attempting to start a PostgreSQL server.

#### open

Emitted when a PostgreSQL server becomes ready to service requests.

#### closing

Emitted when attempting to stop a PostgreSQL server.

#### close

Emitted once a PostgreSQL server has stopped.
